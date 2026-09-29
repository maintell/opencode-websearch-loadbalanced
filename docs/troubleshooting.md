# 故障排查

> 配置项一律以 `src/config.ts` 为准（见 `docs/configuration.md`）；错误分类见 `src/utils/errors.ts`、`docs/routing.md` §4。
> **铁律：日志与工具输出绝不含 key**——脱敏在序列化层（`src/utils/logging.ts` `redact()`），不靠日志级别开关；`logging.level=debug` 也不打印 secret。本文所有示例均已脱敏。

## 0. 先开 debug 日志

配置通道是 `opencode.jsonc → plugins[].options`（**没有 yaml**）：

```jsonc
"options": { "logging": { "level": "debug" } }   // silent | error | info | debug，默认 info
```

日志行构造（`formatLogLine`）：JSON 一行，字段**白名单** `level` / `msg` / `provider` / `keyId` / `status` / `latencyMs`，白名单外一律丢弃（debug 也不放过）；`msg` 与字符串字段全部过 `redact()`（已登记 secret、`tvly-…`/`sk-…`/`AIza…` 模式、`api_key=…` query、`Bearer …`、32+ 位 hex 全部替换成 `***`）。默认 writer 是 `process.stdout.write`；插件 stdout 是否进 `opencode.log` 官方未文档化（不确定项，见 `docs/api-research-opencode.md` §5.3）。

典型行（脱敏）：

```json
{"level":"info","msg":"attempt","provider":"exa","keyId":"exa:9f3a7c21","status":429,"latencyMs":132}
```

诊断辅助：`ProviderAttempt[]`（每 provider 一条 `outcome` + `skippedReason` + `error.code` + `httpStatus`）比日志更完整，优先看它。

## 1. 429 Too Many Requests

**现象**：`error.code = "RATE_LIMIT"`，`keyId` 进入 cooldown。

| 上游 | Retry-After | 依据 |
|---|---|---|
| exa / tavily | **有则遵守**（官方承诺） | https://exa.ai/docs/admin/billing 、 https://docs.tavily.com/documentation/rate-limits |
| you | when present（且 429 不在 OpenAPI 内） | https://you.com/docs/rate-limits |
| parallel | **未承诺**（只要求指数退避） | https://docs.parallel.ai/resources/warnings-and-errors |
| serpapi | 官方未公开 429 结构 | https://serpapi.com/pricing |
| searxng | 无（限流在 CDN 层） | https://docs.searxng.org/dev/search_api.html |

排查与处置：
1. 冷却时长 = `Retry-After` 优先，否则 `keyPool.baseCooldownMs·2^consecutiveErrors` 封顶 `maxCooldownMs`（默认 5000…300000）→ 大量 429 时调低请求速率或增大 `baseCooldownMs`（不建议），或多配 key
2. 冷却中的 key 自动跳过，round-robin 换下一个 active key；**全部 cooldown → `skipped(no_active_key)` 换 provider**（不是错误）
3. key 健康度看 `keyPool` 状态（`states()` 输出只含 keyId，无 secret）
4. 上游限流值本身是配置不是代码：Parallel 600 POST/min、Exa 10 QPS、Tavily Dev 100 RPM、You 10 RPS、SerpApi 50/hr（Free）——见 `docs/providers.md`

## 2. 401 / 403（key 失效）

**现象**：`error.code = "AUTH"`，该 key → `disabled`，`disabledReason = "auth_401_403"`。

- **disabled 不自动恢复**：只有**配置重载**（`reload(keys)`，改配置后重启/重载插件）才回到 active。进程重启也会重置
- 排查顺序：
  1. env 是否设对名字（`keys` 里写的 env 名 vs 实际变量名，如 `EXA_API_KEY`）
  2. key 是否被吊销 / scope 不足（You 403 = `Missing required scopes`，https://you.com/docs/using-the-api/error-code-reference ）
  3. 认证方式是否对（Exa 双可用；Tavily 必须 `Bearer tvly-…`；You 只有 `X-API-Key`；SerpApi 走 query `api_key`；Parallel `x-api-key`）→ 见 `docs/providers.md`
