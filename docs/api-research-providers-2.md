# 搜索 API 官方文档调研（You.com / SerpApi / SearXNG）

- 抓取日期：**2026-09-29**
- 依据：仅官方文档域名 + 官方源码仓库（searxng/searxng）+ 实测请求；**不引用第三方博客/第三方 SDK**
- 实例实测：`https://search.658658.xyz`（只读 GET）

---

## 1. You.com Web Search API

### 1.1 官方文档 URL

| 内容 | URL |
|---|---|
| 文档入口（旧域 301 到此） | https://documentation.you.com/ → https://you.com/docs/ |
| 文档总索引（机器可读） | https://you.com/docs/llms.txt |
| API reference 索引 | https://you.com/docs/api-reference/llms.txt |
| Search endpoint 参考 | https://you.com/docs/api-reference/search/v1-search（`.md` 后缀可取纯文本） |
| OpenAPI 3.1（分 API） | https://you.com/docs/openapi/web-search.json （总入口 https://you.com/docs/openapi.json 为 HTML 索引页） |
| 认证 | https://you.com/docs/using-the-api/authentication |
| 错误码 | https://you.com/docs/using-the-api/error-code-reference |
| 速率限制 | https://you.com/docs/rate-limits |
| 请求控制（freshness/country/language/domain/pagination/safesearch） | https://you.com/docs/guides/search/request-controls |
| 计费与免费额度 | https://you.com/docs/administration/billing |
| Quickstart | https://you.com/docs/guides/search/quickstart |

> 注：`documentation.you.com` 已 301 到 `you.com/docs/`；抓取时 `you.com/docs/`（HTML 入口）会 307 到登录页，但 **任意页面加 `.md` 可直接拿到 Markdown**（Fern 文档站约定，页面头部原文声明）。

### 1.2 Endpoint

- **主推：`POST https://ydc-index.io/v1/search`**，`Content-Type: application/json`
- 遗留：`GET /v1/search` **仍可用但不再接收新特性**；官方原文：「GET /v1/search still works and existing integrations will keep running, but it will not receive new feature updates. New features will be added to POST only, and extraction is only available here.」（来源：v1-search reference + request-controls）
- 当前 OpenAPI（`https://you.com/docs/openapi/web-search.json`）**只定义了 `post`**，`get` 无 schema → GET 的 query 参数名**当前官方未公开 schema**，不要按旧博客参数表实现。
- 其它 host：Answer / Research / Finance Research 只在 `api.you.com`；在 `ydc-index.io` 上调错路径会返回 403 `{"message":"Missing Authentication Token"}`（错误码页原文）。

### 1.3 Authentication

- **Header：`X-API-Key: <key>`（唯一正式方式）**，环境变量约定名 `YDC_API_KEY`（authentication.md）
- OpenAPI auth header 亦为 `X-API-Key`（docs 头部声明）
- **无 query 参数放 key 的官方写法**
- 免费无 key 通道：MCP `https://api.you.com/mcp?profile=free`（`you-search` / `you-discover`，**100 queries/day**）——不是 REST `/v1/search`
- 另有 x402 / MPP 机器支付（无 key 计费）：https://you.com/docs/administration/machine-payments

### 1.4 Request schema（POST JSON body，来源 v1-search reference）

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string | **是** | — | 查询词，支持搜索操作符 |
| `count` | integer | 否 | `10` | 每个分区（`web`/`news`）最大结果数；guidance 页写 max `100` |
| `offset` | integer | 否 | `0` | 翻页，`0 ≤ offset ≤ 9`，按 `count` 的倍数跳页 |
| `freshness` | enum/string | 否 | — | `day`/`week`/`month`/`year` 或 `YYYY-MM-DDtoYYYY-MM-DD` |
| `country` | enum | 否 | — | ISO 3166-1 alpha-2 子集（`AR,AU,AT,BE,BR,CA,CL,DK,FI,FR,DE,HK,IN,ID,IT,JP,KR,MY,MX,NL,NZ,NO,CN,PL,PT,PH,RU,SA,ZA,ES,SE,CH,TW,TR,GB,US`） |
| `language` | enum | 否 | `EN` | BCP 47 子集（`EN,EN-GB,ZH-HANS,ZH-HANT,JA,...`，全表见 reference） |
| `safesearch` | enum | 否 | `moderate` | `off` / `moderate` / `strict` |
| `knowledge` | enum | 否 | — | `core`（授权数据源的行情/天气等） |
| `include_domains` | string[] | 否 | — | 严格白名单，最多 500；与 `exclude_domains`/`boost_domains` 同传 → **422** |
| `exclude_domains` | string[] | 否 | — | 最多 500 |
| `boost_domains` | string[] | 否 | — | 排序加权，非过滤；可与 `exclude_domains` 同传 |
| `extraction` | object | 否 | — | `extraction_mode: highlights \| full_page`；`extraction_source: blend(默认)/cache/fetch`；`full_page.extraction_formats: ["markdown"(默认),"html"]`。**可能额外计费** |
| `crawl_timeout` | integer | 否 | `10` | 1–60 秒 |
| `livecrawl` | enum | 否 | — | **已废弃**（`web/news/all`） |
| `livecrawl_formats` | enum[] | 否 | `["html"]` | **已废弃** |

