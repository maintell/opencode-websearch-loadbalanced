import { describe, expect, it } from "vitest"
import { createMonthlyBudgetManager, periodOf } from "../src/budget"
import type { BudgetConfig } from "../src/types"

function cfg(over: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    enabled: true,
    unit: "requests",
    countMode: "attempt",
    limits: [],
    ...over,
  }
}

/** 本地时区下的确定时间点 */
function at(year: number, month: number, day = 1, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime()
}

describe("budget：零硬编码额度", () => {
  it("未配置任何 limits → 永远 ok（代码里没有默认额度）", () => {
    const b = createMonthlyBudgetManager({ config: cfg(), now: () => at(2026, 9) })
    for (let i = 0; i < 10_000; i++) {
      b.record({ provider: "serpapi", ok: true })
    }
    expect(b.check({ provider: "serpapi" })).toEqual({ ok: true })
    expect(b.entries()).toHaveLength(0)
  })

  it("enabled=false 时 check 恒 ok、record 不计数", () => {
    const b = createMonthlyBudgetManager({
      config: cfg({ enabled: false, limits: [{ scope: "provider", target: "serpapi", limit: 1 }] }),
      now: () => at(2026, 9),
    })
    b.record({ provider: "serpapi", ok: true })
    b.record({ provider: "serpapi", ok: true })
    expect(b.check({ provider: "serpapi" })).toEqual({ ok: true })
    expect(b.entries()).toHaveLength(0)
  })
})

describe("budget：provider scope", () => {
  it("耗尽返回 skip 信息（limit/used/scope/target）", () => {
    const b = createMonthlyBudgetManager({
      config: cfg({ limits: [{ scope: "provider", target: "serpapi", limit: 3 }] }),
      now: () => at(2026, 9),
    })
    expect(b.check({ provider: "serpapi" })).toEqual({ ok: true })
    b.record({ provider: "serpapi", ok: false }) // attempt 口径：失败也计
    b.record({ provider: "serpapi", ok: true })
    expect(b.check({ provider: "serpapi" })).toEqual({ ok: true })
    b.record({ provider: "serpapi", ok: true })
    const v = b.check({ provider: "serpapi" })
    expect(v).toEqual({
      ok: false,
      scope: "provider",
      target: "serpapi",
      limit: 3,
      used: 3,
    })
    // 未配置额度的 provider 不受影响
    expect(b.check({ provider: "exa" })).toEqual({ ok: true })
  })
})

describe("budget：key scope", () => {
  it("provider 与 key 双 scope 同时闸，任一耗尽即 skip", () => {
    const b = createMonthlyBudgetManager({
      config: cfg({
        limits: [
          { scope: "provider", target: "exa", limit: 100 },
          { scope: "key", target: "exa:9f3a7c21", limit: 2 },
        ],
      }),
      now: () => at(2026, 9),
    })
    b.record({ provider: "exa", keyId: "exa:9f3a7c21", ok: true })
    b.record({ provider: "exa", keyId: "exa:9f3a7c21", ok: true })
    const v = b.check({ provider: "exa", keyId: "exa:9f3a7c21" })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.scope).toBe("key")
      expect(v.target).toBe("exa:9f3a7c21")
      expect(v.used).toBe(2)
    }
    // 同 provider 的其他 key 不受牵连
    expect(b.check({ provider: "exa", keyId: "exa:aaaaaaaa" })).toEqual({ ok: true })
    // key 计数也进 provider 总账
    const entries = b.entries()
    const pv = entries.find((e) => e.scope === "provider")
    expect(pv?.used).toBe(2)
  })
})

describe("budget：countMode", () => {
  it("success 口径（SerpApi）：失败不计数", () => {
    const b = createMonthlyBudgetManager({
      config: cfg({
        countMode: "success",
        limits: [{ scope: "provider", target: "serpapi", limit: 2 }],
      }),
      now: () => at(2026, 9),
    })
    b.record({ provider: "serpapi", ok: false })
    b.record({ provider: "serpapi", ok: false })
    expect(b.check({ provider: "serpapi" })).toEqual({ ok: true })
    b.record({ provider: "serpapi", ok: true })
    b.record({ provider: "serpapi", ok: true })
    expect(b.check({ provider: "serpapi" }).ok).toBe(false)
  })

  it("attempt 口径：成功失败都计", () => {
    const b = createMonthlyBudgetManager({
      config: cfg({ limits: [{ scope: "provider", target: "tavily", limit: 1 }] }),
      now: () => at(2026, 9),
    })
    b.record({ provider: "tavily", ok: false })
    expect(b.check({ provider: "tavily" }).ok).toBe(false)
  })
})

