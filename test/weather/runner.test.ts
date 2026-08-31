import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import type { Env } from "../../src/env";
import { INSERT_ATTEMPT_SQL, RequestRecorder } from "../../src/telemetry";
import { runWeather } from "../../src/weather/runner";
import type { GeoCandidate, WeatherForecastRequest } from "../../src/weather/types";
import { makeFakeCtx, makeFakeD1 } from "../helpers";

// runner 依赖 providers/open-meteo 模块，mock 用「委托 state」模式；coords.ts 不 mock（链接换算是真实数学）
const state = vi.hoisted(() => ({
  geocodeImpl: async (): Promise<GeoCandidate[]> => [],
  forecastImpl: async (): Promise<{ body: unknown }> => ({ body: {} }),
  geocodeName: "",
  forecastReq: undefined as WeatherForecastRequest | undefined,
}));

vi.mock("../../src/weather/providers/open-meteo", () => ({
  openMeteo: {
    id: "open-meteo",
    forecast: (req: WeatherForecastRequest) => {
      state.forecastReq = req;
      return state.forecastImpl();
    },
  },
  geocodeOpenMeteo: (name: string) => {
    state.geocodeName = name;
    return state.geocodeImpl();
  },
}));

const env: Env = {};
const fast = { delayMs: 0 };

const GUANGZHOU: GeoCandidate = {
  name: "广州",
  latitude: 23.129,
  longitude: 113.264,
  admin1: "广东省",
  country: "中国",
};

// 用户实际提供的百度分享链接 → 换算后 ≈ (113.2230, 23.0827)
const BAIDU_SHARE_URL =
  "https://map.baidu.com/poi/%E9%87%91%E9%BE%99%E8%8B%91-15%E5%8F%B7%E6%A5%BC/@12605385.759150315,2625484.0239938027,20.77z?uid=99dbd8587b525fa02b201ae4&da_src=shareurl";