### 1.5 Response schema（200）

顶层：`results`（object，可选）、`metadata`（object，可选）。

- **`results.web[]`**（`WebResultPost`）字段路径：
  - `results.web[].url`
  - `results.web[].title`
  - `results.web[].description`
  - `results.web[].snippets[]`（string 数组；请求 `extraction_mode:"highlights"` 时**省略**）
  - `results.web[].page_age`（string，如 `2024-12-18T00:00:00`）
  - `results.web[].thumbnail_url`、`results.web[].favicon_url`
  - `results.web[].contents.markdown` / `.contents.html` / `.contents.highlights[]`（按 extraction 出现）
- **`results.news[]`**：`title` / `description` / `page_age`（UTC 发布时间戳）/ `thumbnail_url` / `url` / `contents.*`
- **`results.knowledge[]`**（`knowledge:"core"` 时）：`type`(目前仅 `answer`) / `title` / `attribution[].name` / `description` / `as_of`
- **`metadata.search_uuid` / `metadata.query` / `metadata.latency`**

> 关键差异：**没有顶层扁平 `results[]`，没有 `date`/`position` 字段**；日期字段名是 `page_age`，位置概念不存在（靠数组顺序）。web/news 是两个分区，`count` 是"每分区"上限。

### 1.6 Error 响应结构（error-code-reference + reference）

| 状态码 | 返回体 |
|---|---|
| 401 | `{"detail": "API key is required"}` / `{"detail": "Invalid or expired API key"}` / `{"detail": "<msg>"}` |
| 402（余额不足） | `{"detail": "Insufficient credits"}`；reference 另列结构：`error`/`message`/`upgrade_url` 必填，`limit`/`used`/`period`/`reset_at` 可选 |
| 402（无 key 支付挑战，仅 GET `/v1/search`、`/v1/agents/search`、POST `/v1/finance_research`） | 响应头 `PAYMENT-REQUIRED` + `WWW-Authenticate: Payment`（挑战，非失败） |
| 403 | `{"detail": "Missing required scopes"}`（key scope 不足）；或 `{"message": "Missing Authentication Token"}`（路径放错 host） |
| 404 | `agent_not_found` / `agent_not_supported_yet` |
| 422 | `{"error": "invalid request parameter(s)"}`（如 include+exclude 同传） |
| 429 | 文档只说返回 `429 Too Many Requests`，**并「Honor the Retry-After header when present」** → **Retry-After 是"when present"，非保证存在** |
| 500 | `{"detail": "Internal authentication error"}` / `{"detail": "Internal authorization error"}` |

补充事实：当前 `web-search.json` OpenAPI 的 `responses` 只有 `200/401/402/403/422/500`——**429 未写进 OpenAPI**（只在 rate-limits 页面描述）。响应头另有 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`（Unix 秒）。

### 1.7 Rate limit / 免费额度（官方当前数字，2026-09-29）

- `/v1/search`：**10 requests/second**（self-serve 默认；rate-limits.md 表格）
- 免费：新账号 **$100 免费额度**（billing.md，无需信用卡）；无 key MCP `profile=free` **100 queries/day**（authentication.md）
- 价格：Web Search **$5.00 / 1,000 calls**（每 call 最多 100 结果）；`full_page` 抓取 **$1.00 / 1,000 页**（`blend` 下缓存页免费）

### 1.8 与本地额度保护相关的官方说明

- 402 返回体带 `limit` / `used` / `period` / `reset_at` → 可直接做额度看板
- `GET https://api.you.com/v1/billing/account_balance`（`X-API-Key`）返回 `data.attributes.balance`（**单位：分**，除以 100 得 USD）—— billing.md 原文，适合本地预算熔断
- `X-RateLimit-*` 三头用于客户端预节流（rate-limits.md 明确建议"读头而不是等 429"）
- Auto Top-Up **官方明示"No spending caps"**（月度上限未提供）→ 本地必须自建 spend cap

