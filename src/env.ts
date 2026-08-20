export interface Env {
  ADMIN_TOKEN?: string;
  OPENROUTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  AGNES_API_KEY?: string;
  SILICONFLOW_API_KEY?: string;
  GPTSAPI_API_KEY?: string;
  ZHIPU_API_KEY?: string;
  JINA_API_KEY?: string;
  TAVILY_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  /** 允许供应商声明各自的其它 key 名 */
  [key: string]: string | undefined;
}

/**
 * Worker 入口实际收到的 env：Env + D1 binding。
 * DB 是对象类型，不放进 Env（避免与 string index signature 冲突，供应商 env[ENV_KEY] 用法不受影响）。
 */
export type WorkerEnv = Env & { DB: D1Database };
