import type { Env } from "../env";

export interface RerankRequest {
  model: string;
  /** 查询文本 */
  query: string;
  /** 待重排序的文档列表 */
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
  /** 其余字段原样透传（供应商发送前按白名单裁剪） */
  [key: string]: unknown;
}

export type RerankResponse = Record<string, unknown>;

export interface RerankProvider {
  id: string;
  rerank(req: RerankRequest, env: Env, signal: AbortSignal): Promise<RerankResponse>;
}