---

## 2. SerpApi（engine=google）

### 2.1 官方文档 URL

| 内容 | URL |
|---|---|
| Google Search API 主文档 | https://serpapi.com/search-api （`.md` 版同路径） |
| 定价 / 免费额度 | https://serpapi.com/pricing （`.md` 版可用） |
| 首页（含 throughput/计费 FAQ 原文） | https://serpapi.com/ |
| JSON Restrictor | https://serpapi.com/json-restrictor |
| Locations API | https://serpapi.com/locations-api |
| 错误参考页 | **不存在**：`/errors`、`/errors.md`、`/rate-limits`、`/error-codes`、`/status-codes` 等 2026-09-29 实测均为 404 |

### 2.2 Endpoint

- `GET https://serpapi.com/search?engine=google&q=QUERY&api_key=KEY`（官方 Example Request 原文）
- 同一路径 `.json` 后缀亦可（响应中的 `serpapi_pagination.next_link` 指向 `https://serpapi.com/search.json?...`，实测）

### 2.3 Authentication

- **Query 参数 `api_key=<private key>`**（官方参数表：`api_key` — **Yes** — "Parameter defines the SerpApi private key"）
- 无 header 认证的官方描述

### 2.4 Request schema（engine=google，官方参数表摘录）

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `q` | **是** | — | 查询词，支持 `site:`/`inurl:` 等 |
| `api_key` | **是** | — | 私钥 |
| `engine` | 否 | `google` | 显式指定引擎（**可扩展**：官方另有 bing/google-news 等独立文档页与 `tbm` 切换） |
| `output` | 否 | `json` | `json` / `html` / `md` |
| `location` | 否 | — | 地理位置（城市级推荐）；与 `uule`/`lat`/`lon` 互斥 |
| `uule` / `lat` / `lon` / `radius` | 否 | — | 位置相关，互斥规则见表 |
| `google_domain` | 否 | `google.com` | |
| `gl` | 否 | — | 两位国家码 |
| `hl` | 否 | — | 2–3 位语言码，可带地区（`en-gb`） |
| `cr` / `lr` | 否 | — | 限定国家/语言集合 |
| `start` | 否 | `0` | 翻页偏移（0/10/20…） |
| `safe` | 否 | — | `active` / `off`（Google 默认模糊显式内容） |
| `nfpr` | 否 | `0` | 排除自动纠正结果 |
| `filter` | 否 | `1` | 相似/省略结果过滤开关 |
| `tbm` | 否 | — | 搜索类型：`isch/lcl/vid/nws/shop/pts` |
| `tbs` | 否 | — | 高级过滤（日期/新闻/专利…） |
| `device` | 否 | `desktop` | `desktop/tablet/mobile` |
| `no_cache` | 否 | `false` | `true` 强制重抓；**缓存命中免费、不计入月额度**；与 `async` 互斥 |
| `async` | 否 | `false` | 异步提交，配合 Searches Archive API 取回 |
| `json_restrictor` | 否 | — | 裁剪返回字段 |
| `zero_trace` | 否 | `false` | Enterprise only |

**`num` 不在当前官方参数表中**（2026-09-29 抓取 `search-api.md` 全文核对：参数表无 `num` 条目）。结果条数由 `start` 翻页决定，不要依赖 `num`。

### 2.5 Response schema（`output=json` 默认）

顶层关键键：`search_metadata`、`search_parameters`、`search_information`、`organic_results[]`、`related_searches[]`、`pagination`、`serpapi_pagination`，以及条件性出现的 `knowledge_graph` / `local_results` / `inline_images` / `inline_videos` / `ai_overview` / `things_to_know` / `related_questions` 等。

**`organic_results[]` 元素字段（官方 Response Example + 2026-09-29 实测一致）：**

