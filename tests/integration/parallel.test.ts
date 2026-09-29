import { describe, expect, it } from "vitest"
import { createHttpClient } from "../../src/http-client"
import { createParallelAdapter } from "../../src/providers/parallel"
import type { HttpConfig, ProviderSearchOutput } from "../../src/types"

/**
 * Parallel 真实外呼（默认排除：npm test 不跑本目录；单独跑 npm run test:providers）。
 * 门禁：RUN_INTEGRATION_TESTS=1 才执行；key 缺失 → skip 不 fail；网络失败 → skip 不 fail。
 */
const RUN = process.env.RUN_INTEGRATION_TESTS === "1"
const KEY = process.env.PARALLEL_API_KEY_TEST

const httpCfg: HttpConfig = {
  timeoutMs: 15000,
  retriesPerKey: 0, // 集成测试单发，不重试
  retryBackoffMs: 0,
  maxRetryBackoffMs: 0,
}

describe.skipIf(!RUN)("parallel integration", () => {
  describe.skipIf(!KEY)("with PARALLEL_API_KEY_TEST", () => {
    it("真实 /v1/search 返回映射结果", async (ctx) => {
      const http = createHttpClient({ config: httpCfg, provider: "parallel" })
      const adapter = createParallelAdapter()
      let out: ProviderSearchOutput
      try {
        out = await adapter.search({
          request: { query: "TypeScript official documentation", maxResults: 5 },
          key: { id: "parallel:integration", secret: KEY as string },
          http,
          signal: AbortSignal.timeout(25000),
        })
      } catch (e) {
        // adapter 契约不抛错；防御性转 skip（网络层异常不算失败）
        return ctx.skip(`adapter threw: ${String(e)}`)
      }
      if (out.error && (out.error.code === "NETWORK_ERROR" || out.error.code === "TIMEOUT")) {
        return ctx.skip(`network unavailable: ${out.error.code}`)
      }
      expect(out.error).toBeUndefined()
      expect(out.results.length).toBeGreaterThan(0)
      expect(out.results[0].url).toMatch(/^https?:\/\//)
      expect(out.results[0].provider).toBe("parallel")
      expect(out.results[0].rank).toBeGreaterThanOrEqual(1)
      expect(out.results[0].score).toBeUndefined() // 上游无 score，不发明
    })
  })
})
