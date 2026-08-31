# /v1/weather 天气查询接口使用说明

查天气不用先查坐标——四种方式任选其一告诉网关「查哪里」：**地名**、**地图分享链接**、**经纬度直传**，或什么都不传（按调用方 IP 自动定位）。底层为 open-meteo（免密钥匿名调用），实况 + 日预报。

- 生产域名：`https://api.oklapzlj.com`
- 路径：`POST /v1/weather`（仅支持 POST，GET 及其它方法返回 404）
- 请求体：`application/json`
- 成功响应：`200`，JSON 信封 `{ "location": {...}, "weather": {...} }`（`weather` 为 open-meteo 上游响应**原样透传**）
- 失败响应：OpenAI 风格错误体 `{ "error": { "message", "type", "code", "provider_errors?" } }`

## 认证

```text
Authorization: Bearer <token>
```

token 由管理员经 `/admin` 后台管理；token 需带有 `weather` scope（scopes 为空的 token 不受限制）。缺失或错误返回 `401 {"error":{"message":"unauthorized"}}`。

## 请求格式

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `location` | string | 与 `latitude`/`longitude` 二选一 | **地名**（如 `"广州"`、`"荔湾区"`，GeoNames 库，支持中文）或**地图分享链接**（见下）；与 `latitude`/`longitude` 同时出现返回 400 |
| `latitude` | number | 与 `location` 二选一 | WGS-84 纬度，[-90, 90]；必须与 `longitude` 成对出现 |
| `longitude` | number | 同上 | WGS-84 经度，[-180, 180] |
| `days` | integer | 否 | 日预报天数，1-16 的整数，缺省 3 |
| （无任何位置字段） | | | 回退到调用方 IP 定位（Cloudflare 边缘自带城市级精度坐标）。定位数据不可用时返回 400 `location_required` |

### 地图分享链接支持

`location` 以 `http(s)://` 开头时按链接解析，自动换算坐标系为 WGS-84（无需知道坐标是哪个坐标系）：

| 链接形态 | 示例 | 坐标系 |
| --- | --- | --- |
| 百度地图桌面分享链接（`/@x,y,z` 视口中心） | `https://map.baidu.com/poi/.../@12605385.76,2625484.02,20.77z?...` | BD-09 墨卡托 |
| 百度地图手机 marker（`?location=纬度,经度`） | `https://api.map.baidu.com/marker?location=23.08,113.23&...` | BD-09 经纬度 |
| 高德 marker（`?position=经度,纬度`，注意经度在前） | `https://uri.amap.com/marker?position=113.22,23.08` | GCJ-02 |

不支持在链接里取坐标的形态（如高德搜索页 `uri.amap.com/search?...`）返回 400 `unparseable_map_link`。百度桌面链接取的是**视口中心**，楼宇级缩放下与目标位置通常相差几十米内，天气场景可忽略。

### 位置解析优先级与歧义

- 地名解析默认取 GeoNames 第一个结果（按相关性/人口排序），响应 `location` 中回显解析出的 `name`/`admin1`/`country`，**调用方应核对自己被解析到了哪个城市**（如「朝阳」可能命中多个城市）。
- 不支持裸坐标对字符串（如 `"23.08,113.22"`）——经纬度顺序有歧义风险，请用 `latitude`/`longitude` 字段。

## 响应格式

成功（200）：

```json
{
  "location": {
    "latitude": 23.129,
    "longitude": 113.264,
    "source": "geocode",
    "name": "广州",
    "admin1": "广东省",
    "country": "中国"
  },
  "weather": {
    "latitude": 23.13,
    "longitude": 113.25,
    "timezone": "Asia/Shanghai",
    "current": {
      "time": "2026-08-31T15:15",
      "temperature_2m": 30.2,
      "relative_humidity_2m": 77,
      "apparent_temperature": 36.1,
      "is_day": 1,
      "precipitation": 0,
      "weather_code": 3,
      "wind_speed_10m": 5.9,
      "wind_direction_10m": 172
    },
    "daily": {
      "time": ["2026-08-31", "2026-09-01", "2026-09-02"],
      "weather_code": [3, 61, 0],
      "temperature_2m_max": [33.5, 31.2, 32.8],
      "temperature_2m_min": [26.1, 25.3, 25.0],
      "precipitation_sum": [0, 12.4, 0.6],
      "precipitation_probability_max": [10, 85, 40],
      "wind_speed_10m_max": [14.2, 25.1, 18.3]
    }
  }
}
```

