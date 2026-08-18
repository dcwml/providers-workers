import type { Env } from "../env";

export interface EmbeddingsRequest {
  model: string;
  /** 单条文本或文本数组 */
  input: string | string[];
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
  /** 其余 OpenAI 字段原样透传（供应商发送前按白名单裁剪） */
  [key: string]: unknown;
}

export type EmbeddingsResponse = Record<string, unknown>;

export interface EmbeddingsProvider {
  id: string;
  embed(req: EmbeddingsRequest, env: Env, signal: AbortSignal): Promise<EmbeddingsResponse>;
}
