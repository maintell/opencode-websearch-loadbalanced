# opencode-websearch-loadbalanced

OpenCode v2 插件：多 provider 负载均衡 websearch（优先级路由 / key 池 / 预算闸 / 熔断）。

## 架构

通过官方 `ctx.websearch.transform` 注册**单个** provider（`id: "loadbalanced"`），在
`setup(ctx)` 内把 `ctx.options` 解析为 `ResolvedConfig` 并构造全套内核实例（闭包持有），
**不**为 6 个上游各注册一个 provider，也**不**注册普通 tool（见 `docs/architecture.md` §1）。

```
src/index.ts     Plugin.define({ id, setup })：装配 + execute 入口 + 剥离为 WebSearch.Result[]
src/config.ts    ctx.options → ResolvedConfig（默认值 / ${ENV} 展开 / 校验 / key 脱敏）
src/router.ts    候选过滤 → 策略排序 → 逐派发 → 错误分类（切 key / 切 provider / 放弃）
src/key-pool.ts    每 provider 的 key 状态：round-robin、429 冷却、401/403 禁用
src/circuit-breaker.ts  每 provider CLOSED/OPEN/HALF_OPEN（只计 5xx/网络/超时）
src/budget.ts    月度预算闸（YYYY-MM，provider/key 双 scope，额度零硬编码）
src/cache.ts     provider 级结果缓存（TTL + LRU；命中不消耗预算、不打上游）
src/http-client.ts  fetch 封装（超时 / Retry-After / latency；不重试）
src/providers/*  parallel / exa / tavily / you / serpapi / searxng 协议适配
src/utils/*      redact 日志脱敏、错误分类表、URL 规范化去重
```

请求流：`execute({query},{signal})` → `router.route()` →（cache → budget → 熔断 → key 池）
逐 provider 派发 → 首个非空成功短路 → `rankAndDedupe` 跨 provider 排序去重 →
`toWebSearchResult()` 剥离为 `{url,title,content,time}` 四字段。全挂才抛 `RouterError`
（message 经 `redact()` 脱敏）。

## 配置

唯一生效通道是 `opencode.jsonc` 的 `plugins[]` 条目 `{ package, options }`，
`options` 在 `setup(ctx)` 内经 `ctx.options` 读取（**不存在 yaml**）。
`examples/websearch.yaml` 是同结构的可读模板（**模板，非生效配置**）。
key 一律走 `${ENV_VAR}` 环境变量名，明文不进配置、不进 git。

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "websearch": { "provider": "loadbalanced" },   // 选中本插件注册的 provider
  "plugins": [
    {
      "package": "opencode-websearch-loadbalanced",  // 或本地路径 ./.opencode/plugins/websearch-loadbalanced
      "options": {                                    // → ctx.options
        "providers": {
          "exa":     { "enabled": true, "priority": 20, "keys": ["EXA_API_KEY"] },
          "tavily":  { "enabled": true, "priority": 30, "keys": ["TAVILY_API_KEY"] },
          "searxng": { "enabled": true, "priority": 99 }   // 无 key，最终 fallback
        },
        "routing":  { "strategy": "priority", "maxProviderAttempts": 6 },
        "http":     { "timeoutMs": 8000, "retriesPerKey": 2 },
        "budget":   {
          "enabled": true,
          "unit": "requests",            // requests | credits | credit | usd | unlimited（别名见下）
          "countMode": "attempt",
          "limits": [ { "scope": "provider", "target": "serpapi", "limit": 250 } ]
        },
        "logging":  { "level": "info" }
      }
    }
  ]
}
```

### `budget.unit` 取值

| 值 | 归一行为 |
|---|---|
| `requests` | 每次成功调用计 1（默认） |
| `credits` | 按 adapter 上报的 usage/units 加权 |
| `credit` | 别名 → `credits` |
| `usd` | 别名 → `credits`（`ponytail:` 数值按 provider 计费单位，USD 换算表暂不做） |
| `unlimited` | 等价未设 limit：丢弃 `budget.limits`，沿用现有无 limit 行为 |
| 其他 | 非法 → 回退 `requests` + warning |

### 环境变量（keys）

`keys` 只写环境变量名（`"EXA_API_KEY"` / `"${EXA_API_KEY}"` / `{id, value}` 三种等价写法），
解析时读 `process.env`：

| provider | env | 说明 |
|---|---|---|
| parallel | `PARALLEL_API_KEY`（可加 `_2` 等多 key） | |
| exa | `EXA_API_KEY` | |
| tavily | `TAVILY_API_KEY` | |
| you | `YDC_API_KEY` | |
| serpapi | `SERPAPI_API_KEY` | |
| searxng | 无 | 无 key，最终 fallback |

env 缺失 → 该 key/provider 标记不可用（warning + `enabled=false`），**不抛错**。
日志 / attempt / 响应里只有 `keyId`（sha256 前 8 位），`logging.level=debug` 也绝不打印明文。

## 脚手架说明（scripts 语义）

| script | 命令 | 说明 |
|---|---|---|
| `test` | `vitest run` | 跑 `tests/**/*.test.ts`（排除 `tests/integration/`），零网络 |
| `test:providers` | `vitest run tests/integration` | provider 真实网络冒烟，见下方门禁 |
| `typecheck` | `tsc --noEmit` | 类型检查 |
| `lint` | `tsc --noEmit` | **占位**：仓库暂无 eslint 配置，先用 typecheck 顶替；引入 eslint 后替换此行 |
| `build` | `tsc --noEmit` | `ponytail:` OpenCode v2 用 Bun 直接加载 `src/index.ts`（`exports` 直指 TS 源），**不需要编译产物**；此脚本仅作编译期校验。若将来要发 npm CJS/ESM 包，再换成 `tsc -p tsconfig.build.json` 出 `dist/` |

### 集成测试门禁（`tests/integration/`）

真实外呼测试**双重门禁**，默认完全不跑：

1. 目录被 `vitest.config.ts` 排除，只有 `npm run test:providers`（argv 含 `integration`）才纳入；
2. 每个文件要求 `RUN_INTEGRATION_TESTS=1`，否则整体 skip。

```bash
# Windows/pwsh
$env:RUN_INTEGRATION_TESTS='1'; $env:EXA_API_KEY_TEST='...'; npm run test:providers
```

key 缺失或网络失败 → `skip` 不 `fail`（各文件用 `*_API_KEY_TEST` 变量，与运行时配置的
`EXA_API_KEY` 等隔离，避免误耗额度）。

## 开发

```bash
npm install
npm run typecheck
npm test
```
