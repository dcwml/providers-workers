import { isAuthorized } from "./auth";
import { CHAT_PROVIDER_IDS, getChatProviderById } from "./chat/chains";
import { runChat } from "./chat/runner";
import type { ChatProvider, ChatRequest } from "./chat/types";
import {
  EMBEDDING_MODEL_IDS,
  EMBEDDINGS_PROVIDER_IDS,
  getEmbeddingsProviderById,
  getEmbeddingsProviderByModel,
} from "./embeddings/models";
import { runEmbeddings } from "./embeddings/runner";
import type { EmbeddingsProvider, EmbeddingsRequest } from "./embeddings/types";
import type { Env } from "./env";
import { getReaderProviderById, READER_PROVIDER_IDS, runRead } from "./read/runner";
import type { ReaderProvider } from "./read/types";
import {
  RERANK_MODEL_IDS,
  RERANK_PROVIDER_IDS,
  getRerankProviderById,
  getRerankProviderByModel,
} from "./rerank/models";
import { runRerank } from "./rerank/runner";
import type { RerankProvider, RerankRequest } from "./rerank/types";

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

async function handleChat(
  request: Request,
  env: Env,
  providerParam: string | null,
): Promise<Response> {
  const denied = await guard(request, env);
  if (denied) return denied;

  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: ChatProvider | undefined;
  if (providerParam !== null) {
    only = getChatProviderById(providerParam);
    if (!only) {
      return json(400, {
        error: {
          message: `unknown provider: ${providerParam}; valid providers: ${CHAT_PROVIDER_IDS.join(", ")}`,
          type: "invalid_request_error",
          code: "unknown_provider",
        },
      });
    }
  }

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

  const outcome = await runChat(req as ChatRequest, env, undefined, only);
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

async function handleRead(
  request: Request,
  env: Env,
  providerParam: string | null,
): Promise<Response> {
  const denied = await guard(request, env);
  if (denied) return denied;

  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: ReaderProvider | undefined;
  if (providerParam !== null) {
    only = getReaderProviderById(providerParam);
    if (!only) {
      return json(400, {
        error: {
          message: `unknown provider: ${providerParam}; valid providers: ${READER_PROVIDER_IDS.join(", ")}`,
        },
      });
    }
  }

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

  const outcome = await runRead(target, env, undefined, only);
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

async function handleEmbeddings(
  request: Request,
  env: Env,
  providerParam: string | null,
): Promise<Response> {
  const denied = await guard(request, env);
  if (denied) return denied;

  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: EmbeddingsProvider | undefined;
  if (providerParam !== null) {
    only = getEmbeddingsProviderById(providerParam);
    if (!only) {
      return json(400, {
        error: {
          message: `unknown provider: ${providerParam}; valid providers: ${EMBEDDINGS_PROVIDER_IDS.join(", ")}`,
          type: "invalid_request_error",
          code: "unknown_provider",
        },
      });
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, {
      error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
    });
  }

  const req = (body ?? {}) as Partial<EmbeddingsRequest>;
  if (typeof req.model !== "string" || req.model.length === 0) {
    return json(400, {
      error: { message: "model is required", type: "invalid_request_error", code: "missing_model" },
    });
  }
  const inputOk =
    (typeof req.input === "string" && req.input.length > 0) ||
    (Array.isArray(req.input) && req.input.length > 0);
  if (!inputOk) {
    return json(400, {
      error: {
        message: "input must be a non-empty string or a non-empty array",
        type: "invalid_request_error",
        code: "invalid_input",
      },
    });
  }

  // 单 provider 形式：无链、无降级。未注册的 model 直接 400（不像 chat 有回落链）。
  const provider = only ?? getEmbeddingsProviderByModel(req.model);
  if (!provider) {
    return json(400, {
      error: {
        message: `model not found: ${req.model}; valid models: ${EMBEDDING_MODEL_IDS.join(", ")}`,
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });
  }

  const outcome = await runEmbeddings(req as EmbeddingsRequest, env, provider);
  if (outcome.kind === "failed") {
    return json(502, {
      error: {
        message: "embeddings provider failed",
        type: "upstream_error",
        code: "provider_failed",
        provider_errors: outcome.errors,
      },
    });
  }
  return json(200, outcome.body);
}

async function handleRerank(
  request: Request,
  env: Env,
  providerParam: string | null,
): Promise<Response> {
  const denied = await guard(request, env);
  if (denied) return denied;

  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: RerankProvider | undefined;
  if (providerParam !== null) {
    only = getRerankProviderById(providerParam);
    if (!only) {
      return json(400, {
        error: {
          message: `unknown provider: ${providerParam}; valid providers: ${RERANK_PROVIDER_IDS.join(", ")}`,
          type: "invalid_request_error",
          code: "unknown_provider",
        },
      });
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, {
      error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
    });
  }

  const req = (body ?? {}) as Partial<RerankRequest>;
  if (typeof req.model !== "string" || req.model.length === 0) {
    return json(400, {
      error: { message: "model is required", type: "invalid_request_error", code: "missing_model" },
    });
  }
  const inputOk =
    typeof req.query === "string" &&
    req.query.length > 0 &&
    Array.isArray(req.documents) &&
    req.documents.length > 0;
  if (!inputOk) {
    return json(400, {
      error: {
        message: "query must be a non-empty string and documents must be a non-empty array",
        type: "invalid_request_error",
        code: "invalid_input",
      },
    });
  }

  // 单 provider 形式：无链、无降级。未注册的 model 直接 400（不像 chat 有回落链）。
  const provider = only ?? getRerankProviderByModel(req.model);
  if (!provider) {
    return json(400, {
      error: {
        message: `model not found: ${req.model}; valid models: ${RERANK_MODEL_IDS.join(", ")}`,
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });
  }

  const outcome = await runRerank(req as RerankRequest, env, provider);
  if (outcome.kind === "failed") {
    return json(502, {
      error: {
        message: "rerank provider failed",
        type: "upstream_error",
        code: "provider_failed",
        provider_errors: outcome.errors,
      },
    });
  }
  return json(200, outcome.body);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST") {
      const providerParam = url.searchParams.get("provider");
      if (url.pathname === "/v1/chat/completions") return handleChat(request, env, providerParam);
      if (url.pathname === "/v1/read") return handleRead(request, env, providerParam);
      if (url.pathname === "/v1/embeddings") return handleEmbeddings(request, env, providerParam);
      if (url.pathname === "/v1/rerank") return handleRerank(request, env, providerParam);
    }
    return json(404, { error: { message: "not found" } });
  },
};
