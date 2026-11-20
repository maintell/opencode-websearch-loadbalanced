/**
 * mcode.ts：MiniMax Code / WorkBuddy 本地 Plugin 入口（MCP 宿主适配层）。
 *
 * 与 index.ts 只差两件事，业务内核（runtime.ts）完全相同：
 *
 *  1. 参数声明：MCP 宿主自己发布 JSON Schema 并把参数原样透传，不需要 zod。
 *     OpenCode V1 的 `tool.args` 是 zod raw shape；若把它直接当 schema 发布，
 *     会得到一个空 properties 的 schema，模型无从知道能传 query。
 *  2. 配置文件探测：源码把默认路径写死为 `~/.config/opencode/websearch-loadbalanced.jsonc`。
 *     这里按 MiniMax 侧既有约定查找，取第一个存在的：
 *       a. `$MCODE_CONFIG_DIR`
 *       b. MiniMax 数据目录（`$MINIMAX_DATA_DIR` | `$MAVIS_DATA_DIR` | `~/.minimax`）
 *       c. OpenCode 配置目录（`$OPENCODE_CONFIG_DIR` | `$XDG_CONFIG_HOME/opencode` | `~/.config/opencode`）
 *       d. 本插件包根目录
 *     都不存在时不传 configFile，交回插件自身的默认探测（零副作用）。
 *
 * 构建：`npm run build:mcode` → dist/mcode.cjs（CJS，不含 zod），由插件包的
 * `server.js` require 后把 `searchweb` 发布成 MCP 工具。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createExecute, createRuntime, formatSearchResults } from "./runtime"
import type { WebSearchPluginOptions, WebSearchResult } from "./types"

export const PLUGIN_ID = "websearch-tools"
export const TOOL_NAME = "searchweb"
export const CONFIG_BASENAME = "websearch-loadbalanced.jsonc"

/** MCP 发布的参数 schema：与 index.ts 里 zod shape 一一对应，字段名与约束不得漂移。 */
export const SEARCHWEB_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, description: "The search query." },
    maxResults: {
      type: "integer",
      minimum: 1,
      description: "Maximum number of results to return.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const

export const SEARCHWEB_DESCRIPTION =
  "Search the web across multiple load-balanced providers (parallel/exa/tavily/you/serpapi/searxng). " +
  "Use for current information, facts, documentation, news, and URLs."

/* ============================================================
 * 配置位置（与 plugin-build/_shared/vendor/_lib/mcode-config.js 同序）
 * ============================================================ */

export interface ConfigLookupOptions {
  env?: Record<string, string | undefined>
  exists?: (candidate: string) => boolean
}

function homeDirOf(env: Record<string, string | undefined>): string {
  return env.USERPROFILE || env.HOME || os.homedir()
}

/** 按既有约定返回配置文件绝对路径；都不存在时返回 undefined，交给插件自身默认探测。 */
export function resolveConfigFile(opts: ConfigLookupOptions = {}): string | undefined {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? ((candidate: string) => fs.existsSync(candidate))
  const home = homeDirOf(env)

  const dataDir = env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR || path.join(home, ".minimax")
  const opencodeDir =
    env.OPENCODE_CONFIG_DIR ||
    (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "opencode") : path.join(home, ".config", "opencode"))
  // CJS 产物位于 <pkg>/vendor/<service>/index.js，包根在上两级。
  const packageRoot = path.resolve(__dirname, "..", "..")

  const dirs = [env.MCODE_CONFIG_DIR, dataDir, opencodeDir, packageRoot].filter(
    (d): d is string => typeof d === "string" && d.length > 0,
  )
  for (const dir of dirs) {
    const candidate = path.join(dir, CONFIG_BASENAME)
    try {
      if (exists(candidate)) return candidate
    } catch {
      /* 不可读的候选：继续往下找 */
    }
  }
  return undefined
}

/* ============================================================
 * tool（JSON Schema 形态）
 * ============================================================ */

export interface McpSearchToolDeps {
  run: (
    input: { query: string },
    context: { signal: AbortSignal },
  ) => Promise<readonly WebSearchResult[]>
}

export function createMcpSearchTool(deps: McpSearchToolDeps) {
  return {
    description: SEARCHWEB_DESCRIPTION,
    args: SEARCHWEB_INPUT_SCHEMA,
    async execute(args: { query: string; maxResults?: number }) {
      const query = String(args?.query ?? "")
      const results = await deps.run({ query }, { signal: new AbortController().signal })
      const sliced = args?.maxResults && args.maxResults > 0 ? results.slice(0, args.maxResults) : results
      return formatSearchResults(query, sliced)
    },
  }
}

/* ============================================================
 * 插件定义
 * ============================================================ */

export interface McpPluginDeps extends ConfigLookupOptions {
  homeDir?: string
}

export function createMcpPlugin(deps: McpPluginDeps = {}) {
  const env = deps.env ?? process.env
  // env 定了 home 就跟着走：测试里注入假 home 时不会再去读真实用户目录。
  const homeDir = deps.homeDir ?? env.USERPROFILE ?? env.HOME
  return {
    id: PLUGIN_ID,
    async server(_input?: unknown, options?: WebSearchPluginOptions) {
      const configFile = options?.configFile ?? resolveConfigFile({ env, exists: deps.exists })
      const runtime = createRuntime(
        { ...(options ?? {}), ...(configFile ? { configFile } : {}) },
        { env, homeDir },
      )
      if (configFile) runtime.logger.info(`${PLUGIN_ID}: config ${configFile}`)
      for (const w of runtime.warnings) runtime.logger.info(`config warning: ${w}`)
      for (const e of runtime.errors) runtime.logger.error(`config error: ${e}`)
      const execute = createExecute({ router: runtime.router, logger: runtime.logger })
      return {
        tool: {
          [TOOL_NAME]: createMcpSearchTool({ run: execute }),
        },
      }
    },
  }
}

export default createMcpPlugin()
