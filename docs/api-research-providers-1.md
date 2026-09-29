# 搜索 API 官方文档调研：Parallel / Exa / Tavily

- 抓取日期：**2026-09-29**
- 依据：仅官方文档与官方 OpenAPI spec（`docs.parallel.ai` / `exa.ai` / `docs.tavily.com`），不引用第三方博客。
- 说明：Mintlify 系文档站（Parallel、Tavily）单页 `.md` 常被重定向到 `llms-full.txt`，故部分字段表取自同一官方域名下的 best-practices / changelog / 官方工具 schema 页面，均已标注 URL。

---

## 1. Parallel（docs.parallel.ai）

### 1.1 官方文档 URL

| 内容 | URL |
|---|---|
| 文档索引 | https://docs.parallel.ai/llms.txt 、 https://docs.parallel.ai/llms-full.txt |
| Search API Reference | https://docs.parallel.ai/api-reference/search/search |
| Search Modes | https://docs.parallel.ai/search/modes |
| Search Quickstart（含响应示例） | https://docs.parallel.ai/search/search-quickstart |
| Best Practices（请求字段表） | https://docs.parallel.ai/search/best-practices |
| Advanced Search Settings | https://docs.parallel.ai/search/advanced-search-settings |
| Beta → V1 迁移指南 | https://docs.parallel.ai/search/search-migration-guide |
| Rate Limits | https://docs.parallel.ai/getting-started/rate-limits |
| Errors / Warnings | https://docs.parallel.ai/resources/warnings-and-errors |
| Pricing | https://docs.parallel.ai/getting-started/pricing |
| Changelog（turbo、免费额度） | https://docs.parallel.ai/changelog |

### 1.2 Endpoint

- `POST https://api.parallel.ai/v1/search`
- 旧版 `POST https://api.parallel.ai/v1beta/search` 仅用于维护既有集成；新集成一律用 `/v1`（官方明确要求，见 llms-full.txt 每页页脚说明）。

### 1.3 Authentication

- Header：`x-api-key: $PARALLEL_API_KEY`（quickstart 与迁移指南示例均为此形式）。
- 官方未在 Search 文档中给出 `Authorization: Bearer` 用法（Account API/OAuth 另用 Bearer）。

### 1.4 Request schema

来源：https://docs.parallel.ai/search/best-practices （Request Fields 表）+ https://docs.parallel.ai/search/advanced-search-settings

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `search_queries` | string[] | **必填**（V1 起） | — | 1–5 条关键词查询，每条 3–6 词、≤200 字符；超过第 5 条被丢弃并返回 input validation warning |
| `objective` | string | 可选（建议与 search_queries 同时给） | — | 自然语言研究目标，≤5000 字符 |
| `mode` | string enum | 可选 | `advanced` | `turbo` / `fast` / `basic` / `advanced` |
| `max_chars_total` | int | 可选 | 动态（取决于 queries/objective/client_model；示例 50000） | 所有结果 excerpts 的总字符上限 |
| `client_model` | string | 可选 | — | 如 `claude-opus-5`、`gpt-6-astra`，用于按模型调优输出 |
| `session_id` | string | 可选 | 服务端生成 | ≤1000 字符，响应原样回显 |
| `advanced_settings` | object | 可选 | 见下 | 见下表 |

`advanced_settings` 子字段：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `source_policy` | object | — | `include_domains` / `exclude_domains`（域名或域名/路径前缀）+ `after_date`（freshness）。`turbo` 模式不支持路径前缀。`include_domains` 是硬白名单 |
| `fetch_policy` | object | 默认用索引缓存 | 例：`{"max_age_seconds": 3600}`；开启 live fetch 显著增加延迟 |
| `excerpt_settings` | object | — | `{"max_chars_per_result": 10000}` |
| `location` | string | — | ISO 3166-1 alpha-2 国家码（`us`/`gb`/`cn`/`jp` 等，大小写不敏感，须用 `gb` 非 `uk`）；非法值被忽略并给 warning |
| `max_results` | int | `10` | >0；公开模式上限 20，超出降到 20 并 warning |

**搜索相关能力对照**：query=`objective`+`search_queries`；结果数=`max_results`；国家=`location`；时间/新鲜度=`source_policy.after_date`、`fetch_policy.max_age_seconds`（无 `time_range`）；域名 include/exclude=`source_policy.include_domains/exclude_domains`；**无语言参数、无 safe search 参数**（官方文档未提供）。

