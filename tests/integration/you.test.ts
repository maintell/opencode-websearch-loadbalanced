/**
 * You.com 真实网络冒烟（默认不跑）：
 *  - RUN_INTEGRATION_TESTS=1 才执行
 *  - 需 YOU_API_KEY_TEST；缺失 skip（不 fail）
 *  - 网络失败 / 上游错误一律 skip（不 fail）——单测已覆盖错误映射，本文件只验证真实链路
 */
import { describe, expect, it } from "vitest"
import type { ProviderSearchOutput } from "../../src/types"
import { createHttpClient } from "../../src/http-client"
import { createYouAdapter } from "../../src/providers/you"

const RUN = process.env.RUN_INTEGRATION_TESTS === "1"
const KEY = process.env.YOU_API_KEY_TEST

describe.skipIf(!RUN || !KEY)("you integration", () => {
  const http = createHttpClient({
    provider: "you",
    config: { timeoutMs: 15000, retriesPerKey: 0, retryBackoffMs: 200, maxRetryBackoffMs: 1000 },
  })
  const adapter = createYouAdapter()

  it("真实搜索返回归一结果", async (ctx) => {
    let out: ProviderSearchOutput
    try {
      out = await adapter.search({
        request: { query: "TypeScript", maxResults: 3 },
        key: { id: "you:integration", secret: KEY as string },
        http,
      })
    } catch {
      ctx.skip("network failure")
      return
    }
    if (out.error) {
      ctx.skip(`upstream: ${out.error.code}`)
      return
    }
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results[0].provider).toBe("you")
    expect(out.results[0].url).toMatch(/^https?:\/\//)
    expect(out.results[0].rank).toBeGreaterThanOrEqual(1)
  })
})
