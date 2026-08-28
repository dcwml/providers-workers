import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { SearchProvider } from "../types";

const BASE_URL = "https://api.anysearch.com";
const ENV_KEY = "ANYSEARCH_API_KEY";

export const anysearch: SearchProvider = {
  id: "anysearch",
  async search(req, env, signal) {
    const body: Record<string, unknown> = { query: req.query };
    if (req.maxResults !== undefined) body.max_results = req.maxResults;

    // anysearch 官方支持匿名访问（低限流）：未配 key 照常调用，配了才带 Bearer。
    const apiKey = env[ENV_KEY];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/v1/search`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);

    let envelope: { code?: unknown; message?: unknown };
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new RetryableError("anysearch returned non-JSON response");
    }
    // 信封约定：code !== 0 即上游业务失败（即使 HTTP 200）
    if (typeof envelope !== "object" || envelope === null || envelope.code !== 0) {
      const detail =
        typeof envelope === "object" && envelope !== null && typeof envelope.message === "string"
          ? envelope.message
          : text.slice(0, 300);
      throw new RetryableError(`anysearch error: ${detail}`);
    }
    return { body: envelope };
  },
};
