# 上游 Provider 参考（parallel / exa / tavily / you / serpapi / searxng）

> 事实来源：`docs/api-research-providers-1.md`、`docs/api-research-providers-2.md`（仅官方文档 + 官方源码 + 实测），架构交互见 `docs/architecture.md` §9。
> **抓取日期 2026-09-29，可能变化；Free quota / Rate limit 是上游配置不是代码**——本插件不硬编码任何额度，额度只进 `budget.limits`（见 `docs/budget.md`）。
> 示例中的 key 一律脱敏（`***`）；日志与错误 message 永不含明文 key。

## 0. 横向速查

| 维度 | parallel | exa | tavily | you | serpapi | searxng |
|---|---|---|---|---|---|---|
| Endpoint | `POST https://api.parallel.ai/v1/search` | `POST https://api.exa.ai/search` | `POST https://api.tavily.com/search` | `POST https://ydc-index.io/v1/search` | `GET https://serpapi.com/search` | `GET {baseUrl}/search` |
| 认证 | header `x-api-key` | `x-api-key` 或 `Bearer` | `Authorization: Bearer tvly-…` | header `X-API-Key` | **query `api_key`** | **无 key** |
| 查询必填字段 | `search_queries[]` | `query` | `query` | `query` | `q` | `q` |
| 结果数上限 | `advanced_settings.max_results` ≤20 | `numResults` ≤100 | `max_results` ≤20 | `count` ≤100/分区 | 无 `num`，翻页 `start` | 翻页 `pageno` |
| score | 无 | 无（schema 已移除） | `results[].score` 0..1 | 无（数组顺序） | 用 `position` | `score` 融合分 |
| 内容字段 | `results[].excerpts[]` | `contents.text/highlights/summary` 按需 | `results[].content`（+按需 `raw_content`） | `description`+`snippets[]` | `snippet`（可能缺） | `content` |
| 日期字段 | `publish_date` | `publishedDate`（YYYY-MM-DD 估算） | `published_date`（需开关） | `page_age` | **无稳定 date** | `publishedDate`（可 null） |
| 429 Retry-After | 未承诺（要求指数退避） | 有则遵守 | 有则遵守 | when present | 官方未公开 | 无（CDN 层） |
| 错误信封 | `{"error":{message,detail}}` | `{"requestId","error","tag"}` | `{"detail":{"error":…}}` | `{"detail":…}` | `{"error":"…"}` | 400/500=`{"error":…}` JSON；**403=HTML** |
| 默认 baseUrl | `https://api.parallel.ai` | `https://api.exa.ai` | `https://api.tavily.com` | `https://ydc-index.io` | `https://serpapi.com` | `https://search.658658.xyz` |

默认 priority（数字小者优先，`src/config.ts` `DEFAULT_PRIORITY`）：parallel 10 → exa 20 → tavily 30 → you 40 → serpapi 50 → searxng 99（最终 fallback）。

---

## 1. Parallel

### 1.1 官方文档 URL

| 内容 | URL |
|---|---|
| Search API Reference | https://docs.parallel.ai/api-reference/search/search |
| Search Modes | https://docs.parallel.ai/search/modes |
| Quickstart（响应示例） | https://docs.parallel.ai/search/search-quickstart |
| Best Practices（请求字段表） | https://docs.parallel.ai/search/best-practices |
| Advanced Search Settings | https://docs.parallel.ai/search/advanced-search-settings |
| Rate Limits | https://docs.parallel.ai/getting-started/rate-limits |
| Errors / Warnings | https://docs.parallel.ai/resources/warnings-and-errors |
| Pricing | https://docs.parallel.ai/getting-started/pricing |
| Changelog（免费额度） | https://docs.parallel.ai/changelog |

### 1.2 Authentication

`x-api-key: $PARALLEL_API_KEY`（Search 文档无 `Bearer` 用法；Account API 另用 Bearer）。

### 1.3 Endpoint