### 1.5 Search Modes（`mode` 取值）

来源：https://docs.parallel.ai/search/modes （2026-09-29 抓取）

| mode | 延迟 | 价格 | 说明 |
|---|---|---|---|
| `turbo` | ~200ms（p50） | $1/1,000 次 | **当前有效取值**（2026-07-13 上线，见 changelog "Introducing Turbo mode"）。仅支持英语与日语查询；不支持 source path 前缀 |
| `fast` | ~700ms | $1/1,000 | 官方推荐默认（对"大多数 agent"） |
| `basic` | ~1s | $5/1,000 | 每条结果返回更长 snippets，建议配 2–3 条 search_queries |
| `advanced` | ~3s | $5/1,000 | **API 默认值**；更高检索+压缩质量 |

> 明确结论：`mode: "turbo"` 是 V1 当前文档化的有效枚举值，非历史遗留。

### 1.6 Response schema

来源：https://docs.parallel.ai/search/search-quickstart （Sample Response）

```json
{
  "search_id": "search_...",
  "results": [
    {
      "url": "https://...",
      "title": "...",
      "publish_date": "2025-11-19",   // 可为 null
      "excerpts": ["..."]              // 内容正文（压缩后片段），string[]
    }
  ],
  "warnings": null,
  "usage": [{ "name": "sku_search", "count": 1 }],
  "session_id": "session_..."
}
```

- 顶层：`search_id` / `results[]` / `warnings` / `usage[]` / `session_id`。
- 结果字段确切路径：`results[].url`、`results[].title`、`results[].publish_date`、`results[].excerpts[]`。
- **无 `score` 字段**，无独立 `content` 字段（内容在 `excerpts` 内）。

### 1.7 Error 响应结构

来源：https://docs.parallel.ai/resources/warnings-and-errors

统一体：

```json
{ "error": { "message": "Human-readable error description", "detail": { } } }
```

| 状态码 | 含义 | 可重试 |
|---|---|---|
| 401 | 凭证缺失/无效 | 否 |
| 402 | 账户余额不足（含 in-flight 预留） | 否 |
| 403 | 请求中的 processor 无效/无权限 | 否 |
| 404 | 资源不存在 | 否 |
| 408 | 同步请求超时 | 是 |
| 422 | 校验失败（`detail` 给出字段级原因） | 否 |
| 429 | 限流/配额超限 | 是，指数退避 |
| 500/502/503 | 服务端错误 | 是，退避 |

- **`Retry-After`：官方 api.parallel.ai 文档未提及**；文档只要求 429 用指数退避。（`Retry-After` 仅出现在其 MPP 演示站 parallelmpp.dev 的说明中，非正式 API。）
- 该错误页原标题面向 Task API，但格式声明为"All errors return a consistent JSON structure"。

### 1.8 Rate limit / Free quota（2026-09-29）

- Search：**600 POST/min**，计数单位为每次 `POST /v1/search`；GET 类请求不计数（https://docs.parallel.ai/getting-started/rate-limits）。
- 免费额度：**每月 $5 免费 credits**（需绑定信用卡的合格组织，当月有效、不结转；changelog 2026-07-15，https://docs.parallel.ai/changelog）。
- 价格：turbo/fast $1/1k（默认 10 结果），basic/advanced $5/1k，额外结果与 excerpts 每 1,000 个 $1（https://docs.parallel.ai/getting-started/pricing）。

### 1.9 搜索响应内是否返回页面内容

**是（默认）**。`results[].excerpts` 始终返回（预压缩、面向 LLM 的正文片段），无需二次调用 Extract；需要整页 markdown 时再用 `POST /v1/extract`。

---

## 2. Exa（docs.exa.ai → exa.ai/docs）

### 2.1 官方文档 URL

| 内容 | URL |
|---|---|
| 文档索引 | https://exa.ai/docs/llms.txt |
| Search reference（含 OpenAPI） | https://exa.ai/docs/reference/search （`.md` 版：https://exa.ai/docs/reference/search.md ） |
| OpenAPI spec（schema 唯一权威源） | https://exa.ai/docs/exa-spec.yaml 、 https://exa.ai/docs/exa-spec.json |
| Error codes | https://exa.ai/docs/admin/error-codes |
| Billing and Rate Limits | https://exa.ai/docs/admin/billing |
| Pricing | https://exa.ai/docs/admin/pricing |
| Quickstart | https://exa.ai/docs/search/quickstart |

