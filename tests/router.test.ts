/**
 * router 真实逻辑测试（mock provider + 注入 clock/sleep，零网络请求）。
 * 覆盖：key round-robin、429 冷却切 key、401 禁用切 key、provider fallback、
 * searxng 最终 fallback、全挂脱敏抛错、budget 前置闸与月度重置、缓存命中不耗预算、
 * 跨 provider 排序与 URL 去重、round_robin 策略。
 */
import { describe, expect, it } from "vitest"
import { createRouter, isRouterError, rankAndDedupe, RouterError, type RetryPolicy, type SearchProvider } from "../src/router"
import { createMonthlyBudgetManager, periodOf } from "../src/budget"
import { createCache } from "../src/cache"
import { createCircuitBreaker } from "../src/circuit-breaker"
import { resolveConfig, resolveProviderKeys } from "../src/config"
import { createKeyPool } from "../src/key-pool"
import type {
  ErrorCode,
  HttpClient,
  ProviderID,
  ProviderSearchInput,
  ProviderSearchOutput,
  ProviderError,
  SearchResult,
  WebSearchPluginOptions,
} from "../src/types"
import { fingerprint } from "../src/utils/logging"

/* ---------- 测试夹具 ---------- */

// sk- 前缀 + ≥16 位：命中 redact() 的 key 形态模式，另经 resolveProviderKeys 注册进 secret 池
const S1 = "sk-alpha111111111111"
const S2 = "sk-bravo222222222222"
const S3 = "sk-charlie3333333333"

type AdapterOut = ProviderSearchOutput & { droppedParams?: string[] }
type Handler = (input: ProviderSearchInput) => AdapterOut | Promise<AdapterOut>

function provider(id: ProviderID, handler: Handler, opts: { requiresKey?: boolean } = {}): SearchProvider {
  return {
    id,
    displayName: id,
    requiresKey: opts.requiresKey ?? id !== "searxng",
    cost: () => 1,
    search: async (input) => handler(input),
  }
}

function ok(url: string, over: Partial<SearchResult> = {}): SearchResult {
  return { url, title: "title", time: {}, provider: "exa", rank: 1, ...over }
}

/** 刻意用裸 ProviderError 字面量（绕过 createProviderError），验证 router 出厂时自行脱敏；drops 模拟交叉类型上报 */
function errOut(
  code: ErrorCode,
  p: ProviderID,
  message: string,
  extra: Partial<ProviderError> = {},
  drops?: string[],
): AdapterOut {
  const out: AdapterOut = { results: [], error: { code, provider: p, message, ...extra } }
  if (drops) out.droppedParams = drops
  return out
}

function at(year: number, month: number, day = 1, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime()
}

interface SetupOpts {
  providers: Partial<Record<ProviderID, SearchProvider>>
  options?: WebSearchPluginOptions
  env?: Record<string, string | undefined>
  now?: () => number
  retry?: Partial<RetryPolicy>
  cache?: boolean
}

function setup(opts: SetupOpts) {
  const now = opts.now ?? (() => Date.now())
  const env = opts.env ?? {}
  const { resolved, errors } = resolveConfig(opts.options ?? {}, { env, now })
  expect(errors).toEqual([])
  const keys = resolveProviderKeys(resolved, env)
  const keyPool = createKeyPool({ config: resolved.keyPool, keys, now })
  const circuitBreaker = createCircuitBreaker({ config: resolved.circuitBreaker, now })
  const budget = createMonthlyBudgetManager({ config: resolved.budget, now })
  const cache = opts.cache ? createCache<SearchResult[]>(resolved.cache, now) : undefined
  // 默认注入「记录式 sleep」：不真等待，断言退避序列
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
  }
  const http: HttpClient = {
    request: () => Promise.reject(new Error("router 单测禁止真实网络请求")),
    parseRetryAfter: () => undefined,
  }
  const router = createRouter({
    config: resolved,
    providers: opts.providers,
    keyPool,
    circuitBreaker,
    budget,
    http,
    now,
    sleep,
    cache,
    retry: opts.retry,
  })
  return { router, keyPool, circuitBreaker, budget, sleeps, resolved }
}