`POST https://api.parallel.ai/v1/search`。`/v1beta/search` 仅为兼容存量，新集成一律 `/v1`（官方页脚要求）。

### 1.4 Request

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `search_queries` | **是**（V1 起） | — | 1–5 条，每条 3–6 词、≤200 字符 |
| `objective` | 否 | — | 自然语言目标 ≤5000 字符 |
| `mode` | 否 | `advanced` | `turbo`/`fast`/`basic`/`advanced` |
| `max_chars_total` | 否 | 动态（示例 50000） | 顶层字段 |
| `advanced_settings.max_results` | 否 | `10` | 公开上限 20，超出降级并 warning |
| `advanced_settings.source_policy` | 否 | — | `include_domains`/`exclude_domains`/`after_date` |
| `advanced_settings.location` | 否 | — | ISO 3166-1 alpha-2（`gb` 非 `uk`） |

**支持的搜索参数映射**（本插件 `SearchRequest` → Parallel）：`query→search_queries:[q]`、`maxResults→advanced_settings.max_results`、`startDate/endDate→source_policy.after_date`、`includeDomains/excludeDomains→source_policy.*`、`country→advanced_settings.location`；**不支持 `language`/`timeRange`/`safeSearch`** → adapter 丢弃并记 `droppedParams`。

**特殊能力（Key rotation 交互相关）**：`mode` 可配——经 `providers.parallel.options.mode` 透传（`turbo` ~200ms $1/1k，仅英语/日语；`fast` ~700ms $1/1k；`basic`/`advanced` $5/1k）；响应默认带 `excerpts` 正文，无需二次 Extract。

### 1.5 Response

```json
{ "search_id": "…", "results": [ { "url": "…", "title": "…", "publish_date": "2025-11-19", "excerpts": ["…"] } ],
  "warnings": null, "usage": [ { "name": "sku_search", "count": 1 } ], "session_id": "…" }
```

`results[].url/title/publish_date/excerpts[]`；**无 score、无 `content` 字段**（内容在 `excerpts`）。

### 1.6 Error

`{"error":{"message":"…","detail":{}}}`：401 凭证无效、402 余额不足、403 processor 无权限、404、408 可重试、422 校验失败（`detail` 字段级原因）、429 限流（指数退避）、500/502/503 可重试退避。

**Retry-After：api.parallel.ai 文档未提及** → 缺失时由 `keyPool.baseCooldownMs·2ⁿ` 退避兜底。

### 1.7 Rate Limit / Free quota（抓取日期 2026-09-29，可能变化，额度是配置不是代码）

- 限流：Search **600 POST/min**（GET 不计数），来源 https://docs.parallel.ai/getting-started/rate-limits
- 免费额度：**每月 $5 credits**（需绑卡的合格组织、当月有效不结转），来源 https://docs.parallel.ai/changelog
- 价格：turbo/fast $1/1k，basic/advanced $5/1k

### 1.8 Key rotation 交互

429 → `RATE_LIMIT` → 冷却当前 key（无 Retry-After → 指数退避），round-robin 切同 provider 下一个 key；401/403 → `AUTH` → key `disabled`（仅配置重载恢复）；402 → `QUOTA_EXCEEDED` → key `disabled` + budget provider scope 停用；5xx/网络/超时 → 每轮重试经 `keyPool.next()` 取下一个 active key，共 `retriesPerKey + 1` 次尝试，次数用尽 → 换 provider（全 key 轮过 → 熔断计数）。多个 key 用 `keys: ["PARALLEL_API_KEY", "PARALLEL_API_KEY_2"]`。

---

## 2. Exa

### 2.1 官方文档 URL

| 内容 | URL |
|---|---|
| Search reference | https://exa.ai/docs/reference/search （`.md`：…/search.md） |
| OpenAPI spec（schema 权威源） | https://exa.ai/docs/exa-spec.yaml 、 https://exa.ai/docs/exa-spec.json |
| Error codes | https://exa.ai/docs/admin/error-codes |
| Billing and Rate Limits | https://exa.ai/docs/admin/billing |
| Pricing | https://exa.ai/docs/admin/pricing |

