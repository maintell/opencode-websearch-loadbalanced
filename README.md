# opencode-websearch-loadbalanced

OpenCode **V1** 插件：把 6 家搜索上游（`parallel` / `exa` / `tavily` / `you` / `serpapi` / `searxng`）聚合为一个**负载均衡的 `searchweb` 工具**——优先级路由、多 key 池、熔断、月度预算闸、TTL+LRU 缓存。

> 单次调用内按优先级逐 provider 派发，**首个非空成功即短路**；跨 provider 去重排序后返回可读文本。任一上游抖动都不会让整次搜索失败。

---

## 特性

- **多 provider 负载均衡** — `priority` / `round_robin` 两种策略，每 provider 可配优先级。
- **多 key 池** — 每 provider 多 key 轮询；429 冷却（尊重 `Retry-After`）、401/403 禁用该 key。
- **熔断器** — 每 provider `CLOSED` / `OPEN` / `HALF_OPEN`（只计 5xx / 网络 / 超时）。
- **月度预算闸** — `provider` / `key` 双 scope，`YYYY-MM` 周期，额度**零硬编码**（只来自配置）。
- **结果缓存** — provider 级 TTL + LRU；命中不打上游、不耗预算。
- **密钥零泄漏** — 配置只写 `${ENV_VAR}` 引用；日志 / 错误 / 响应一律脱敏为 `keyId`（sha256 前 8 位），`debug` 级也不打印明文。

## 要求

- OpenCode **V1**（`opencode-ai` 1.18.x，插件契约 `{ id, server }`）。
  - V1 **没有** `ctx.websearch` provider 扩展点（那是 V2 独有），故本插件以**普通 tool** 形态交付。
- Node 20+（或 Bun）；构建产物是自包含 ESM 单文件。

## 安装

```bash
npm install
npm run build      # → dist/index.js
```

1. 把 `dist/index.js` 放到 `~/.config/opencode/plugin/websearch-loadbalanced/index.js`，同目录放一个 `package.json`：`{"type":"module"}`。
2. 在 `~/.config/opencode/opencode.jsonc` 的 `plugin` 数组登记：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugin/websearch-loadbalanced/index.js"]
}
```

3. 配置放外置 JSONC 文件（默认 `~/.config/opencode/websearch-loadbalanced.jsonc`，见下）。

### 替代内置 web search（可选）

内置 web search 是 `oh-my-opencode-slim` 插件注入的 `websearch` MCP。要让它被本插件取代：

```jsonc
// ~/.config/opencode/oh-my-opencode-slim.jsonc
{ "disabled_mcps": ["websearch"] }

// ~/.config/opencode/opencode.jsonc
{ "tools": { "websearch": false } }
```

> ⚠️ 工具名**不能**叫 `websearch`——会与内置 `websearch_*` 工具族冲突并被**静默丢弃**（已实测）。本插件注册为 `searchweb`。

## 使用

插件向模型注册一个工具：

```
searchweb(query: string, maxResults?: number) → string
```

模型在需要外部 / 实时信息时调用它，返回可读文本：

```
Web search results for "<query>" (N):

1. <title>
<url>
<snippet>

