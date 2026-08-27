import type { ChatProvider } from "./types";
import { agnes } from "./providers/agnes";
import { deepseekOfficial } from "./providers/deepseek-official";
import { gptsapi } from "./providers/gptsapi";
import { openrouter } from "./providers/openrouter";
import { sensenova } from "./providers/sensenova";
import { siliconflow } from "./providers/siliconflow";
import { zhipu } from "./providers/zhipu";

/**
 * 逻辑 model → 供应商调用顺序（写死）。
 * 首批为示例配置，按需在 providers/ 增删供应商文件后在此调整。
 */
export const CHAINS: Record<string, readonly ChatProvider[]> = {
  // "sample-chat": [openrouter, deepseekOfficial, siliconflow],
  // "sample-reasoning": [deepseekOfficial, openrouter],
  "agnes-2.0-flash": [agnes, gptsapi, siliconflow],
  "Qwen/Qwen3-8B": [siliconflow, agnes, gptsapi],
  "gpt-5.4-nano": [gptsapi, agnes, siliconflow],
  "glm-4.7-flash": [zhipu, agnes, gptsapi],
  "sensenova-6.8-flash-lite": [sensenova, agnes, gptsapi],
};

/** 未注册的逻辑 model 统一回落到 agnes。 */
export const FALLBACK_CHAIN: readonly ChatProvider[] = [agnes];

export function getChain(model: string): readonly ChatProvider[] {
  return CHAINS[model] ?? FALLBACK_CHAIN;
}

/**
 * 汇总所有链中出现过的 provider（按 id 去重），供 ?provider= 覆盖参数解析。
 * 与 model→链的映射解耦：覆盖参数可指定任一已注册 provider 做隔离测试。
 */
const ALL_PROVIDERS: readonly ChatProvider[] = (() => {
  const seen = new Map<string, ChatProvider>();
  for (const chain of [...Object.values(CHAINS), FALLBACK_CHAIN]) {
    for (const provider of chain) {
      if (!seen.has(provider.id)) seen.set(provider.id, provider);
    }
  }
  return [...seen.values()];
})();

export const CHAT_PROVIDER_IDS: readonly string[] = ALL_PROVIDERS.map((p) => p.id);

export function getChatProviderById(id: string): ChatProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}
