import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { ReaderProvider } from "../types";

const ENV_KEY = "TAVILY_API_KEY";

interface TavilyExtractResponse {
  results?: { url?: string; raw_content?: string | null }[];
}

export const tavily: ReaderProvider = {
  id: "tavily",
  async read(url, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    let res: Response;
    try {
      res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ urls: [url] }),
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);

    let json: TavilyExtractResponse;
    try {
      json = JSON.parse(text) as TavilyExtractResponse;
    } catch (err) {
      throw new RetryableError("tavily: response is not valid JSON", { cause: err });
    }

    const markdown = (json.results?.[0]?.raw_content ?? "").trim();
    if (markdown.length === 0) throw new NonRetryableError("tavily returned empty content");
    return { markdown };
  },
};
