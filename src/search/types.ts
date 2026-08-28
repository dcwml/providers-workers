import type { Env } from "../env";

export interface SearchRequest {
  query: string;
  /** 1-10 的整数，缺省由上游决定（默认 10） */
  maxResults?: number;
}

export interface SearchResult {
  /** 上游 JSON 响应信封，原样透传（不改任何字段） */
  body: unknown;
}

export interface SearchProvider {
  id: string;
  search(req: SearchRequest, env: Env, signal: AbortSignal): Promise<SearchResult>;
}