| 字段路径 | 说明 |
|---|---|
| `organic_results[].position` | int，1 起 |
| `organic_results[].title` | |
| `organic_results[].link` | 最终 URL |
| `organic_results[].redirect_link` | Google 跳转链接 |
| `organic_results[].displayed_link` | 面包屑展示 URL |
| `organic_results[].snippet` | 摘要（**可能缺失**：实测部分结果无此键） |
| `organic_results[].snippet_highlighted_words[]` | |
| `organic_results[].source` | 域名来源（如 `Wikipedia`；**可能缺失**） |
| `organic_results[].thumbnail` / `.favicon` | 可选 |
| `organic_results[].sitelinks.inline[].title/.link` | 可选 |
| `organic_results[].about_this_result` / `.about_page_link` / `.read_more_link` | 可选 |
| `organic_results[].duration` / `.video_link` | 视频类结果可选 |

**`date` 字段**：官方示例的 `organic_results[]` 中**不含 `date`**（`date` 出现在 `related_questions[]`、`things_to_know`、`inline_videos[]` 等区块）；两次实测 `organic_results[]` 也均无 `date`。→ 结论：**`organic_results[].date` 是条件字段，不是稳定 schema**，解析必须容忍缺失。

翻页：`pagination.current` / `pagination.next`；`serpapi_pagination.current/.next/.next_link/.other_pages`。

`search_metadata.status`（如 `Success`）、`search_metadata.id`、`json_endpoint`。

### 2.6 Error 响应结构

**官方没有公开错误参考页**（见 2.1）。实测（2026-09-29，只读 GET）：

| 场景 | HTTP | 返回体 |
|---|---|---|
| `api_key=INVALID_KEY_123` | **401** | `{"error": "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"}` |
| 非法/不支持的输出格式（如 `/faq.md` 被当作格式解析） | 200/4xx | `{"error": "Unsupported request format."}` |

→ **错误信封是单键 `{"error": "<message>"}`**（与常见第三方博客描述一致，但这里由官方端点实测佐证）。

- **429**：官方文档未给出 429 返回体，也未提及 `Retry-After`。公开可依据的只有 pricing 的 **Throughput/hr** 概念（"guaranteed number of successful searches per hour"）与首页 FAQ「no other specific rate limit… spread your searches evenly」。→ **429/Retry-After：官方未公开，勿臆造 schema。**
- **额度耗尽**：pricing FAQ 只描述产品行为（Automatic Early Renewal / 手动续费后额度重置），**未公开返回结构**。→ 需登录账户或实测真实 key 才能确认，本次标记为**未知**。
- 非 2xx 时 body 仍为 JSON（401 实测），因此本地可统一 `JSON.parse` + `if (body.error)` 判定。

### 2.7 Rate limit / Free quota（官方当前数字，2026-09-29）

| 项 | 值 | 来源 |
|---|---|---|
| Free 计划 | **250 searches/mo，50 throughput/hr，$0** | https://serpapi.com/pricing |
| Starter | $25/mo → 1,000 次，200/hr | 同上 |
| 计费口径 | 「**Only successful searches** are counted；cached / errored / failed 不计；100 条结果与空结果同样算 1 次」 | pricing FAQ + 首页 FAQ |
| 缓存 | 缓存命中**免费且不计入**月额度（缓存 1h 过期） | search-api `no_cache` 条目 |
| SLA | 99.95%（各计划） | 首页 FAQ |

### 2.8 本地额度保护相关

- 免费 250/月 + 50/小时是**硬数字**，本地应做「月度计数 + 每小时滑动窗口」双闸
- 只有成功请求计数 → 失败/错误请求可安全重试而不烧额度（官方明文）
- 缓存免费 → 相同 `q`+全部参数的重复查询可直接复用本地缓存（参数完全相同才命中服务端缓存）
- **无公开 `X-RateLimit-*` 类响应头，无公开额度查询 API**（`account`/`plan` 页面需登录）→ 本地只能自建计数，不能依赖服务端余量信号

---

## 3. SearXNG JSON Search API

### 3.1 官方文档 URL

