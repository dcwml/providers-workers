import {
  NonRetryableError,
  classifyHttpStatus,
  classifyNetworkError,
} from "../../errors";
import type { Env } from "../../env";
import type { ReaderProvider } from "../types";

const ENV_KEY = "JINA_API_KEY";

export const jina: ReaderProvider = {
  id: "jina",
  async read(url, env, signal) {
    const apiKey = env[ENV_KEY];
    if (!apiKey) throw new NonRetryableError(`${ENV_KEY} is not configured`);

    let res: Response;
    try {
      res = await fetch(`https://r.jina.ai/${url}`, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "text/markdown",
        },
        signal,
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);

    const markdown = text.trim();
    if (markdown.length === 0) throw new NonRetryableError("jina returned empty content");
    return { markdown };
  },
};
