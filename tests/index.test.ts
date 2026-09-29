/**
 * index.ts 可测部分：
 * - execute 冒烟（注入 fake router，零网络；不得 mock 冒充真实 provider 调用）
 * - 装配 createRuntime（无 provider 启用 → 不外呼、可构造）
 * - 错误脱敏（RouterError 原样上抛；裸 Error 经 redact）
 * - 插件定义形态（id / setup）
 */
import { describe, expect, it } from "vitest"
import plugin, { createExecute, createRuntime, toWebSearchResult } from "../src/index"
import { RouterError } from "../src/router"
import type { RouteResponse, Router } from "../src/router"
import type { DedupedResult } from "../src/utils/url"
import { createLogger } from "../src/utils/logging"

function deduped(url: string, over: Partial<DedupedResult> = {}): DedupedResult {
  return {
    url,
    title: "标题",
    content: "正文",
    time: { published: 1700000000000 },
    provider: "exa",
    rank: 1,
    providers: ["exa"],
    ...over,
  }
}

function okResponse(results: DedupedResult[]): RouteResponse {
  return {
    query: "q",
    results,
    attempts: [],
    cacheHit: false,
    totalMs: 12,
    elapsedMs: 12,
    cached: false,
    warnings: [],
  }
}

describe("toWebSearchResult", () => {
  it("只保留 url/title/content/time 四字段（剥 provider/rank/score/providers）", () => {
    const out = toWebSearchResult(deduped("https://a.example/1", { score: 0.9 }))
    expect(out).toEqual({
      url: "https://a.example/1",
      title: "标题",
      content: "正文",
      time: { published: 1700000000000 },
    })
    expect(out).not.toHaveProperty("provider")
    expect(out).not.toHaveProperty("rank")
    expect(out).not.toHaveProperty("score")
    expect(out).not.toHaveProperty("providers")
  })

  it("缺省 title/content 不落 undefined key；time 缺省补空对象", () => {
    const out = toWebSearchResult({
      url: "https://b.example/2",
      time: undefined as unknown as { published?: number }, // 模拟上游缺 time（类型上必填，运行时兜底）
      provider: "searxng",
      rank: 3,
    })
    expect(out).toEqual({ url: "https://b.example/2", time: {} })
    expect(Object.keys(out)).toEqual(["url", "time"])
  })
})

describe("createExecute（fake router 冒烟，零网络）", () => {
  it("route 成功 → 返回剥离后的 WebSearch.Result[]，query/signal 透传", async () => {
    let seenQuery: string | undefined
    let seenSignal: AbortSignal | undefined
    const signal = new AbortController().signal
    const router: Pick<Router, "route"> = {
      route: async (req) => {
        seenQuery = req.query
        seenSignal = req.signal
        return okResponse([deduped("https://a.example/1"), deduped("https://b.example/2", { providers: ["exa", "searxng"] })])
      },
    }
    const execute = createExecute({ router })
    const out = await execute({ query: "opencode v2" }, { signal })
    expect(seenQuery).toBe("opencode v2")
    expect(seenSignal).toBe(signal)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      url: "https://a.example/1",
      title: "标题",
      content: "正文",
      time: { published: 1700000000000 },
    })
  })

  it("router 抛 RouterError → 原样上抛（message 已在构造时脱敏）", async () => {
    const boom = new RouterError("所有 provider 失败：exa:AUTH", [])
    const execute = createExecute({ router: { route: async () => { throw boom } } })
    await expect(execute({ query: "q" }, { signal: new AbortController().signal })).rejects.toBe(boom)
    expect(boom.message).not.toMatch(/sk-|tvly-/)
  })

  it("裸 Error 携带 key 形态串 → 上抛 message 与日志行均被 redact", async () => {
    const lines: string[] = []
    const logger = createLogger({ level: "error", write: (l) => lines.push(l) })
    const execute = createExecute({
      router: { route: async () => { throw new Error("upstream refused key sk-alphabeta1234567890") } },
      logger,
    })
    const e = await execute({ query: "q" }, { signal: new AbortController().signal }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(e).toBeInstanceOf(Error)
    const msg = (e as Error).message
    expect(msg).not.toContain("sk-alphabeta1234567890")
    expect(msg).toContain("sk-***")
    expect(lines.join("\n")).not.toContain("sk-alphabeta1234567890")
    expect(lines.length).toBe(1)
  })

  it("空结果（全部 empty 但有 ok）→ 返回空数组，不抛错", async () => {
    const execute = createExecute({ router: { route: async () => okResponse([]) } })
    await expect(execute({ query: "q" }, { signal: new AbortController().signal })).resolves.toEqual([])
  })
})

describe("createRuntime 装配冒烟（无 provider 启用 → 零网络）", () => {
  it("空 options → 无 error、router 可构造、route 全挂抛 RouterError（不出网络请求）", async () => {
    const rt = createRuntime({}, { env: {} })
    expect(rt.errors).toEqual([])
    expect(rt.config.providers.exa.enabled).toBe(false)
    await expect(rt.router.route({ query: "q" })).rejects.toBeInstanceOf(RouterError)
  })

  it("启用 provider 但 env 缺失 → warning + provider 置灰，不抛错", () => {
    const rt = createRuntime({ providers: { exa: { enabled: true, keys: ["EXA_API_KEY"] } } }, { env: {} })
    expect(rt.errors).toEqual([])
    expect(rt.config.providers.exa.enabled).toBe(false)
    expect(rt.warnings.some((w) => w.includes("EXA_API_KEY"))).toBe(true)
  })
})

describe("插件定义形态", () => {
  it("默认导出 id=websearch-loadbalanced 且含 setup", () => {
    expect(plugin.id).toBe("websearch-loadbalanced")
    expect(typeof plugin.setup).toBe("function")
  })
})