> 注意：`https://docs.exa.ai/...` 现 307 重定向到 `https://exa.ai/docs/...`（2026-09-29 实测）。

### 2.2 Endpoint

- `POST https://api.exa.ai/search`（OpenAPI `servers: https://api.exa.ai`，`operationId: search`）

### 2.3 Authentication

OpenAPI securitySchemes 同时声明两种（等价）：

- Header `x-api-key: <EXA_API_KEY>`
- Header `Authorization: Bearer <EXA_API_KEY>`

来源：https://exa.ai/docs/reference/search.md （securitySchemes）、https://exa.ai/docs/llms.txt

### 2.4 Request schema（`SearchRequest`，唯一 required：`query`）

来源：https://exa.ai/docs/reference/search.md （exa-spec.yaml 嵌入）

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string (minLength 1) | **必填** | — | 检索查询 |
| `numResults` | int 1–100 | 可选 | `10` | 公开上限 100；请求 highlights 时 >100 → 400 `INVALID_NUM_RESULTS` |
| `type` | enum | 可选 | `auto` | `instant` / `fast` / `auto` / `deep-lite` / `deep` / `deep-reasoning` |
| `category` | enum | 可选 | — | `company` / `publication` / `news` / `personal site` / `financial report` / `people`；`company`/`people` 不支持 `startPublishedDate`/`endPublishedDate`/`excludeDomains`（传了 → 400） |
| `includeDomains` | string[] ≤1200 | 可选 | — | 域名 / 域名+路径前缀 / `*.example.com` 通配子域 |
| `excludeDomains` | string[] ≤1200 | 可选 | — | 同上，反向 |
| `startPublishedDate` | ISO 8601 date-time | 可选 | — | 只返回该日期之后发布的链接 |
| `endPublishedDate` | ISO 8601 date-time | 可选 | — | 只返回该日期之前发布的链接 |
| `moderation` | bool | 可选 | `false` | 内容安全过滤 |
| `userLocation` | string (ISO 3166-1 alpha-2) | 可选 | — | 用户所在国 |
| `additionalQueries` | string[] 1–10 | 可选 | — | 仅 deep-search 类型使用 |
| `contents` | object | 可选 | — | 见下（内容选项都嵌在这里） |
| `outputSchema` | object | 可选 | — | 结构化输出（text / object，≤10 属性、≤2 层嵌套），额外约 2s 合成延迟 |
| `systemPrompt` | string | 可选 | — | 生成行为引导 |
| `stream` | bool | 可选 | `false` | 仅在提供 `outputSchema` 时走 SSE |
| `startCrawlDate` / `endCrawlDate` / `includeText` / `excludeText` / `context` | — | 已 deprecated | — | API 忽略或标记弃用（`context` → 用 `highlights`/`text`） |

`contents` 子字段（`ContentsOptions`）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `contents.text` | bool \| object | `false` | `true` 返回全文；object 可设 `maxCharacters`(1–1,000,000)、`includeHtmlTags`、`verbosity`(`compact`/`standard`/`full`，默认 `compact`)、`includeSections`/`excludeSections` |
| `contents.highlights` | bool \| object | `false` | object：`query`、`verbosity`(beta，需 `Exa-Beta: dynamic-highlights-2026-08-28` header)、`dynamic`(beta)、`maxCharacters`；`numSentences`/`highlightsPerUrl` 已弃用 |
| `contents.summary` | object | — | `{"query": ..., "schema": ...}` |
| `contents.extras` | object | 各 0 | `links` / `imageLinks` / `richImageLinks` / `richLinks` / `codeBlocks`（0–1000） |
| `contents.livecrawlTimeout` | int(ms) ≤90000 | `10000` | livecrawl 超时 |
| `contents.maxAgeHours` | int -1..720 | 未传=缓存不可用时回退抓取 | `0`=抓新内容（应用 text 渲染选项的受支持方式），`-1`=总是用缓存，`>0`=只用不超过 N 小时的缓存 |
| `contents.snapshotAsOf` | ISO date-time / date | — | 返回该时刻的历史存档版本 |
| `contents.subpages` / `subpageTarget` | int 0–100 / string\|string[] | `0` / — | 抓取结果页的子页面 |
| `contents.livecrawl` | enum `never`/`always`/`fallback`/`preferred` | 已 **deprecated** | → 用 `maxAgeHours`；不可与 `maxAgeHours` 同传 |
| `contents.context` | bool \| object | 已 deprecated | → `highlights` / `text` |

