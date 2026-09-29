import { describe, expect, it } from "vitest"
import { createKeyPool, type KeyPool } from "../src/key-pool"
import type { KeyPoolConfig, ResolvedKey } from "../src/types"

const CONFIG: KeyPoolConfig = {
  errorThreshold: 3,
  baseCooldownMs: 1_000,
  maxCooldownMs: 10_000,
}

const SECRET_A = "sk-test-aaaaaaaaaaaaaaaaaaaa"
const SECRET_B = "sk-test-bbbbbbbbbbbbbbbbbbbb"

function keys(...secrets: string[]): ResolvedKey[] {
  return secrets.map((s, i) => ({ id: `exa:${i.toString().padStart(8, "0")}`, secret: s }))
}

function make(nowValue = 0): { pool: KeyPool; advanceTo: (t: number) => void } {
  let t = nowValue
  const pool = createKeyPool({
    config: CONFIG,
    keys: { exa: keys(SECRET_A, SECRET_B) },
    now: () => t,
  })
  return { pool, advanceTo: (v) => (t = v) }
}

describe("key-pool round-robin", () => {
  it("依次返回各 active key 并循环", () => {
    const { pool } = make()
    expect(pool.next("exa")?.id).toBe("exa:00000000")
    expect(pool.next("exa")?.id).toBe("exa:00000001")
    expect(pool.next("exa")?.id).toBe("exa:00000000")
  })

  it("无配置 key 的 provider 返回 undefined", () => {
    const { pool } = make()
    expect(pool.next("tavily")).toBeUndefined()
    expect(pool.hasActive("tavily")).toBe(false)
  })
})

describe("key-pool 429 cooldown", () => {
  it("Retry-After 优先于退避", () => {
    const { pool, advanceTo } = make(1_000)
    pool.report("exa", "exa:00000000", "RATE_LIMIT", { retryAfterMs: 5_000, now: 1_000 })
    expect(pool.next("exa", 1_000)?.id).toBe("exa:00000001") // 冷却中的 key 被跳过
    expect(pool.next("exa", 1_000)?.id).toBe("exa:00000001") // 仅 1 把可用时只能重复它
    expect(pool.states("exa").find((s) => s.keyId === "exa:00000000")?.status).toBe("cooldown")
    advanceTo(6_000) // 1_000 + 5_000 到期
    expect(pool.hasActive("exa", 6_000)).toBe(true)
  })

  it("无 Retry-After 时按 base·2ⁿ 指数退避并封顶", () => {
    const { pool, advanceTo } = make(0)
    // 第 1 次：2^0 · 1000 = 1000
    pool.report("exa", "exa:00000000", "RATE_LIMIT", { now: 0 })
    expect(pool.states("exa")[0].cooldownUntil).toBe(1_000)
    advanceTo(1_000)
    // 第 2 次（consecutiveErrors=1）：2^1 · 1000 = 2000
    pool.report("exa", "exa:00000000", "RATE_LIMIT", { now: 1_000 })
    expect(pool.states("exa")[0].cooldownUntil).toBe(3_000)
    advanceTo(3_000)
    // 第 3 次：2^2 · 1000 = 4000
    pool.report("exa", "exa:00000000", "RATE_LIMIT", { now: 3_000 })
    expect(pool.states("exa")[0].cooldownUntil).toBe(7_000)
    advanceTo(7_000)
    // 连续加码至超过封顶 → 10_000
    for (let i = 0; i < 6; i++) {
      pool.report("exa", "exa:00000000", "RATE_LIMIT", { now: 7_000 })
    }
    const st = pool.states("exa")[0]
    expect((st.cooldownUntil ?? 0) - 7_000).toBeLessThanOrEqual(CONFIG.maxCooldownMs)
  })

  it("冷却到期自动回 active", () => {
    const { pool } = make(0)
    pool.report("exa", "exa:00000000", "RATE_LIMIT", { retryAfterMs: 2_000, now: 0 })
    expect(pool.hasActive("exa", 1_999)).toBe(true) // 另一把 key 仍 active
    expect(pool.next("exa", 1_999)?.id).toBe("exa:00000001")
    expect(pool.states("exa").find((s) => s.keyId === "exa:00000000")?.status).toBe("cooldown")
    expect(pool.next("exa", 2_000)?.id).toBe("exa:00000000")
  })
})

