import { describe, expect, it } from "vitest"
import { createCircuitBreaker } from "../src/circuit-breaker"
import type { CircuitBreakerConfig } from "../src/types"

const CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  openMs: 30_000,
  halfOpenMaxCalls: 1,
  successThreshold: 2,
}

function make() {
  let t = 1_000
  const cb = createCircuitBreaker({ config: CONFIG, now: () => t })
  return { cb, advance: (ms: number) => (t += ms), now: () => t }
}

describe("circuit-breaker 状态机", () => {
  it("初始 CLOSED，canPass 放行", () => {
    const { cb } = make()
    expect(cb.view("exa").state).toBe("CLOSED")
    expect(cb.canPass("exa")).toBe(true)
  })

  it("连续 failureThreshold 次计入失败 → OPEN", () => {
    const { cb } = make()
    expect(cb.onFailure("exa", "SERVER_ERROR")).toBe(false)
    expect(cb.onFailure("exa", "NETWORK_ERROR")).toBe(false)
    expect(cb.view("exa").state).toBe("CLOSED")
    expect(cb.onFailure("exa", "TIMEOUT")).toBe(true)
    expect(cb.view("exa").state).toBe("OPEN")
    expect(cb.canPass("exa")).toBe(false)
    const v = cb.view("exa")
    expect(v.openedAt).toBeDefined()
    expect(v.nextProbeAt).toBe((v.openedAt ?? 0) + CONFIG.openMs)
  })

  it("成功会清零 CLOSED 下的连续失败", () => {
    const { cb } = make()
    cb.onFailure("exa", "SERVER_ERROR")
    cb.onFailure("exa", "SERVER_ERROR")
    cb.onSuccess("exa")
    expect(cb.view("exa").consecutiveFailures).toBe(0)
    cb.onFailure("exa", "SERVER_ERROR")
    cb.onFailure("exa", "SERVER_ERROR")
    expect(cb.view("exa").state).toBe("CLOSED") // 未连到阈值
  })

  it("只统计 5xx/网络/超时：AUTH/RATE_LIMIT/QUOTA/BAD_REQUEST/UNKNOWN 不计入", () => {
    const { cb } = make()
    for (const code of ["AUTH", "RATE_LIMIT", "QUOTA_EXCEEDED", "BAD_REQUEST", "UNKNOWN"] as const) {
      expect(cb.onFailure("exa", code)).toBe(false)
    }
    expect(cb.view("exa").consecutiveFailures).toBe(0)
    expect(cb.view("exa").state).toBe("CLOSED")
  })

  it("OPEN → openMs 到点 → HALF_OPEN，放行探测", () => {
    const { cb, advance } = make()
    cb.onFailure("exa", "SERVER_ERROR")
    cb.onFailure("exa", "SERVER_ERROR")
    cb.onFailure("exa", "SERVER_ERROR")
    expect(cb.view("exa").state).toBe("OPEN")
    advance(CONFIG.openMs - 1)
    expect(cb.canPass("exa")).toBe(false)
    advance(1)
    expect(cb.canPass("exa")).toBe(true)
    expect(cb.view("exa").state).toBe("HALF_OPEN")
    // halfOpenMaxCalls=1：第二个探测请求被拒
    expect(cb.canPass("exa")).toBe(false)
  })

  it("HALF_OPEN 连续 successThreshold 次成功 → CLOSED", () => {
    const { cb, advance } = make()
    for (let i = 0; i < CONFIG.failureThreshold; i++) cb.onFailure("exa", "SERVER_ERROR")
    advance(CONFIG.openMs)
    expect(cb.canPass("exa")).toBe(true) // 进入 HALF_OPEN
    cb.onSuccess("exa")
    expect(cb.view("exa").state).toBe("HALF_OPEN")
    expect(cb.canPass("exa")).toBe(true) // 名额归还后可再探测
    cb.onSuccess("exa")
    expect(cb.view("exa").state).toBe("CLOSED")
    expect(cb.canPass("exa")).toBe(true)
  })

  it("HALF_OPEN 探测失败 → 立即重新 OPEN 并重置 openMs", () => {
    const { cb, advance } = make()
    for (let i = 0; i < CONFIG.failureThreshold; i++) cb.onFailure("exa", "SERVER_ERROR")
    const firstOpened = cb.view("exa").openedAt
    advance(CONFIG.openMs)
    expect(cb.canPass("exa")).toBe(true)
    cb.onFailure("exa", "SERVER_ERROR")
    expect(cb.view("exa").state).toBe("OPEN")
    expect(cb.view("exa").openedAt).toBeGreaterThan(firstOpened ?? 0)
    expect(cb.canPass("exa")).toBe(false)
  })

  it("provider 之间状态独立", () => {
    const { cb } = make()
    for (let i = 0; i < CONFIG.failureThreshold; i++) cb.onFailure("exa", "SERVER_ERROR")
    expect(cb.view("exa").state).toBe("OPEN")
    expect(cb.view("tavily").state).toBe("CLOSED")
    expect(cb.canPass("tavily")).toBe(true)
    expect(cb.views().length).toBe(2)
  })
})
