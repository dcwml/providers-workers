import { authorize } from "./auth";
import { ADMIN_PAGE_HTML } from "./admin-page";
import { handleAdminApi } from "./admin";
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
import type { WorkerEnv } from "./env";
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
import { parseAddress, prepareRecipients } from "./email/address";
import { EMAIL_PROVIDER_IDS, getEmailProviderById, runEmail } from "./email/runner";
import type { EmailProvider, ParsedAddress, PreparedMail } from "./email/types";
import { recordUnauthorized, RequestRecorder, type Feature, type RecorderMeta } from "./telemetry";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface GuardResult {
  denied: Response | null;
  tokenId: number | null;
}

async function guard(request: Request, env: WorkerEnv): Promise<GuardResult> {
  const result = await authorize(request, env.DB);
  if (result.ok) return { denied: null, tokenId: result.tokenId };
  if (result.reason === "db-error") {
    return {
      denied: json(500, {
        error: { message: "auth store unavailable", type: "server_error", code: "auth_store_error" },
      }),
      tokenId: null,
    };
  }
  return { denied: json(401, { error: { message: "unauthorized" } }), tokenId: null };
}

interface HandlerResult {
  response: Response;
  providerOk?: string;
}

/**
 * 每个业务端点的统一外壳：鉴权 → 建 recorder → 跑 handler → finish 落一行 requests。
 * 401 也落一行；500（D1 故障）不落。handler 内解析出 model 后改写 meta.model。
 */
async function withRecording(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  pathname: string,
  feature: Feature,
  run: (recorder: RequestRecorder, meta: RecorderMeta) => Promise<HandlerResult>,
): Promise<Response> {
  const start = Date.now();
  const auth = await guard(request, env);
  if (auth.denied !== null) {
    if (auth.denied.status === 401) recordUnauthorized(ctx, env.DB, pathname);
    return auth.denied;
  }
  const meta: RecorderMeta = {
    requestId: crypto.randomUUID(),
    feature,
    endpoint: pathname,
    model: "",
    tokenId: auth.tokenId,
  };
  const recorder = new RequestRecorder(ctx, env.DB, meta);
  const { response, providerOk } = await run(recorder, meta);
  recorder.finish({ status: response.status, providerOk, elapsedMs: Date.now() - start });
  return response;
}

async function handleChat(
  request: Request,
  env: WorkerEnv,
  providerParam: string | null,
  recorder: RequestRecorder,
  meta: RecorderMeta,
): Promise<HandlerResult> {
  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: ChatProvider | undefined;
  if (providerParam !== null) {
    only = getChatProviderById(providerParam);
    if (!only) {
      return {
        response: json(400, {
          error: {
            message: `unknown provider: ${providerParam}; valid providers: ${CHAT_PROVIDER_IDS.join(", ")}`,
            type: "invalid_request_error",
            code: "unknown_provider",
          },
        }),
      };
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      response: json(400, {
        error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
      }),
    };
  }

  const req = (body ?? {}) as Partial<ChatRequest>;
  if (typeof req.model !== "string" || req.model.length === 0) {
    return {
      response: json(400, {
        error: { message: "model is required", type: "invalid_request_error", code: "missing_model" },
      }),
    };
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return {
      response: json(400, {
        error: { message: "messages must be a non-empty array", type: "invalid_request_error", code: "invalid_messages" },
      }),
    };
  }
  if (req.stream === true) {
    return {
      response: json(400, {
        error: { message: "streaming is not supported", type: "invalid_request_error", code: "stream_not_supported" },
      }),
    };
  }
  meta.model = req.model;

  const outcome = await runChat(req as ChatRequest, env, undefined, only, recorder);
  if (outcome.kind === "all-failed") {
    return {
      response: json(502, {
        error: {
          message: "all providers failed",
          type: "upstream_error",
          code: "all_providers_failed",
          provider_errors: outcome.errors,
        },
      }),
    };
  }
  return { response: json(200, outcome.body), providerOk: outcome.providerOk };
}

async function handleRead(
  request: Request,
  env: WorkerEnv,
  providerParam: string | null,
  recorder: RequestRecorder,
  meta: RecorderMeta,
): Promise<HandlerResult> {
  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: ReaderProvider | undefined;
  if (providerParam !== null) {
    only = getReaderProviderById(providerParam);
    if (!only) {
      return {
        response: json(400, {
          error: {
            message: `unknown provider: ${providerParam}; valid providers: ${READER_PROVIDER_IDS.join(", ")}`,
          },
        }),
      };
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: json(400, { error: { message: "invalid JSON body" } }) };
  }

  const target = ((body ?? {}) as { url?: unknown }).url;
  if (typeof target !== "string" || !/^https?:\/\//i.test(target)) {
    return { response: json(400, { error: { message: "url must be an http(s) URL" } }) };
  }

  const outcome = await runRead(target, env, undefined, only, recorder);
  if (outcome.kind === "all-failed") {
    return {
      response: json(502, {
        error: { message: "all providers failed", provider_errors: outcome.errors },
      }),
    };
  }
  return {
    response: new Response(outcome.markdown ?? "", {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    }),
    providerOk: outcome.providerOk,
  };
}