describe("budget：unit=credits 按 adapter.cost() 加权", () => {
  it("units 累加，失败不计（success 口径下）", () => {
    const b = createMonthlyBudgetManager({
      config: cfg({ unit: "credits", countMode: "success", limits: [{ scope: "provider", target: "tavily", limit: 10 }] }),
      now: () => at(2026, 9),
    })
    b.record({ provider: "tavily", ok: true, units: 1 })
    b.record({ provider: "tavily", ok: true, units: 2 }) // advanced=2 credits
    expect(b.entries()[0].used).toBe(3)
    expect(b.entries()[0].unit).toBe("credits")
    b.record({ provider: "tavily", ok: false, units: 5 })
    expect(b.entries()[0].used).toBe(3) // success 口径 → 失败不计
  })

  it("unit=requests 时忽略 units 权重", () => {
    const b = createMonthlyBudgetManager({
      config: cfg({ limits: [{ scope: "provider", target: "tavily", limit: 2 }] }),
      now: () => at(2026, 9),
    })
    b.record({ provider: "tavily", ok: true, units: 100 })
    b.record({ provider: "tavily", ok: true, units: 100 })
    expect(b.check({ provider: "tavily" }).ok).toBe(false)
  })
})

describe("budget：YYYY-MM 周期自动滚动", () => {
  it("跨月后额度自动重置，旧周期 entry 不残留", () => {
    let t = at(2026, 9, 30)
    const b = createMonthlyBudgetManager({
      config: cfg({ limits: [{ scope: "provider", target: "serpapi", limit: 1 }] }),
      now: () => t,
    })
    b.record({ provider: "serpapi", ok: true })
    expect(b.check({ provider: "serpapi" }).ok).toBe(false)
    expect(b.serialize().period).toBe("2026-09")

    t = at(2026, 10, 1) // 滚动
    expect(b.check({ provider: "serpapi" })).toEqual({ ok: true })
    expect(b.serialize().period).toBe("2026-10")
    expect(b.entries()).toHaveLength(0) // 新周期无旧计数
  })

  it("periodOf 输出本地时区 YYYY-MM", () => {
    expect(periodOf(at(2026, 1, 15))).toBe("2026-01")
    expect(periodOf(at(2026, 12, 31))).toBe("2026-12")
  })
})

describe("budget：序列化", () => {
  it("serialize → restore 跨实例保持计数与强制耗尽标记", () => {
    const b = createMonthlyBudgetManager({
      config: cfg({ limits: [{ scope: "provider", target: "serpapi", limit: 2 }] }),
      now: () => at(2026, 9),
    })
    b.record({ provider: "serpapi", ok: true })
    b.markExhausted("provider", "you") // 上游 402 信号（you 无配置 limit）
    const snap = JSON.parse(JSON.stringify(b.serialize()))

    const b2 = createMonthlyBudgetManager({
      config: cfg({ limits: [{ scope: "provider", target: "serpapi", limit: 2 }] }),
      now: () => at(2026, 9),
    })
    b2.restore(snap)
    expect(b2.check({ provider: "serpapi" })).toEqual({ ok: true })
    b2.record({ provider: "serpapi", ok: true })
    expect(b2.check({ provider: "serpapi" }).ok).toBe(false)
    // forced：无配置额度也被停用
    expect(b2.check({ provider: "you" }).ok).toBe(false)
    expect(b2.entries().find((e) => e.target === "you")).toBeUndefined()
  })

  it("markExhausted 对已配置额度 → used 提升到 limit", () => {
    const b = createMonthlyBudgetManager({
      config: cfg({ limits: [{ scope: "provider", target: "serpapi", limit: 5 }] }),
      now: () => at(2026, 9),
    })
    b.record({ provider: "serpapi", ok: true })
    b.markExhausted("provider", "serpapi")
    expect(b.check({ provider: "serpapi" }).ok).toBe(false)
    expect(b.entries()[0].used).toBe(5)
  })
})
