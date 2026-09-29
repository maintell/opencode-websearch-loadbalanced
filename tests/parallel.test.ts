import { describe, expect, it } from "vitest"
import { createParallelAdapter } from "../src/providers/parallel"
import { createProviderError } from "../src/utils/errors"
import type { HttpClient, HttpRequest, ProviderSearchInput } from "../src/types"

/* ---- mock HttpClient（注入假响应，不外呼） ---- */

interface MockReply {
  status?: number
  body?: unknown
  /** 直接给原始文本（测非 JSON body） */
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

const KEY = { id: "parallel:abcdef12", secret: "sk-test-abcdef1234567890" }

function input(http: HttpClient, over: Partial<ProviderSearchInput> = {}): ProviderSearchInput {
  return { request: { query: "rust async runtime" }, key: KEY, http, ...over }
}

const OK_BODY = {
  search_id: "search_123",
  results: [
    {
      url: "https://example.com/a",
      title: "A",
      publish_date: "2025-11-19",
      excerpts: ["excerpt one", "excerpt two"],
    },
    { url: "https://example.com/b", title: "B", publish_date: null, excerpts: [] },
  ],
  warnings: null,
  usage: [{ name: "sku_search", count: 1 }],
  session_id: "session_1",
}

describe("parallel adapter：请求映射", () => {
  it("POST /v1/search + x-api-key + search_queries + 默认 mode=turbo", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    const out = await createParallelAdapter().search(input(http))
    expect(out.error).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://api.parallel.ai/v1/search")
    expect(calls[0].method).toBe("POST")
    expect(calls[0].headers?.["x-api-key"]).toBe(KEY.secret)
    const body = calls[0].body as Record<string, unknown>
    expect(body.search_queries).toEqual(["rust async runtime"])
    expect(body.mode).toBe("turbo") // 默认 turbo，非上游默认 advanced
  })

  it("mode 可配置（不写死），baseUrl 可覆盖", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    await createParallelAdapter({ mode: "fast", baseUrl: "https://proxy.internal/parallel/" }).search(
      input(http),
    )
    expect(calls[0].url).toBe("https://proxy.internal/parallel/v1/search")
    expect((calls[0].body as Record<string, unknown>).mode).toBe("fast")
  })

  it("maxResults>20 裁剪到 20；startDate/includeDomains → source_policy", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    await createParallelAdapter().search(
      input(http, {
        request: {
          query: "q",
          maxResults: 50,
          startDate: "2026-01-01",
          includeDomains: ["example.com"],
          excludeDomains: ["spam.example.com"],
          country: "jp",
        },
      }),
    )
    const adv = (calls[0].body as { advanced_settings: Record<string, unknown> }).advanced_settings
    expect(adv.max_results).toBe(20)
    expect(adv.location).toBe("jp")
    expect(adv.source_policy).toEqual({
      after_date: "2026-01-01",
      include_domains: ["example.com"],
      exclude_domains: ["spam.example.com"],
    })
  })
})

describe("parallel adapter：响应映射", () => {
  it("url/title/excerpts.join→content/publish_date→毫秒/rank/provider/keyId，无 score", async () => {
    const { http } = mockHttp(() => ({ body: OK_BODY }))
    const out = await createParallelAdapter().search(input(http))
    expect(out.results).toHaveLength(2)
    const [a, b] = out.results
    expect(a).toMatchObject({
      url: "https://example.com/a",
      title: "A",
      content: "excerpt one\nexcerpt two",
      time: { published: Date.parse("2025-11-19") },
      provider: "parallel",
      rank: 1,
      keyId: KEY.id,
    })
    expect(a.score).toBeUndefined() // 上游无 score，不发明
    expect(b.time).toEqual({}) // publish_date null → 无 published
    expect(b.content).toBeUndefined() // 空 excerpts → 无 content
    expect(b.rank).toBe(2)
    expect(out.usage).toEqual({ units: 1, detail: expect.any(String) })
  })

  it("字段缺失容错：无 results 键 / 缺 url 条目 / 非对象条目", async () => {
    const { http } = mockHttp(() => ({
      body: { results: [{ title: "no-url" }, "junk", { url: "https://ok.example/", excerpts: ["x"] }] },
    }))
    const out = await createParallelAdapter().search(input(http))
    expect(out.error).toBeUndefined()
    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({ url: "https://ok.example/", content: "x", rank: 3 })
    expect(out.results[0].title).toBeUndefined()

    const empty = await createParallelAdapter().search(
      input(mockHttp(() => ({ body: {} })).http),
    )
    expect(empty.error).toBeUndefined()
    expect(empty.results).toEqual([])
  })
})

describe("parallel adapter：错误映射", () => {
  it("429 → RATE_LIMIT + Retry-After 换算 ms", async () => {
    const { http } = mockHttp(() => ({
      status: 429,
      headers: { "Retry-After": "7" },
      body: { error: { message: "rate limited", detail: {} } },
    }))
    const out = await createParallelAdapter().search(input(http))
    expect(out.results).toEqual([])
    expect(out.error).toMatchObject({
      code: "RATE_LIMIT",
      provider: "parallel",
      httpStatus: 429,
      retryAfterMs: 7000,
      keyId: KEY.id,
    })
  })

  it("429 无 Retry-After → RATE_LIMIT 且 retryAfterMs 缺省（router 退避兜底）", async () => {
    const { http } = mockHttp(() => ({ status: 429, body: { error: { message: "slow down" } } }))
    const out = await createParallelAdapter().search(input(http))
    expect(out.error?.code).toBe("RATE_LIMIT")
    expect(out.error?.retryAfterMs).toBeUndefined()
  })

  it("401 → AUTH", async () => {
    const { http } = mockHttp(() => ({
      status: 401,
      body: { error: { message: "invalid api key", detail: {} } },
    }))
    const out = await createParallelAdapter().search(input(http))
    expect(out.error).toMatchObject({ code: "AUTH", httpStatus: 401, provider: "parallel" })
  })

  it("5xx → SERVER_ERROR", async () => {
    const { http } = mockHttp(() => ({ status: 503, body: { error: { message: "upstream down" } } }))
    const out = await createParallelAdapter().search(input(http))
    expect(out.error).toMatchObject({ code: "SERVER_ERROR", httpStatus: 503 })
  })

  it("网络错误（fetch 抛非 ProviderError）→ NETWORK_ERROR", async () => {
    const { http } = mockHttp(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:443")
    })
    const out = await createParallelAdapter().search(input(http))
    expect(out.results).toEqual([])
    expect(out.error).toMatchObject({ code: "NETWORK_ERROR", provider: "parallel", keyId: KEY.id })
  })

  it("http-client 抛出的 ProviderError 原样透传并归一 provider/keyId", async () => {
    const thrown = createProviderError({
      code: "TIMEOUT",
      provider: "parallel",
      message: "timeout after 8000ms",
    })
    const { http } = mockHttp(() => {
      throw thrown
    })
    const out = await createParallelAdapter().search(input(http))
    expect(out.error).toMatchObject({ code: "TIMEOUT", provider: "parallel", keyId: KEY.id })
  })

  it("无 key 防御分支 → 不发请求", async () => {
    const { http, calls } = mockHttp(() => ({ body: OK_BODY }))
    const out = await createParallelAdapter().search({ request: { query: "q" }, http })
    expect(calls).toHaveLength(0)
    expect(out.error?.code).toBe("BAD_REQUEST")
  })
})
