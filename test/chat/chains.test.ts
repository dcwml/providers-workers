import { describe, expect, it } from "vitest";
import { CHAINS, FALLBACK_CHAIN, getChain } from "../../src/chat/chains";

describe("getChain", () => {
  it("returns the configured chain for a known model", () => {
    expect(getChain("agnes-2.0-flash")).toBe(CHAINS["agnes-2.0-flash"]);
  });

  it("maps gpt-5.4-nano to the gptsapi-first fallback chain", () => {
    expect(getChain("gpt-5.4-nano").map((p) => p.id)).toEqual(["gptsapi", "agnes", "dots", "siliconflow", "sensenova", "zhipu"]);
  });

  it("maps glm-4.7-flash to the zhipu-first chain", () => {
    expect(getChain("glm-4.7-flash").map((p) => p.id)).toEqual(["zhipu", "agnes", "dots", "gptsapi", "siliconflow", "sensenova"]);
  });

  it("maps sensenova-6.8-flash-lite to the sensenova-first chain", () => {
    expect(getChain("sensenova-6.8-flash-lite").map((p) => p.id)).toEqual(["sensenova", "agnes", "dots", "gptsapi", "siliconflow", "zhipu"]);
  });

  it("maps dots3-note-prev to the dots-first chain", () => {
    expect(getChain("dots3-note-prev").map((p) => p.id)).toEqual(["dots", "agnes", "gptsapi", "siliconflow", "sensenova", "zhipu"]);
  });

  it("falls back to the agnes chain for unknown models", () => {
    expect(getChain("whatever")).toBe(FALLBACK_CHAIN);
    expect(FALLBACK_CHAIN.map((p) => p.id)).toEqual(["agnes"]);
  });
});