> `docs.exa.ai` 现 307 到 `exa.ai/docs`（2026-09-29 实测）。

### 2.2 Authentication

两种等价：`x-api-key: <EXA_API_KEY>` 或 `Authorization: Bearer <EXA_API_KEY>`（OpenAPI securitySchemes）。

### 2.3 Endpoint

`POST https://api.exa.ai/search`（`operationId: search`）。

### 2.4 Request（唯一 required：`query`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `numResults` | `10` | 1–100；请求 highlights 时 >100 → 400 |
| `type` | `auto` | `instant`/`fast`/`auto`/`deep-lite`/`deep`/`deep-reasoning` |
| `includeDomains`/`excludeDomains` | — | 各 ≤1200，支持 `*.example.com` |
| `startPublishedDate`/`endPublishedDate` | — | ISO 8601 |
| `userLocation` | — | ISO 3166-1 alpha-2 |
| `moderation` | `false` | 内容安全过滤（无独立 safe_search） |
| `contents` | — | **内容选项全部嵌套在 `contents` 内**，见下 |

`contents` 子字段：`text`（bool/object，`maxCharacters`、`verbosity`）、`highlights`、`summary`、`extras`（`links`/`codeBlocks`…）、`livecrawlTimeout`（默认 10000ms）、`maxAgeHours`（0=抓新、-1=永远缓存、>0=N 小时内）、`snapshotAsOf`、`subpages`。`livecrawl`/`context`/`includeText` 已 deprecated。

**支持的搜索参数映射**：`query→query`、`maxResults→numResults`、`startDate/endDate→startPublishedDate/endPublishedDate`、`includeDomains/excludeDomains→includeDomains/excludeDomains`、`country→userLocation`；**无 `language`/`timeRange`/`safeSearch` 参数**（时间可用 `contents.maxAgeHours` 近似，adapter 丢弃不支持字段）。

**特殊能力（Key rotation 交互相关）**：**Exa `contents` 嵌套**——同一次 `/search` 内取回正文/高亮/摘要，避免二次 `/contents`；429 官方明示「wait for the Retry-After header when present」→ Retry-After 优先直接生效。

### 2.5 Response

`requestId`、`results[]`（required 仅 `title`、`url`）、`searchTime`、`costDollars{…}`。字段路径：`results[].publishedDate`（date-time 声明、实为 YYYY-MM-DD 估算、可 null）、`.text`/`.highlights[]`/`.summary`（按 `contents.*`）、`.id`（供 `/contents`）。**当前 schema 无 `results[].score`。**

### 2.6 Error

`{"requestId":"…","error":"…","tag":"…"}`（三者 required，`additionalProperties:false`）：

| 状态 | tag |
|---|---|
| 401 | `INVALID_API_KEY` |
| 402 | `NO_MORE_CREDITS` / `API_KEY_BUDGET_EXCEEDED` / `TEAM_BUDGET_EXCEEDED` |
| 403 | `FEATURE_DISABLED` / `PROHIBITED_CONTENT` / `CONTENT_FILTER_ERROR` |
| 429 | `RATE_LIMIT_EXCEEDED` |
| 503 | `SERVICE_OVERLOADED`（与速率无关，重试即可） |
| 400 | `INVALID_REQUEST_BODY` / `INVALID_NUM_RESULTS` / `NUM_RESULTS_EXCEEDED` |

### 2.7 Rate Limit / Free quota（抓取日期 2026-09-29，可能变化，额度是配置不是代码）

来源 https://exa.ai/docs/admin/billing ：Free 计划 **每月 $10 credits（每月 1 日重置、不累计）+ 一次性 $10 onboarding bonus**；`/search` 默认 **10 QPS**（deep 类 5 QPS），团队级跨 key 计；超速 429（带 Retry-After 按其等）、余额耗尽 402。

### 2.8 Key rotation 交互

