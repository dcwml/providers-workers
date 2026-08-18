import type { EmbeddingsProvider } from "./types";
import { siliconflow } from "./providers/siliconflow";

/**
 * 逻辑 model → 单个 provider（写死）。
 * 与 chat 的链不同：embeddings 无链、无降级，失败即失败；未注册的 model 直接 400。
 */
export const MODELS: Record<string, EmbeddingsProvider> = {
  "BAAI/bge-m3": siliconflow,
};

export const EMBEDDING_MODEL_IDS: readonly string[] = Object.keys(MODELS);

export function getEmbeddingsProviderByModel(model: string): EmbeddingsProvider | undefined {
  return MODELS[model];
}

/**
 * 汇总映射中出现过的 provider（按 id 去重），供 ?provider= 覆盖参数解析。
 */
const ALL_PROVIDERS: readonly EmbeddingsProvider[] = (() => {
  const seen = new Map<string, EmbeddingsProvider>();
  for (const provider of Object.values(MODELS)) {
    if (!seen.has(provider.id)) seen.set(provider.id, provider);
  }
  return [...seen.values()];
})();

export const EMBEDDINGS_PROVIDER_IDS: readonly string[] = ALL_PROVIDERS.map((p) => p.id);

export function getEmbeddingsProviderById(id: string): EmbeddingsProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}