| 内容 | URL |
|---|---|
| Search API | https://docs.searxng.org/dev/search_api.html |
| `search:` 配置（formats 等） | https://docs.searxng.org/admin/settings/settings_search.html |
| 搜索语法 | https://docs.searxng.org/user/search-syntax.html |
| 结果 JSON 构造（官方源码） | https://github.com/searxng/searxng/blob/master/searx/webutils.py (`get_json_response`) |
| 路由/错误处理（官方源码） | https://github.com/searxng/searxng/blob/master/searx/webapp.py (`/search`, `index_error`) |
| 结果字段定义（官方源码） | https://github.com/searxng/searxng/blob/master/searx/result_types/_base.py |

### 3.2 Endpoint

- `GET /search?q=QUERY&format=json` —— **正确**（官方示例：`curl 'https://searx.example.org/search?q=searxng&format=json'`）
- 同时支持：`GET /`、`POST /`、`POST /search`（POST 为 `application/x-www-form-urlencoded`）
- 实例端**必须开启** `json` 格式，否则 403（见 3.6）

### 3.3 Authentication

- **无认证机制**（官方文档无任何 API key / header 说明）

### 3.4 实例端配置（settings.yml → `search:`）

```yaml
search:
  formats:
    - html     # 默认值（settings_defaults: OUTPUT_FORMATS = ['html','csv','json','rss'] 是"可选集合"）
```
- 可选格式集合：`html`, `csv`, `json`, `rss`（`searx/settings_defaults.py`：`OUTPUT_FORMATS = ['html', 'csv', 'json', 'rss']`）
- 官方文档原文：**"Requesting an unset format will return a 403 Forbidden error. Be aware that many public instances have these formats disabled."**

### 3.5 Query 参数

官方 Search API 页列出：

| 参数 | 必填 | 默认 | 取值 |
|---|---|---|---|
| `q` | **是** | — | 查询词（透传给各引擎，支持 `site:` 等语法） |
| `categories` | 否 | 实例配置 | 逗号分隔，如 `general,images` |
| `language` | 否 | `search.default_lang` | 语言码（`all` 表示不带语言参数） |
| `pageno` | 否 | `1` | 页码 |
| `time_range` | 否 | — | 文档表：`day`/`month`/`year` |
| `format` | 否 | `html` | `json`/`csv`/`rss`（需实例开启） |
| `safesearch` | 否 | `search.safe_search` | `0`/`1`/`2` |
| `theme` | 否 | `simple` | 仅 `simple` |

**源码补充（`searx/webadapter.py`，官方仓库）** — 文档未列但实际生效：
- `engines=<name>,<name>`：显式指定引擎（`parse_generic` 中 `if pd_name == 'engines'`）
- `categories` 还支持 `category_<name>` 形式（`parse_category_form`）
- `time_range` 源码接受 **`day`/`week`/`month`/`year`**（`parse_time_range`），`week` 文档漏列
- `language` 校验：`VALID_LANGUAGE_CODE` 或 `auto`，否则 `SearxParameterException`
- `safesearch` 必须为 0–2 数字；`pageno` 必须为 ≥1 数字
- `timeout_limit`：可选超时参数

### 3.6 Response schema（`format=json`）

顶层（`webutils.get_json_response` 原文）：

```json
{
  "query": "...",
  "results": [ ... ],
  "answers": [],
  "corrections": [],
  "infoboxes": [],
  "suggestions": [],
  "unresponsive_engines": []
}
```

`results[]` 元素 = `Result.as_dict()` = 该 msgspec Struct 的全部字段（`result_types/_base.py`）。核心字段：

| 字段路径 | 类型 | 说明 |
|---|---|---|
| `results[].url` | string | |
| `results[].title` | string | |
| `results[].content` | string | **摘要字段名是 `content`，不是 `snippet`** |
| `results[].engine` | string | 产生该结果的"主"引擎 |
| `results[].engines` | string[] | 所有命中该结果的引擎 |
| `results[].positions` | int[] | 与 `engines` 对齐的各引擎内排名 |
| `results[].score` | number | 融合得分 |
| `results[].category` | string | 如 `general` / `videos` |
| `results[].publishedDate` | string/null | ISO 时间（如 `"2025-08-21T16:20:03"`）；可为 `null` |
| `results[].pubdate` | string | `YYYY-MM-DD HH:MM:SS±ZZZZ` 字符串形式（`publishedDate` 有值时填充） |
| `results[].img_src` | string | 原图 |
| `results[].thumbnail` | string | 缩略图 |
| `results[].template` | string | `default.html` 等 |
| `results[].parsed_url` | array | `[scheme, host, path, query, anchor]` |
| `results[].iframe_src` / `.audio_src` | string/null | |
| `results[].priority` / `.author` / `.metadata` / `.views` / `.length` | 各类型 | 按模板/引擎可选 |

