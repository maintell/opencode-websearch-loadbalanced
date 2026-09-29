/**
 * 外置配置文件（JSONC）：
 * - 默认路径缺失 → no-op（静默走 inline）
 * - inline configFile 加载 / `~` 展开 / 显式路径缺失告警
 * - 合并语义 = 顶层键整体覆盖（非深合并）
 * - JSONC 注释剥离状态机（字符串内的 // 不被截断）
 * - 坏 JSON → warning + 回退 inline（不抛错）
 * 全部用真实临时文件，零网络、不 mock provider 调用。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG_FILE, expandHome, loadExternalConfig, resolveConfig, stripJsonComments } from "../src/config"
import { createRuntime } from "../src/index"

const EXAMPLE = fileURLToPath(new URL("../examples/websearch.config.jsonc", import.meta.url))

/** Windows/pwsh：优先 F:\Temp\opencode（已批准的外部临时目录），否则系统 tmp */
const TMP_BASE = existsSync("F:/Temp/opencode") ? "F:/Temp/opencode" : os.tmpdir()
const homes: string[] = []

function tmpHome(): string {
  const dir = mkdtempSync(path.join(TMP_BASE, "wslb-cfg-"))
  homes.push(dir)
  return dir
}

function put(home: string, rel: string, content: string): string {
  const p = path.join(home, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, content, "utf8")
  return p
}

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

describe("默认路径探测", () => {
  it("默认路径缺失 → no-op：无 warning、options 原样、source undefined", () => {
    const home = tmpHome()
    const out = loadExternalConfig({ logging: { level: "debug" } }, { homeDir: home })
    expect(out.warnings).toEqual([])
    expect(out.source).toBeUndefined()
    expect(out.options).toEqual({ logging: { level: "debug" } })
  })

  it("默认路径存在 → 自动加载（相对 homedir 的 .config/opencode/…）", () => {
    const home = tmpHome()
    put(home, DEFAULT_CONFIG_FILE, '{ "logging": { "level": "silent" } }')
    const out = loadExternalConfig({}, { homeDir: home })
    expect(out.warnings).toEqual([])
    expect(out.source).toBe(path.join(home, DEFAULT_CONFIG_FILE))
    expect(out.options).toEqual({ logging: { level: "silent" } })
  })
})

describe("inline configFile", () => {
  it("显式路径 → 读取文件内容", () => {
    const home = tmpHome()
    const p = put(home, "custom.jsonc", '{ "routing": { "strategy": "round_robin" } }')
    const out = loadExternalConfig({ configFile: p }, { homeDir: home })
    expect(out.warnings).toEqual([])
    expect(out.source).toBe(p)
    expect(out.options.routing).toEqual({ strategy: "round_robin" })
    expect(out.options.configFile).toBeUndefined() // 仅输入侧，不进合并结果
  })

  it("`~/…` 展开为 homedir", () => {
    const home = tmpHome()
    const p = put(home, "cfg/websearch.jsonc", '{ "cache": { "ttlMs": 42 } }')
    const out = loadExternalConfig({ configFile: "~/cfg/websearch.jsonc" }, { homeDir: home })
    expect(out.source).toBe(p)
    expect(out.options.cache).toEqual({ ttlMs: 42 })
    expect(expandHome("~/x/y.jsonc", home)).toBe(path.join(home, "x/y.jsonc"))
    expect(expandHome("~/x\\y.jsonc", home)).toBe(path.join(home, "x\\y.jsonc"))
    expect(expandHome("~", home)).toBe(home)
    expect(expandHome("C:/abs/c.jsonc", home)).toBe("C:/abs/c.jsonc")
  })

  it("显式路径不存在 → warning + 回退 inline（不抛错）", () => {
    const home = tmpHome()
    const out = loadExternalConfig({ configFile: path.join(home, "missing.jsonc"), logging: { level: "error" } }, { homeDir: home })
    expect(out.warnings.some((w) => w.includes("读取失败"))).toBe(true)
    expect(out.source).toBeUndefined()
    expect(out.options).toEqual({ logging: { level: "error" } })
  })
})

describe("合并语义：文件为 base，inline 顶层键整体覆盖（非深合并）", () => {
  it("inline 有同名顶层键 → 整体替换文件的该块", () => {
    const home = tmpHome()
    const p = put(
      home,
      "base.jsonc",
      JSON.stringify({
        providers: { exa: { enabled: true, priority: 20, keys: ["EXA_API_KEY"] }, searxng: { enabled: true } },
        routing: { strategy: "round_robin", maxProviderAttempts: 6 },
        cache: { ttlMs: 111 },
      }),
    )
    const out = loadExternalConfig(
      {
        configFile: p,
        providers: { exa: { enabled: false } }, // 顶层整体覆盖 → 文件里的 searxng / priority / keys 全丢
        routing: { maxProviderAttempts: 3 },
      },
      { homeDir: home },
    )
    expect(out.warnings).toEqual([])
    expect(out.options.providers).toEqual({ exa: { enabled: false } })
    expect(out.options.routing).toEqual({ maxProviderAttempts: 3 }) // strategy 不继承文件
    expect(out.options.cache).toEqual({ ttlMs: 111 }) // inline 未给的顶层键保留文件值
  })
})