- **403 必须分 provider 看**：
  - key 型（parallel/exa/you/serpapi/tavily）→ `AUTH`，禁 key
  - **tavily 403** 默认按响应体探测：含 auth 语义才 `AUTH`，否则 `UNKNOWN`
  - **searxng 403 → `UNKNOWN`**，与 key 无关（见 §4）

## 3. 5xx / 网络错误 / 超时

**现象**：`SERVER_ERROR` / `NETWORK_ERROR` / `TIMEOUT`，`keyPool.providerErrors` 上升。

处置链（`docs/routing.md` §4）：
1. 同一 key 重试 `http.retriesPerKey`（默认 2）次，退避 `retryBackoffMs`（400）指数增长、封顶 `maxRetryBackoffMs`（8000）
2. 仍失败 → 切同 provider 下一个 key（key 本身不冷却不禁用）
3. 全 key 轮过且 provider 级连续计数 ≥ `keyPool.errorThreshold`（3）→ `cb.onFailure` 计一次熔断失败
4. 连续 `circuitBreaker.failureThreshold`（3）次 → 熔断 OPEN（见 §5）

排查：单次 `latencyMs` 接近 `http.timeoutMs`（8000）→ 超时，调大 `providers.<id>.timeoutMs`；大面积 503（如 Exa `SERVICE_OVERLOADED`）→ 上游故障，等 OPEN→HALF_OPEN 自动探测恢复。

## 4. SearXNG 403（实例禁用了 json 格式）

**现象**：HTTP **403 + HTML body**（不是 JSON），`error.code = "UNKNOWN"`。

原因（官方文档原文）：「Requesting an unset format will return a 403 Forbidden error. Be aware that many public instances have these formats disabled.」实例须在 `settings.yml → search.formats` 启用 `json`（https://docs.searxng.org/admin/settings/settings_search.html ）。403 由 `flask.abort` 产生，**发生在 JSON 错误分支之前 → 不可 JSON.parse**。

排查：
1. `curl '{baseUrl}/search?q=test&format=json'` 看是否 200 + `application/json`
2. 403 → 换实例：改 `providers.searxng.baseUrl`（默认 `https://search.658658.xyz` 已实测支持 json）
3. 注意：**`format` 拼错（不在 `html/csv/json/rss` 内）不报错，静默回退 HTML 200**——只有「合法但被禁用」才 403
4. 400/500 才是 JSON 信封 `{"error": "…"}`（缺 q、非法参数、内部错误）
5. 403-HTML 归类 `UNKNOWN` → **不动 key、不冷却**，直接换 provider；searxng 是最终 fallback，它挂了且其余全挂才抛错

## 5. 熔断 OPEN

**现象**：`ProviderAttempt.skippedReason = "circuit_open"`，`view()` 显示 `state: "OPEN"`。

| 状态 | 含义 | 处置 |
|---|---|---|
| `CLOSED` | 正常 | — |
| `OPEN` | 连续 `failureThreshold`（3）次 5xx/网络/超时；**探测期外的请求直接 skip** | 等 `openMs`（30000）到点，`canPass` 惰性转 HALF_OPEN；或确认上游恢复后 `reset(provider)` |
| `HALF_OPEN` | 放行 ≤ `halfOpenMaxCalls`（1）探测；连续 `successThreshold`（2）成功 → CLOSED，任一失败 → 立即重开 | 半开期请求变慢属正常 |

要点：
- **`AUTH`/`RATE_LIMIT`/`QUOTA_EXCEEDED` 不计入熔断**（`countsTowardCircuit` 只含 5xx/网络/超时）→ 若 OPEN，说明是上游服务端问题，不是 key 配额问题
- key 全部 disabled/cooldown ≠ 熔断：前者 `skipped(no_active_key)`，后者 `skipped(circuit_open)`
- 排查根因看 `attempts[].error.httpStatus` 分布