describe("key-pool 401/403 disabled 与配置重载恢复", () => {
  it("AUTH → disabled，时间流逝不恢复，仅 reload 恢复", () => {
    const { pool } = make()
    pool.report("exa", "exa:00000000", "AUTH", { now: 0 })
    expect(pool.states("exa").find((s) => s.keyId === "exa:00000000")?.status).toBe("disabled")
    expect(pool.next("exa", 10 ** 12)?.id).toBe("exa:00000001") // 永不自动恢复
    expect(pool.hasActive("exa", 10 ** 12)).toBe(true)
    // 配置重载 → 恢复 active
    pool.reload({ exa: keys(SECRET_A, SECRET_B) })
    expect(pool.states("exa").every((s) => s.status === "active")).toBe(true)
    expect(pool.next("exa")?.id).toBe("exa:00000000")
  })

  it("QUOTA_EXCEEDED → disabled（architecture.md §6.3）", () => {
    const { pool } = make()
    pool.report("exa", "exa:00000001", "QUOTA_EXCEEDED")
    const st = pool.states("exa").find((s) => s.keyId === "exa:00000001")
    expect(st?.status).toBe("disabled")
    expect(st?.disabledReason).toBe("quota_exceeded")
  })
})

describe("key-pool 错误计数与阈值", () => {
  it("5xx/网络/超时 计数，成功清零", () => {
    const { pool } = make()
    pool.report("exa", "exa:00000000", "SERVER_ERROR")
    pool.report("exa", "exa:00000001", "NETWORK_ERROR")
    expect(pool.providerErrors("exa")).toBe(2)
    expect(pool.thresholdExceeded("exa")).toBe(false)
    pool.report("exa", "exa:00000000", "TIMEOUT")
    expect(pool.providerErrors("exa")).toBe(3)
    expect(pool.thresholdExceeded("exa")).toBe(true) // ≥ errorThreshold
    pool.reportSuccess("exa")
    expect(pool.providerErrors("exa")).toBe(0)
    expect(pool.states("exa").every((s) => s.consecutiveErrors === 0)).toBe(true)
  })

  it("BAD_REQUEST / UNKNOWN 不动 key 状态、不进 provider 计数", () => {
    const { pool } = make()
    pool.report("exa", "exa:00000000", "BAD_REQUEST")
    pool.report("exa", "exa:00000000", "UNKNOWN")
    expect(pool.providerErrors("exa")).toBe(0)
    const st = pool.states("exa").find((s) => s.keyId === "exa:00000000")
    expect(st?.status).toBe("active")
    expect(st?.consecutiveErrors).toBe(0)
  })
})

describe("key-pool 序列化", () => {
  it("snapshot 不含 secret 明文，restore 保留状态", () => {
    const { pool } = make()
    pool.report("exa", "exa:00000000", "AUTH")
    pool.report("exa", "exa:00000001", "RATE_LIMIT", { retryAfterMs: 4_000, now: 0 })
    const snap = pool.snapshot()
    const json = JSON.stringify(snap)
    expect(json).not.toContain(SECRET_A)
    expect(json).not.toContain(SECRET_B)

    const fresh = createKeyPool({ config: CONFIG, keys: { exa: keys(SECRET_A, SECRET_B) }, now: () => 0 })
    fresh.restore(JSON.parse(json))
    const st = fresh.states("exa")
    expect(st.find((s) => s.keyId === "exa:00000000")?.status).toBe("disabled")
    expect(st.find((s) => s.keyId === "exa:00000001")?.status).toBe("cooldown")
    expect(fresh.next("exa", 0)).toBeUndefined() // 一个 disabled 一个冷却中
    expect(fresh.next("exa", 4_000)?.id).toBe("exa:00000001")
  })

  it("restore 忽略新配置中不存在的 key", () => {
    const { pool } = make()
    pool.report("exa", "exa:00000000", "AUTH")
    const snap = pool.snapshot()
    const reduced = createKeyPool({
      config: CONFIG,
      keys: { exa: [{ id: "exa:00000001", secret: SECRET_B }] },
      now: () => 0,
    })
    reduced.restore(snap)
    expect(reduced.states("exa")).toHaveLength(1)
    expect(reduced.states("exa")[0].keyId).toBe("exa:00000001")
    expect(reduced.states("exa")[0].status).toBe("active") // 快照中该 key 未被禁用/冷却
  })
})
