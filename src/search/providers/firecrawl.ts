import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { SearchProvider } from "../types";

const BASE_URL = "https://api.firecrawl.dev";
const ENV_KEY = "FIRECRAWL_API_KEY";

interface FirecrawlSearchResponse {
  success?: unknown;
  error?: unknown;
}

export const firecrawl: SearchProvider = {
  id: "firecrawl",
  async search(req, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    const body: Record<string, unknown> = { query: req.query };
    // 网关入口 max_results（1-10）映射为 firecrawl 的 limit（1-100）
    if (req.maxResults !== undefined) body.limit = req.maxResults;

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/v2/search`, {
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

    let json: FirecrawlSearchResponse;
    try {
      json = JSON.parse(text) as FirecrawlSearchResponse;
    } catch {
      throw new RetryableError("firecrawl returned non-JSON response");
    }
    // 信封约定：success !== true 即上游业务失败（即使 HTTP 200）
    if (typeof json !== "object" || json === null || json.success !== true) {
      const detail =
        typeof json === "object" && json !== null && typeof json.error === "string"
          ? json.error
          : text.slice(0, 300);
      throw new RetryableError(`firecrawl error: ${detail}`);
    }
    return { body: json };
  },
};