describe("runWeather", () => {
  beforeEach(() => {
    state.geocodeImpl = async () => [GUANGZHOU];
    state.forecastImpl = async () => ({ body: { current: { temperature_2m: 30.2 } } });
    state.geocodeName = "";
    state.forecastReq = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses explicit WGS-84 coords directly (source=coords, default days=3)", async () => {
    const outcome = await runWeather({ latitude: 23.0827, longitude: 113.223 }, env, fast);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.location).toEqual({ latitude: 23.0827, longitude: 113.223, source: "coords" });
    expect(outcome.body).toEqual({ current: { temperature_2m: 30.2 } });
    expect(outcome.providerOk).toBe("open-meteo");
    expect(state.forecastReq).toEqual({ latitude: 23.0827, longitude: 113.223, days: 3 });
    expect(state.geocodeName).toBe("");
  });

  it("passes days through to the forecast", async () => {
    const outcome = await runWeather({ latitude: 1, longitude: 2, days: 7 }, env, fast);
    expect(outcome.kind).toBe("ok");
    expect(state.forecastReq?.days).toBe(7);
  });

  it("geocodes a place name and echoes the resolved place (source=geocode)", async () => {
    const outcome = await runWeather({ location: "广州" }, env, fast);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.location).toEqual({
      latitude: 23.129,
      longitude: 113.264,
      source: "geocode",
      name: "广州",
      admin1: "广东省",
      country: "中国",
    });
    expect(state.geocodeName).toBe("广州");
    expect(state.forecastReq).toEqual({ latitude: 23.129, longitude: 113.264, days: 3 });
  });

  it("returns 404 location_not_found when geocoding has no match", async () => {
    state.geocodeImpl = async () => [];
    const outcome = await runWeather({ location: "不存在的地方xyz" }, env, fast);
    expect(outcome).toEqual({
      kind: "not-found",
      status: 404,
      code: "location_not_found",
      message: expect.stringContaining("不存在的地方xyz"),
    });
    expect(state.forecastReq).toBeUndefined();
  });

  it("parses a baidu share link without calling geocoding (source=baidu-link)", async () => {
    const outcome = await runWeather({ location: BAIDU_SHARE_URL }, env, fast);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.location.source).toBe("baidu-link");
    expect(outcome.location.longitude).toBeCloseTo(113.223, 3);
    expect(outcome.location.latitude).toBeCloseTo(23.0827, 3);
    expect(state.geocodeName).toBe("");
    expect(state.forecastReq?.longitude).toBeCloseTo(113.223, 3);
  });

  it("parses an amap marker link (source=amap-link)", async () => {
    const outcome = await runWeather(
      { location: "https://uri.amap.com/marker?position=113.228295,23.080031" },
      env,
      fast,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.location.source).toBe("amap-link");
    expect(outcome.location.longitude).toBeCloseTo(113.222963, 3);
  });

  it("rejects a map link without extractable coordinates with 400 unparseable_map_link", async () => {
    const outcome = await runWeather({ location: "https://uri.amap.com/search?keyword=food" }, env, fast);
    expect(outcome).toMatchObject({ kind: "bad-request", status: 400, code: "unparseable_map_link" });
    expect(state.geocodeName).toBe("");
    expect(state.forecastReq).toBeUndefined();
  });

  it("rejects location together with coords with 400 ambiguous_location", async () => {
    const outcome = await runWeather({ location: "广州", latitude: 1, longitude: 2 }, env, fast);
    expect(outcome).toMatchObject({ kind: "bad-request", status: 400, code: "ambiguous_location" });
  });

  it("falls back to the caller's IP coordinates (source=ip)", async () => {
    const outcome = await runWeather({ ipFallback: { latitude: 39.9, longitude: 116.4 } }, env, fast);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.location).toEqual({ latitude: 39.9, longitude: 116.4, source: "ip" });
  });

  it("returns 400 location_required when nothing to resolve from", async () => {
    const outcome = await runWeather({}, env, fast);
    expect(outcome).toMatchObject({ kind: "bad-request", status: 400, code: "location_required" });
  });

  it("retries a retryable geocoding failure 3 times, then 502 without forecasting", async () => {
    let calls = 0;
    state.geocodeImpl = async () => {
      calls++;
      throw new RetryableError("geocode down");
    };
    const outcome = await runWeather({ location: "广州" }, env, fast);
    expect(outcome).toMatchObject({ kind: "failed", status: 502 });
    if (outcome.kind !== "failed") return;
    expect(outcome.errors).toEqual([{ provider: "open-meteo-geocode", message: "geocode down" }]);
    expect(calls).toBe(3);
    expect(state.forecastReq).toBeUndefined();
  });

  it("does not retry a non-retryable geocoding failure", async () => {
    let calls = 0;
    state.geocodeImpl = async () => {
      calls++;
      throw new NonRetryableError("bad request");
    };
    const outcome = await runWeather({ location: "广州" }, env, fast);
    expect(outcome.kind).toBe("failed");
    expect(calls).toBe(1);
  });

  it("retries a retryable forecast failure 3 times, then 502", async () => {
    let calls = 0;
    state.forecastImpl = async () => {
      calls++;
      throw new RetryableError("forecast down");
    };
    const outcome = await runWeather({ latitude: 1, longitude: 2 }, env, fast);
    expect(outcome).toMatchObject({ kind: "failed", status: 502 });
    if (outcome.kind !== "failed") return;
    expect(outcome.errors).toEqual([{ provider: "open-meteo", message: "forecast down" }]);
    expect(calls).toBe(3);
  });

  it("logs attempts with the weather feature tag when no recorder is attached", async () => {
    await runWeather({ latitude: 1, longitude: 2 }, env, fast);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[weather] provider=open-meteo"));
  });

  it("records attempts for both stages via recorder", async () => {
    const d1 = makeFakeD1();
    const c = makeFakeCtx();
    const recorder = new RequestRecorder(c.ctx, d1.db, {
      requestId: "r9", feature: "weather", endpoint: "/v1/weather", model: "", tokenId: 1,
    });
    const outcome = await runWeather({ location: "广州" }, env, fast, recorder);
    expect(outcome.kind).toBe("ok");
    await Promise.all(c.promises);
    const rows = d1.statements.filter((s) => s.sql === INSERT_ATTEMPT_SQL);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.params[2]).toBe("open-meteo-geocode");
    expect(rows[1]?.params[2]).toBe("open-meteo");
  });
});
