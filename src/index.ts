/**
 * index.ts：OpenCode V1 插件入口。
 *
 * V1 契约（opencode-ai 1.18.x）：
 *   export default = { id, server(input, options) => Hooks }
 *   Hooks.tool = { "<name>": { description, args: <zod raw shape>, execute(args, ctx) } }
 *
 * 背景：V1 没有 ctx.websearch provider 扩展点（那是 V2 独有）。故本插件以「普通 tool」
 * 形态交付：注册单个 tool `searchweb`，其 execute 内部复用 router 做多上游负载均衡搜索，
 * 返回可读文本。core 模块（router/key-pool/budget/cache/adapters/…）全部复用，未改写。
 *
 * 职责边界：只做「装配 + 入口」。options（V1 为 server 第二参）→ config.ts 解析 →
 * 构造内核实例 → 注册 tool。错误输出一律经 utils/logging.redact() 脱敏，绝不含 key 明文。
 */
import { z } from "zod"
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
 * 装配（server() 内调用一次；测试可直接复用）
 * ============================================================ */

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
  env?: Record<string, string | undefined>
  now?: () => number
  homeDir?: string
}

export interface Runtime {
  config: ResolvedConfig
  router: Router
  logger: Logger
  errors: string[]
  warnings: string[]
}

export function createRuntime(
  options: WebSearchPluginOptions = {},
  opts: RuntimeOptions = {},
): Runtime {
  const env = opts.env ?? process.env
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
 * execute（复用：router.route → WebSearchResult[]）
 * ============================================================ */

export interface ExecuteInput {
  query: string
}

export interface ExecuteContext {
  signal: AbortSignal
}

export function toWebSearchResult(r: SearchResult): WebSearchResult {
  const out: WebSearchResult = { url: r.url, time: r.time ?? {} }
  if (r.title !== undefined) out.title = r.title
  if (r.content !== undefined) out.content = r.content
  return out
}

export interface ExecuteDeps {
  router: Pick<Router, "route">
  logger?: Logger
}

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
      if (isRouterError(e)) throw e
      throw new Error(msg)
    }
  }
}

/* ============================================================
 * V1 tool：文本化 + tool 定义
 * ============================================================ */

/** 把结果渲染为给模型看的可读文本（V1 tool 返回 string）。 */
export function formatSearchResults(query: string, results: readonly WebSearchResult[]): string {
  if (results.length === 0) return `No web search results for "${query}".`
  const lines = results.map((r, i) => {
    const head = r.title ? `${i + 1}. ${r.title}` : `${i + 1}. ${r.url}`
    const body = r.content ? `\n${r.content}` : ""
    return `${head}\n${r.url}${body}`
  })
  return `Web search results for "${query}" (${results.length}):\n\n${lines.join("\n\n")}`
}

export interface WebSearchToolDeps {
  run: (input: ExecuteInput, context: ExecuteContext) => Promise<readonly WebSearchResult[]>
}

/** V1 tool 定义：{ description, args(zod raw shape), execute } */
export function createWebSearchTool(deps: WebSearchToolDeps) {
  return {
    description:
      "Search the web across multiple load-balanced providers (parallel/exa/tavily/you/serpapi/searxng). " +
      "Use for current information, facts, documentation, news, and URLs.",
    args: {
      query: z.string().describe("The search query."),
      maxResults: z.number().int().positive().optional().describe("Maximum number of results to return."),
    },
    async execute(args: { query: string; maxResults?: number }, context?: { signal?: AbortSignal }) {
      const signal = context?.signal ?? new AbortController().signal
      const results = await deps.run({ query: args.query }, { signal })
      const sliced = args.maxResults && args.maxResults > 0 ? results.slice(0, args.maxResults) : results
      return formatSearchResults(args.query, sliced)
    },
  }
}

/* ============================================================
 * 插件定义（V1）
 * ============================================================ */

export default {
  id: "websearch-loadbalanced",
  async server(_input: unknown, options?: WebSearchPluginOptions) {
    const runtime = createRuntime(options ?? {})
    for (const w of runtime.warnings) runtime.logger.info(`config warning: ${w}`)
    for (const e of runtime.errors) runtime.logger.error(`config error: ${e}`)
    const execute = createExecute({ router: runtime.router, logger: runtime.logger })
    return {
      tool: {
        // ponytail: name starts with "searchweb" (NOT "websearch") to avoid the built-in
        // websearch_* family; the built-in is disabled via config so this replaces it.
        searchweb: createWebSearchTool({ run: execute }),
      },
    }
  },
}
