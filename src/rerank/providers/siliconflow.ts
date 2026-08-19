import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { RerankProvider, RerankResponse } from "../types";

const BASE_URL = "https://api.siliconflow.cn/v1";
const UPSTREAM_MODEL = "BAAI/bge-reranker-v2-m3";
const ENV_KEY = "SILICONFLOW_API_KEY";

export const siliconflow: RerankProvider = {
  id: "siliconflow",
  async rerank(req, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    // rerank 标准字段白名单，其余字段裁剪；model 改写为上游 model
    const body: Record<string, unknown> = {
      model: UPSTREAM_MODEL,
      query: req.query,
      documents: req.documents,
    };
    if (req.top_n !== undefined) body.top_n = req.top_n;
    if (req.return_documents !== undefined) body.return_documents = req.return_documents;

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/rerank`, {
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
      throw new RetryableError("siliconflow rerank: response is not valid JSON", {
        cause: err,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new NonRetryableError("siliconflow rerank: response has no results");
    }
    const resp = parsed as RerankResponse;
    if (!Array.isArray(resp.results) || resp.results.length === 0) {
      throw new NonRetryableError("siliconflow rerank: response has no results");
    }
    return resp;
  },
};
