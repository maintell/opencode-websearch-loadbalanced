import { describe, expect, it } from "vitest"
import { createExaAdapter } from "../src/providers/exa"
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

const KEY = { id: "exa:9f3a7c21", secret: "exa-test-key-1234567890abcdef" }

function input(http: HttpClient, over: Partial<ProviderSearchInput> = {}): ProviderSearchInput {
  return { request: { query: "semantic search engines" }, key: KEY, http, ...over }
}

const OK_BODY = {
  requestId: "6720abc",
  results: [
    { title: "First", url: "https://example.com/1", publishedDate: "2026-01-02", text: "body one" },
    { title: "Second", url: "https://example.com/2", publishedDate: null, text: "" },
  ],
  searchTime: 123,
}

describe("exa adapter：请求映射", () => {
  it("POST /search + x-api-key + query + contents.text 嵌套（无顶层 text）", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    const out = await createExaAdapter().search(input(http))
    expect(out.error).toBeUndefined()
    expect(calls[0].url).toBe("https://api.exa.ai/search")
    expect(calls[0].method).toBe("POST")
    expect(calls[0].headers?.["x-api-key"]).toBe(KEY.secret)
    const body = calls[0].body as Record<string, unknown>
    expect(body.query).toBe("semantic search engines")
    expect(body.contents).toEqual({ text: true })
    expect(body.text).toBeUndefined() // 内容选项禁止出现在顶层
    expect(body.highlights).toBeUndefined()
  })

  it("numResults 裁剪 ≤100；域名/日期/userLocation/moderation 映射", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    await createExaAdapter().search(
      input(http, {
        request: {
          query: "q",
          maxResults: 500,
          includeDomains: ["example.com"],
          excludeDomains: ["bad.example"],
          startDate: "2026-01-01",
          endDate: "2026-02-01",
          country: "us",
          safeSearch: true,
        },
      }),
    )
    const body = calls[0].body as Record<string, unknown>
    expect(body.numResults).toBe(100)
    expect(body.includeDomains).toEqual(["example.com"])
    expect(body.excludeDomains).toEqual(["bad.example"])
    expect(body.startPublishedDate).toBe("2026-01-01")
    expect(body.endPublishedDate).toBe("2026-02-01")
    expect(body.userLocation).toBe("us")
    expect(body.moderation).toBe(true)
  })
})

describe("exa adapter：响应映射", () => {
  it("url/title/text→content/publishedDate→毫秒/rank/provider/keyId，无 score", async () => {
    const { http } = mockHttp(() => ({ body: OK_BODY }))
    const out = await createExaAdapter().search(input(http))
    expect(out.results).toHaveLength(2)
    const [a, b] = out.results
    expect(a).toMatchObject({
      url: "https://example.com/1",
      title: "First",
      content: "body one",
      time: { published: Date.parse("2026-01-02") },
      provider: "exa",
      rank: 1,
      keyId: KEY.id,
    })
    expect(a.score).toBeUndefined() // schema 无 score 字段，不发明
    expect(b.time).toEqual({}) // publishedDate null
    expect(b.content).toBeUndefined() // 空 text → 无 content
    expect(b.rank).toBe(2)
  })

  it("字段缺失容错：无 results / 缺 url 条目 / 缺 title", async () => {
    const { http } = mockHttp(() => ({
      body: { requestId: "x", results: [{ title: "no-url" }, { url: "https://ok.example/" }] },
    }))
    const out = await createExaAdapter().search(input(http))
    expect(out.error).toBeUndefined()
    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({ url: "https://ok.example/", rank: 2 })
    expect(out.results[0].title).toBeUndefined()

    const empty = await createExaAdapter().search(input(mockHttp(() => ({ body: {} })).http))
    expect(empty.error).toBeUndefined()
    expect(empty.results).toEqual([])
  })
})

describe("exa adapter：错误映射", () => {
  it("429 + Retry-After → RATE_LIMIT 带 retryAfterMs，upstreamTag=tag", async () => {
    const { http } = mockHttp(() => ({
      status: 429,
      headers: { "Retry-After": "3" },
      body: { requestId: "r1", error: "Rate limit exceeded", tag: "RATE_LIMIT_EXCEEDED" },
    }))
    const out = await createExaAdapter().search(input(http))
    expect(out.results).toEqual([])
    expect(out.error).toMatchObject({
      code: "RATE_LIMIT",
      provider: "exa",
      httpStatus: 429,
      retryAfterMs: 3000,
      upstreamTag: "RATE_LIMIT_EXCEEDED",
    })
  })

  it("429 无 Retry-After → RATE_LIMIT 且 retryAfterMs 缺省", async () => {
    const { http } = mockHttp(() => ({
      status: 429,
      body: { requestId: "r1", error: "qps exceeded", tag: "RATE_LIMIT_EXCEEDED" },
    }))
    const out = await createExaAdapter().search(input(http))
    expect(out.error?.code).toBe("RATE_LIMIT")
    expect(out.error?.retryAfterMs).toBeUndefined()
  })

  it("401 + 错误信封 → AUTH + tag", async () => {
    const { http } = mockHttp(() => ({
      status: 401,
      body: { requestId: "r2", error: "Invalid API key", tag: "INVALID_API_KEY" },
    }))
    const out = await createExaAdapter().search(input(http))
    expect(out.error).toMatchObject({
      code: "AUTH",
      httpStatus: 401,
      provider: "exa",
      upstreamTag: "INVALID_API_KEY",
      keyId: KEY.id,
    })
  })

  it("5xx → SERVER_ERROR", async () => {
    const { http } = mockHttp(() => ({
      status: 503,
      body: { requestId: "r3", error: "Service overloaded", tag: "SERVICE_OVERLOADED" },
    }))
    const out = await createExaAdapter().search(input(http))
    expect(out.error).toMatchObject({ code: "SERVER_ERROR", httpStatus: 503 })
    expect(out.error?.upstreamTag).toBe("SERVICE_OVERLOADED")
  })

  it("网络错误 → NETWORK_ERROR", async () => {
    const { http } = mockHttp(() => {
      throw new Error("getaddrinfo ENOTFOUND api.exa.ai")
    })
    const out = await createExaAdapter().search(input(http))
    expect(out.results).toEqual([])
    expect(out.error).toMatchObject({ code: "NETWORK_ERROR", provider: "exa", keyId: KEY.id })
  })

  it("200 + 非 JSON body → UNKNOWN", async () => {
    const { http } = mockHttp(() => ({ raw: "<html>gateway error</html>" }))
    const out = await createExaAdapter().search(input(http))
    expect(out.error?.code).toBe("UNKNOWN")
  })

  it("无 key 防御分支 → 不发请求", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    const out = await createExaAdapter().search({ request: { query: "q" }, http })
    expect(calls).toHaveLength(0)
    expect(out.error?.code).toBe("BAD_REQUEST")
  })
})