429 → 冷却该 key（Retry-After 优先）+ 切下一个 active key；401 → `AUTH` → key disabled；402 `NO_MORE_CREDITS` → `QUOTA_EXCEEDED` → key disabled + budget provider scope 停用（本月不再用 exa）；503/网络/超时 → 每轮重试取下一个 active key（共 `retriesPerKey + 1` 次），次数用尽 → 换 provider → `circuitBreaker` 计数。Exa 多 key 共享团队 QPS 配额 → key 数量不提升 QPS，仅提升可用性。

---

## 3. Tavily

### 3.1 官方文档 URL

| 内容 | URL |
|---|---|
| Search API Reference | https://docs.tavily.com/documentation/api-reference/endpoint/search |
| Rate Limits | https://docs.tavily.com/documentation/rate-limits |
| Credits & Pricing | https://docs.tavily.com/documentation/api-credits |
| Best Practices（参数表） | https://docs.tavily.com/documentation/best-practices/best-practices-search |
| 认证示例 | https://docs.tavily.com/agents |
| Keyless | https://docs.tavily.com/documentation/keyless |

### 3.2 Authentication

`Authorization: Bearer tvly-YOUR_API_KEY`（现行文档唯一写法；旧 `Tavily-API-Key` header 已不出现）。另有 keyless：`X-Tavily-Access-Mode: keyless`（本插件不使用，key 型 provider 走 keys 配置）。

### 3.3 Endpoint

`POST https://api.tavily.com/search`（`Content-Type: application/json`）。

### 3.4 Request

| 字段 | 默认 | 说明 |
|---|---|---|
| `query` | — | **必填** |
| `search_depth` | `basic` | `ultra-fast`(1 credit)/`fast`(1)/`basic`(1)/`advanced`(2) |
| `topic` | `general` | `general`/`news`/`finance` |
| `max_results` | `5` | 0–20 |
| `time_range` | — | `day`/`week`/`month`/`year` |
| `start_date`/`end_date` | — | `YYYY-MM-DD` |
| `include_domains` | — | ≤300，默认**硬过滤**；软偏好须 `include_domains_mode: "prefer"`（与 include_domains 同传否则 400） |
| `exclude_domains` | — | ≤150 |
| `country` | — | 小写英文国名（`united states`），仅 `topic=general` |
| `language` / `filter_by_language` | — / `false` | ISO 639-1；严格过滤须同传否则 400 |
| `safe_search` | `false` | `fast`/`ultra-fast` 深度不支持 |
| `include_usage` | `false` | 响应加 `usage.credits` → 喂给 budget |
| `auto_parameters` | `false` | **可能自动升 advanced → 2 credits** |

**支持的搜索参数映射**：`query→query`、`maxResults→max_results`、`language→language`、`country→country`（adapter 内 ISO 码转小写英文国名）、`timeRange→time_range`、`startDate/endDate→start_date/end_date`、`includeDomains/excludeDomains→*`、`safeSearch→safe_search`。**参数能力最全的一家。**

### 3.5 Response

顶层 `query`/`follow_up_questions`/`answer`/`images[]`/`results[]`/`response_time`（+`usage.credits`）。`results[].url/title/content/score/raw_content/published_date`。`content` 为重排 chunk，多 chunk 以 ` [...] ` 连接（2026-07 起 basic 也支持 `chunks_per_source`）。

### 3.6 Error

429（**有 `Retry-After`，按秒等待**；官方要求用状态码 + header 判断，勿匹配 message 文本）：

```json
{ "detail": { "error": "Your request has been blocked due to excessive requests. …" } }
```

参数组合非法 → 400；401/403 无 Search 专页样例（403 官方仅在 Research 端点提及 → 本插件 `classifyStatus` 对 tavily 403 默认 `UNKNOWN`，响应体含 auth 语义才 `AUTH`）；5xx 按通用 JSON。

### 3.7 Rate Limit / Free quota（抓取日期 2026-09-29，可能变化，额度是配置不是代码）

