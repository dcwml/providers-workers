import type { Env } from "../env";

export interface ReadResult {
  markdown: string;
  title?: string;
}

export interface ReaderProvider {
  id: string;
  read(url: string, env: Env, signal: AbortSignal): Promise<ReadResult>;
}