**搜索相关能力对照**：query=`query`；结果数=`numResults`；国家=`userLocation`；时间=`startPublishedDate`/`endPublishedDate` + `contents.maxAgeHours`/`snapshotAsOf`（freshness）；域名=`includeDomains`/`excludeDomains`；安全过滤=`moderation`（无独立 safe_search 参数）；语言无参数（靠 query）。

### 2.5 Response schema

`SearchResponse = SearchSynthesisResponse | SearchResultsResponse`，均含：

- `requestId`
- `results[]`（`SearchResultOutput`，**required 仅 `title`、`url`**）
- `searchTime`（毫秒，网关侧）
- `costDollars{total, search{neural, keyword}, summary, contents{text, highlights, summary}}`
- `resolvedSearchType`（deprecated）、`context`（deprecated）
- `output{content, grounding[]}` —— 仅在传 `outputSchema` 时（此分支 required `results`+`output`）

`results[]` 字段确切路径：

| 路径 | 类型 | 说明 |
|---|---|---|
| `results[].title` | string | required |
| `results[].url` | string(uri) | required |
| `results[].publishedDate` | string(date-time，实为 YYYY-MM-DD 估算) | 可为 null |
| `results[].author` | string \| null | |
| `results[].id` | string | 供 `/contents` 使用的临时 ID |
| `results[].image` / `results[].favicon` | string(uri) | |
| `results[].text` | string | 请求 `contents.text` 时返回 |
| `results[].highlights[]` / `results[].highlightScores[]` | string[] / float[] | 请求 `contents.highlights` 时返回 |
| `results[].summary` | string | 请求 `contents.summary` 时返回 |
| `results[].subpages[]` | object[] | 请求 subpages 时 |
| `results[].entities[]` | company/person/publication 实体 | category 相关 |
| `results[].extras{links, imageLinks, richImageLinks, richLinks, codeBlocks}` | | 按需 |

**注意：当前 OpenAPI 的 `SearchResultOutput` 中没有 `score` 字段**（旧版集成常见的 `results[].score` 已不在 schema 中）。

### 2.6 Error 响应结构

来源：https://exa.ai/docs/admin/error-codes 、 OpenAPI `ErrorResponse`

```json
{ "requestId": "6720...", "error": "Invalid request body | Validation error: ...", "tag": "INVALID_REQUEST_BODY" }
```

三者均 required，`additionalProperties: false`。

| 状态 | tag 示例 |
|---|---|
| 401 | `INVALID_API_KEY` |
| 402 | `NO_MORE_CREDITS` / `API_KEY_BUDGET_EXCEEDED` / `TEAM_BUDGET_EXCEEDED`（x402 场景返回 `X402_PAYMENT_REQUIRED` 挑战体） |
| 403 | `FEATURE_DISABLED` / `PROHIBITED_CONTENT` / `CONTENT_FILTER_ERROR` |
| 429 | `RATE_LIMIT_EXCEEDED`（另有 `X402_TOO_MANY_UNPAID`、`X402_WALLET_RATE_LIMITED`） |
| 503 | `SERVICE_OVERLOADED` |
| 400 | `INVALID_REQUEST_BODY` / `INVALID_REQUEST` / `INVALID_NUM_RESULTS` / `NUM_RESULTS_EXCEEDED` |

- **`Retry-After`：429 时"wait for the Retry-After header when present"**（官方 billing 页与 error-codes 页均如此表述）→ 有则必须遵守，无则指数退避。
- 503 说明：与请求速率无关，重试即可（降速无用）。
- 响应头：`x-request-id`（所有错误均带）、`x-exa-queued`、`x-exa-queue-ms`（200，标记是否在限流队列排队）。

### 2.7 Rate limit / Free quota（2026-09-29）