## 6. 「无可用 key / env 未设置」

**现象**：启动 warning（不失败）：

```
providers.exa 环境变量 EXA_API_KEY 未设置（key 不可用）
providers.exa 无可用 key（env 缺失或未配置），标记为不可用
```

规则（`src/config.ts`）：
- env 缺失 → **该 key 不可用**，其余 key 照常；**全部缺失 → 该 provider `enabled=false`**，插件与其余 provider 正常启动（**不会启动失败**）
- searxng 是唯一无 key 也启用的 provider
- `keysInline` 明文写法可用但会 warning（不推荐）；日志仍只显示 keyId
- 配置里 provider 名拼错 → error：`providers 未知 provider "exa2"（合法值：parallel, exa, tavily, you, serpapi, searxng）`
- 自检：把 `logging.level` 调 `info`，看 warnings[] 是否出现；确认 env 在**OpenCode server 进程**环境中（插件跑在 server 子进程，TUI shell 里 export 不一定可见）

## 7. 额度耗尽（budget exhausted）

**现象**：`skippedReason = "budget_exhausted"`；或上游 402 → `QUOTA_EXCEEDED` → key `disabled`（`quota_exceeded`）。

排查：
1. `budget.enabled` 是否为 true（默认 true）；`limits` 是否配了该 `scope:target`（**没配 = 不受闸**，耗尽只可能来自上游 402 → `markExhausted`）
2. 周期是**本地时区 `YYYY-MM`**，跨月首次 `check/record` 自动重置——「上月没恢复」通常是时区/进程时钟问题
3. `used >= limit` 即停：看 `entries()` 输出（`{scope, target, period, limit, used, unit}`）
4. `countMode` 只在 `budget.record` 内生效；**router 只在成功后记一次**（失败不调 record），故 `attempt`/`success` 两口径当前实际等价
5. `unit=credits` 记账量来自 router：**tavily 取上游 `usage.credits`**（`search_depth=advanced` 一次 2），其余 provider 恒 1；`auto_parameters` 可能自动升 advanced → 消耗翻倍
6. 上游信号：You 402 体带 `limit/used/period/reset_at`；Exa 402 tag `NO_MORE_CREDITS`；Tavily `include_usage=true` 返回 `usage.credits`
7. 临时放行：调大 limit 或 `budget.enabled=false`（改配置后重载）

## 8. 常见错误速查表

| 症状 | code / reason | 根因 | 处置 |
|---|---|---|---|
| 全部 provider skip、最终抛错 | attempts 无 `ok` | key/env/熔断/额度同时不可用 | 按 §6/§5/§7 逐项查；确认 `searxng` 是否启用作兜底 |
| 结果为空但不报错 | `outcome=empty` | 查询无命中（正常返回） | 换 query；检查 `includeDomains` 硬过滤 |
| 字段没生效（如 language） | `droppedParams` | 该 provider 不支持（parallel/exa 无 language） | 见 `docs/providers.md` §7 矩阵 |
| 400/422 | `BAD_REQUEST` | 参数组合非法（Tavily `include_domains_mode` 无 `include_domains`、You include+exclude 同传） | **不重试**，修配置/参数 |
| SerpApi 结果条数不够 | — | 无 `num` 参数，靠 `start` 翻页 | 首屏裁剪；需要更多用 `start` |
| 日志里看到疑似泄漏 | — | — | **不应发生**：`redact()` + 字段白名单双保险；发现即当 bug 报 |

## 9. 安全提醒

- **任何输出（日志、error.message、attempts、SearchResponse）只允许 keyId**（`<provider>:<sha256 前 8 hex>`），发现明文 key 立即按安全事件处理并轮换该 key
- SerpApi key 在 URL query → 对外错误 message 必须抹除 query（`api_key=***`）；排查时也不要直接贴完整请求 URL
- 脱敏不依赖日志级别：调低到 `info`/`error` 不会「更安全」，调到 `debug` 也不会泄露 secret
