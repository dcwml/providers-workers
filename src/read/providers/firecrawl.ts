import {
  NonRetryableError,
  RetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { ReaderProvider } from "../types";

const ENV_KEY = "FIRECRAWL_API_KEY";

interface FirecrawlScrapeResponse {
  data?: { markdown?: string | null };
}

export const firecrawl: ReaderProvider = {
  id: "firecrawl",
  async read(url, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    let res: Response;
    try {
      res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ url, formats: ["markdown"] }),
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);

    let json: FirecrawlScrapeResponse;
    try {
      json = JSON.parse(text) as FirecrawlScrapeResponse;
    } catch (err) {
      throw new RetryableError("firecrawl: response is not valid JSON", { cause: err });
    }

    const markdown = (json.data?.markdown ?? "").trim();
    if (markdown.length === 0) throw new NonRetryableError("firecrawl returned empty content");
    return { markdown };
  },
};
