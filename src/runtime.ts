/**
 * runtime.ts：内核装配层（宿主无关）。
 *
 * 这里只有「把 config 变成可用的 router」和「把 router 结果变成宿主能消费的形状」，
 * 不含任何宿主契约（zod tool / JSON Schema tool 都在各自的适配入口里）：
 *
 *   src/index.ts   OpenCode V1 —— `{ id, server }`，tool.args 为 zod raw shape
 *   src/mcode.ts   MiniMax Code / WorkBuddy —— 同一内核，tool.args 为 JSON Schema
 *
 * 拆出来的原因：OpenCode 的宿主用 zod 校验参数，MCP 宿主自己发布 JSON Schema，
 * 若 MiniMax 入口 import 本文件时经过 index.ts，打包产物会把 zod 一起带进去。
 * 内核本身对 zod 零依赖。
 */
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
 * 文本化（两个宿主一致：工具返回给模型的都是可读文本）
 * ============================================================ */

/** 把结果渲染为给模型看的可读文本。 */
export function formatSearchResults(query: string, results: readonly WebSearchResult[]): string {
  if (results.length === 0) return `No web search results for "${query}".`
  const lines = results.map((r, i) => {
    const head = r.title ? `${i + 1}. ${r.title}` : `${i + 1}. ${r.url}`
    const body = r.content ? `\n${r.content}` : ""
    return `${head}\n${r.url}${body}`
  })
  return `Web search results for "${query}" (${results.length}):\n\n${lines.join("\n\n")}`
}