/* ---------- key 轮换与错误分类 ---------- */

describe("router：key 轮换与错误分类", () => {
  it("key round-robin：key1→key2→key3→key1", async () => {
    const seen: Array<string | undefined> = []
    const p = provider("exa", (input) => {
      seen.push(input.key?.id)
      return { results: [ok("https://a.example/1")] }
    })
    const { router } = setup({
      providers: { exa: p },
      env: { K1: S1, K2: S2, K3: S3 },
      options: { providers: { exa: { enabled: true, keys: ["K1", "K2", "K3"] } } },
    })
    for (let i = 0; i < 4; i++) await router.route({ query: `q${i}` })
    expect(seen).toEqual([fingerprint("exa", S1), fingerprint("exa", S2), fingerprint("exa", S3), fingerprint("exa", S1)])
  })

  it("429：当前 key 按 Retry-After 冷却后立即切下一个 key（不退避等待）", async () => {
    const k1 = fingerprint("exa", S1)
    const k2 = fingerprint("exa", S2)
    const seen: Array<string | undefined> = []
    const p = provider("exa", (input) => {
      seen.push(input.key?.id)
      if (input.key?.id === k1) {
        return errOut("RATE_LIMIT", "exa", "429 too many requests", { httpStatus: 429, retryAfterMs: 1234 })
      }
      return { results: [ok("https://a.example/x")] }
    })
    const t0 = at(2026, 9, 15)
    const { router, keyPool, sleeps } = setup({
      providers: { exa: p },
      env: { K1: S1, K2: S2 },
      options: { providers: { exa: { enabled: true, keys: ["K1", "K2"] } } },
      now: () => t0,
    })
    const res = await router.route({ query: "q" })
    expect(seen).toEqual([k1, k2])
    expect(res.attempts.map((a) => a.outcome)).toEqual(["error", "ok"])
    expect(res.attempts[0].error?.code).toBe("RATE_LIMIT")
    expect(res.attempts[0].error?.retryAfterMs).toBe(1234)
    expect(res.keyId).toBe(k2)
    expect(res.results[0].keyId).toBe(k2)
    expect(sleeps).toEqual([]) // 健康 key 立即接管，不做退避
    const st = keyPool.states("exa").find((s) => s.keyId === k1)
    expect(st?.status).toBe("cooldown")
    expect(st?.cooldownUntil).toBe(t0 + 1234) // Retry-After 优先于指数退避
  })

  it("401：key 禁用（不自动恢复）后用 key2 成功", async () => {
    const k1 = fingerprint("exa", S1)
    const k2 = fingerprint("exa", S2)
    const seen: Array<string | undefined> = []
    const p = provider("exa", (input) => {
      seen.push(input.key?.id)
      if (input.key?.id === k1) return errOut("AUTH", "exa", "401 unauthorized", { httpStatus: 401 })
      return { results: [ok("https://a.example/y")] }
    })
    const { router, keyPool } = setup({
      providers: { exa: p },
      env: { K1: S1, K2: S2 },
      options: { providers: { exa: { enabled: true, keys: ["K1", "K2"] } } },
    })
    const res = await router.route({ query: "q" })
    expect(seen).toEqual([k1, k2])
    expect(res.results).toHaveLength(1)
    expect(res.keyId).toBe(k2)
    const st = keyPool.states("exa").find((s) => s.keyId === k1)
    expect(st?.status).toBe("disabled")
    expect(st?.disabledReason).toBe("auth_401_403")
  })
})

/* ---------- provider fallback 与最终兜底 ---------- */