来源：https://exa.ai/docs/admin/billing

| Plan | 额度 | 速率 |
|---|---|---|
| Free | **每月 $10 credits**（每月 1 日重置、不累计）+ 一次性 $10 onboarding bonus | 10 QPS，50 并发 Agent runs |
| Pay as you go | 预付费 | 10 QPS（30 天内充值 ≥$1,000 → 25 QPS，有效期 90 天） |
| Enterprise | 自定义 | 自定义 |

分端点默认 QPS（团队级，跨所有 key）：

| 端点 | 限制 |
|---|---|
| `/search`（含 `/answer`、`/chat/completions`） | **10 QPS** |
| `/search` + `type` = `deep-lite`/`deep`/`deep-reasoning` | **5 QPS** |
| `/contents` | 100 QPS |
| `/agent/runs`、`/responses` | 5 QPS + 50 并发 |
| `/websets/*` | 20 QPS |

超额 → `429`（带 `Retry-After` 时按其等待）；余额耗尽/超预算 → `402`。

### 2.8 搜索响应内是否返回页面内容

**是**。通过 `contents.text`（全文）、`contents.highlights`（相关片段）、`contents.summary`（摘要）在同一次 `/search` 内返回，避免二次请求（二次请求 = `POST /contents`，用 `results[].id`）。

---

## 3. Tavily（docs.tavily.com）

### 3.1 官方文档 URL

| 内容 | URL |
|---|---|
| 文档索引 | https://docs.tavily.com/llms.txt 、 https://docs.tavily.com/llms-full.txt |
| Agents 总览（认证示例） | https://docs.tavily.com/agents |
| Search API Reference | https://docs.tavily.com/documentation/api-reference/endpoint/search |
| Rate Limits | https://docs.tavily.com/documentation/rate-limits |
| Credits & Pricing | https://docs.tavily.com/documentation/api-credits |
| Best Practices for Search（参数表） | https://docs.tavily.com/documentation/best-practices/best-practices-search |
| Changelog | https://docs.tavily.com/changelog |
| Keyless | https://docs.tavily.com/documentation/keyless |

> 限制说明：`endpoint/search` 单页与 `openapi.json` 抓取时均被重定向至 `llms-full.txt`，而 `llms-full.txt` 中该 reference 页仅有标题条目。故下方参数表以同一官方域名的 **best-practices-search**、**官方 LangChain 工具 schema（含默认值）**、**changelog** 三处交叉核对；字段名与默认值互相一致。

### 3.2 Endpoint

- `POST https://api.tavily.com/search`（`Content-Type: application/json`）

### 3.3 Authentication

- **`Authorization: Bearer tvly-YOUR_API_KEY`**（当前文档所有 curl 示例均如此，https://docs.tavily.com/agents ）。
- Keyless 路径：加 header `X-Tavily-Access-Mode: keyless`，无需 key（仅 Search/Extract）。
- 可选遥测 header：`X-Project-ID`、`X-Session-Id`、`X-Human-Id`（changelog 2026-01 / 2026-05）。
- 当前文档**未出现** `Tavily-API-Key` header（旧版写法，见 §4）。

