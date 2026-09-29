import { describe, expect, it } from "vitest"
import { createSearxngAdapter } from "../src/providers/searxng"
import type { HttpClient, HttpRequest, ProviderSearchInput } from "../src/types"

/* ---- mock HttpClient（注入假响应，不外呼） ---- */

interface MockReply {
  status?: number
  body?: unknown
  raw?: string
  headers?: Record<string, string>
}

function mockHttp(handler: (req: HttpRequest) => MockReply | Promise<MockReply>) {
  const calls: HttpRequest[] = []
  const http: HttpClient = {
    async request(req) {
      calls.push(req)
      const reply = await handler(req)
      const raw = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body))
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(reply.headers ?? {})) headers[k.toLowerCase()] = v
      return {
        status: reply.status ?? 200,
        headers,
        latencyMs: 1,
        text: async () => raw,
        json: async <T>() => JSON.parse(raw) as T,
      }
    },
    parseRetryAfter(v) {
      if (!v) return undefined
      const t = v.trim()
      if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000)
      const at = Date.parse(t)
      return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
    },
  }
  return { http, calls }
}

function input(http: HttpClient, over: Partial<ProviderSearchInput> = {}): ProviderSearchInput {
  return { request: { query: "weather tokyo" }, http, ...over }
}

const OK_BODY = {
  query: "weather tokyo",
  results: [
    {
      url: "https://www.jma.go.jp/",
      title: "JMA",
      content: "Japan Meteorological Agency",
      score: 9.0,
      publishedDate: "2025-08-21T16:20:03",
      engines: ["bing", "brave"],
      img_src: "https://img.example/x.png",
    },
    { url: "https://example.org/no-meta", title: "No meta", content: "text", publishedDate: null },
  ],
  answers: [],
  corrections: [],
  infoboxes: [],
  suggestions: [],
  unresponsive_engines: [],
}

describe("searxng adapter：请求映射（无 key）", () => {
  it("GET /search + format=json + q，不需要 key", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    const out = await createSearxngAdapter().search(input(http))
    expect(out.error).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://search.658658.xyz/search")
    expect(calls[0].method).toBe("GET")
    expect(calls[0].query).toMatchObject({ q: "weather tokyo", format: "json" })
  })

  it("language/time_range/safesearch/engines 透传；非法 language 丢弃（避免实例 400）", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    await createSearxngAdapter({ engines: ["bing", "brave"] }).search(
      input(http, { request: { query: "q", language: "zh-CN", timeRange: "week", safeSearch: true } }),
    )
    expect(calls[0].query).toMatchObject({
      language: "zh-CN",
      time_range: "week",
      safesearch: 2,
      engines: "bing,brave",
    })

    const bad = mockHttp(() => ({ body: OK_BODY }))
    await createSearxngAdapter().search(
      input(bad.http, { request: { query: "q", language: "<script>", safeSearch: false } }),
    )
    expect(bad.calls[0].query).toMatchObject({ safesearch: 0 })
    expect(bad.calls[0].query?.language).toBeUndefined()
  })

  it("baseUrl 可覆盖（去尾斜杠）", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    await createSearxngAdapter({ baseUrl: "http://localhost:8080/" }).search(input(http))
    expect(calls[0].url).toBe("http://localhost:8080/search")
  })
})

describe("searxng adapter：响应映射", () => {
  it("url/title/content/score→毫秒/rank，publishedDate null 容错", async () => {
    const { http } = mockHttp(() => ({ body: OK_BODY }))
    const out = await createSearxngAdapter().search(input(http))
    expect(out.results).toHaveLength(2)
    const [a, b] = out.results
    expect(a).toMatchObject({
      url: "https://www.jma.go.jp/",
      title: "JMA",
      content: "Japan Meteorological Agency",
      score: 9.0,
      time: { published: Date.parse("2025-08-21T16:20:03") },
      provider: "searxng",
      rank: 1,
    })
    expect(a.keyId).toBeUndefined() // 无 key 通道
    expect(b.time).toEqual({}) // publishedDate null
    expect(b.rank).toBe(2)
  })

  it("maxResults 裁剪上游结果；字段缺失容错", async () => {
    const { http } = mockHttp(() => ({
      body: { results: [{ url: "https://a.example/" }, "junk", { title: "no-url" }] },
    }))
    const out = await createSearxngAdapter().search(
      input(http, { request: { query: "q", maxResults: 1 } }),
    )
    expect(out.error).toBeUndefined()
    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({ url: "https://a.example/", rank: 1 })
    expect(out.results[0].title).toBeUndefined()
    expect(out.results[0].score).toBeUndefined()

    const empty = await createSearxngAdapter().search(input(mockHttp(() => ({ body: {} })).http))
    expect(empty.error).toBeUndefined()
    expect(empty.results).toEqual([])
  })
})

describe("searxng adapter：错误映射", () => {
  it("403 HTML（实例禁用 format=json）→ UNKNOWN 而非 AUTH", async () => {
    const { http } = mockHttp(() => ({
      status: 403,
      raw: "<!doctype html><html lang=en><title>403 Forbidden</title></html>",
      headers: { "content-type": "text/html" },
    }))
    const out = await createSearxngAdapter().search(input(http))
    expect(out.results).toEqual([])
    expect(out.error).toMatchObject({ code: "UNKNOWN", httpStatus: 403, provider: "searxng" })
    expect(out.error?.code).not.toBe("AUTH") // 与 key 无关，绝不能禁 key
  })

  it("400 JSON {error} → BAD_REQUEST + upstreamTag=msg", async () => {
    const { http } = mockHttp(() => ({ status: 400, body: { error: "No query" } }))
    const out = await createSearxngAdapter().search(input(http))
    expect(out.error).toMatchObject({ code: "BAD_REQUEST", httpStatus: 400, upstreamTag: "No query" })
  })

  it("500 JSON {error} → SERVER_ERROR", async () => {
    const { http } = mockHttp(() => ({ status: 500, body: { error: "search error" } }))
    const out = await createSearxngAdapter().search(input(http))
    expect(out.error).toMatchObject({ code: "SERVER_ERROR", httpStatus: 500 })
  })

  it("网络错误 → NETWORK_ERROR", async () => {
    const { http } = mockHttp(() => {
      throw new Error("fetch failed: ECONNRESET")
    })
    const out = await createSearxngAdapter().search(input(http))
    expect(out.results).toEqual([])
    expect(out.error).toMatchObject({ code: "NETWORK_ERROR", provider: "searxng" })
  })

  it("200 + HTML（格式静默回退）→ UNKNOWN", async () => {
    const { http } = mockHttp(() => ({ raw: "<!doctype html><html>...</html>" }))
    const out = await createSearxngAdapter().search(input(http))
    expect(out.error?.code).toBe("UNKNOWN")
  })
})
