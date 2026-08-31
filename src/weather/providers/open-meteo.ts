import { RetryableError, classifyHttpStatus, classifyNetworkError } from "../../errors";
import type { Env } from "../../env";
import type { GeoCandidate, WeatherForecastRequest, WeatherProvider } from "../types";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

// current/daily 字段集是网关选定的固定集合（timezone=auto 由上游按坐标给当地时间）
const CURRENT_FIELDS =
  "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m";
const DAILY_FIELDS =
  "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max";

/**
 * open-meteo 免费匿名（无 ENV_KEY，类似 anysearch 的匿名例外）。
 * 响应 JSON 原样透传，不改任何字段。
 */
export const openMeteo: WeatherProvider = {
  id: "open-meteo",
  async forecast(req: WeatherForecastRequest, _env: Env, signal: AbortSignal) {
    const params = new URLSearchParams({
      latitude: String(req.latitude),
      longitude: String(req.longitude),
      current: CURRENT_FIELDS,
      daily: DAILY_FIELDS,
      timezone: "auto",
      forecast_days: String(req.days),
    });
    let res: Response;
    try {
      res = await fetch(`${FORECAST_URL}?${params.toString()}`, { signal });
    } catch (err) {
      throw classifyNetworkError(err);
    }
    const text = await res.text();
    if (!res.ok) throw classifyHttpStatus(res.status, text);
    try {
      return { body: JSON.parse(text) };
    } catch {
      throw new RetryableError("open-meteo returned non-JSON response");
    }
  },
};

interface RawGeoResult {
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  admin1?: unknown;
  country?: unknown;
}

/**
 * 地名 → 候选坐标（GeoNames 库，language=zh 回显中文名）。免费匿名。
 * 空结果是合法响应（没查到地名），由 runner 决定 404；只取第一条候选。
 */
export async function geocodeOpenMeteo(name: string, signal: AbortSignal): Promise<GeoCandidate[]> {
  const params = new URLSearchParams({ name, count: "1", language: "zh", format: "json" });
  let res: Response;
  try {
    res = await fetch(`${GEOCODE_URL}?${params.toString()}`, { signal });
  } catch (err) {
    throw classifyNetworkError(err);
  }
  const text = await res.text();
  if (!res.ok) throw classifyHttpStatus(res.status, text);
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new RetryableError("open-meteo geocoding returned non-JSON response");
  }
  const results = (envelope as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const candidates: GeoCandidate[] = [];
  for (const raw of results as RawGeoResult[]) {
    if (
      typeof raw.name === "string" &&
      typeof raw.latitude === "number" &&
      typeof raw.longitude === "number"
    ) {
      const candidate: GeoCandidate = { name: raw.name, latitude: raw.latitude, longitude: raw.longitude };
      if (typeof raw.admin1 === "string") candidate.admin1 = raw.admin1;
      if (typeof raw.country === "string") candidate.country = raw.country;
      candidates.push(candidate);
    }
  }
  return candidates;
}