async function handleEmbeddings(
  request: Request,
  env: WorkerEnv,
  providerParam: string | null,
  recorder: RequestRecorder,
  meta: RecorderMeta,
): Promise<HandlerResult> {
  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: EmbeddingsProvider | undefined;
  if (providerParam !== null) {
    only = getEmbeddingsProviderById(providerParam);
    if (!only) {
      return {
        response: json(400, {
          error: {
            message: `unknown provider: ${providerParam}; valid providers: ${EMBEDDINGS_PROVIDER_IDS.join(", ")}`,
            type: "invalid_request_error",
            code: "unknown_provider",
          },
        }),
      };
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      response: json(400, {
        error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
      }),
    };
  }

  const req = (body ?? {}) as Partial<EmbeddingsRequest>;
  if (typeof req.model !== "string" || req.model.length === 0) {
    return {
      response: json(400, {
        error: { message: "model is required", type: "invalid_request_error", code: "missing_model" },
      }),
    };
  }
  const inputOk =
    (typeof req.input === "string" && req.input.length > 0) ||
    (Array.isArray(req.input) && req.input.length > 0);
  if (!inputOk) {
    return {
      response: json(400, {
        error: {
          message: "input must be a non-empty string or a non-empty array",
          type: "invalid_request_error",
          code: "invalid_input",
        },
      }),
    };
  }
  meta.model = req.model;

  // 单 provider 形式：无链、无降级。未注册的 model 直接 400（不像 chat 有回落链）。
  const provider = only ?? getEmbeddingsProviderByModel(req.model);
  if (!provider) {
    return {
      response: json(400, {
        error: {
          message: `model not found: ${req.model}; valid models: ${EMBEDDING_MODEL_IDS.join(", ")}`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      }),
    };
  }

  const outcome = await runEmbeddings(req as EmbeddingsRequest, env, provider, undefined, recorder);
  if (outcome.kind === "failed") {
    return {
      response: json(502, {
        error: {
          message: "embeddings provider failed",
          type: "upstream_error",
          code: "provider_failed",
          provider_errors: outcome.errors,
        },
      }),
    };
  }
  return { response: json(200, outcome.body), providerOk: outcome.providerOk };
}

async function handleRerank(
  request: Request,
  env: WorkerEnv,
  providerParam: string | null,
  recorder: RequestRecorder,
  meta: RecorderMeta,
): Promise<HandlerResult> {
  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: RerankProvider | undefined;
  if (providerParam !== null) {
    only = getRerankProviderById(providerParam);
    if (!only) {
      return {
        response: json(400, {
          error: {
            message: `unknown provider: ${providerParam}; valid providers: ${RERANK_PROVIDER_IDS.join(", ")}`,
            type: "invalid_request_error",
            code: "unknown_provider",
          },
        }),
      };
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      response: json(400, {
        error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
      }),
    };
  }

  const req = (body ?? {}) as Partial<RerankRequest>;
  if (typeof req.model !== "string" || req.model.length === 0) {
    return {
      response: json(400, {
        error: { message: "model is required", type: "invalid_request_error", code: "missing_model" },
      }),
    };
  }
  const inputOk =
    typeof req.query === "string" &&
    req.query.length > 0 &&
    Array.isArray(req.documents) &&
    req.documents.length > 0;
  if (!inputOk) {
    return {
      response: json(400, {
        error: {
          message: "query must be a non-empty string and documents must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_input",
        },
      }),
    };
  }
  meta.model = req.model;

  // 单 provider 形式：无链、无降级。未注册的 model 直接 400（不像 chat 有回落链）。
  const provider = only ?? getRerankProviderByModel(req.model);
  if (!provider) {
    return {
      response: json(400, {
        error: {
          message: `model not found: ${req.model}; valid models: ${RERANK_MODEL_IDS.join(", ")}`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      }),
    };
  }

  const outcome = await runRerank(req as RerankRequest, env, provider, undefined, recorder);
  if (outcome.kind === "failed") {
    return {
      response: json(502, {
        error: {
          message: "rerank provider failed",
          type: "upstream_error",
          code: "provider_failed",
          provider_errors: outcome.errors,
        },
      }),
    };
  }
  return { response: json(200, outcome.body), providerOk: outcome.providerOk };
}

type RecipientParse =
  | { ok: true; list: ParsedAddress[] }
  | { ok: false; message: string };

function parseRecipientField(field: string, value: unknown): RecipientParse {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (values === null || values.length === 0) {
    return { ok: false, message: `${field} must be a non-empty string or a non-empty array of addresses` };
  }
  const list: ParsedAddress[] = [];
  for (let i = 0; i < values.length; i++) {
    const item = values[i];
    if (typeof item !== "string") {
      return { ok: false, message: `${field}[${i}] must be a string` };
    }
    const parsed = parseAddress(item);
    if (parsed === null) {
      return { ok: false, message: `${field}[${i}]: invalid address "${item}"` };
    }
    list.push(parsed);
  }
  return { ok: true, list };
}

function recipientsError(message: string): HandlerResult {
  return {
    response: json(400, {
      error: { message, type: "invalid_request_error", code: "invalid_recipients" },
    }),
  };
}

async function handleEmail(
  request: Request,
  env: WorkerEnv,
  providerParam: string | null,
  recorder: RequestRecorder,
  meta: RecorderMeta,
): Promise<HandlerResult> {
  // ?provider= 覆盖（测试用）：隔离只跑指定单家。未知 provider 直接 400。
  let only: EmailProvider | undefined;
  if (providerParam !== null) {
    only = getEmailProviderById(providerParam);
    if (!only) {
      return {
        response: json(400, {
          error: {
            message: `unknown provider: ${providerParam}; valid providers: ${EMAIL_PROVIDER_IDS.join(", ")}`,
            type: "invalid_request_error",
            code: "unknown_provider",
          },
        }),
      };
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      response: json(400, {
        error: { message: "invalid JSON body", type: "invalid_request_error", code: "invalid_json" },
      }),
    };
  }
  const req = (body ?? {}) as { [key: string]: unknown };

  if (typeof req.subject !== "string" || req.subject.length === 0) {
    return {
      response: json(400, {
        error: { message: "subject is required", type: "invalid_request_error", code: "missing_subject" },
      }),
    };
  }
  if (/[\x00-\x1F\x7F]/.test(req.subject)) {
    return {
      response: json(400, {
        error: {
          message: "subject must not contain control characters",
          type: "invalid_request_error",
          code: "invalid_subject",
        },
      }),
    };
  }

  // text/html 二选一：都传以 html 为准（不报错）；至少一个非空
  const html = typeof req.html === "string" && req.html.length > 0 ? req.html : null;
  const text = typeof req.text === "string" && req.text.length > 0 ? req.text : null;
  if (html === null && text === null) {
    return {
      response: json(400, {
        error: {
          message: "text or html body is required",
          type: "invalid_request_error",
          code: "missing_body",
        },
      }),
    };
  }

  const toParsed = parseRecipientField("to", req.to);
  if (!toParsed.ok) return recipientsError(toParsed.message);
  let cc: ParsedAddress[] = [];
  if (req.cc !== undefined) {
    const parsed = parseRecipientField("cc", req.cc);
    if (!parsed.ok) return recipientsError(parsed.message);
    cc = parsed.list;
  }
  let bcc: ParsedAddress[] = [];
  if (req.bcc !== undefined) {
    const parsed = parseRecipientField("bcc", req.bcc);
    if (!parsed.ok) return recipientsError(parsed.message);
    bcc = parsed.list;
  }

  const recipients = prepareRecipients(toParsed.list, cc, bcc);
  const mail: PreparedMail = {
    subject: req.subject,
    bodyKind: html !== null ? "html" : "text",
    body: html ?? text ?? "",
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
  };

  const outcome = await runEmail(mail, env, only, recorder);
  if (outcome.kind === "all-failed") {
    return {
      response: json(502, {
        error: {
          message: "all email providers failed",
          type: "upstream_error",
          code: "all_providers_failed",
          provider_errors: outcome.errors,
        },
      }),
    };
  }
  if (outcome.kind === "uncertain") {
    return {
      response: json(502, {
        error: {
          message:
            "delivery is uncertain: the upstream may have accepted the message; provider fallback was suppressed to avoid duplicate sends",
          type: "upstream_error",
          code: "delivery_uncertain",
          provider_errors: outcome.errors,
        },
      }),
    };
  }
  return { response: json(200, outcome.body), providerOk: outcome.providerOk };
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/admin") {
      return new Response(ADMIN_PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname.startsWith("/admin/api/")) return handleAdminApi(request, env);
    if (request.method === "POST") {
      const providerParam = url.searchParams.get("provider");
      if (url.pathname === "/v1/chat/completions") {
        return withRecording(request, env, ctx, url.pathname, "chat", (recorder, meta) =>
          handleChat(request, env, providerParam, recorder, meta),
        );
      }
      if (url.pathname === "/v1/read") {
        return withRecording(request, env, ctx, url.pathname, "read", (recorder, meta) =>
          handleRead(request, env, providerParam, recorder, meta),
        );
      }
      if (url.pathname === "/v1/embeddings") {
        return withRecording(request, env, ctx, url.pathname, "embeddings", (recorder, meta) =>
          handleEmbeddings(request, env, providerParam, recorder, meta),
        );
      }
      if (url.pathname === "/v1/rerank") {
        return withRecording(request, env, ctx, url.pathname, "rerank", (recorder, meta) =>
          handleRerank(request, env, providerParam, recorder, meta),
        );
      }
      if (url.pathname === "/v1/send-email") {
        return withRecording(request, env, ctx, url.pathname, "email", (recorder, meta) =>
          handleEmail(request, env, providerParam, recorder, meta),
        );
      }
    }
    return json(404, { error: { message: "not found" } });
  },
};