### 3.4 Request schema

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string | **必填** | — | 检索查询 |
| `search_depth` | enum | 可选 | `basic` | `ultra-fast`(BETA,1 credit) / `fast`(BETA,1) / `basic`(1) / `advanced`(2) |
| `topic` | enum | 可选 | `general` | `general` / `news` / `finance` |
| `max_results` | int 0–20 | 可选 | `5` | 文档建议 5（聚焦）/10（研究） |
| `chunks_per_source` | int | 可选 | `3` | 官方工具 schema：1–3；每 chunk ≤500 字符；适用于 advanced/basic/fast（changelog 2026-07 起 basic 也支持） |
| `time_range` | enum | 可选 | — | `day` / `week` / `month` / `year` |
| `start_date` / `end_date` | string `YYYY-MM-DD` | 可选 | — | 绝对日期区间（changelog 2025-07） |
| `include_published_date` | bool | 可选 | `false`（`topic=news` 时自动 true） | 返回 `results[].published_date`（Beta） |
| `filter_by_published_date` | bool | 可选 | — | 严格剔除窗口外与无发布日期的结果 |
| `include_domains` | string[] ≤300 | 可选 | — | 硬过滤（默认 restrict） |
| `include_domains_mode` | enum | 可选 | `restrict` | `prefer`=软偏好（其余网络也搜）/ `restrict`=硬过滤；**须与 include_domains 同传，否则 400**（changelog 2026-08） |
| `exclude_domains` | string[] ≤150 | 可选 | — | 排除域名（含子域向下匹配） |
| `country` | string | 可选 | — | 小写英文国名（如 `united states`），**仅 `topic=general`** |
| `language` | string | 可选 | — | ISO 639-1（`en`、`zh-cn`）或英文名（`french`）；软提升（changelog 2026-08） |
| `filter_by_language` | bool | 可选 | `false` | 严格按 `language` 过滤；**须与 language 同传，否则 400** |
| `safe_search` | bool | 可选 | `false` | 全计划可用；`fast`/`ultra-fast` 深度不支持（changelog 2026-08） |
| `exact_match` | bool | 可选 | `false` | 强制匹配 query 内引号短语（changelog 2026-02） |
| `include_answer` | bool \| `basic` \| `advanced` | 可选 | `false` | LLM 短答案 |
| `include_raw_content` | bool \| `markdown` \| `text` | 可选 | `false` | 返回清洗解析后的页面正文 |
| `include_images` | bool | 可选 | `false` | 相关图片列表 |
| `include_image_descriptions` | bool | 可选 | `false` | 图片+描述 |
| `include_favicon` | bool | 可选 | `false` | 每条结果 favicon URL |
| `include_usage` | bool | 可选 | `false` | 响应加 `usage.credits` |
| `auto_parameters` | bool | 可选 | `false` | 自动调参；**可能把 search_depth 提到 advanced（2 credits）** |

**搜索相关能力对照**：结果数=`max_results`；国家=`country`（boost）+`topic`；时间=`time_range`/`start_date`/`end_date`；域名=`include_domains`/`exclude_domains`/`include_domains_mode`；安全=`safe_search`；语言=`language`/`filter_by_language`；内容包含=`include_raw_content`/`chunks_per_source`/`include_answer`。

### 3.5 Response schema

官方文档示例（https://docs.tavily.com/documentation/best-practices/best-practices-search 内 LangChain 工具输出，与 API 响应字段一致）：

```json
{
  "query": "...",
  "follow_up_questions": null,
  "answer": null,
  "images": [],
  "results": [
    {
      "url": "https://en.wikipedia.org/wiki/Wimbledon_Championships",
      "title": "Wimbledon Championships - Wikipedia",
      "content": "Due to the COVID-19 pandemic, ...",
      "score": 0.62365627198,
      "raw_content": null
    }
  ],
  "response_time": 2.3
}
```

- 顶层：`query` / `follow_up_questions` / `answer` / `images[]` / `results[]` / `response_time`（+ `include_usage=true` 时的 `usage.credits`）。
- 结果字段确切路径：`results[].url`、`results[].title`、`results[].content`、`results[].score`、`results[].raw_content`、`results[].published_date`（需 `include_published_date` 或 `topic=news`）、favicon（`include_favicon=true`）。
- `results[].content` 在 basic/fast/advanced 下为重排 chunk，多个 chunk 以 ` [...] ` 连接（changelog 2026-07）。

### 3.6 Error 响应结构

来源：https://docs.tavily.com/documentation/rate-limits

429（有 `Retry-After`）：

```http
HTTP/2 429 Too Many Requests
Content-Type: application/json
Retry-After: 60

{
  "detail": {
    "error": "Your request has been blocked due to excessive requests. Please reduce the rate of requests."
  }
}
```

- **`Retry-After`：存在，按返回秒数等待**；官方明确要求用 HTTP 状态 + header 做重试判断，不要匹配 message 文本。
- 参数组合非法（如 `include_domains_mode` 无 `include_domains`、`filter_by_language` 无 `language`）→ **400**（changelog 2026-08）。
- 401/403：官方未给出 Search 专页的 401/403 body 样例；仅明确 **Research 端点免费账号返回 403**（https://docs.tavily.com/documentation/api-reference/endpoint/research ），keyless 走不同错误格式与独立限额。生产 key 需付费计划或开启 PAYGO。
- 5xx：文档未单列体结构，按通用 JSON 处理。

