import { describe, expect, it } from "vitest";
import {
  parseMapLocation,
  wgs84FromBd09Ll,
  wgs84FromBd09Mc,
  wgs84FromGcj02,
} from "../../src/weather/coords";

// 公开实测对照点（厦门一带）：同一位置的四种坐标系表示
const XIAMEN = { longitude: 118.021679, latitude: 24.495394 };

// 用户实际提供的百度分享链接（广州荔湾 金龙苑-15号楼，视口中心为 BD-09 墨卡托）
const BAIDU_SHARE_URL =
  "https://map.baidu.com/poi/%E9%87%91%E9%BE%99%E8%8B%91-15%E5%8F%B7%E6%A5%BC/@12605385.759150315,2625484.0239938027,20.77z?uid=99dbd8587b525fa02b201ae4&info_merge=1&isBizPoi=false&ugc_type=3&ugc_ver=1&device_ratio=1&compat=1&pcevaname=pc4.1&querytype=detailConInfo&da_src=shareurl";

describe("coordinate conversion (公开实测用例校验)", () => {
  it("converts BD-09MC mercator to WGS-84", () => {
    const p = wgs84FromBd09Mc(13139533.24, 2796369.48);
    expect(p.longitude).toBeCloseTo(XIAMEN.longitude, 4);
    expect(p.latitude).toBeCloseTo(XIAMEN.latitude, 4);
  });

  it("converts BD-09 lng/lat to WGS-84", () => {
    const p = wgs84FromBd09Ll(118.03315104440664, 24.498307986743058);
    expect(p.longitude).toBeCloseTo(XIAMEN.longitude, 4);
    expect(p.latitude).toBeCloseTo(XIAMEN.latitude, 4);
  });

  it("converts GCJ-02 to WGS-84", () => {
    const p = wgs84FromGcj02(118.02657021322973, 24.492638370577403);
    expect(p.longitude).toBeCloseTo(XIAMEN.longitude, 4);
    expect(p.latitude).toBeCloseTo(XIAMEN.latitude, 4);
  });
});

describe("parseMapLocation", () => {
  it("extracts and converts coordinates from a baidu desktop share link (/@ mercator)", () => {
    const p = parseMapLocation(BAIDU_SHARE_URL);
    expect(p).not.toBeNull();
    expect(p?.source).toBe("baidu-link");
    expect(p?.longitude).toBeCloseTo(113.222963, 3);
    expect(p?.latitude).toBeCloseTo(23.082718, 3);
  });

  it("extracts coordinates from a baidu mobile marker link (?location=lat,lng, BD-09)", () => {
    const p = parseMapLocation(
      "https://api.map.baidu.com/marker?location=24.498307986743058,118.03315104440664&title=x&content=y&output=html",
    );
    expect(p).not.toBeNull();
    expect(p?.source).toBe("baidu-link");
    expect(p?.longitude).toBeCloseTo(XIAMEN.longitude, 4);
    expect(p?.latitude).toBeCloseTo(XIAMEN.latitude, 4);
  });

  it("extracts coordinates from an amap marker link (?position=lng,lat, GCJ-02)", () => {
    const p = parseMapLocation("https://uri.amap.com/marker?position=118.02657021322973,24.492638370577403");
    expect(p).not.toBeNull();
    expect(p?.source).toBe("amap-link");
    expect(p?.longitude).toBeCloseTo(XIAMEN.longitude, 4);
    expect(p?.latitude).toBeCloseTo(XIAMEN.latitude, 4);
  });

  it("returns null for a plain place name", () => {
    expect(parseMapLocation("广州")).toBeNull();
  });

  it("returns null for a non-map URL", () => {
    expect(parseMapLocation("https://example.com/@12605385.75,2625484.02,20.77z")).toBeNull();
  });

  it("returns null for a baidu link without extractable coordinates", () => {
    expect(parseMapLocation("https://map.baidu.com/detail/99dbd8587b525fa02b201ae4?querytype=detailConInfo")).toBeNull();
  });

  it("returns null for an amap link without a position parameter", () => {
    expect(parseMapLocation("https://uri.amap.com/search?keyword=%E7%BE%8E%E9%A3%9F&city=110000")).toBeNull();
  });

  it("returns null for a marker position with malformed numbers", () => {
    expect(parseMapLocation("https://uri.amap.com/marker?position=abc,def")).toBeNull();
    expect(parseMapLocation("https://api.map.baidu.com/marker?location=24.5,118.0,extra")).toBeNull();
  });
});