- 限流：Development **100 RPM** / Production **1,000 RPM**（需付费计划或 PAYGO），https://docs.tavily.com/documentation/rate-limits
- 免费额度：**1,000 credits/月**（Researcher 计划，免信用卡）；`basic`=1 credit、`advanced`=**2 credits**，https://docs.tavily.com/documentation/api-credits
- 用量查询 `GET https://api.tavily.com/usage`

### 3.8 Key rotation 交互

429 → Retry-After 优先冷却 + 切 key；401 → key disabled；403 → 按响应体探测分类（auth 语义 → `AUTH`，否则 `UNKNOWN` 不动 key）；额度信号 → `QUOTA_EXCEEDED` → key disabled + budget 停用；`unit: "credits"` 时 `cost()` 按 `search_depth` 报 1 或 2（`providers.tavily.options.search_depth` 决定，禁止硬编码死值）。

---

## 4. You.com

### 4.1 官方文档 URL

| 内容 | URL |
|---|---|
| 文档入口 | https://you.com/docs/ （`documentation.you.com` 301 至此） |
| Search reference | https://you.com/docs/api-reference/search/v1-search （页面加 `.md` 取纯文本） |
| OpenAPI | https://you.com/docs/openapi/web-search.json |
| 认证 | https://you.com/docs/using-the-api/authentication |
| 错误码 | https://you.com/docs/using-the-api/error-code-reference |
| 速率限制 | https://you.com/docs/rate-limits |
| 请求控制 | https://you.com/docs/guides/search/request-controls |
| 计费 | https://you.com/docs/administration/billing |

### 4.2 Authentication

**唯一正式方式：header `X-API-Key: <key>`**（约定 env 名 `YDC_API_KEY`）；**无 query 放 key 的官方写法**。免费无 key 通道是 MCP `api.you.com/mcp?profile=free`（100 queries/day），不是 REST `/v1/search`，本插件不接。

### 4.3 Endpoint

主推 `POST https://ydc-index.io/v1/search`（JSON body）；`GET /v1/search` 遗留兼容、不再接收新特性（当前 OpenAPI 只定义 POST）。错路径到 `ydc-index.io` → 403 `{"message":"Missing Authentication Token"}`。

### 4.4 Request

| 字段 | 默认 | 说明 |
|---|---|---|
| `query` | — | **必填** |
| `count` | `10` | **每分区**（web/news）上限，max 100 |
| `offset` | `0` | 0–9 |
| `freshness` | — | `day`/`week`/`month`/`year` 或 `YYYY-MM-DDtoYYYY-MM-DD` |
| `country` / `language` | — / `EN` | 枚举子集（ISO / BCP 47 子集，如 `ZH-HANS`） |
| `safesearch` | `moderate` | `off`/`moderate`/`strict` |
| `include_domains`/`exclude_domains`/`boost_domains` | — | 各 ≤500；include+exclude 同传 → **422** |
| `extraction` | — | `highlights`/`full_page`，**可能额外计费** |
| `crawl_timeout` | `10` | 1–60 秒 |
| `livecrawl`/`livecrawl_formats` | — | 已废弃 |

**支持的搜索参数映射**：`query→query`、`maxResults→count`、`language→language`、`country→country`、`timeRange→freshness`、`includeDomains/excludeDomains→include/exclude_domains`、`safeSearch→safesearch`。

**特殊能力**：`X-RateLimit-Limit/Remaining/Reset` 三头 → adapter 可做**预节流**（官方建议读头而非等 429）；402 体带 `limit/used/period/reset_at`。

### 4.5 Response

顶层 `results`（object）+ `metadata`。**没有顶层扁平 `results[]`**：

- `results.web[]`：`url`/`title`/`description`/`snippets[]`（`extraction_mode=highlights` 时省略）/`page_age`（日期字段名）/`thumbnail_url`/`favicon_url`/`contents.*`
- `results.news[]`：`title`/`description`/`page_age`（UTC 时间戳）/`url`
- `results.knowledge[]`（`knowledge:"core"`）
- `metadata.search_uuid/query/latency`