### 3.7 Rate limit / Free quota / 计费（2026-09-29）

Rate limits（https://docs.tavily.com/documentation/rate-limits）：

| 环境 | Search RPM |
|---|---|
| `Development` | **100** |
| `Production` | **1,000**（需付费计划或 PAYGO） |

其他：Crawl 100/100 RPM；Research 创建 20/20 RPM；Usage 10 次/10 分钟。

Credits（https://docs.tavily.com/documentation/api-credits）：

- 免费额度：**1,000 credits/月**（Researcher 计划，免信用卡）。
- Search 计费：`basic` = **1 credit**/请求，`advanced` = **2 credits**/请求；`fast`/`ultra-fast` = 1 credit（changelog 2025-12）；`auto_parameters` 可能自动升到 advanced → 2 credits。
- 价格：PAYGO $0.008/credit；月付 $0.0075–$0.005/credit（Project $30/4,000 … Growth $500/100,000）。
- 用量查询：`GET https://api.tavily.com/usage`。

### 3.8 搜索响应内是否返回页面内容

**是**。`include_raw_content=true` 返回每条结果的清洗正文（`results[].raw_content`）；`content` 字段本身即 chunk 片段。官方同时建议"Search → Extract"两步法获取更全内容。

---

## 4. 与常见旧版认知的差异

### Parallel
1. **Endpoint**：`/v1beta/search` → **`/v1/search`**（官方要求新集成用 /v1，/v1beta 只为兼容存量）。
2. **Modes 变更**：Beta 的 `fast`/`one-shot`/`agentic`（默认 `one-shot`）→ V1 的 `turbo`/`fast`/`basic`/`advanced`，**默认变成 `advanced`**；映射：`one-shot`→`fast`（想要长摘录则用 `basic`）、`agentic`→`advanced`；`turbo` 为 V1 新增。
3. **`search_queries` 从可选变必填**（V1 起至少 1 条非空）；`objective` 变为可选（建议同时传）。
4. **字段搬家**：`max_results`、`source_policy`、`fetch_policy`、excerpt 设置全部收进 `advanced_settings`；`location` 是新增（仅 `advanced_settings.location`）；`max_chars_total` 从 `excerpts` 对象提升为**顶层**字段；`client_model` 新增。
5. **响应结构**：结果内容字段是 `excerpts[]`，**不是** `content`；无 `score`；顶层有 `search_id`/`warnings`/`usage`/`session_id`。
6. **错误体**：`{"error":{"message","detail"}}`，不是裸字符串；`Retry-After` 在 api.parallel.ai 文档中**未承诺**（只在 MPP 演示站出现）。
7. 免费额度是 **$5/月 credits**（需绑卡），不是"每日 N 次免费调用"。

### Exa
1. **文档域名**：`docs.exa.ai` → 307 → `exa.ai/docs`；schema 权威源为 `exa.ai/docs/exa-spec.yaml`。
2. **内容选项全部嵌套进 `contents.*`**：旧认知里的顶层 `text` / `highlights` / `summary` / `extras` / `livecrawl` / `livecrawlTimeout` 现在都在 `contents` 对象内。
3. **`livecrawl` 已 deprecated** → 用 `contents.maxAgeHours`（`0`=抓新、`-1`=永远缓存、`>0`=N 小时内缓存），且两者不可同传；`crawledBeforeDate` → `snapshotAsOf`；`context` → `highlights`/`text`；`includeText`/`excludeText` 已弃用。
4. **`type` 取值扩容**：`auto`（默认）/`fast`/`instant`/`deep-lite`/`deep`/`deep-reasoning`——旧的"neural/keyword"不是 type，而是 `costDollars.search` 里的成本分项。
5. **响应里没有 `results[].score`**（当前 `SearchResultOutput` required 仅 `title`、`url`）；`publishedDate` 是解析估算、格式声明为 date-time 但值为 `YYYY-MM-DD`。
6. **错误信封统一为 `{requestId, error, tag}`**，402 表示余额/预算耗尽（不只是支付协议）；429 有 `Retry-After` 时必须遵守。
7. **认证两可**：`x-api-key` 与 `Authorization: Bearer` 都被官方支持（早期文档只写 `x-api-key`）。
8. `numResults` 上限 100；请求 highlights 时 >100 直接 400。