describe("JSONC 注释剥离（状态机，非 naive regex）", () => {
  it("行/块注释被剥离，字符串内的 // 与转义引号原样保留", () => {
    const src = [
      "{",
      '  // 行注释',
      '  "baseUrl": "https://api.example.com/v1//x", /* 行内块注释 */',
      '  "note": "看 https://not-a-comment // 仍然在字符串里",',
      '  "escaped": "quote \\" and // tail",',
      '  /* 多行',
      '     注释 */',
      '  "n": 1',
      "}",
    ].join("\n")
    const parsed = JSON.parse(stripJsonComments(src)) as Record<string, unknown>
    expect(parsed.baseUrl).toBe("https://api.example.com/v1//x")
    expect(parsed.note).toBe("看 https://not-a-comment // 仍然在字符串里")
    expect(parsed.escaped).toBe('quote " and // tail')
    expect(parsed.n).toBe(1)
  })

  it("未闭合块注释 → 吞到结尾但不抛错", () => {
    expect(stripJsonComments('{"a":1} /* never closed')).toContain('{"a":1}')
  })

  it("从文件加载：baseUrl 含 // 不被截断（resolveConfig 侧 URL 校验通过）", () => {
    const home = tmpHome()
    const p = put(
      home,
      "url.jsonc",
      `{
  // provider 列表
  "providers": { "searxng": { "enabled": true, "baseUrl": "https://search.example.com/path//seg" } }
}`,
    )
    const loaded = loadExternalConfig({ configFile: p }, { homeDir: home })
    expect(loaded.warnings).toEqual([])
    expect(loaded.options.providers?.searxng?.baseUrl).toBe("https://search.example.com/path//seg")
    const rt = createRuntime(loaded.options, { env: {}, homeDir: home })
    expect(rt.errors).toEqual([])
    expect(rt.config.providers.searxng.baseUrl).toBe("https://search.example.com/path//seg")
    expect(rt.config.providers.searxng.enabled).toBe(true)
  })
})

describe("坏 JSON → 回退 inline + warning（不抛错）", () => {
  it("语法错误 → options=inline、warnings 含解析失败", () => {
    const home = tmpHome()
    const p = put(home, "broken.jsonc", '{ "providers": { ')
    const out = loadExternalConfig({ configFile: p, logging: { level: "debug" } }, { homeDir: home })
    expect(out.warnings.some((w) => w.includes("解析失败"))).toBe(true)
    expect(out.source).toBeUndefined()
    expect(out.options).toEqual({ logging: { level: "debug" } })
  })

  it("尾逗号（JSONC 方言未支持）→ 同样回退 inline + warning", () => {
    const home = tmpHome()
    const p = put(home, "trailing.jsonc", '{ "cache": { "ttlMs": 5, }, }')
    const out = loadExternalConfig({ configFile: p }, { homeDir: home })
    expect(out.warnings.some((w) => w.includes("解析失败"))).toBe(true)
    expect(out.options).toEqual({})
  })

  it("顶层非对象 → 回退 inline + warning", () => {
    const home = tmpHome()
    const p = put(home, "array.jsonc", "[1,2,3]")
    const out = loadExternalConfig({ configFile: p }, { homeDir: home })
    expect(out.warnings.some((w) => w.includes("解析失败"))).toBe(true)
    expect(out.options).toEqual({})
  })
})

describe("createRuntime 集成（本地文件 IO，零网络）", () => {
  it("示例 examples/websearch.config.jsonc 可解析且通过 schema 校验", () => {
    const p = EXAMPLE
    const loaded = loadExternalConfig({ configFile: p }, { homeDir: tmpHome() })
    expect(loaded.warnings).toEqual([])
    const { errors } = resolveConfig(loaded.options, { env: {} })
    expect(errors).toEqual([]) // env 全缺只产生 warning，不产生 error
  })

  it("inline configFile → 配置进 ResolvedConfig", () => {
    const home = tmpHome()
    const p = put(
      home,
      "rt.jsonc",
      '{ "providers": { "searxng": { "enabled": true, "baseUrl": "https://s.example.org" } } }',
    )
    const rt = createRuntime({ configFile: p }, { env: {}, homeDir: home })
    expect(rt.errors).toEqual([])
    expect(rt.config.providers.searxng.enabled).toBe(true)
    expect(rt.config.providers.searxng.baseUrl).toBe("https://s.example.org")
  })

  it("默认路径自动加载 + 文件 warning 透传到 runtime.warnings", () => {
    const home = tmpHome()
    put(home, DEFAULT_CONFIG_FILE, '{ "providers": { "searxng": { "enabled": true } }, "cache": { "ttlMs": 7, } }')
    const rt = createRuntime({}, { env: {}, homeDir: home })
    // 坏 JSON（尾逗号）→ 回退 inline，不抛错
    expect(rt.warnings.some((w) => w.includes("解析失败"))).toBe(true)
    expect(rt.config.providers.searxng.enabled).toBe(false)

    put(home, DEFAULT_CONFIG_FILE, '{ "providers": { "searxng": { "enabled": true } }, "cache": { "ttlMs": 7 } }')
    const ok = createRuntime({}, { env: {}, homeDir: home })
    expect(ok.warnings).toEqual([])
    expect(ok.config.providers.searxng.enabled).toBe(true)
    expect(ok.config.cache.ttlMs).toBe(7)
  })
})
