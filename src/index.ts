import { isAuthorized } from "./auth";
import { runChat } from "./chat/runner";
import type { ChatRequest } from "./chat/types";
import type { Env } from "./env";
import { runRead } from "./read/runner";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function guard(request: Request, env: Env): Promise<Response | null> {
  if (await isAuthorized(request, env.AUTH_TOKENS)) return null;
  return json(401, { error: { message: "unauthorized" } });
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const denied = await guard(request, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, {
      error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
    });
  }

  const req = (body ?? {}) as Partial<ChatRequest>;
  if (typeof req.model !== "string" || req.model.length === 0) {
    return json(400, {
      error: { message: "model is required", type: "invalid_request_error", code: "missing_model" },
    });
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return json(400, {
      error: { message: "messages must be a non-empty array", type: "invalid_request_error", code: "invalid_messages" },
    });
  }
  if (req.stream === true) {
    return json(400, {
      error: { message: "streaming is not supported", type: "invalid_request_error", code: "stream_not_supported" },
    });
  }

  const outcome = await runChat(req as ChatRequest, env);
  if (outcome.kind === "all-failed") {
    return json(502, {
      error: {
        message: "all providers failed",
        type: "upstream_error",
        code: "all_providers_failed",
        provider_errors: outcome.errors,
      },
    });
  }
  return json(200, outcome.body);
}

async function handleRead(request: Request, env: Env): Promise<Response> {
  const denied = await guard(request, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: { message: "invalid JSON body" } });
  }

  const target = ((body ?? {}) as { url?: unknown }).url;
  if (typeof target !== "string" || !/^https?:\/\//i.test(target)) {
    return json(400, { error: { message: "url must be an http(s) URL" } });
  }

  const outcome = await runRead(target, env);
  if (outcome.kind === "all-failed") {
    return json(502, {
      error: { message: "all providers failed", provider_errors: outcome.errors },
    });
  }
  return new Response(outcome.markdown ?? "", {
    status: 200,
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST") {
      if (url.pathname === "/v1/chat/completions") return handleChat(request, env);
      if (url.pathname === "/v1/read") return handleRead(request, env);
    }
    return json(404, { error: { message: "not found" } });
  },
};
