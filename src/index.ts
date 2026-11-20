/**
 * index.ts：OpenCode V1 插件入口（宿主适配层）。
 *
 * V1 契约（opencode-ai 1.18.x）：
 *   export default = { id, server(input, options) => Hooks }
 *   Hooks.tool = { "<name>": { description, args: <zod raw shape>, execute(args, ctx) } }
 *
 * 背景：V1 没有 ctx.websearch provider 扩展点（那是 V2 独有）。故本插件以「普通 tool」
 * 形态交付：注册单个 tool `searchweb`，其 execute 内部复用 router 做多上游负载均衡搜索，
 * 返回可读文本。内核（装配 / 路由 / key 池 / 预算 / 缓存 / adapter）在 runtime.ts，未改写。
 *
 * 职责边界：只做「宿主适配」。OpenCode 用 zod raw shape 声明参数，所以 zod 只出现在
 * 这一层与 MiniMax Code 入口（mcode.ts，用 JSON Schema）无关。
 */
import { z } from "zod"
import { createExecute, createRuntime, formatSearchResults } from "./runtime"
import type { WebSearchPluginOptions, WebSearchResult } from "./types"

/* 内核在 runtime.ts；这里重导出，外部与测试的既有 import 路径保持不变。 */
export {
  buildAdapters,
  createExecute,
  createRuntime,
  formatSearchResults,
  toWebSearchResult,
} from "./runtime"
export type { ExecuteContext, ExecuteDeps, ExecuteInput, Runtime, RuntimeOptions } from "./runtime"

/* ============================================================
 * V1 tool：文本化 + tool 定义
 * ============================================================ */

export interface WebSearchToolDeps {
  run: (
    input: { query: string },
    context: { signal: AbortSignal },
  ) => Promise<readonly WebSearchResult[]>
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