**没有 `position` 字段**（顺序即排名），也**没有 `date`**（用 `publishedDate`）。

### 3.7 错误响应

源码 `webapp.py` 的 `search()` 路由（官方仓库，逐行核对）：

1. `output_format = form.get('format','html')`；**不在 `OUTPUT_FORMATS` → 静默回退 `html`**（如 `format=xml` → 返回 HTML 200，不报错）
2. 格式合法但实例未启用 → **`flask.abort(403)`** → **HTML 版 403 Forbidden 页**（不是 JSON）
3. `format=json` 且已启用，但缺 `q` → `index_error('json','No query')` → **HTTP 400 + `{"error": "No query"}`**
4. `SearxParameterException`（非法 pageno/language/safesearch/time_range）→ **400 + `{"error": "<参数错误信息>"}`**
5. 其它异常 → **500 + `{"error": "search error"}`**

`index_error` 源码：
```python
if output_format == 'json':
    return Response(json.dumps({'error': error_message}), mimetype='application/json')
```
→ **JSON 错误信封 = `{"error": "<msg>"}`**（400/500）。403 路径发生在 `index_error` 之前，**因此 403 是 HTML、不可解析为 JSON**。

> 旧版认知中的 `"Search engine does not support this URL"` 与 `JSONNotValid` 字符串在当前 master 源码中**零命中**（gh_grep 实测）——不是现行错误文案。

### 3.8 实例实测（`https://search.658658.xyz`，2026-09-29，只读 GET）

**A. `GET /search?q=test&format=json` → 200，`Content-Type: application/json`，36,774 bytes**

- 关键响应头：`server-timing: total;dur=1377.128 ... total_0_wikipedia; total_1_bing; total_2_google cse; total_3_wikidata; total_4_brave` → 该实例启用引擎：**wikipedia / bing / google cse / wikidata / brave**
- 顶层键实测：`query`, `results`, `answers`, `corrections`, `infoboxes`, `suggestions`, `unresponsive_engines`（与官方 `get_json_response` 完全一致）
- `results[]` 元素实测字段：`url`, `title`, `content`, `engine`, `template`, `parsed_url`, `img_src`, `thumbnail`, `priority`, `engines`, `positions`, `score`, `category`, `publishedDate`, `iframe_src`（部分元素还带 `pubdate`, `length`, `views`, `author`, `metadata`, `open_group`, `close_group`）
- 样例：
  ```json
  {"url":"https://www.speedtest.net/","title":"Speedtest by Ookla ...","content":"Apps ... Speedtest is better ...",
   "engine":"bing","template":"default.html","parsed_url":["https","www.speedtest.net/","/","",""],
   "img_src":"","thumbnail":"","priority":"","engines":["brave","google cse","bing"],
   "positions":[1,1,1],"score":9.0,"category":"general","publishedDate":null,"iframe_src":null}
  ```
- `publishedDate` 在本次 general 查询中全为 `null`；新闻/视频类引擎结果才会有值（字段存在但可空）
- `infoboxes[]` 中 `engine:"wikidata"`，`suggestions[]` 有 9 条

**B. `GET /search?q=test&format=csv` → 403（HTML body）**

```
HTTP/1.1 403 Forbidden
<!doctype html><html lang=en><title>403 Forbidden</title>...
```
→ 证明该实例 `formats` 只开了 `html` + `json`；**403 是 HTML，不是 JSON**，与文档和源码一致。

**结论**：该实例**支持** `format=json`，schema 与官方源码一致，可直接对接；实现侧需同时容忍 403-HTML（格式被禁）与 400/500-JSON（参数/内部错误）两类失败。

### 3.9 Rate limit / 配额

- **官方文档无任何 per-client rate limit / quota 数字**（无 key 体系，故无"免费额度"概念）
- 相关配置仅面向**上游引擎**：`ban_time_on_fail`（默认 5s）、`max_ban_time_on_fail`（120s）、`suspended_times.SearxEngineTooManyRequests`（3600s）等 —— 语义是"引擎被限流后暂停多久"，**不是对调用方的限流**
- 公开实例的限流来自前置 CDN/反代：本实例响应头带 `Server: cloudflare`、`cf-cache-status: DYNAMIC` → 实际限流策略在 Cloudflare 层，官方文档未定义
- **本地额度保护**：只能自建（按实例计数 + 超时熔断）；官方唯一相关提示是"很多公共实例禁用了 json 格式"，以及实例随时可能改 `formats`/引擎集合 → **必须把 403-HTML 作为常态失败分支处理**