describe("router：provider fallback", () => {
  it("A 全 key 失败（5xx 指数退避）→ 切 B 成功", async () => {
    const exa = provider("exa", () => errOut("SERVER_ERROR", "exa", "500 boom", { httpStatus: 500 }))
    const tavily = provider("tavily", () => ({ results: [ok("https://b.example/1", { provider: "tavily" })] }))
    const { router, sleeps } = setup({
      providers: { exa, tavily },
      env: { E: S1, E2: S2, T: S3 },
      options: {
        providers: {
          exa: { enabled: true, keys: ["E", "E2"] },
          tavily: { enabled: true, keys: ["T"] },
        },
      },
    })
    const res = await router.route({ query: "q" })
    expect(res.results[0].provider).toBe("tavily")
    const exaAttempts = res.attempts.filter((a) => a.provider === "exa")
    expect(exaAttempts).toHaveLength(3) // retriesPerKey=2 → maxAttempts=3，两个 key 轮换打满
    expect(exaAttempts.every((a) => a.outcome === "error" && a.error?.code === "SERVER_ERROR")).toBe(true)
    expect(res.attempts.at(-1)).toMatchObject({ provider: "tavily", outcome: "ok" })
    expect(sleeps).toEqual([400, 800]) // backoffDelay：base=400，指数封顶 max
  })

  it("全部商业 provider 失败 → 必试 searxng 成功；BAD_REQUEST 不重试", async () => {
    const commercial: ProviderID[] = ["parallel", "exa", "tavily", "you", "serpapi"]
    const mocks: Partial<Record<ProviderID, SearchProvider>> = {}
    const env: Record<string, string | undefined> = {}
    const options: WebSearchPluginOptions = { providers: {} }
    for (const id of commercial) {
      const envName = `${id.toUpperCase()}_KEY`
      env[envName] = `sk-${id}000000000000000`
      mocks[id] = provider(id, () => errOut("BAD_REQUEST", id, "400 bad", { httpStatus: 400 }))
      options.providers![id] = { enabled: true, keys: [envName] }
    }
    mocks.searxng = provider("searxng", () => ({ results: [ok("https://s.example/1", { provider: "searxng" })] }))
    options.providers!.searxng = { enabled: true }

    const { router, sleeps } = setup({ providers: mocks, env, options })
    const res = await router.route({ query: "q" })
    expect(res.results[0].provider).toBe("searxng")
    expect(res.attempts.map((a) => a.provider)).toEqual([...commercial, "searxng"])
    for (const id of commercial) {
      const tries = res.attempts.filter((a) => a.provider === id)
      expect(tries).toHaveLength(1) // BAD_REQUEST：不重试、不切 key
      expect(tries[0].error?.code).toBe("BAD_REQUEST")
    }
    expect(res.attempts.at(-1)).toMatchObject({ provider: "searxng", outcome: "ok" })
    expect(sleeps).toEqual([])
  })

  it("全部失败 → 抛 RouterError，message 与 attempt 轨迹不含 key 明文", async () => {
    const exa = provider("exa", () => errOut("AUTH", "exa", `bad key ${S1}`, { httpStatus: 401 }))
    const searxng = provider("searxng", () => errOut("UNKNOWN", "searxng", "403 html page", { httpStatus: 403 }))
    const { router } = setup({
      providers: { exa, searxng },
      env: { E: S1 },
      options: { providers: { exa: { enabled: true, keys: ["E"] }, searxng: { enabled: true } } },
    })
    let thrown: unknown
    try {
      await router.route({ query: "q" })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(RouterError)
    expect(isRouterError(thrown)).toBe(true)
    const err = thrown as RouterError
    expect(err.message).toContain("exa:AUTH/401")
    expect(err.message).not.toContain(S1) // message 已脱敏
    expect(err.message).not.toContain(S1.slice(3))
    expect(JSON.stringify(err.attempts)).not.toContain(S1) // 轨迹只带 keyId
    expect(err.attempts[0].error?.keyId).toBe(fingerprint("exa", S1))
    expect(err.attempts.map((a) => a.provider)).toEqual(["exa", "searxng"])
  })
})

/* ---------- budget 前置闸与周期滚动 ---------- */

describe("router：budget", () => {
  it("耗尽即 skip：used=4999 允许第 5000 次，5000 后跳过", async () => {
    const exa = provider("exa", () => ({ results: [ok("https://a.example/1")] }))
    const searxng = provider("searxng", () => ({ results: [ok("https://s.example/1", { provider: "searxng" })] }))
    const t = at(2026, 9, 15)
    const { router, budget } = setup({
      providers: { exa, searxng },
      env: { E: S1 },
      options: {
        providers: { exa: { enabled: true, keys: ["E"] }, searxng: { enabled: true } },
        budget: { enabled: true, unit: "requests", countMode: "attempt", limits: [{ scope: "provider", target: "exa", limit: 5000 }] },
      },
      now: () => t,
    })
    const period = periodOf(t)
    budget.restore({
      period,
      entries: {
        [`provider:exa:${period}`]: { scope: "provider", target: "exa", period, limit: 5000, used: 4999, unit: "requests" },
      },
      forced: {},
    })

    const r1 = await router.route({ query: "q1" })
    expect(r1.attempts[0]).toMatchObject({ provider: "exa", outcome: "ok" })
    expect(budget.entries().find((e) => e.scope === "provider")?.used).toBe(5000)

    const r2 = await router.route({ query: "q2" })
    expect(r2.attempts[0]).toMatchObject({ provider: "exa", outcome: "skipped", skippedReason: "budget_exhausted" })
    expect(r2.results[0].provider).toBe("searxng") // 耗尽后落到最终 fallback
    expect(r2.warnings.some((w) => w.includes("budget exhausted"))).toBe(true)
  })

  it("月度重置：2026-09 额度耗尽 → 2026-10 新额度可用", async () => {
    const exa = provider("exa", () => ({ results: [ok("https://a.example/1")] }))
    const searxng = provider("searxng", () => ({ results: [ok("https://s.example/1", { provider: "searxng" })] }))
    let t = at(2026, 9, 30)
    const { router, budget } = setup({
      providers: { exa, searxng },
      env: { E: S1 },
      options: {
        providers: { exa: { enabled: true, keys: ["E"] }, searxng: { enabled: true } },
        budget: { enabled: true, unit: "requests", countMode: "attempt", limits: [{ scope: "provider", target: "exa", limit: 1 }] },
      },
      now: () => t,
    })

    const r1 = await router.route({ query: "sep-1" })
    expect(r1.attempts[0]).toMatchObject({ provider: "exa", outcome: "ok" })
    const r2 = await router.route({ query: "sep-2" })
    expect(r2.attempts[0]).toMatchObject({ provider: "exa", outcome: "skipped", skippedReason: "budget_exhausted" })
    expect(r2.results[0].provider).toBe("searxng")
    expect(budget.serialize().period).toBe("2026-09")

    t = at(2026, 10, 1) // 跨月：周期滚动，额度重置
    const r3 = await router.route({ query: "oct-1" })
    expect(r3.attempts[0]).toMatchObject({ provider: "exa", outcome: "ok" })
    expect(r3.results[0].provider).toBe("exa")
    expect(budget.serialize().period).toBe("2026-10")
    expect(budget.entries().find((e) => e.scope === "provider")?.used).toBe(1)
  })

  it("cache 命中排在 budget 闸之前：不消耗额度、不再调用 provider", async () => {
    let calls = 0
    const exa = provider("exa", () => {
      calls++
      return { results: [ok("https://a.example/1")] }
    })
    const { router, budget } = setup({
      providers: { exa },
      env: { E: S1 },
      options: {
        providers: { exa: { enabled: true, keys: ["E"] } },
        budget: { enabled: true, unit: "requests", countMode: "attempt", limits: [{ scope: "provider", target: "exa", limit: 1 }] },
        cache: { ttlMs: 60_000, maxEntries: 16 },
      },
      cache: true,
    })
    const r1 = await router.route({ query: "same" })
    expect(r1.cacheHit).toBe(false)
    expect(calls).toBe(1)

    const r2 = await router.route({ query: "same" }) // 额度已满，但缓存命中在闸之前
    expect(r2.cacheHit).toBe(true)
    expect(r2.cached).toBe(true)
    expect(r2.attempts).toHaveLength(1)
    expect(r2.attempts[0].outcome).toBe("ok")
    expect(calls).toBe(1)
    expect(budget.entries().find((e) => e.scope === "provider")?.used).toBe(1) // 未消耗
    expect(r2.results).toHaveLength(1)
  })
})

/* ---------- 裁决②：budget 成功后记一次，usage 权重优先不叠加 ---------- */

describe("router：budget 计数口径（裁决②）", () => {
  it("失败不计数；成功记一次且 usage 权重优先（credits 不叠加 attempt=1）", async () => {
    let n = 0
    const tavily = provider("tavily", () => {
      n++
      if (n === 1) return errOut("BAD_REQUEST", "tavily", "400 bad", { httpStatus: 400 })
      return { results: [ok("https://t.example/1", { provider: "tavily" })], usage: { units: 2, detail: "credits" } }
    })
    const searxng = provider("searxng", () => ({ results: [ok("https://s.example/1", { provider: "searxng" })] }))
    const t = at(2026, 9, 15)
    const { router, budget } = setup({
      providers: { tavily, searxng },
      env: { T: S1 },
      options: {
        providers: { tavily: { enabled: true, keys: ["T"] }, searxng: { enabled: true } },
        budget: {
          enabled: true,
          unit: "credits",
          countMode: "attempt",
          limits: [{ scope: "provider", target: "tavily", limit: 5 }],
        },
      },
      now: () => t,
    })
    const used = () => budget.entries().find((e) => e.scope === "provider")?.used ?? 0

    // 失败不消耗预算（BAD_REQUEST 不重试 → 落到 searxng）
    const r1 = await router.route({ query: "q1" })
    expect(r1.attempts[0]).toMatchObject({ provider: "tavily", outcome: "error" })
    expect(r1.results[0].provider).toBe("searxng")
    expect(used()).toBe(0)

    // 成功：记 usage.units=2（若叠加 attempt=1 会是 3）
    await router.route({ query: "q2" })
    expect(used()).toBe(2)
    await router.route({ query: "q3" })
    expect(used()).toBe(4) // 4 ≤ 5 仍可用
    await router.route({ query: "q4" })
    expect(used()).toBe(6) // 成功后越过 limit → 下次闸

    const r5 = await router.route({ query: "q5" })
    expect(r5.attempts[0]).toMatchObject({ provider: "tavily", outcome: "skipped", skippedReason: "budget_exhausted" })
    expect(r5.results[0].provider).toBe("searxng")
  })
})

/* ---------- 追加裁决（Provider A）---------- */

describe("router：usage 量纲分流（裁决 A①）", () => {
  it("parallel 的 request 口径 usage 在 credits 模式不换算；exa 无 usage 默认 1", async () => {
    const t = at(2026, 9, 15)
    // parallel 上报 usage.units=3（request 口径）→ unit=credits 下禁止换算，只计 1
    const parallel = provider("parallel", () => ({
      results: [ok("https://p.example/1", { provider: "parallel" })],
      usage: { units: 3, detail: '[{"name":"search","count":3}]' },
    }))
    const a = setup({
      providers: { parallel },
      env: { P: S1 },
      options: {
        providers: { parallel: { enabled: true, keys: ["P"] } },
        budget: { enabled: true, unit: "credits", countMode: "attempt", limits: [{ scope: "provider", target: "parallel", limit: 5 }] },
      },
      now: () => t,
    })
    await a.router.route({ query: "q1" })
    const used = (b: typeof a.budget) => b.entries().find((e) => e.scope === "provider")?.used
    expect(used(a.budget)).toBe(1) // 3 → 1：跨量纲不换算
    await a.router.route({ query: "q2" })
    expect(used(a.budget)).toBe(2)

    // exa 不报 usage → 按 countMode 默认 1 次
    const exa = provider("exa", () => ({ results: [ok("https://a.example/1")] }))
    const b = setup({
      providers: { exa },
      env: { E: S1 },
      options: {
        providers: { exa: { enabled: true, keys: ["E"] } },
        budget: { enabled: true, unit: "credits", countMode: "attempt", limits: [{ scope: "provider", target: "exa", limit: 5 }] },
      },
      now: () => t,
    })
    await b.router.route({ query: "q" })
    expect(b.budget.entries().find((e) => e.scope === "provider")?.used).toBe(1)
  })

  it("tavily 上报的 credits 仍是唯一可信 credits 源", async () => {
    const t = at(2026, 9, 15)
    const tavily = provider("tavily", () => ({
      results: [ok("https://t.example/1", { provider: "tavily" })],
      usage: { units: 2, detail: "credits(response)" },
    }))
    const s = setup({
      providers: { tavily },
      env: { T: S1 },
      options: {
        providers: { tavily: { enabled: true, keys: ["T"] } },
        budget: { enabled: true, unit: "credits", countMode: "attempt", limits: [{ scope: "provider", target: "tavily", limit: 5 }] },
      },
      now: () => t,
    })
    await s.router.route({ query: "q1" })
    expect(s.budget.entries().find((e) => e.scope === "provider")?.used).toBe(2)
  })
})

describe("router：408 归类（裁决 A②）", () => {
  it("408 → SERVER_ERROR（retryable）：退避一次后同 key 重试成功", async () => {
    let n = 0
    const exa = provider("exa", () => {
      n++
      // classifyStatus 现状：408 → UNKNOWN + httpStatus=408
      if (n === 1) return errOut("UNKNOWN", "exa", "408 request timeout", { httpStatus: 408 })
      return { results: [ok("https://a.example/1")] }
    })
    const { router, sleeps } = setup({
      providers: { exa },
      env: { E: S1 },
      options: { providers: { exa: { enabled: true, keys: ["E"] } } },
    })
    const res = await router.route({ query: "q" })
    expect(res.attempts).toHaveLength(2)
    expect(res.attempts[0]).toMatchObject({ outcome: "error" })
    expect(res.attempts[0].error?.code).toBe("SERVER_ERROR") // router 出厂归一（选 SERVER_ERROR，非 TIMEOUT）
    expect(res.attempts[0].error?.httpStatus).toBe(408) // 原始状态保留
    expect(sleeps).toEqual([400]) // retryable → 指数退避兜底
    expect(res.results).toHaveLength(1)
    expect(res.results[0].provider).toBe("exa")
  })
})

/* ---------- 追加裁决①：UNKNOWN 不计熔断（以 countsTowardCircuit 代码为准） ---------- */

describe("router：UNKNOWN 不计熔断（追加裁决①）", () => {
  it("searxng 403=UNKNOWN 反复出现：不开电路、从不 skipped(circuit_open)", async () => {
    let calls = 0
    const searxng = provider("searxng", () => {
      calls++
      return errOut("UNKNOWN", "searxng", "403 html page", { httpStatus: 403 })
    })
    const { router, circuitBreaker } = setup({
      providers: { searxng },
      options: { providers: { searxng: { enabled: true } } },
    })
    for (let i = 0; i < 4; i++) {
      await router.route({ query: `q${i}` }).catch((e) => expect(isRouterError(e)).toBe(true)) // 全挂 → 抛错
      expect(circuitBreaker.view("searxng").state).toBe("CLOSED") // 超过 failureThreshold=3 仍 CLOSED
    }
    expect(calls).toBe(4) // 每轮都真实派发，无一次被熔断闸拦截
  })

  it("HALF_OPEN 探测遇 UNKNOWN：结算探测名额、不误开电路、可恢复 CLOSED", async () => {
    let calls = 0
    const exa = provider("exa", () => {
      calls++
      return errOut("UNKNOWN", "exa", "weird upstream", { httpStatus: 418 })
    })
    const searxng = provider("searxng", () => ({ results: [ok("https://s.example/1", { provider: "searxng" })] }))
    let t = at(2026, 9, 15)
    const { router, circuitBreaker } = setup({
      providers: { exa, searxng },
      env: { E: S1 },
      options: { providers: { exa: { enabled: true, keys: ["E"] }, searxng: { enabled: true } } },
      now: () => t,
    })
    // 打到 OPEN
    circuitBreaker.onFailure("exa", "SERVER_ERROR")
    circuitBreaker.onFailure("exa", "SERVER_ERROR")
    circuitBreaker.onFailure("exa", "SERVER_ERROR")
    expect(circuitBreaker.view("exa").state).toBe("OPEN")

    // openMs（默认 30000）到点 → 探测（第 1 次 HALF_OPEN 放行）
    t += 40_000
    const r1 = await router.route({ query: "q1" })
    expect(calls).toBe(1)
    expect(r1.attempts[0]).toMatchObject({ provider: "exa", outcome: "error" })
    const v1 = circuitBreaker.view("exa")
    expect(v1.state).toBe("HALF_OPEN") // UNKNOWN 不触发 reopen
    expect(v1.consecutiveSuccesses).toBe(1) // 名额按 onSuccess 结算（不泄漏）

    // 第 2 次探测仍可放行（名额已释放）→ 连续 2 次结算 → CLOSED
    const r2 = await router.route({ query: "q2" })
    expect(calls).toBe(2)
    expect(r2.attempts[0]).toMatchObject({ provider: "exa", outcome: "error" })
    expect(circuitBreaker.view("exa").state).toBe("CLOSED")
    expect(r1.results[0].provider).toBe("searxng")
    expect(r2.results[0].provider).toBe("searxng")
  })
})

/* ---------- 路由策略 ---------- */

describe("router：策略", () => {
  it("priority（默认）：按 priority 升序起手，searxng 恒定压尾", async () => {
    const exa = provider("exa", () => ({ results: [ok("https://a.example/1")] }))
    const tavily = provider("tavily", () => ({ results: [ok("https://b.example/1", { provider: "tavily" })] }))
    const { router } = setup({
      providers: { exa, tavily },
      env: { E: S1, T: S2 },
      options: { providers: { exa: { enabled: true, keys: ["E"] }, tavily: { enabled: true, keys: ["T"] } } },
    })
    const res = await router.route({ query: "q" })
    expect(res.attempts[0].provider).toBe("exa") // priority 20 < 30
    expect(res.results[0].provider).toBe("exa")
  })

  it("round_robin：每轮从不同 provider 起手", async () => {
    const exa = provider("exa", () => ({ results: [ok("https://a.example/1")] }))
    const tavily = provider("tavily", () => ({ results: [ok("https://b.example/1", { provider: "tavily" })] }))
    const { router } = setup({
      providers: { exa, tavily },
      env: { E: S1, T: S2 },
      options: {
        providers: { exa: { enabled: true, keys: ["E"] }, tavily: { enabled: true, keys: ["T"] } },
        routing: { strategy: "round_robin", maxProviderAttempts: 6 },
      },
    })
    const firsts: ProviderID[] = []
    for (let i = 0; i < 3; i++) {
      const res = await router.route({ query: `q${i}` })
      firsts.push(res.attempts[0].provider)
    }
    expect(firsts).toEqual(["exa", "tavily", "exa"])
  })

  it("circuit OPEN → skipped(circuit_open)，不消耗 key 状态", async () => {
    let calls = 0
    const exa = provider("exa", () => {
      calls++
      return { results: [ok("https://a.example/1")] }
    })
    const searxng = provider("searxng", () => ({ results: [ok("https://s.example/1", { provider: "searxng" })] }))
    const t = at(2026, 9, 15)
    const { router, circuitBreaker, keyPool } = setup({
      providers: { exa, searxng },
      env: { E: S1 },
      options: { providers: { exa: { enabled: true, keys: ["E"] }, searxng: { enabled: true } } },
      now: () => t,
    })
    circuitBreaker.onFailure("exa", "SERVER_ERROR")
    circuitBreaker.onFailure("exa", "SERVER_ERROR")
    circuitBreaker.onFailure("exa", "SERVER_ERROR") // failureThreshold=3 → OPEN
    expect(circuitBreaker.view("exa").state).toBe("OPEN")

    const res = await router.route({ query: "q" })
    expect(res.attempts[0]).toMatchObject({ provider: "exa", outcome: "skipped", skippedReason: "circuit_open" })
    expect(res.results[0].provider).toBe("searxng")
    expect(calls).toBe(0) // 未打上游
    expect(keyPool.states("exa")[0].consecutiveErrors).toBe(0) // key 状态未被 skip 消耗
  })
})

/* ---------- 排序与去重 ---------- */

function r(url: string, p: ProviderID, rank: number, published?: number): SearchResult {
  return { url, title: `${p}-${rank}`, time: published !== undefined ? { published } : {}, provider: p, rank }
}

describe("router：跨 provider 排序与去重", () => {
  it("dedup：exa/tavily/searxng 同 URL（含 fragment/tracking/尾斜杠差异）只留一份", () => {
    const out = rankAndDedupe([
      { provider: "exa", results: [r("https://example.com/a", "exa", 1, 100)] },
      { provider: "tavily", results: [r("https://example.com/a#section", "tavily", 1, 200)] },
      { provider: "searxng", results: [r("https://example.com/a/?utm_source=x", "searxng", 1, 300)] },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].providers).toEqual(["exa", "tavily", "searxng"])
    expect(out[0].title).toBe("exa-1") // 首见（层级高者）字段优先
    expect(out[0].time.published).toBe(100)
  })

  it("排序：provider 层级 > provider 内 rank > 新鲜度", () => {
    const out = rankAndDedupe([
      { provider: "exa", results: [r("https://x.test/old", "exa", 2, 1000)] },
      {
        provider: "tavily",
        results: [r("https://t.test/1", "tavily", 1, 9000), r("https://t.test/2", "tavily", 2, 8000)],
      },
    ])
    // 层级压倒 rank：exa rank2 仍在 tavily rank1 之前
    expect(out.map((o) => `${o.provider}:${o.rank}`)).toEqual(["exa:2", "tavily:1", "tavily:2"])

    // 同 provider 同 rank → 新鲜度兜底（新者在前）
    const fresh = rankAndDedupe([
      { provider: "exa", results: [r("https://x.test/1", "exa", 1, 1000), r("https://x.test/2", "exa", 1, 2000)] },
    ])
    expect(fresh.map((o) => o.url)).toEqual(["https://x.test/2", "https://x.test/1"])
  })
})

/* ---------- 裁决①③：droppedParams 透传 + warnings ---------- */

describe("router：droppedParams（裁决①③）", () => {
  it("serpapi 丢 time/domain 过滤：attempt 与 response 都带 droppedParams，warnings 记录", async () => {
    const drops = ["timeRange", "startDate", "includeDomains"]
    const serpapi = provider("serpapi", () => ({
      results: [ok("https://serp.example/1", { provider: "serpapi" })],
      droppedParams: drops,
    }))
    const { router } = setup({
      providers: { serpapi },
      env: { SP: S1 },
      options: { providers: { serpapi: { enabled: true, keys: ["SP"] } } },
    })
    const res = await router.route({ query: "q", timeRange: "day", includeDomains: ["x.com"] })
    expect(res.attempts[0].outcome).toBe("ok")
    expect(res.attempts[0].droppedParams).toEqual(drops) // 轨迹带
    expect(res.droppedParams).toEqual(drops) // 响应透传命中 attempt
    expect(res.warnings.some((w) => w.includes("serpapi: dropped params timeRange"))).toBe(true)
  })

  it("错误 attempt 同样携带 droppedParams（交叉类型透传）", async () => {
    const serpapi = provider("serpapi", () => errOut("SERVER_ERROR", "serpapi", "500", { httpStatus: 500 }, ["timeRange"]))
    const searxng = provider("searxng", () => ({ results: [ok("https://s.example/1", { provider: "searxng" })] }))
    const { router } = setup({
      providers: { serpapi, searxng },
      env: { SP: S1 },
      options: { providers: { serpapi: { enabled: true, keys: ["SP"] }, searxng: { enabled: true } } },
    })
    const res = await router.route({ query: "q", timeRange: "week" })
    expect(res.attempts[0].outcome).toBe("error")
    expect(res.attempts[0].droppedParams).toEqual(["timeRange"])
    // 响应级只透传命中（成功）attempt 的丢弃字段 → searxng 无 drops → undefined
    expect(res.droppedParams).toBeUndefined()
    expect(res.results[0].provider).toBe("searxng")
  })
})