无 `date`/`position`，位置靠数组顺序；`count` 是每分区上限。

### 4.6 Error

| 状态 | 返回体 |
|---|---|
| 401 | `{"detail":"API key is required"}` / `"Invalid or expired API key"` |
| 402 | `{"detail":"Insufficient credits"}`；或 `error`/`message`/`upgrade_url`（+`limit`/`used`/`period`/`reset_at`） |
| 403 | `{"detail":"Missing required scopes"}`；或错 host 的 `{"message":"Missing Authentication Token"}` |
| 422 | `{"error":"invalid request parameter(s)"}` |
| 429 | 「Honor the Retry-After header **when present**」——429 不在 OpenAPI responses 里 |
| 500 | `{"detail":"Internal authentication error"}` 等 |

### 4.7 Rate Limit / Free quota（抓取日期 2026-09-29，可能变化，额度是配置不是代码）

- `/v1/search`：**10 requests/second**（self-serve 默认），https://you.com/docs/rate-limits
- 免费：新账号 **$100 免费额度**（一次性，免信用卡），https://you.com/docs/administration/billing
- 价格：Web Search **$5.00/1,000 calls**；`full_page` $1.00/1,000 页
- **Auto Top-Up 官方明示「No spending caps」→ 必须本地自建 spend cap**（`budget.limits`）

### 4.8 Key rotation 交互

401 → key disabled；403 scope 不足 → `AUTH` → key disabled；402 → `QUOTA_EXCEEDED` → key disabled + budget 停用；429 → Retry-After 有则优先、无则退避 → 切 key；`X-RateLimit-Remaining` 可喂 budget/预节流（adapter `usage` 上报）；5xx/超时 → 重试后切 key。you 与 serpapi 均为高优先级 fallback 层，多 key 建议按账号分槽 `{id, value}` 写法区分。

---

## 5. SerpApi（engine=google）

### 5.1 官方文档 URL

| 内容 | URL |
|---|---|
| Google Search API | https://serpapi.com/search-api |
| Pricing / 免费额度 | https://serpapi.com/pricing |
| 首页（throughput FAQ） | https://serpapi.com/ |
| 错误参考页 | **不存在**（`/errors`、`/rate-limits` 等 2026-09-29 实测 404） |

### 5.2 Authentication

**Query 参数 `api_key=<private key>`**，无 header 认证。→ key 在 URL 里：http-client 对外错误 message **必须抹除 query**（`api_key=***`），见 `docs/architecture.md` §8.3。

### 5.3 Endpoint

`GET https://serpapi.com/search?engine=google&q=QUERY&api_key=KEY`（`.json` 后缀亦可）。

### 5.4 Request

| 参数 | 默认 | 说明 |
|---|---|---|
| `q` | — | **必填** |
| `api_key` | — | **必填** |
| `engine` | `google` | 可扩展（bing/google-news…，经 `providers.serpapi.options.engine` 透传） |
| `gl` / `hl` | — | 国家码 / 语言码（`en-gb`） |
| `start` | `0` | 翻页偏移 0/10/20…；**无 `num` 参数**（当前参数表零命中） |
| `safe` | — | `active`/`off` |
| `tbm` / `tbs` | — | 搜索类型 / 高级过滤 |
| `no_cache` | `false` | 缓存命中**免费不计额度**，本地缓存可复用 |

**支持的搜索参数映射**：`query→q`、`country→gl`、`language→hl`、`safeSearch→safe`、`maxResults→无对应**（靠 `start` 翻页，adapter 按首屏裁剪）`、`timeRange→tbs` 部分映射（丢弃不支持项记 `droppedParams`）。

### 5.5 Response

顶层 `search_metadata`/`search_parameters`/`search_information`/`organic_results[]`/`pagination`/`serpapi_pagination` + 条件块（`knowledge_graph`/`ai_overview`/…）。