---

## 4. 与常见旧版认知的差异

1. **You.com 文档域名已迁移**：`documentation.you.com` 301 → `you.com/docs/`，且 HTML 入口会跳登录页；官方给出的机器可读入口是 `llms.txt` / 页面加 `.md` / `openapi/*.json`。旧版"documentation.you.com/reference"类链接已失效。
2. **You.com 主 endpoint 是 `POST /v1/search`**，且 host 是 `ydc-index.io`；`GET /v1/search` 只是遗留兼容（官方明说不再加新特性），当前 OpenAPI 只定义 POST。旧文档里的 GET 参数表（`count/num/freshness/...` 作为 query string）**不再是权威 schema**。
3. **You.com 没有 `date` / `position`**：日期是 `page_age`，且 web 与 news **分两个数组**，`count` 是"每分区"上限；`offset` 上限为 9（最多约 10 页）。
4. **You.com 认证只有 `X-API-Key` header**，没有 `?api_key=` query 写法（与 SerpApi 相反）。另外存在无 key 通道，但那是 **MCP `?profile=free`（100/day）**，不是 REST。
5. **You.com 的 429 与 `Retry-After` 是"when present"**：官方用词是「Honor the Retry-After header **when present**」，且 429 **不在 OpenAPI responses 里**——不能把 `Retry-After` 当作必然存在。
6. **You.com 免费额度不是"每天 N 次搜索"**：REST 是 **$100 一次性赠送额度 + 10 RPS**；100/day 属于 keyless MCP profile，二者不可混为一谈。且官方明确 **无 spending caps**，本地必须自建预算闸。
7. **SerpApi 无 `num` 参数**（当前官方参数表零命中）——旧博客/旧 SDK 常见的 `num=20` 写法在现行文档里不存在，翻页用 `start`。
8. **SerpApi 错误没有官方 error reference 页**：`/errors`、`/rate-limits` 等全部 404；可验证的只有实测信封 `{"error": "..."}`（401 场景）。**429 结构与 `Retry-After` 官方未公开**；"额度耗尽"的返回结构同样未公开（只有 pricing FAQ 的续费行为描述）。
9. **SerpApi 计费口径是"仅成功计数"**，缓存命中（参数完全相同、1h 内）**免费不计额度**——旧版常按"每次请求都扣 1 次"实现本地计数，会高估消耗。
10. **SerpApi `organic_results[].date` 不是稳定字段**：官方 response 示例与两次实测的 `organic_results[]` 均无 `date`（`date` 只在 `related_questions` / `inline_videos` / `things_to_know` 等区块稳定出现）→ 解析必须可选。
11. **SearXNG `format=json` 的前提是实例配置 `search.formats` 包含 `json`**；默认配置只有 `html`。且 `format` 拼错（不在 `html/csv/json/rss` 集合内）**不会报错，而是静默回退 HTML 200**——只有"合法但被禁用"的格式才 403。
12. **SearXNG 的 403 是 HTML 页，不是 JSON**；只有 400/500 才是 `{"error": "..."}` JSON。所以不能写"统一 JSON.parse body"的错误处理。
13. **旧错误文案已不存在**：`"Search engine does not support this URL"` 与 `JSONNotValid` 在当前 master 源码零命中；现行是 `flask.abort(403)` 与 `{"error":"No query"|"search error"}`。
14. **SearXNG 结果摘要字段是 `content` 不是 `snippet`**，没有 `position`（数组顺序即排名），日期是 `publishedDate`（可为 `null`）而非 `date`；`engine` 之外还有 `engines[]` + `positions[]` 表示多引擎融合。
15. **SearXNG `time_range` 源码支持 `week`**，官方 Search API 页只列了 `day/month/year`；`engines=` 参数源码可用但文档页未列。
16. **SearXNG 没有任何官方 rate limit / 免费额度数字**（无 key 体系）；`suspended_times` 里出现的"限流"是针对上游引擎的封禁时长，不是对调用方的配额。