### Tavily
1. **认证以 `Authorization: Bearer tvly-...` 为准**（当前文档所有示例）；旧资料常见的 `Tavily-API-Key: <key>` header 已不在现行文档中出现。另有 keyless：`X-Tavily-Access-Mode: keyless`。
2. **`search_depth` 新增 `fast` 与 `ultra-fast`（BETA，各 1 credit）**；`topic` 新增 `finance`。
3. **新增参数**（旧集成多半没有）：`include_domains_mode`（2026-08，`prefer`/`restrict`）、`safe_search`（2026-08，全计划）、`language`+`filter_by_language`（2026-08）、`exact_match`（2026-02）、`include_published_date`/`filter_by_published_date`、`include_usage`（2025-12）、`start_date`/`end_date`（2025-07）、`include_favicon`（2025-06）、`auto_parameters`（2025-06）。
4. **`search_depth=basic` 行为变化**（2026-07）：从"每源单段摘要"变为"重排 chunk"，`results[].content` 可能含 ` [...] ` 连接的多段；`chunks_per_source` 现也适用于 basic。
5. **`include_domains` 默认是硬过滤**，想要软偏好必须显式 `include_domains_mode="prefer"`（新语义，避免"空结果"坑）。
6. **Rate limit 是环境二分**：Development 100 RPM / Production 1,000 RPM（Production key 需付费计划或 PAYGO），不是单一全局值；429 带 `Retry-After`，错误体是 FastAPI 风格 `{"detail":{"error":...}}`。
7. **免费额度口径**：1,000 credits/月，不是 1,000 次/月——advanced 一次扣 2 credits。
8. `max_results` 默认 **5**、上限 20（旧资料常见"默认 5"仍正确，但"上限 20"需以工具 schema 为准）。

---

## 5. 三家横向速查（2026-09-29）

| 维度 | Parallel | Exa | Tavily |
|---|---|---|---|
| Endpoint | `POST /v1/search` @api.parallel.ai | `POST /search` @api.exa.ai | `POST /search` @api.tavily.com |
| 认证 | `x-api-key` | `x-api-key` 或 `Bearer` | `Authorization: Bearer tvly-...` |
| 查询字段 | `objective` + `search_queries`(必填) | `query`(必填) | `query`(必填) |
| 模式/深度 | `mode`: turbo/fast/basic/advanced（默认 advanced） | `type`: instant/fast/auto/deep-lite/deep/deep-reasoning（默认 auto） | `search_depth`: ultra-fast/fast/basic/advanced（默认 basic） |
| 结果数 | `advanced_settings.max_results`（默认 10，上限 20） | `numResults`（默认 10，上限 100） | `max_results`（默认 5，上限 20） |
| 时间过滤 | `source_policy.after_date` / `fetch_policy.max_age_seconds` | `startPublishedDate`/`endPublishedDate` | `time_range` / `start_date` / `end_date` |
| 域名过滤 | `source_policy.include/exclude_domains`（硬白名单） | `includeDomains`/`excludeDomains`（≤1200） | `include_domains`（≤300，可用 `prefer` 软化）/ `exclude_domains`（≤150） |
| 国家 | `advanced_settings.location`（ISO 码） | `userLocation`（ISO 码） | `country`（小写英文国名，仅 topic=general） |
| 语言 | 无参数 | 无参数 | `language` + `filter_by_language` |
| Safe search | 无（文档未提供） | `moderation` | `safe_search` |
| 响应内容字段 | `results[].excerpts[]`（默认返回） | `results[].text/highlights/summary`（按需 `contents.*`） | `results[].content`（默认）+ `raw_content`（按需） |
| 结果打分 | 无 | 无（`score` 已不在 schema） | `results[].score` |
| 错误体 | `{"error":{message,detail}}` | `{"requestId","error","tag"}` | `{"detail":{"error":...}}`（429 示例） |
| 429 Retry-After | 未承诺（要求指数退避） | 有则遵守 | 有则遵守 |
| 限流 | 600 POST/min（Search） | 10 QPS（deep 类 5 QPS） | Dev 100 RPM / Prod 1,000 RPM |
| 免费额度 | $5 credits/月（需绑卡） | $10 credits/月 + 一次性 $10 | 1,000 credits/月 |
