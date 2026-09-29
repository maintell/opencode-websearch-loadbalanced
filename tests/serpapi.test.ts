import { describe, expect, it } from "vitest"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/types"
import { createProviderError } from "../src/utils/errors"
import { createSerpApiAdapter } from "../src/providers/serpapi"

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = JSON.stringify(body)
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v
  return {
    status,
    headers: h,
    latencyMs: 1,
    text: async () => text,
    json: async <T>() => JSON.parse(text) as T,
  }
}

function mockHttp(handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>): {
  http: HttpClient
  calls: HttpRequest[]
} {
  const calls: HttpRequest[] = []
  return {
    calls,
    http: {
      async request(req) {
        calls.push(req)
        return handler(req)
      },
      parseRetryAfter(v) {
        if (v === undefined || v === "") return undefined
        const t = v.trim()
        if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000)
        const at = Date.parse(t)
        return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
      },
    },
  }
}

const KEY = { id: "serpapi:deadbeef", secret: "SERPAPI_TEST_KEY_abc123" }

describe("serpapi adapter — request mapping", () => {
  it("GET /search、key 走 query、engine 默认 google、gl/hl/safe 归一", async () => {
    const { http, calls } = mockHttp(() => jsonRes(200, { organic_results: [] }))
    const adapter = createSerpApiAdapter()
    await adapter.search({
      request: { query: "opencode", country: "US", language: "en-gb", safeSearch: true },
      key: KEY,
      http,
    })

    const req = calls[0]
    expect(req.method).toBe("GET")
    expect(req.url).toBe("https://serpapi.com/search")
    expect(req.query).toMatchObject({
      engine: "google",
      q: "opencode",
      api_key: KEY.secret,
      gl: "us",
      hl: "en-gb",
      safe: "active",
    })
    expect(req.query?.num).toBeUndefined() // 官方无 num 参数
    expect(req.headers).toBeUndefined() // key 在 query，无认证 header
  })

  it("engine 可配置；time/域名过滤无稳定参数 → 丢弃并记录", async () => {
    const { http, calls } = mockHttp(() => jsonRes(200, { organic_results: [] }))
    const adapter = createSerpApiAdapter({ options: { engine: "google_news" } })
    const out = await adapter.search({
      request: {
        query: "q",
        timeRange: "week",
        startDate: "2026-09-01",
        endDate: "2026-09-29",
        includeDomains: ["example.com"],
        excludeDomains: ["spam.com"],
        safeSearch: false,
      },
      key: KEY,
      http,
    })

    expect(calls[0].query?.engine).toBe("google_news")
    expect(calls[0].query?.safe).toBe("off")
    for (const k of ["timeRange", "startDate", "endDate", "includeDomains", "excludeDomains"]) {
      expect(calls[0].query?.[k]).toBeUndefined()
    }
    const dropped = (out as { droppedParams?: string[] }).droppedParams ?? []
    expect(dropped).toEqual(
      expect.arrayContaining(["timeRange", "startDate", "endDate", "includeDomains", "excludeDomains"]),
    )
  })
})

describe("serpapi adapter — response mapping", () => {
  it("organic_results → SearchResult；position→rank；date/snippet 可缺失", async () => {
    const { http } = mockHttp(() =>
      jsonRes(200, {
        organic_results: [
          { position: 1, title: "A", link: "https://a.example/", snippet: "sa", date: "2026-09-01" },
          { position: 2, title: "B", link: "https://b.example/" }, // 无 snippet、无 date
          { title: "no link skipped", snippet: "x" }, // 无 link → 跳过
          { link: "https://c.example/", title: "C", snippet: "sc", source: "Wikipedia" }, // 无 position → 顺序兜底
        ],
      }),
    )
    const adapter = createSerpApiAdapter()
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })

    expect(out.error).toBeUndefined()
    expect(out.results).toHaveLength(3)
    const [a, b, c] = out.results
    expect(a).toMatchObject({ url: "https://a.example/", title: "A", content: "sa", provider: "serpapi", rank: 1, keyId: KEY.id })
    expect(a.time.published).toBe(Date.parse("2026-09-01"))
    expect(b.url).toBe("https://b.example/")
    expect(b.content).toBeUndefined() // snippet 缺失 → 省略，不造空串
    expect(b.time).toEqual({}) // date 缺失属正常
    expect(b.rank).toBe(2)
    expect(c.rank).toBe(3) // 无 position → 数组顺序兜底
  })

  it("maxResults 本地切片（无 num 参数）", async () => {
    const { http } = mockHttp(() =>
      jsonRes(200, {
        organic_results: [1, 2, 3, 4, 5].map((i) => ({ position: i, title: `T${i}`, link: `https://x.example/${i}` })),
      }),
    )
    const adapter = createSerpApiAdapter()
    const out = await adapter.search({ request: { query: "x", maxResults: 3 }, key: KEY, http })
    expect(out.results).toHaveLength(3)
    expect(out.results.map((r) => r.rank)).toEqual([1, 2, 3])
  })

  it("空 organic_results → 空数组无错误", async () => {
    const { http } = mockHttp(() => jsonRes(200, {}))
    const adapter = createSerpApiAdapter()
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.results).toEqual([])
    expect(out.error).toBeUndefined()
  })
})

describe("serpapi adapter — error mapping", () => {
  const adapter = createSerpApiAdapter()

  it("401 + {\"error\": ...} → AUTH，message 脱敏且不带 query", async () => {
    const { http } = mockHttp(() =>
      jsonRes(401, { error: `Invalid API key. Your API key should be here: ${KEY.secret}` }),
    )
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "AUTH", provider: "serpapi", httpStatus: 401 })
    expect(out.error?.message).toContain("Invalid API key")
    expect(out.error?.message).not.toContain(KEY.secret) // 明文 key 绝不出现在 message
    expect(out.error?.message).not.toContain("api_key=") // 绝不带 URL query
  })

  it("429 → RATE_LIMIT + retryAfterMs", async () => {
    const { http } = mockHttp(() => jsonRes(429, { error: "too many searches" }, { "Retry-After": "12" }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "RATE_LIMIT", httpStatus: 429, retryAfterMs: 12000 })
  })

  it("5xx → SERVER_ERROR", async () => {
    const { http } = mockHttp(() => jsonRes(500, { error: "internal error" }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "SERVER_ERROR", httpStatus: 500 })
  })

  it("2xx 但 body 带 error（官方实测信封）→ BAD_REQUEST 不重试", async () => {
    const { http } = mockHttp(() => jsonRes(200, { error: "Unsupported request format." }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "BAD_REQUEST", httpStatus: 200 })
    expect(out.error?.message).toContain("Unsupported request format.")
  })

  it("HttpClient 抛出的 NETWORK_ERROR 原样透传", async () => {
    const err = createProviderError({ code: "NETWORK_ERROR", provider: "serpapi", message: "network failure: ETIMEDOUT" })
    const { http } = mockHttp(() => {
      throw err
    })
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toBe(err)
  })

  it("缺 key → AUTH（不发请求）", async () => {
    const { http, calls } = mockHttp(() => jsonRes(200, {}))
    const out = await adapter.search({ request: { query: "x" }, http })
    expect(calls).toHaveLength(0)
    expect(out.error).toMatchObject({ code: "AUTH" })
  })
})
