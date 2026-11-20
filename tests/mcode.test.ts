/**
 * mcode.test.ts：MiniMax Code 入口的契约（零网络）。
 *
 * 三件必须锁住的事：
 *  1. MCP 发布的 inputSchema 必须是真的 JSON Schema（不是 zod shape），
 *     否则模型拿到的是一张空参数表 —— 这正是迁移里最容易静默失败的点。
 *  2. 配置文件按 `$MCODE_CONFIG_DIR` → 数据目录 → OpenCode 目录 的既有顺序探测。
 *  3. `searchweb` 返回可读文本，`maxResults` 生效。
 */
import path from "node:path"
import { describe, expect, it } from "vitest"
import pluginDefault, {
  CONFIG_BASENAME,
  PLUGIN_ID,
  SEARCHWEB_INPUT_SCHEMA,
  createMcpPlugin,
  createMcpSearchTool,
  resolveConfigFile,
} from "../src/mcode"
import type { WebSearchResult } from "../src/types"

describe("MCP 参数 schema", () => {
  it("是 JSON Schema，且把 query 列为必填", () => {
    expect(SEARCHWEB_INPUT_SCHEMA.type).toBe("object")
    expect(SEARCHWEB_INPUT_SCHEMA.required).toContain("query")
    expect(SEARCHWEB_INPUT_SCHEMA.properties.query.type).toBe("string")
    expect(SEARCHWEB_INPUT_SCHEMA.properties.maxResults.type).toBe("integer")
  })

  it("没有 zod 痕迹（zod shape 的键才是字段名，且不带 type）", () => {
    const schema = SEARCHWEB_INPUT_SCHEMA as Record<string, unknown>
    expect(schema.type).toBe("object")
    expect(Object.keys(schema)).not.toContain("_def")
  })
})

describe("resolveConfigFile（与 mcode-config.js 同序）", () => {
  const home = path.join("C:", "Users", "tester")
  const env = { USERPROFILE: home } as Record<string, string | undefined>

  it("MCODE_CONFIG_DIR 优先", () => {
    const custom = path.join(home, "custom-dir")
    const found = resolveConfigFile({
      env: { ...env, MCODE_CONFIG_DIR: custom },
      exists: () => true,
    })
    expect(found).toBe(path.join(custom, CONFIG_BASENAME))
  })

  it("数据目录优先于 OpenCode 目录", () => {
    const dataDir = path.join(home, ".minimax")
    const opencodeDir = path.join(home, ".config", "opencode")
    const present = new Set([path.join(dataDir, CONFIG_BASENAME), path.join(opencodeDir, CONFIG_BASENAME)])
    const found = resolveConfigFile({ env, exists: (p) => present.has(p) })
    expect(found).toBe(path.join(dataDir, CONFIG_BASENAME))
  })

  it("数据目录缺失时回退 OpenCode 目录（迁移前的位置）", () => {
    const opencodeDir = path.join(home, ".config", "opencode")
    const present = new Set([path.join(opencodeDir, CONFIG_BASENAME)])
    const found = resolveConfigFile({ env, exists: (p) => present.has(p) })
    expect(found).toBe(path.join(opencodeDir, CONFIG_BASENAME))
  })

  it("都不存在时返回 undefined，交回插件默认探测", () => {
    expect(resolveConfigFile({ env, exists: () => false })).toBeUndefined()
  })
})

describe("createMcpSearchTool", () => {
  const results: WebSearchResult[] = [
    { url: "https://a.example", title: "A", content: "alpha", time: {} },
    { url: "https://b.example", title: "B", content: "beta", time: {} },
    { url: "https://c.example", title: "C", content: "gamma", time: {} },
  ]

  it("渲染可读文本并应用 maxResults", async () => {
    const tool = createMcpSearchTool({ run: async () => results })
    const text = await tool.execute({ query: "hello", maxResults: 2 })
    expect(text).toContain('Web search results for "hello" (2):')
    expect(text).toContain("https://a.example")
    expect(text).toContain("https://b.example")
    expect(text).not.toContain("https://c.example")
  })

  it("空结果给出明确文本而不是空串", async () => {
    const tool = createMcpSearchTool({ run: async () => [] })
    expect(await tool.execute({ query: "nothing" })).toBe('No web search results for "nothing".')
  })
})

describe("插件定义", () => {
  it("注册单个 searchweb 工具，参数 schema 可直接发布", async () => {
    const plugin = createMcpPlugin({ env: { USERPROFILE: path.join("C:", "Users", "tester") } })
    expect(pluginDefault.id).toBe(PLUGIN_ID)
    expect(plugin.id).toBe(PLUGIN_ID)
    const hooks = await plugin.server()
    const tool = hooks.tool.searchweb
    expect(Object.keys(hooks.tool)).toEqual(["searchweb"])
    expect(tool.args).toBe(SEARCHWEB_INPUT_SCHEMA)
    expect(typeof tool.execute).toBe("function")
  })
})
