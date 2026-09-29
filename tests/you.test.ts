import { describe, expect, it } from "vitest"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/types"
import { createProviderError } from "../src/utils/errors"
import { createYouAdapter } from "../src/providers/you"

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

const KEY = { id: "you:deadbeef", secret: "ydc-test-key-0123456789" }

describe("you adapter — request mapping", () => {
  it("POST ydc-index.io/v1/search、X-API-Key、字段归一", async () => {
    const { http, calls } = mockHttp(() => jsonRes(200, { results: {} }))
    const adapter = createYouAdapter()
    await adapter.search({
      request: {
        query: "hello",
        maxResults: 150, // 每分区上限 100 → 裁剪
        startDate: "2026-09-01",
        endDate: "2026-09-29",
        country: "us",
        language: "zh-CN",
        safeSearch: true,
        includeDomains: ["example.com"],
        excludeDomains: ["spam.com"], // include+exclude 同传 → 422，弃 exclude
      },
      key: KEY,
      http,
    })

    const req = calls[0]
    expect(req.method).toBe("POST")
    expect(req.url).toBe("https://ydc-index.io/v1/search")
    expect(req.headers?.["X-API-Key"]).toBe(KEY.secret)
    const body = req.body as Record<string, unknown>
    expect(body.query).toBe("hello")
    expect(body.count).toBe(100)
    expect(body.freshness).toBe("2026-09-01to2026-09-29")
    expect(body.country).toBe("US")
    expect(body.language).toBe("ZH-HANS")
    expect(body.safesearch).toBe("strict")
    expect(body.include_domains).toEqual(["example.com"])
    expect(body.exclude_domains).toBeUndefined()
  })

  it("timeRange 映射 freshness；enum 外 country/language 丢弃并记录", async () => {
    const { http, calls } = mockHttp(() => jsonRes(200, { results: {} }))
    const adapter = createYouAdapter()
    const out = await adapter.search({
      request: { query: "q", timeRange: "day", country: "ZZ", language: "xx-YY" },
      key: KEY,
      http,
    })
    const body = calls[0].body as Record<string, unknown>
    expect(body.freshness).toBe("day")
    expect(body.country).toBeUndefined()
    expect(body.language).toBeUndefined()
    const dropped = (out as { droppedParams?: string[] }).droppedParams ?? []
    expect(dropped).toEqual(expect.arrayContaining(["country", "language"]))
  })

  it("仅单边日期（无 endDate）→ 丢弃而非半截区间", async () => {
    const { http, calls } = mockHttp(() => jsonRes(200, { results: {} }))
    const adapter = createYouAdapter()
    const out = await adapter.search({ request: { query: "q", startDate: "2026-09-01" }, key: KEY, http })
    expect((calls[0].body as Record<string, unknown>).freshness).toBeUndefined()
    expect((out as { droppedParams?: string[] }).droppedParams).toContain("startDate")
  })
})

describe("you adapter — response mapping", () => {
  it("web + news 分区合并、description+snippets、page_age、数组顺序即 rank", async () => {
    const { http } = mockHttp(() =>
      jsonRes(200, {
        results: {
          web: [
            {
              url: "https://a.example/1",
              title: "A",
              description: "desc a",
              snippets: ["s1", "s2"],
              page_age: "2024-12-18T00:00:00",
            },
            { url: "https://b.example/2" }, // 无 title/description/snippets/page_age
          ],
          news: [
            { url: "https://n.example/3", title: "N", description: "news desc", page_age: "2026-09-28T10:00:00" },
          ],
        },
        metadata: { search_uuid: "u" },
      }),
    )
    const adapter = createYouAdapter()
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })

    expect(out.error).toBeUndefined()
    expect(out.results).toHaveLength(3) // web(2) + news(1)
    const [a, b, n] = out.results
    expect(a.url).toBe("https://a.example/1")
    expect(a.title).toBe("A")
    expect(a.content).toBe("desc a\ns1\ns2")
    expect(a.time.published).toBe(Date.parse("2024-12-18T00:00:00"))
    expect(a.provider).toBe("you")
    expect(a.keyId).toBe(KEY.id)
    expect(b.rank).toBe(2)
    expect(b.content).toBeUndefined()
    expect(b.time).toEqual({})
    expect(n.url).toBe("https://n.example/3")
    expect(n.rank).toBe(3) // news 接续 web 顺序
    expect(n.time.published).toBe(Date.parse("2026-09-28T10:00:00"))
  })

  it("web 单分区 / 完全空响应 → 容错", async () => {
    const { http } = mockHttp(() => jsonRes(200, { results: { web: [{ url: "https://w.example/" }] } }))
    const adapter = createYouAdapter()
    const out1 = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out1.results).toHaveLength(1)

    const { http: http2 } = mockHttp(() => jsonRes(200, {}))
    const out2 = await adapter.search({ request: { query: "x" }, key: KEY, http: http2 })
    expect(out2.results).toEqual([])
    expect(out2.error).toBeUndefined()
  })

  it("usage：X-RateLimit-* 头 → detail（每调用 1 单位）", async () => {
    const { http } = mockHttp(() =>
      jsonRes(
        200,
        { results: {} },
        { "X-RateLimit-Limit": "10", "X-RateLimit-Remaining": "9", "X-RateLimit-Reset": "1790000000" },
      ),
    )
    const adapter = createYouAdapter()
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.usage?.units).toBe(1)
    expect(out.usage?.detail).toContain("remaining=9")
    expect(adapter.cost({ query: "x" })).toBe(1)
  })
})

describe("you adapter — error mapping", () => {
  const adapter = createYouAdapter()

  it("429 → RATE_LIMIT + retryAfterMs；无 Retry-After 则 undefined", async () => {
    const { http } = mockHttp(() => jsonRes(429, { detail: "Too many requests" }, { "Retry-After": "7" }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "RATE_LIMIT", httpStatus: 429, retryAfterMs: 7000 })
    expect(out.error?.message).toContain("Too many requests")

    const { http: http2 } = mockHttp(() => jsonRes(429, { detail: "rate limited" }))
    const out2 = await adapter.search({ request: { query: "x" }, key: KEY, http: http2 })
    expect(out2.error?.code).toBe("RATE_LIMIT")
    expect(out2.error?.retryAfterMs).toBeUndefined() // 服务端未给 → 上层退避兜底
  })

  it("401 → AUTH", async () => {
    const { http } = mockHttp(() => jsonRes(401, { detail: "Invalid or expired API key" }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "AUTH", httpStatus: 401 })
    expect(out.error?.message).toContain("Invalid or expired API key")
  })

  it("402 → QUOTA_EXCEEDED", async () => {
    const { http } = mockHttp(() => jsonRes(402, { detail: "Insufficient credits" }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "QUOTA_EXCEEDED", httpStatus: 402 })
  })

  it("5xx → SERVER_ERROR", async () => {
    const { http } = mockHttp(() => jsonRes(500, { detail: "Internal authentication error" }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "SERVER_ERROR", httpStatus: 500 })
  })

  it("HttpClient 抛出的 NETWORK_ERROR 原样透传", async () => {
    const err = createProviderError({ code: "NETWORK_ERROR", provider: "you", message: "network failure: DNS" })
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