- `location.source`：`geocode`（地名解析）/ `coords`（经纬度直传）/ `ip`（IP 定位）/ `baidu-link` / `amap-link`（地图链接换算）。`name`/`admin1`/`country` 仅 `geocode` 来源回填，其余来源只有坐标。
- `weather` 为 open-meteo 上游响应原样透传：字段集固定为上表的 current/daily 项，`timezone=auto`（时间已按当地时区给出）；顶层 `latitude`/`longitude` 是上游网格吸附值，与请求坐标略有偏差属正常。
- `weather_code` 为 WMO 天气代码（0=晴，3=阴，61=小雨等），完整对照见 open-meteo 文档。

## 错误码速查

| 状态码 | code | 原因 |
| --- | --- | --- |
| 401 | — | token 缺失或错误（`{"error":{"message":"unauthorized"}}`） |
| 403 | `insufficient_scope` | token 无 `weather` 权限 |
| 400 | `invalid_json` | 请求体不是合法 JSON |
| 400 | `invalid_location` | `location` 非法（非字符串/空白），或 `latitude`/`longitude` 不成对、非有限数、超出范围 |
| 400 | `invalid_days` | `days` 不是 1-16 的整数 |
| 400 | `ambiguous_location` | `location` 与 `latitude`/`longitude` 同时出现 |
| 400 | `unparseable_map_link` | 链接无法提取坐标（看 message 中列出的支持形态） |
| 400 | `location_required` | 没有任何位置输入且调用方 IP 无定位数据 |
| 404 | `location_not_found` | 地名查不到（换更标准的地名，如城市/区县名重试） |
| 502 | `provider_failed` | open-meteo 上游失败（地理编码或预报阶段），看 `provider_errors`（provider 为 `open-meteo-geocode` 或 `open-meteo`） |

## 重试机制

- 地理编码与预报两个阶段各自独立重试：单阶段最多 3 次尝试（首次 + 2 次重试），间隔 1 秒；单次上游超时 30 秒。
- 网络错/超时/5xx/429/非 JSON 触发重试；其它 4xx 不重试。
- 单供应商、无链、无降级（同 embeddings/rerank 形态）：预报阶段失败即 502。
- 上游限额：open-meteo 免费档每日约 1 万次请求（无需 key）；网关自身的 token 限流/监控见 `/admin` 后台。

## 调用示例

```bash
export GATEWAY_TOKEN="<向管理员索取>"

# 1) 地名（最常用）
curl -X POST "https://api.oklapzlj.com/v1/weather" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"location":"广州"}'

# 2) 地图分享链接（直接粘贴，自动换算坐标系）
curl -X POST "https://api.oklapzlj.com/v1/weather" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"location":"https://map.baidu.com/poi/%E9%87%91%E9%BE%99%E8%8B%91-15%E5%8F%B7%E6%A5%BC/@12605385.759150315,2625484.0239938027,20.77z?uid=99dbd8587b525fa02b201ae4&da_src=shareurl"}'
# → location.source = "baidu-link"，坐标 ≈ (23.0827, 113.2230)

# 3) 经纬度直传（WGS-84）
curl -X POST "https://api.oklapzlj.com/v1/weather" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"latitude":23.0827,"longitude":113.2230,"days":7}'

# 4) 什么都不传（按调用方 IP 定位）
curl -X POST "https://api.oklapzlj.com/v1/weather" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# 错误示例：地名查不到
curl -X POST "https://api.oklapzlj.com/v1/weather" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"location":"不存在的地方xyzq"}'
# → 404 {"error":{"message":"geocoding found no place named ...","type":"invalid_request_error","code":"location_not_found"}}
```