`organic_results[]`：`position`（1 起，作 rank）、`title`、`link`（→url）、`snippet`（**可能缺失** → content 可空）、`source`、`sitelinks…`。**`date` 是条件字段，非稳定 schema**（官方示例与实测均无）→ 解析必须容忍缺失。

### 5.6 Error

无官方错误参考页；实测信封为**单键** `{"error": "<message>"}`（401 实测：`Invalid API key. …`）。**429 返回体与 `Retry-After` 官方未公开，额度耗尽返回结构亦未公开** → 不臆造 schema，按通用退避处理。

### 5.7 Rate Limit / Free quota（抓取日期 2026-09-29，可能变化，额度是配置不是代码）

来源 https://serpapi.com/pricing ：Free **250 searches/mo、50 throughput/hr、$0**；Starter $25/mo → 1,000 次、200/hr。
**计费口径：仅成功搜索计数**；缓存命中（参数全同、1h 内）免费不计；空结果与 100 条结果同样算 1 次。无公开 `X-RateLimit-*` 头、无额度查询 API → 本地只能自建计数。

### 5.8 Key rotation 交互

401 → `AUTH` → key disabled；`countMode: "success"` 是 SerpApi 口径（失败不计数，失败请求可安全重试不烧额度）；429/额度 → 无官方信号，靠 `budget.limits`（如 `{scope:"provider", target:"serpapi", limit:250}`）+ 本地每小时窗口；5xx → 重试后切 key。key 走 query → **日志/attempt 中绝不能带完整 URL**。

---

## 6. SearXNG

### 6.1 官方文档 URL

| 内容 | URL |
|---|---|
| Search API | https://docs.searxng.org/dev/search_api.html |
| `search:` 配置（formats） | https://docs.searxng.org/admin/settings/settings_search.html |
| 搜索语法 | https://docs.searxng.org/user/search-syntax.html |
| 结果 JSON 构造（源码） | https://github.com/searxng/searxng/blob/master/searx/webutils.py |
| 路由/错误（源码） | https://github.com/searxng/searxng/blob/master/searx/webapp.py |
| 结果字段（源码） | https://github.com/searxng/searxng/blob/master/searx/result_types/_base.py |

### 6.2 Authentication

**无认证机制、无 API key**（`requiresKey: false`，`src/config.ts` `KEYLESS_PROVIDERS`）——配置里不写 `keys` 也可用，`resolveProviderKeys` 对 searxng 返回空数组仍放行。

### 6.3 Endpoint

`GET {baseUrl}/search?q=QUERY&format=json`；同时支持 `GET /`、`POST /`、`POST /search`（form-encoded）。**实例必须在 `settings.yml → search.formats` 开启 `json`，否则 403。** 默认 baseUrl `https://search.658658.xyz`（可配 `providers.searxng.baseUrl`，已实测支持 `format=json`）。

### 6.4 Request

| 参数 | 默认 | 说明 |
|---|---|---|
| `q` | — | **必填** |
| `format` | `html` | `json`/`csv`/`rss`（需实例开启；**拼错/未支持 → 静默回退 HTML 200**） |
| `categories` | 实例配置 | 逗号分隔 |
| `language` | 实例默认 | 无效码 → 400 |
| `pageno` | `1` | ≥1 整数 |
| `time_range` | — | 源码接受 `day`/`week`/`month`/`year`（**`week` 文档漏列**） |
| `safesearch` | 实例默认 | `0`/`1`/`2` |
| `engines` | — | 源码可用、文档未列 |

**支持的搜索参数映射**：`query→q`、`language→language`、`timeRange→time_range`、`safeSearch→safesearch`（bool→0/2）、`maxResults→无（按首页结果裁剪）`；`country` 不支持 → 丢弃。

### 6.5 Response

顶层 `query`/`results[]`/`answers`/`corrections`/`infoboxes`/`suggestions`/`unresponsive_engines`。

