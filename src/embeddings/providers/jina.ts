import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { EmbeddingsProvider, EmbeddingsResponse } from "../types";

const BASE_URL = "https://api.jina.ai/v1";
const UPSTREAM_MODEL = "jina-embeddings-v5-omni-small";
const ENV_KEY = "JINA_API_KEY";

export const jina: EmbeddingsProvider = {
  id: "jina",
  async embed(req, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    // OpenAI 标准字段白名单 + jina 专属 task/normalized 透传，其余字段裁剪；model 改写为上游 model
    const body: Record<string, unknown> = { model: UPSTREAM_MODEL, input: req.input };
    if (req.encoding_format !== undefined) body.encoding_format = req.encoding_format;
    if (req.dimensions !== undefined) body.dimensions = req.dimensions;
    if (req.user !== undefined) body.user = req.user;
    if (req.task !== undefined) body.task = req.task;
    if (req.normalized !== undefined) body.normalized = req.normalized;

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new RetryableError("jina embeddings: response is not valid JSON", {
        cause: err,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new NonRetryableError("jina embeddings: response has no data");
    }
    const resp = parsed as EmbeddingsResponse;
    if (!Array.isArray(resp.data) || resp.data.length === 0) {
      throw new NonRetryableError("jina embeddings: response has no data");
    }
    return resp;
  },
};