2. ...
```

## 架构

```
src/index.ts            { id, server }：装配 + tool execute 入口（formatSearchResults → string）
src/config.ts           options → ResolvedConfig（默认值 / ${ENV} 展开 / 校验 / key 脱敏）
src/router.ts           候选过滤 → 策略排序 → 逐派发 → 错误分类（切 key / 切 provider / 放弃）
src/key-pool.ts         每 provider 的 key 状态：round-robin、429 冷却、401/403 禁用
src/circuit-breaker.ts  每 provider CLOSED/OPEN/HALF_OPEN（只计 5xx/网络/超时）
src/budget.ts           月度预算闸（YYYY-MM，provider/key 双 scope，额度零硬编码）
src/cache.ts            provider 级结果缓存（TTL + LRU；命中不消耗预算、不打上游）
src/http-client.ts      fetch 封装（超时 / Retry-After / latency；不重试）
src/providers/*         parallel / exa / tavily / you / serpapi / searxng 协议适配
src/utils/*             redact 日志脱敏、错误分类表、URL 规范化去重
```

请求流：`execute({query})` → `router.route()` →（cache → budget → 熔断 → key 池）逐 provider 派发
→ 首个非空成功短路 → `rankAndDedupe` 跨 provider 排序去重 → 剥离为文本。全部 provider 失败才抛
`RouterError`（message 经 `redact()` 脱敏）。

## 配置

**主配置走外置 JSONC 文件**：默认路径 `~/.config/opencode/websearch-loadbalanced.jsonc`
（也可用 `options.configFile` 指定其他路径）。文件不存在 → 静默走 inline options；解析失败 → warning 回退。
合并规则：文件为 base，inline options **顶层键整体覆盖**（不做深合并）。
key 一律走 `${ENV_VAR}` 环境变量名，明文不进配置、不进 git。

```jsonc
// ~/.config/opencode/websearch-loadbalanced.jsonc
{
  "providers": {
    "parallel": { "enabled": true, "priority": 10, "keys": ["PARALLEL_API_KEY"],
                  "options": { "mode": "fast" } },
    "exa":      { "enabled": true, "priority": 20, "keys": ["EXA_API_KEY"] },
    "tavily":   { "enabled": true, "priority": 30, "keys": ["TAVILY_API_KEY"],
                  "options": { "search_depth": "basic" } },
    "you":      { "enabled": true, "priority": 40, "keys": ["YDC_API_KEY"] },
    "serpapi":  { "enabled": true, "priority": 50, "keys": ["SERPAPI_API_KEY"] },
    "searxng":  { "enabled": true, "priority": 99 }   // 无 key，最终 fallback
  },
  "routing":        { "strategy": "priority", "maxProviderAttempts": 6 },
  "http":           { "timeoutMs": 8000, "retriesPerKey": 2,
                      "retryBackoffMs": 400, "maxRetryBackoffMs": 8000 },
  "cache":          { "ttlMs": 300000, "maxEntries": 256 },
  "circuitBreaker": { "failureThreshold": 3, "openMs": 30000,
                      "halfOpenMaxCalls": 1, "successThreshold": 2 },
  "keyPool":        { "errorThreshold": 3, "baseCooldownMs": 5000, "maxCooldownMs": 300000 },
  "budget":         { "enabled": true, "unit": "requests", "countMode": "attempt",
                      "limits": [
                        { "scope": "provider", "target": "serpapi", "limit": 250 },
                        { "scope": "key", "target": "exa:9f3a7c21", "limit": 10000 }
                      ] },
  "logging":        { "level": "info" }   // silent | error | info | debug
}
```

### `budget.unit` 取值

| 值 | 归一行为 |
|---|---|
| `requests` | 每次成功调用计 1（默认） |
| `credits` | 按 adapter 上报的 usage/units 加权 |
| `credit` | 别名 → `credits` |
| `usd` | 别名 → `credits`（数值按 provider 计费单位，USD 换算表暂不做） |
| `unlimited` | 等价未设 limit：丢弃 `budget.limits`，沿用现有无 limit 行为 |
| 其他 | 非法 → 回退 `requests` + warning |

### 环境变量（keys）

`keys` 只写环境变量名，支持三种等价写法：`"EXA_API_KEY"` / `"${EXA_API_KEY}"` / `{ "id": "primary", "value": "${EXA_API_KEY}" }`。

| provider | env | 说明 |
|---|---|---|
| parallel | `PARALLEL_API_KEY`（可加 `_2` 等多 key） | |
| exa | `EXA_API_KEY` | |
| tavily | `TAVILY_API_KEY` | |
| you | `YDC_API_KEY` | |
| serpapi | `SERPAPI_API_KEY` | |
| searxng | 无 | 无 key，最终 fallback |

env 缺失 → 该 key/provider 标记不可用（warning + `enabled=false`），**不抛错**。

## 开发 / 测试

| script | 命令 | 说明 |
|---|---|---|
| `test` | `vitest run` | 单元测试（`tests/**/*.test.ts`，排除 `tests/integration/`），零网络 |
| `test:providers` | `vitest run tests/integration` | provider 真实网络冒烟（双重门禁，默认不跑） |
| `typecheck` | `tsc --noEmit` | 类型检查 |
| `lint` | `tsc --noEmit` | 占位（暂无 eslint 配置） |
| `build` | `esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js` | 打包为自包含 ESM 单文件（bundled zod，`node:` 内置外部化） |

```bash
npm install
npm run typecheck
npm test
npm run build
```

集成测试**双重门禁**：目录默认被 `vitest.config.ts` 排除；且每个文件要求 `RUN_INTEGRATION_TESTS=1`。
key 缺失或网络失败 → `skip` 不 `fail`（用 `*_API_KEY_TEST` 变量与运行时 key 隔离，避免误耗额度）。

```bash
# Windows/pwsh
$env:RUN_INTEGRATION_TESTS='1'; $env:EXA_API_KEY_TEST='...'; npm run test:providers
```

> 说明：仓库 `docs/*.md` 记录的是本项目早期 V2 provider 设计的调研/设计，尚未同步到 V1 形态；**本 README 为准**。

## License

MIT
