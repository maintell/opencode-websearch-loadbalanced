/**
 * index.ts：OpenCode v2 插件入口（docs/architecture.md §1/§3）。
 *
 * - 注册单个 websearch provider（id="loadbalanced"），**不**注册普通 tool。
 * - 职责边界：只做「装配 + 入口」——ctx.options → config.ts 解析 → 构造内核实例
 *   （key-pool / circuit-breaker / budget / cache / http / adapters → router，全部复用
 *   现有模块，不重写）→ 注册 execute。不含路由/重试逻辑。
 * - IO / 实例构造全部在 setup() 内完成；ctx.websearch.transform 回调会被重放（replay），
 *   必须同步、廉价、无一次性副作用——回调内只有 editor.add / editor.default.set。
 * - 错误输出一律经 utils/logging.redact() 脱敏，绝不含 key 明文。
 * - ctx 无顶层 directory（路径在 ctx.location.directory）；本文件不读 ctx 路径。
 *   外置配置文件路径只来自 options（`configFile` / 默认 `~/.config/opencode/…jsonc`），在 setup 内同步读一次。
 */
import { Plugin } from "@opencode/plugin"
import { createMonthlyBudgetManager } from "./budget"
import { createCache } from "./cache"
import { createCircuitBreaker } from "./circuit-breaker"
import { loadExternalConfig, resolveConfig, resolveProviderKeys } from "./config"
import { createHttpClient } from "./http-client"
import { createKeyPool } from "./key-pool"
import { createExaAdapter } from "./providers/exa"
import { createParallelAdapter } from "./providers/parallel"
import { createSearxngAdapter } from "./providers/searxng"
import { createSerpApiAdapter } from "./providers/serpapi"
import { createTavilyAdapter } from "./providers/tavily"
import { createYouAdapter } from "./providers/you"
import { createRouter, isRouterError, type Router, type SearchProvider } from "./router"
import type {
  ProviderID,
  ResolvedConfig,
  SearchResult,
  WebSearchPluginOptions,
  WebSearchResult,
} from "./types"
import { createLogger, redact, type Logger } from "./utils/logging"

/* ============================================================
 * 装配（setup() 内调用一次；测试可直接复用）
 * ============================================================ */

/** adapter 注册表（id → 实例）；router 按 enabled 过滤后使用 */
export function buildAdapters(config: ResolvedConfig): Partial<Record<ProviderID, SearchProvider>> {
  const p = config.providers
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)
  const enginesRaw = p.searxng.options.engines
  const engines =
    typeof enginesRaw === "string" || (Array.isArray(enginesRaw) && enginesRaw.every((e) => typeof e === "string"))
      ? (enginesRaw as string | string[])
      : undefined
  return {
    parallel: createParallelAdapter({
      baseUrl: p.parallel.baseUrl,
      timeoutMs: p.parallel.timeoutMs,
      mode: str(p.parallel.options.mode),
    }),
    exa: createExaAdapter({ baseUrl: p.exa.baseUrl, timeoutMs: p.exa.timeoutMs }),
    tavily: createTavilyAdapter({ baseUrl: p.tavily.baseUrl, options: p.tavily.options }),
    you: createYouAdapter({ baseUrl: p.you.baseUrl, options: p.you.options }),
    serpapi: createSerpApiAdapter({ baseUrl: p.serpapi.baseUrl, options: p.serpapi.options }),
    searxng: createSearxngAdapter({
      baseUrl: p.searxng.baseUrl,
      timeoutMs: p.searxng.timeoutMs,
      engines,
    }),
  }
}

export interface RuntimeOptions {
  /** 默认 process.env（keys 只在 resolve 时读 env，明文不落配置） */
  env?: Record<string, string | undefined>
  /** 测试注入时钟 */
  now?: () => number
  /** 外置配置文件的 homedir（`~` 与默认路径基准）；默认 `os.homedir()`，测试可注入临时目录 */
  homeDir?: string
}

export interface Runtime {
  config: ResolvedConfig
  router: Router
  logger: Logger
  errors: string[]
  warnings: string[]
}

