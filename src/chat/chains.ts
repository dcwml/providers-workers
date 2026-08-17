import type { ChatProvider } from "./types";
import { agnes } from "./providers/agnes";
import { deepseekOfficial } from "./providers/deepseek-official";
import { openrouter } from "./providers/openrouter";

/**
 * 逻辑 model → 供应商调用顺序（写死）。
 * 首批为示例配置，按需在 providers/ 增删供应商文件后在此调整。
 */
export const CHAINS: Record<string, readonly ChatProvider[]> = {
  "sample-chat": [openrouter, deepseekOfficial],
  "sample-reasoning": [deepseekOfficial, openrouter],
  "agnes-2.0-flash": [agnes],
};

/** 未注册的逻辑 model 统一回落到 agnes。 */
export const FALLBACK_CHAIN: readonly ChatProvider[] = [agnes];

export function getChain(model: string): readonly ChatProvider[] {
  return CHAINS[model] ?? FALLBACK_CHAIN;
}
