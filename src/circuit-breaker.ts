/**
 * CircuitBreaker：每 provider 一个 CLOSED/OPEN/HALF_OPEN 状态机（architecture.md §6.2）。
 *
 * - 只统计 SERVER_ERROR / NETWORK_ERROR / TIMEOUT（countsTowardCircuit）；
 *   AUTH/RATE_LIMIT/QUOTA_EXCEEDED 由 key-pool/budget 处理，BAD_REQUEST/UNKNOWN 不计。
 * - CLOSED：连续失败 ≥ failureThreshold → OPEN
 * - OPEN：openMs 到点后 canPass 惰性转 HALF_OPEN，放行 ≤ halfOpenMaxCalls 探测
 * - HALF_OPEN：连续成功 ≥ successThreshold → CLOSED；任一探测失败 → 重新 OPEN
 */
import { countsTowardCircuit } from "./utils/errors"
import type { CircuitBreakerConfig, CircuitBreakerView, CircuitState, ErrorCode, ProviderID } from "./types"

interface BreakerState {
  state: CircuitState
  consecutiveFailures: number
  consecutiveSuccesses: number
  openedAt?: number
  /** HALF_OPEN 已放行未结算的探测数（canPass 预留） */
  inFlight: number
}

export interface CircuitBreaker {
  /** 放行判定；HALF_OPEN 下返回 true 即占用一个探测名额 */
  canPass(provider: ProviderID, now?: number): boolean
  onSuccess(provider: ProviderID): void
  /** code 提供时先过滤：非 5xx/网络/超时 不计入 */
  onFailure(provider: ProviderID, code?: ErrorCode): boolean
  view(provider: ProviderID): CircuitBreakerView
  views(): CircuitBreakerView[]
  /** 测试/重载用 */
  reset(provider?: ProviderID): void
}

export interface CircuitBreakerOptions {
  config: CircuitBreakerConfig
  now?: () => number
}

function fresh(): BreakerState {
  return { state: "CLOSED", consecutiveFailures: 0, consecutiveSuccesses: 0, inFlight: 0 }
}

export function createCircuitBreaker(opts: CircuitBreakerOptions): CircuitBreaker {
  const now = opts.now ?? (() => Date.now())
  const states = new Map<ProviderID, BreakerState>()
  const cfg = opts.config

  const get = (p: ProviderID): BreakerState => {
    let s = states.get(p)
    if (!s) {
      s = fresh()
      states.set(p, s)
    }
    return s
  }

  const open = (s: BreakerState, t: number) => {
    s.state = "OPEN"
    s.openedAt = t
    s.consecutiveFailures = 0
    s.consecutiveSuccesses = 0
    s.inFlight = 0
  }

  const view = (provider: ProviderID): CircuitBreakerView => {
    const s = get(provider)
    const v: CircuitBreakerView = {
      provider,
      state: s.state,
      consecutiveFailures: s.consecutiveFailures,
      consecutiveSuccesses: s.consecutiveSuccesses,
    }
    if (s.openedAt !== undefined) v.openedAt = s.openedAt
    if (s.state === "OPEN" && s.openedAt !== undefined) v.nextProbeAt = s.openedAt + cfg.openMs
    return v
  }

  return {
    canPass(provider, t = now()) {
      const s = get(provider)
      if (s.state === "CLOSED") return true
      if (s.state === "OPEN") {
        const openedAt = s.openedAt ?? 0
        if (t - openedAt < cfg.openMs) return false
        // 到点 → HALF_OPEN，结算首个探测名额
        s.state = "HALF_OPEN"
        s.consecutiveSuccesses = 0
        s.inFlight = 1
        return true
      }
      // HALF_OPEN
      if (s.inFlight < cfg.halfOpenMaxCalls) {
        s.inFlight += 1
        return true
      }
      return false
    },

    onSuccess(provider) {
      const s = get(provider)
      if (s.state === "CLOSED") {
        s.consecutiveFailures = 0
        return
      }
      if (s.state === "HALF_OPEN") {
        s.inFlight = Math.max(0, s.inFlight - 1)
        s.consecutiveSuccesses += 1
        s.consecutiveFailures = 0
        if (s.consecutiveSuccesses >= cfg.successThreshold) {
          s.state = "CLOSED"
          s.consecutiveSuccesses = 0
          s.openedAt = undefined
        }
      }
      // OPEN：迟到的成功不改变状态（已过期窗口才会有探测）
    },

    onFailure(provider, code) {
      if (code !== undefined && !countsTowardCircuit(code)) return false
      const s = get(provider)
      if (s.state === "OPEN") return false
      if (s.state === "HALF_OPEN") {
        open(s, now()) // 探测失败 → 立即重新 OPEN
        return true
      }
      s.consecutiveFailures += 1
      s.consecutiveSuccesses = 0
      if (s.consecutiveFailures >= cfg.failureThreshold) {
        open(s, now())
        return true
      }
      return false
    },

    view,
    views() {
      return [...states.keys()].map(view)
    },

    reset(provider) {
      if (provider !== undefined) states.set(provider, fresh())
      else states.clear()
    },
  }
}
