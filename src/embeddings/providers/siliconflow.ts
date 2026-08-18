import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { EmbeddingsProvider, EmbeddingsResponse } from "../types";

const BASE_URL = "https://api.siliconflow.cn/v1";
const UPSTREAM_MODEL = "BAAI/bge-m3";
const ENV_KEY = "SILICONFLOW_API_KEY";

export const siliconflow: EmbeddingsProvider = {
  id: "siliconflow",
  async embed(req, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    // OpenAI embeddings 标准字段白名单，其余字段裁剪；model 改写为上游 model
    const body: Record<string, unknown> = { model: UPSTREAM_MODEL, input: req.input };
    if (req.encoding_format !== undefined) body.encoding_format = req.encoding_format;
    if (req.dimensions !== undefined) body.dimensions = req.dimensions;
    if (req.user !== undefined) body.user = req.user;

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
      throw new RetryableError("siliconflow embeddings: response is not valid JSON", {
        cause: err,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new NonRetryableError("siliconflow embeddings: response has no data");
    }
    const resp = parsed as EmbeddingsResponse;
    if (!Array.isArray(resp.data) || resp.data.length === 0) {
      throw new NonRetryableError("siliconflow embeddings: response has no data");
    }
    return resp;
  },
};