`results[]`：`url`/`title`/**`content`（不是 snippet）**/`engine`/`engines[]`/`positions[]`/`score`（融合分）/`category`/`publishedDate`（可 `null`）/`pubdate`/`parsed_url`。**无 `position`（顺序即排名）、无 `date`。**

### 6.6 Error（**两类失败必须分别处理**）

1. 格式合法但实例未启用 → **`flask.abort(403)` → HTML 页**（发生在 `index_error` 之前，**不可 JSON.parse**）→ 本插件归类 **`UNKNOWN`**（`classifyStatus`：`provider === "searxng"` 的 403 不算 `AUTH`，不动 key、不冷却，换 provider）
2. `format=json` 已启用但参数/内部错误 → **400 `{"error":"No query"}`**、**500 `{"error":"search error"}`**（JSON 信封）

旧文案 `"Search engine does not support this URL"` / `JSONNotValid` 在当前 master 源码零命中。

### 6.7 Rate Limit / Free quota（抓取日期 2026-09-29，可能变化，额度是配置不是代码）

- **官方无任何 per-client rate limit / quota 数字**（无 key 体系，无免费额度概念），https://docs.searxng.org/dev/search_api.html
- `ban_time_on_fail`/`suspended_times.*` 是**对上游引擎**的封禁时长，不是对调用方的配额
- 公开实例限流在前置 CDN（实测 `Server: cloudflare`）→ 官方未定义
- 本地保护只能自建：`{scope:"provider", target:"searxng", limit:N}` + 熔断/超时

### 6.8 Key rotation 交互

**无 key 可轮换**：`keyPool.next("searxng")` 返回 `undefined` 但 provider 仍可用（router 对 `requiresKey=false` 跳过 key 闸）。403-HTML → `UNKNOWN` → 换 provider（通常回落到其他可用 provider 或作为最终 fallback 计一次熔断失败）；限流/CDN 拦截 → `NETWORK_ERROR`/`UNKNOWN` → 熔断计数。作为 priority 99 的**最终 fallback**：全部 key 型 provider 挂掉时它仍可能出结果；**全挂（含 searxng 失败）才抛错**（`docs/routing.md`）。

---

## 7. 搜索参数支持矩阵（`SearchRequest` → 上游）

| SearchRequest | parallel | exa | tavily | you | serpapi | searxng |
|---|---|---|---|---|---|---|
| `query` | ✅ `search_queries[]` | ✅ | ✅ | ✅ | ✅ `q` | ✅ `q` |
| `maxResults` | ✅ ≤20 | ✅ ≤100 | ✅ ≤20 | ✅ 每分区 ≤100 | ❌ 无 `num` | ❌ 无（首页裁剪） |
| `language` | ❌ | ❌ | ✅ | ✅ | ✅ `hl` | ✅ |
| `country` | ✅ `location` | ✅ `userLocation` | ✅ 英文国名 | ✅ 枚举 | ✅ `gl` | ❌ |
| `timeRange` | ❌ | ❌（可用 `contents.maxAgeHours` 近似） | ✅ | ✅ `freshness` | ⚠️ `tbs` 部分 | ✅ `time_range`（含 week） |
| `startDate`/`endDate` | ⚠️ `after_date` | ✅ `start/endPublishedDate` | ✅ `start/end_date` | ⚠️ `freshness` 区间 | ❌ | ❌ |
| `includeDomains`/`excludeDomains` | ✅ `source_policy` | ✅ ≤1200 | ✅ ≤300/≤150 | ✅ ≤500（同传 422） | ❌ | ❌ |
| `safeSearch` | ❌ | ⚠️ `moderation` | ✅ | ✅ `safesearch` | ✅ `safe` | ✅ 0..2 |
| score 可用 | ❌ | ❌ | ✅ | ❌ | ❌（用 position） | ✅ |

不支持的字段由 adapter **丢弃不报错**，记入 `ProviderAttempt.droppedParams`（`src/types.ts` 注释约定）。
