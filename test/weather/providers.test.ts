import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "../../src/errors";
import type { Env } from "../../src/env";
import { geocodeOpenMeteo, openMeteo } from "../../src/weather/providers/open-meteo";

const signal = new AbortController().signal;
const env: Env = {};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openMeteo.forecast", () => {
  it("GETs the forecast endpoint with the fixed field sets and passes the body through", async () => {
    const upstream = {
      latitude: 23.09,
      longitude: 113.25,
      current: { temperature_2m: 30.2 },
      hourly: { temperature_2m: [27, 27.5] },
      daily: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, upstream));
    vi.stubGlobal("fetch", fetchMock);

    const result = await openMeteo.forecast({ latitude: 23.0827, longitude: 113.223, days: 5 }, env, signal);

    expect(result.body).toEqual(upstream);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target.startsWith("https://api.open-meteo.com/v1/forecast?")).toBe(true);
    const params = new URL(target).searchParams;
    expect(params.get("latitude")).toBe("23.0827");
    expect(params.get("longitude")).toBe("113.223");
    expect(params.get("forecast_days")).toBe("5");
    expect(params.get("timezone")).toBe("auto");
    expect(params.get("current")).toContain("temperature_2m");
    expect(params.get("hourly")).toContain("temperature_2m");
    expect(params.get("hourly")).toContain("precipitation_probability");
    expect(params.get("daily")).toContain("temperature_2m_max");
    expect(init.method).toBeUndefined();
    expect(init.signal).toBe(signal);
  });

  it("maps network errors to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(openMeteo.forecast({ latitude: 1, longitude: 2, days: 3 }, env, signal)).rejects.toThrow(
      RetryableError,
    );
  });

  it("maps 429 and 5xx to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: true })));
    await expect(openMeteo.forecast({ latitude: 1, longitude: 2, days: 3 }, env, signal)).rejects.toThrow(
      RetryableError,
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(502, { error: true })));
    await expect(openMeteo.forecast({ latitude: 1, longitude: 2, days: 3 }, env, signal)).rejects.toThrow(
      RetryableError,
    );
  });

  it("maps other 4xx to NonRetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad coords" })));
    await expect(openMeteo.forecast({ latitude: 1, longitude: 2, days: 3 }, env, signal)).rejects.toThrow(
      NonRetryableError,
    );
  });

  it("maps non-JSON 200 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gateway html", { status: 200 })));
    await expect(openMeteo.forecast({ latitude: 1, longitude: 2, days: 3 }, env, signal)).rejects.toThrow(
      RetryableError,
    );
  });
});

describe("geocodeOpenMeteo", () => {
  it("queries the geocoding API in Chinese and maps candidates", async () => {
    const upstream = {
      generationtime_ms: 0.5,
      results: [
        { id: 1809858, name: "广州", latitude: 23.129, longitude: 113.264, admin1: "广东省", country: "中国" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, upstream));
    vi.stubGlobal("fetch", fetchMock);

    const out = await geocodeOpenMeteo("广州", signal);

    expect(out).toEqual([
      { name: "广州", latitude: 23.129, longitude: 113.264, admin1: "广东省", country: "中国" },
    ]);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target.startsWith("https://geocoding-api.open-meteo.com/v1/search?")).toBe(true);
    const params = new URL(target).searchParams;
    expect(params.get("name")).toBe("广州");
    expect(params.get("count")).toBe("1");
    expect(params.get("language")).toBe("zh");
    expect(init.signal).toBe(signal);
  });

  it("returns [] when results is missing or empty (legit no-match response)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { generationtime_ms: 0.4 })));
    expect(await geocodeOpenMeteo("不存在的地方xyz", signal)).toEqual([]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { results: [] })));
    expect(await geocodeOpenMeteo("不存在的地方xyz", signal)).toEqual([]);
  });

  it("filters entries with invalid shapes", async () => {
    const upstream = {
      results: [
        { name: 42, latitude: 1, longitude: 2 },
        { name: "no-lat", longitude: 2 },
        { name: "ok", latitude: 1, longitude: 2 },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, upstream)));
    const out = await geocodeOpenMeteo("x", signal);
    expect(out).toEqual([{ name: "ok", latitude: 1, longitude: 2 }]);
  });

  it("maps non-JSON 200 to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 200 })));
    await expect(geocodeOpenMeteo("广州", signal)).rejects.toThrow(RetryableError);
  });

  it("maps upstream 5xx to RetryableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, "boom")));
    await expect(geocodeOpenMeteo("广州", signal)).rejects.toThrow(RetryableError);
  });
});