/** ctx.options → 全套内核实例（无网络 IO；仅外置配置文件一次同步本地读）。问题进 errors/warnings，不抛错。 */
export function createRuntime(
  options: WebSearchPluginOptions = {},
  opts: RuntimeOptions = {},
): Runtime {
  const env = opts.env ?? process.env
  // 外置 JSONC 配置文件（inline configFile / 默认路径探测）→ 与 inline 合并；一次本地 IO，放 setup 流程内
  const ext = loadExternalConfig(options, { homeDir: opts.homeDir })
  const { resolved, errors, warnings } = resolveConfig(ext.options, { env, now: opts.now })
  const logger = createLogger({ level: resolved.logging.level })
  const keys = resolveProviderKeys(resolved, env)
  const keyPool = createKeyPool({ config: resolved.keyPool, keys, now: opts.now })
  const circuitBreaker = createCircuitBreaker({ config: resolved.circuitBreaker, now: opts.now })
  const budget = createMonthlyBudgetManager({ config: resolved.budget, now: opts.now })
  const cache = createCache<SearchResult[]>(resolved.cache, opts.now ?? Date.now)
  const http = createHttpClient({ config: resolved.http })
  const router = createRouter({
    config: resolved,
    providers: buildAdapters(resolved),
    keyPool,
    circuitBreaker,
    budget,
    http,
    cache,
    now: opts.now,
  })
  return { config: resolved, router, logger, errors, warnings: [...ext.warnings, ...warnings] }
}

/* ============================================================
 * execute（ctx.websearch provider 的执行体）
 * ============================================================ */

export interface ExecuteInput {
  query: string
}

export interface ExecuteContext {
  signal: AbortSignal
}

/** SearchResult → OpenCode WebSearch.Result（剥归因字段，只留 url/title/content/time 四字段；缺省字段不落 key） */
export function toWebSearchResult(r: SearchResult): WebSearchResult {
  const out: WebSearchResult = { url: r.url, time: r.time ?? {} }
  if (r.title !== undefined) out.title = r.title
  if (r.content !== undefined) out.content = r.content
  return out
}

export interface ExecuteDeps {
  /** 真实运行传 createRuntime().router；测试注入 fake（不得 mock 冒充真实 provider 网络调用） */
  router: Pick<Router, "route">
  logger?: Logger
}

/** execute：router.route → 剥离为 WebSearch.Result[]；全挂时抛错（message 已脱敏）。 */
export function createExecute(
  deps: ExecuteDeps,
): (input: ExecuteInput, context: ExecuteContext) => Promise<readonly WebSearchResult[]> {
  return async (input, context) => {
    try {
      const resp = await deps.router.route({ query: input.query, signal: context.signal })
      return resp.results.map(toWebSearchResult)
    } catch (e) {
      const msg = redact(e instanceof Error ? e.message : String(e))
      deps.logger?.error(`websearch-loadbalanced: ${msg}`)
      // RouterError.message 构造时已过 redact；其余异常在此统一脱敏后再上抛
      if (isRouterError(e)) throw e
      throw new Error(msg)
    }
  }
}

/* ============================================================
 * 插件定义
 * ============================================================ */

export default Plugin.define({
  id: "websearch-loadbalanced",
  async setup(ctx) {
    // ① 解析配置 + 构造内核实例（一次性 IO/状态，放在 transform 之外）
    const runtime = createRuntime((ctx.options ?? {}) as WebSearchPluginOptions)
    for (const w of runtime.warnings) runtime.logger.info(`config warning: ${w}`)
    for (const e of runtime.errors) runtime.logger.error(`config error: ${e}`)
    const execute = createExecute({ router: runtime.router, logger: runtime.logger })

    // ② 注册 provider（回调同步、无副作用，可被重放）
    await ctx.websearch.transform((editor) => {
      editor.add({ id: "loadbalanced", name: "Load-Balanced Web Search", execute })
      editor.default.set("loadbalanced")
    })
    await ctx.websearch.reload()
  },
})
