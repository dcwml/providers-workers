export interface Env {
  AUTH_TOKENS: string;
  OPENROUTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  AGNES_API_KEY?: string;
  SILICONFLOW_API_KEY?: string;
  GPTSAPI_API_KEY?: string;
  JINA_API_KEY?: string;
  TAVILY_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  /** 允许供应商声明各自的其它 key 名 */
  [key: string]: string | undefined;
}
