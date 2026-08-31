import { DEFAULT_RETRY, UPSTREAM_TIMEOUT_MS } from "../config";
import type { ProviderError } from "../errors";
import type { Env } from "../env";
import { logAttempt } from "../log";
import { withRetry, type RetryOptions } from "../retry";
import type { RequestRecorder } from "../telemetry";
import { parseMapLocation } from "./coords";
import { geocodeOpenMeteo, openMeteo } from "./providers/open-meteo";
import type { ResolvedLocation, WeatherOutcome, WeatherRequest } from "./types";

export type { WeatherOutcome, WeatherRequest } from "./types";

export const DEFAULT_FORECAST_DAYS = 3;

/** 遥测里地理编码阶段的 provider 标识（与 forecast 阶段的 open-meteo 区分） */
const GEOCODE_PROVIDER_ID = "open-meteo-geocode";

function badRequest(code: string, message: string): WeatherOutcome {
  return { kind: "bad-request", status: 400, code, message };
}

function failed(errors: ProviderError[]): WeatherOutcome {
  return { kind: "failed", status: 502, errors };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 天气编排：位置解析（经纬度直传 / 地图链接 / 地名地理编码 / IP 兜底）→ open-meteo 预报。
 * 单供应商、无链、无降级（同 embeddings/rerank 形态）：上游失败即 502。
 */
export async function runWeather(
  req: WeatherRequest,
  env: Env,
  retryOverrides?: Partial<RetryOptions>,
  recorder?: RequestRecorder,
): Promise<WeatherOutcome> {
  const days = req.days ?? DEFAULT_FORECAST_DAYS;

  const location = typeof req.location === "string" ? req.location.trim() : "";
  const hasCoords = req.latitude !== undefined || req.longitude !== undefined;
  if (location.length > 0 && hasCoords) {
    return badRequest(
      "ambiguous_location",
      "provide either location (place name or map share link) or latitude/longitude, not both",
    );
  }

  // ---- 位置解析 ----
  let resolved: ResolvedLocation;
  if (hasCoords) {
    // 入口已校验 latitude/longitude 成对且在合法范围
    resolved = {
      latitude: req.latitude as number,
      longitude: req.longitude as number,
      source: "coords",
    };
  } else if (location.length > 0) {
    if (/^https?:\/\//i.test(location)) {
      const parsed = parseMapLocation(location);
      if (parsed === null) {
        return badRequest(
          "unparseable_map_link",
          "cannot extract coordinates from this map link; supported: map.baidu.com share links (/@ mercator or marker?location=), uri.amap.com marker?position=",
        );
      }
      resolved = parsed;
    } else {
      try {
        const candidates = await withRetry(
          async () => {
            const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
            return geocodeOpenMeteo(location, signal);
          },
          {
            ...DEFAULT_RETRY,
            onAttempt: (info) =>
              recorder
                ? recorder.attempt(GEOCODE_PROVIDER_ID, info)
                : logAttempt("weather", GEOCODE_PROVIDER_ID, info),
            ...retryOverrides,
          },
        );
        const top = candidates[0];
        if (top === undefined) {
          return {
            kind: "not-found",
            status: 404,
            code: "location_not_found",
            message: `geocoding found no place named "${location}"; try a more standard name (e.g. city or district name)`,
          };
        }
        resolved = {
          latitude: top.latitude,
          longitude: top.longitude,
          source: "geocode",
          name: top.name,
          ...(top.admin1 !== undefined ? { admin1: top.admin1 } : {}),
          ...(top.country !== undefined ? { country: top.country } : {}),
        };
      } catch (err) {
        return failed([{ provider: GEOCODE_PROVIDER_ID, message: errMessage(err) }]);
      }
    }
  } else if (req.ipFallback !== undefined) {
    resolved = { ...req.ipFallback, source: "ip" };
  } else {
    return badRequest(
      "location_required",
      "provide location (place name or map share link) or latitude/longitude; without either the caller needs client GeoIP data (request.cf unavailable)",
    );
  }

  // ---- 预报 ----
  try {
    const result = await withRetry(
      async () => {
        const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
        return openMeteo.forecast({ latitude: resolved.latitude, longitude: resolved.longitude, days }, env, signal);
      },
      {
        ...DEFAULT_RETRY,
        onAttempt: (info) =>
          recorder ? recorder.attempt(openMeteo.id, info) : logAttempt("weather", openMeteo.id, info),
        ...retryOverrides,
      },
    );
    return {
      kind: "ok",
      status: 200,
      location: resolved,
      body: result.body,
      providerOk: openMeteo.id,
    };
  } catch (err) {
    return failed([{ provider: openMeteo.id, message: errMessage(err) }]);
  }
}
