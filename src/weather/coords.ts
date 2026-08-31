/**
 * 坐标与地图链接工具：把用户随手能给的地图分享链接换算成 WGS-84 经纬度。
 * 百度墨卡托(BD-09MC) 多项式来自百度 JS API 逆向（MCBAND/MC2LL 分段系数）；
 * BD-09/GCJ-02 偏移公式为业界通行版本。均用公开实测用例校验（见 test/weather/coords.test.ts）。
 */

export interface Wgs84Point {
  latitude: number;
  longitude: number;
}

// ---- 百度墨卡托(BD-09MC) → BD-09 经纬度：分段多项式 ----

const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL: readonly (readonly number[])[] = [
  [1.410526172116255e-8, 8.98305509648872e-6, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 17337981.2],
  [-7.435856389565537e-9, 8.983055097726239e-6, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 10260144.86],
  [-3.030883460898826e-8, 8.98305509983578e-6, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6856817.37],
  [-1.981981304930552e-8, 8.983055099779535e-6, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4482777.06],
  [3.09191371068437e-9, 8.983055096812155e-6, 0.00006995724062, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2555164.4],
  [2.890871144776878e-9, 8.983055095805407e-6, -3.068298e-8, 7.47137025468032, -0.00000353937994, -0.02145144861037, -0.00001234426596, 0.00010322952773, -0.00000323890364, 826088.5],
];

function bd09McToBd09Ll(x: number, y: number): Wgs84Point {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let c: readonly number[] | undefined;
  for (let i = 0; i < MCBAND.length; i++) {
    if (ay >= (MCBAND[i] as number)) {
      c = MC2LL[i];
      break;
    }
  }
  if (c === undefined) c = MC2LL[MC2LL.length - 1] as readonly number[];
  const lng = (c[0] as number) + (c[1] as number) * ax;
  const cc = ay / (c[9] as number);
  const lat =
    (c[2] as number) +
    (c[3] as number) * cc +
    (c[4] as number) * cc ** 2 +
    (c[5] as number) * cc ** 3 +
    (c[6] as number) * cc ** 4 +
    (c[7] as number) * cc ** 5 +
    (c[8] as number) * cc ** 6;
  return { longitude: lng * Math.sign(x), latitude: lat * Math.sign(y) };
}

// ---- BD-09 → GCJ-02 ----

function bd09ToGcj02(longitude: number, latitude: number): Wgs84Point {
  const x = longitude - 0.0065;
  const y = latitude - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * Math.PI * 3000 / 180);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * Math.PI * 3000 / 180);
  return { longitude: z * Math.cos(theta), latitude: z * Math.sin(theta) };
}

// ---- GCJ-02 ⇄ WGS-84（正向偏移 + 迭代求逆） ----

const GCJ_A = 6378245;
const GCJ_EE = 0.00669342162296594323;

function transformLat(x: number, y: number): number {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return r;
}

function transformLng(x: number, y: number): number {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return r;
}

function wgs84ToGcj02(longitude: number, latitude: number): Wgs84Point {
  let dLat = transformLat(longitude - 105, latitude - 35);
  let dLng = transformLng(longitude - 105, latitude - 35);
  const radLat = (latitude / 180) * Math.PI;
  const magic = 1 - GCJ_EE * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { longitude: longitude + dLng, latitude: latitude + dLat };
}

function gcj02ToWgs84(longitude: number, latitude: number): Wgs84Point {
  let wl = longitude;
  let wt = latitude;
  for (let i = 0; i < 4; i++) {
    const g = wgs84ToGcj02(wl, wt);
    wl += longitude - g.longitude;
    wt += latitude - g.latitude;
  }
  return { longitude: wl, latitude: wt };
}

// ---- 组合出口：各坐标系 → WGS-84 ----

/** 百度墨卡托(BD-09MC，桌面端分享链接 @ 后的坐标) → WGS-84 */
export function wgs84FromBd09Mc(x: number, y: number): Wgs84Point {
  const bd = bd09McToBd09Ll(x, y);
  const gcj = bd09ToGcj02(bd.longitude, bd.latitude);
  return gcj02ToWgs84(gcj.longitude, gcj.latitude);
}

/** BD-09 经纬度（手机端百度 marker 链接）→ WGS-84 */
export function wgs84FromBd09Ll(longitude: number, latitude: number): Wgs84Point {
  const gcj = bd09ToGcj02(longitude, latitude);
  return gcj02ToWgs84(gcj.longitude, gcj.latitude);
}

/** GCJ-02 经纬度（高德系链接的坐标）→ WGS-84 */
export function wgs84FromGcj02(longitude: number, latitude: number): Wgs84Point {
  return gcj02ToWgs84(longitude, latitude);
}

function inWgs84Range(p: Wgs84Point): boolean {
  return p.latitude >= -90 && p.latitude <= 90 && p.longitude >= -180 && p.longitude <= 180;
}

const NUM = "-?\\d+(?:\\.\\d+)?";

/**
 * 解析地图分享链接中的坐标（换算为 WGS-84）：
 * - map.baidu.com / api.map.baidu.com：
 *   - 桌面端 `/@x,y,zoom`（BD-09 墨卡托，视口中心）
 *   - 手机端 marker `?location=纬度,经度`（BD-09 经纬度）
 * - uri.amap.com marker `?position=经度,纬度`（GCJ-02，注意经度在前）
 * 非地图链接、或链接里取不到坐标时返回 null。
 */
export function parseMapLocation(
  input: string,
): (Wgs84Point & { source: "baidu-link" | "amap-link" }) | null {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname;

  if (host === "map.baidu.com" || host === "api.map.baidu.com" || host.endsWith(".map.baidu.com")) {
    const marker = url.searchParams.get("location");
    if (marker !== null) {
      const m = marker.match(new RegExp(`^(${NUM}),(${NUM})$`));
      if (m) {
        const p = wgs84FromBd09Ll(Number(m[2]), Number(m[1]));
        if (inWgs84Range(p)) return { ...p, source: "baidu-link" };
      }
      return null;
    }
    const mc = trimmed.match(new RegExp(`\\/@(${NUM}),(${NUM}),${NUM}z`));
    if (mc) {
      const p = wgs84FromBd09Mc(Number(mc[1]), Number(mc[2]));
      if (inWgs84Range(p)) return { ...p, source: "baidu-link" };
    }
    return null;
  }

  if (host === "uri.amap.com" || host.endsWith(".amap.com") || host.endsWith(".amap.cn")) {
    const position = url.searchParams.get("position");
    if (position !== null) {
      const m = position.match(new RegExp(`^(${NUM}),(${NUM})$`));
      if (m) {
        const p = wgs84FromGcj02(Number(m[1]), Number(m[2]));
        if (inWgs84Range(p)) return { ...p, source: "amap-link" };
      }
    }
    return null;
  }

  return null;
}
