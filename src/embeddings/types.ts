import type { Env } from "../env";

export interface EmbeddingsRequest {
  model: string;
  /** 单条文本、文本数组或多模态对象数组（{text}/{image} 项，jina 上游支持图文混合） */
  input: string | Array<string | { text?: string; image?: string }>;
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
