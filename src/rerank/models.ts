import type { RerankProvider } from "./types";
import { siliconflow } from "./providers/siliconflow";

/**
 * 逻辑 model → 单个 provider（写死）。
 * 与 chat 的链不同：rerank 无链、无降级，失败即失败；未注册的 model 直接 400。
 */
export const MODELS: Record<string, RerankProvider> = {
  "BAAI/bge-reranker-v2-m3": siliconflow,
};

export const RERANK_MODEL_IDS: readonly string[] = Object.keys(MODELS);

export function getRerankProviderByModel(model: string): RerankProvider | undefined {
  return MODELS[model];
}

/**
 * 汇总映射中出现过的 provider（按 id 去重），供 ?provider= 覆盖参数解析。
 */
const ALL_PROVIDERS: readonly RerankProvider[] = (() => {
  const seen = new Map<string, RerankProvider>();
  for (const provider of Object.values(MODELS)) {
    if (!seen.has(provider.id)) seen.set(provider.id, provider);
  }
  return [...seen.values()];
})();

export const RERANK_PROVIDER_IDS: readonly string[] = ALL_PROVIDERS.map((p) => p.id);

export function getRerankProviderById(id: string): RerankProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}
