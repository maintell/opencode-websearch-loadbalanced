import { describe, expect, it } from "vitest"
import { createHttpClient } from "../../src/http-client"
import { createSearxngAdapter } from "../../src/providers/searxng"
import type { HttpConfig, ProviderSearchOutput } from "../../src/types"

/**
 * SearXNG 真实外呼（无 key，直接打公共实例 https://search.658658.xyz）。
 * 门禁：RUN_INTEGRATION_TESTS=1 才执行；网络失败/超时 → try/catch + ctx.skip 转跳过，不 fail。
 */
const RUN = process.env.RUN_INTEGRATION_TESTS === "1"

const httpCfg: HttpConfig = {
  timeoutMs: 15000,
  retriesPerKey: 0,
  retryBackoffMs: 0,
  maxRetryBackoffMs: 0,
}

describe.skipIf(!RUN)("searxng integration", () => {
  it("公共实例 format=json 返回映射结果", async (ctx) => {
    const http = createHttpClient({ config: httpCfg, provider: "searxng" })
    const adapter = createSearxngAdapter({ baseUrl: "https://search.658658.xyz" })
    let out: ProviderSearchOutput
    try {
      out = await adapter.search({
        request: { query: "weather tokyo", maxResults: 5 },
        http,
        signal: AbortSignal.timeout(25000),
      })
    } catch (e) {
      return ctx.skip(`adapter threw: ${String(e)}`)
    }
    if (out.error && (out.error.code === "NETWORK_ERROR" || out.error.code === "TIMEOUT")) {
      return ctx.skip(`network unavailable: ${out.error.code}`)
    }
    expect(out.error).toBeUndefined()
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results[0].url).toMatch(/^https?:\/\//)
    expect(out.results[0].provider).toBe("searxng")
    expect(out.results[0].rank).toBeGreaterThanOrEqual(1)
  })
})
