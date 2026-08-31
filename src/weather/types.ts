import type { Env } from "../env";
import type { ProviderError } from "../errors";

/** 位置是如何确定的（回显给调用方，便于核对解析到了哪里） */
export type LocationSource = "geocode" | "coords" | "ip" | "baidu-link" | "amap-link";

export interface ResolvedLocation {
  latitude: number;
  longitude: number;
  source: LocationSource;
  /** 地名解析命中时回显（其余来源不填） */
  name?: string;
  admin1?: string;
  country?: string;
}

export interface GeoCandidate {
  name: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country?: string;
}

export interface WeatherRequest {
  /** 地名或地图分享链接；与 latitude/longitude 互斥 */
  location?: string;
  /** WGS-84 坐标（与 longitude 成对出现） */
  latitude?: number;
  longitude?: number;
  /** 日预报天数 1-16，缺省 3 */
  days?: number;
  /** 无显式位置时的 IP 定位兜底（来自 request.cf，城市级精度，由入口提取） */
  ipFallback?: { latitude: number; longitude: number };
}

export interface WeatherForecastRequest {
  latitude: number;
  longitude: number;
  days: number;
}

export interface WeatherProvider {
  id: string;
  forecast(req: WeatherForecastRequest, env: Env, signal: AbortSignal): Promise<{ body: unknown }>;
}

export type WeatherOutcome =
  | { kind: "ok"; status: 200; location: ResolvedLocation; body: unknown; providerOk: string }
  | { kind: "bad-request"; status: 400; code: string; message: string }
  | { kind: "not-found"; status: 404; code: "location_not_found"; message: string }
  | { kind: "failed"; status: 502; errors: ProviderError[] };
