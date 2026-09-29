import { describe, expect, it } from "vitest"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/types"
import { createProviderError } from "../src/utils/errors"
import { createTavilyAdapter } from "../src/providers/tavily"

/* ---- mock HttpClient（不发真网络；覆盖 http-client 抛错与非 2xx 两条路径） ---- */
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

const KEY = { id: "tavily:deadbeef", secret: "tvly-test-0123456789abcdef" }

describe("tavily adapter — request mapping", () => {
  it("POST /search、Bearer 认证、字段归一与上限裁剪", async () => {
    const { http, calls } = mockHttp(() => jsonRes(200, { results: [] }))
    const adapter = createTavilyAdapter({ options: { search_depth: "advanced", topic: "general" } })
    await adapter.search({
      request: {
        query: "opencode plugin",
        maxResults: 30, // tavily 上限 20 → 裁剪
        timeRange: "week",
        startDate: "2026-09-01",
        endDate: "bad-date", // 非法日期 → 丢弃
        includeDomains: ["example.com"],
        excludeDomains: ["spam.com"],
        language: "zh",
        safeSearch: true,
        country: "US", // alpha-2 → 小写英文国名
      },
      key: KEY,
      http,
    })

    expect(calls).toHaveLength(1)
    const req = calls[0]
    expect(req.method).toBe("POST")
    expect(req.url).toBe("https://api.tavily.com/search")
    expect(req.headers?.Authorization).toBe(`Bearer ${KEY.secret}`)
    const body = req.body as Record<string, unknown>
    expect(body.query).toBe("opencode plugin")
    expect(body.max_results).toBe(20)
    expect(body.search_depth).toBe("advanced")
    expect(body.topic).toBe("general")
    expect(body.time_range).toBe("week")
    expect(body.start_date).toBe("2026-09-01")
    expect(body.end_date).toBeUndefined()
    expect(body.include_domains).toEqual(["example.com"])
    expect(body.exclude_domains).toEqual(["spam.com"])
    expect(body.language).toBe("zh")
    expect(body.safe_search).toBe(true)
    expect(body.country).toBe("united states")
    expect(body.include_usage).toBe(true) // usage.credits 上报开关
    expect(body.include_published_date).toBe(true) // published_date 上报开关
  })

  it("未知国别 / fast 深度的 safeSearch 被丢弃并记录", async () => {
    const { http, calls } = mockHttp(() => jsonRes(200, { results: [] }))
    const adapter = createTavilyAdapter({ options: { search_depth: "fast" } })
    const out = await adapter.search({
      request: { query: "q", country: "ZZ", safeSearch: true },
      key: KEY,
      http,
    })
    const body = calls[0].body as Record<string, unknown>
    expect(body.country).toBeUndefined()
    expect(body.safe_search).toBeUndefined()
    const dropped = (out as { droppedParams?: string[] }).droppedParams ?? []
    expect(dropped).toContain("country")
    expect(dropped).toContain("safeSearch")
  })
})

describe("tavily adapter — response mapping", () => {
  it("results → SearchResult（score / published_date / rank / keyId），容错缺失字段", async () => {
    const { http } = mockHttp(() =>
      jsonRes(200, {
        query: "x",
        results: [
          {
            url: "https://a.example/1",
            title: "A",
            content: "ctx a",
            score: 0.62,
            published_date: "2024-12-18T00:00:00",
          },
          { url: "https://b.example/2" }, // 无 title/content/score/published_date
          { title: "no url skipped" }, // 无 url → 跳过
        ],
        response_time: 1.2,
        usage: { credits: 2 },
      }),
    )
    const adapter = createTavilyAdapter()
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })

    expect(out.error).toBeUndefined()
    expect(out.results).toHaveLength(2)
    const [a, b] = out.results
    expect(a).toMatchObject({
      url: "https://a.example/1",
      title: "A",
      content: "ctx a",
      score: 0.62,
      provider: "tavily",
      rank: 1,
      keyId: KEY.id,
    })
    expect(a.time.published).toBe(Date.parse("2024-12-18T00:00:00")) // 毫秒
    expect(b.score).toBeUndefined()
    expect(b.time).toEqual({})
    expect(b.rank).toBe(2)
    expect(out.usage?.units).toBe(2) // 响应 usage.credits 优先
  })

  it("usage.credits 缺失时按配置估算（advanced=2 / basic=1，可覆盖）", async () => {
    const { http } = mockHttp(() => jsonRes(200, { results: [] }))
    const adv = createTavilyAdapter({ options: { search_depth: "advanced" } })
    const out1 = await adv.search({ request: { query: "x" }, key: KEY, http })
    expect(out1.usage?.units).toBe(2)

    const basic = createTavilyAdapter()
    const out2 = await basic.search({ request: { query: "x" }, key: KEY, http })
    expect(out2.usage?.units).toBe(1)

    const custom = createTavilyAdapter({ options: { search_depth: "advanced", cost_per_request: 5 } })
    const out3 = await custom.search({ request: { query: "x" }, key: KEY, http })
    expect(custom.cost({ query: "x" })).toBe(5)
    expect(out3.usage?.units).toBe(5)
  })

  it("空结果 / 缺 results 键 → 空数组无错误", async () => {
    const { http } = mockHttp(() => jsonRes(200, {}))
    const adapter = createTavilyAdapter()
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.results).toEqual([])
    expect(out.error).toBeUndefined()
  })
})

describe("tavily adapter — error mapping", () => {
  const adapter = createTavilyAdapter()

  it("429 → RATE_LIMIT + retryAfterMs（Retry-After 秒数）", async () => {
    const { http } = mockHttp(() =>
      jsonRes(429, { detail: { error: "excessive requests" } }, { "Retry-After": "60" }),
    )
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.results).toEqual([])
    expect(out.error).toMatchObject({
      code: "RATE_LIMIT",
      provider: "tavily",
      httpStatus: 429,
      retryAfterMs: 60000,
    })
    expect(out.error?.message).toContain("excessive requests")
  })

  it("401 → AUTH", async () => {
    const { http } = mockHttp(() => jsonRes(401, { detail: { error: "invalid api key" } }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "AUTH", httpStatus: 401 })
  })

  it("5xx → SERVER_ERROR", async () => {
    const { http } = mockHttp(() => jsonRes(503, { detail: { error: "overloaded" } }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toMatchObject({ code: "SERVER_ERROR", httpStatus: 503 })
  })

  it("HttpClient 抛出的 ProviderError（NETWORK_ERROR）原样透传", async () => {
    const err = createProviderError({
      code: "NETWORK_ERROR",
      provider: "tavily",
      message: "network failure: ECONNREFUSED",
    })
    const { http } = mockHttp(() => {
      throw err
    })
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error).toBe(err)
    expect(out.results).toEqual([])
  })

  it("缺 key → AUTH（不发请求）", async () => {
    const { http, calls } = mockHttp(() => jsonRes(200, { results: [] }))
    const out = await adapter.search({ request: { query: "x" }, http })
    expect(calls).toHaveLength(0)
    expect(out.error).toMatchObject({ code: "AUTH", provider: "tavily" })
  })

  it("错误 message 不含明文 key", async () => {
    const { http } = mockHttp(() => jsonRes(401, { detail: { error: "invalid key tvly-test-0123456789abcdef" } }))
    const out = await adapter.search({ request: { query: "x" }, key: KEY, http })
    expect(out.error?.message).not.toContain(KEY.secret)
  })
})
