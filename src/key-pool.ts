/**
 * KeyPool：每 provider 的 key 状态容器（architecture.md §3、§6.3）。
 *
 * - round-robin 取下一个 active key（cooldown 过期自动回 active）
 * - 429 → cooldown：Retry-After 优先，否则 baseCooldownMs·2ⁿ 封顶 maxCooldownMs
 * - 401/403(AUTH) / QUOTA_EXCEEDED → disabled，仅配置重载（reload）恢复
 * - 5xx/网络/超时 → consecutiveErrors 计数（errorThreshold → provider 全 key 不可用，触发 CB）
 * - 只做状态容器：不发起下一次尝试、不持有 HTTP（router 决策）
 * - 状态可序列化（snapshot/restore，keyId-only，供 ctx.storage 持久化留接口）
 */
import type {
  ErrorCode,
  KeyPoolConfig,
  KeyState,
  KeyStatus,
  ProviderID,
  ResolvedKey,
} from "./types"

export interface KeyEntry extends KeyState {
  /** 仅内存持有；snapshot 绝不包含 */
  secret?: string
}

export type KeyPoolSnapshot = Record<string, KeyState[]> // provider id → states

export interface ReportInfo {
  /** 服务端 Retry-After（已换算 ms）；429 时优先于退避 */
  retryAfterMs?: number
  now?: number
}

export interface KeyPool {
  /** round-robin 取下一个健康 key；无可用 → undefined */
  next(provider: ProviderID, now?: number): ResolvedKey | undefined
  /** 回灌单次尝试结果（router 是唯一决策者） */
  report(provider: ProviderID, keyId: string | undefined, code: ErrorCode, info?: ReportInfo): void
  /** 成功：清零该 key 连续错误计数 */
  reportSuccess(provider: ProviderID, keyId?: string): void
  hasActive(provider: ProviderID, now?: number): boolean
  /** provider 级连续 5xx/网络/超时 计数（≥ errorThreshold → 全 key 不可用） */
  providerErrors(provider: ProviderID): number
  thresholdExceeded(provider: ProviderID): boolean
  /** 可序列化状态（不含 secret） */
  snapshot(): KeyPoolSnapshot
  restore(snapshot: KeyPoolSnapshot): void
  /** 配置重载：disabled key 在新配置中仍存在 → 恢复 active */
  reload(keys: Partial<Record<ProviderID, ResolvedKey[]>>): void
  states(provider?: ProviderID): KeyState[]
}

export interface KeyPoolOptions {
  config: KeyPoolConfig
  keys: Partial<Record<ProviderID, ResolvedKey[]>>
  now?: () => number
}

const STATUS_ORDER: Record<KeyStatus, number> = { active: 0, cooldown: 1, disabled: 2 }

function stripSecret(s: KeyEntry): KeyState {
  const { secret: _ignored, ...state } = s
  return state
}

export function createKeyPool(opts: KeyPoolOptions): KeyPool {
  const now = opts.now ?? (() => Date.now())
  let config = opts.config
  const pools = new Map<ProviderID, KeyEntry[]>()
  const cursor = new Map<ProviderID, number>()
  const providerErrs = new Map<ProviderID, number>()

  function build(keys: Partial<Record<ProviderID, ResolvedKey[]>>): void {
    pools.clear()
    cursor.clear()
    providerErrs.clear()
    for (const [id, list] of Object.entries(keys) as Array<[ProviderID, ResolvedKey[]]>) {
      pools.set(
        id,
        (list ?? []).map((k) => ({
          keyId: k.id,
          provider: id,
          status: "active" as KeyStatus,
          consecutiveErrors: 0,
          secret: k.secret,
        })),
      )
    }
  }
  build(opts.keys)

  /** 把过期 cooldown 拨回 active（惰性） */
  function refresh(entries: KeyEntry[], t: number): void {
    for (const e of entries) {
      if (e.status === "cooldown" && e.cooldownUntil !== undefined && t >= e.cooldownUntil) {
        e.status = "active"
        e.cooldownUntil = undefined
      }
    }
  }

  function getEntries(provider: ProviderID): KeyEntry[] {
    return pools.get(provider) ?? []
  }

  function cooldownFor(consecutive: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined && retryAfterMs >= 0) return retryAfterMs
    const exp = config.baseCooldownMs * 2 ** Math.max(0, consecutive)
    return Math.min(exp, config.maxCooldownMs)
  }

  return {
    next(provider, t = now()) {
      const entries = getEntries(provider)
      if (entries.length === 0) return undefined
      refresh(entries, t)
      const start = cursor.get(provider) ?? 0
      for (let i = 0; i < entries.length; i++) {
        const idx = (start + i) % entries.length
        const e = entries[idx]
        if (e.status === "active") {
          cursor.set(provider, (idx + 1) % entries.length)
          if (e.secret === undefined) continue // restore 后 secret 缺失（配置已移除）→ 跳过
          return { id: e.keyId, secret: e.secret }
        }
      }
      return undefined
    },

    report(provider, keyId, code, info) {
      const entries = getEntries(provider)
      const t = info?.now ?? now()
      refresh(entries, t)
      const e = entries.find((x) => x.keyId === keyId)
      if (!e) return
      e.lastErrorCode = code
      switch (code) {
        case "AUTH":
          e.status = "disabled"
          e.disabledReason = "auth_401_403"
          e.cooldownUntil = undefined
          break
        case "QUOTA_EXCEEDED":
          e.status = "disabled"
          e.disabledReason = "quota_exceeded"
          e.cooldownUntil = undefined
          break
        case "RATE_LIMIT": {
          // 无 Retry-After 时 baseCooldownMs·2ⁿ（n=此前连续错误数）封顶 maxCooldownMs
          const ms = cooldownFor(e.consecutiveErrors, info?.retryAfterMs)
          e.status = "cooldown"
          e.cooldownUntil = t + ms
          e.consecutiveErrors += 1
          break
        }
        case "SERVER_ERROR":
        case "NETWORK_ERROR":
        case "TIMEOUT":
          e.consecutiveErrors += 1
          providerErrs.set(provider, (providerErrs.get(provider) ?? 0) + 1)
          break
        case "BAD_REQUEST":
        case "UNKNOWN":
          break // 不动 key 状态
      }
    },

    reportSuccess(provider, keyId) {
      const entries = getEntries(provider)
      if (keyId === undefined) {
        for (const e of entries) e.consecutiveErrors = 0
      } else {
        const e = entries.find((x) => x.keyId === keyId)
        if (e) e.consecutiveErrors = 0
      }
      providerErrs.set(provider, 0)
    },

    hasActive(provider, t = now()) {
      const entries = getEntries(provider)
      refresh(entries, t)
      return entries.some((e) => e.status === "active")
    },

    providerErrors(provider) {
      return providerErrs.get(provider) ?? 0
    },

    thresholdExceeded(provider) {
      return (providerErrs.get(provider) ?? 0) >= config.errorThreshold
    },

    snapshot() {
      const out: KeyPoolSnapshot = {}
      for (const [id, entries] of pools) out[id] = entries.map(stripSecret)
      return out
    },

    restore(snapshot) {
      for (const [id, states] of Object.entries(snapshot) as Array<[ProviderID, KeyState[]]>) {
        const entries = getEntries(id)
        for (const s of states) {
          const e = entries.find((x) => x.keyId === s.keyId)
          if (!e) continue // 新配置里没有该 key → 忽略
          e.status = s.status
          e.cooldownUntil = s.cooldownUntil
          e.consecutiveErrors = s.consecutiveErrors
          e.lastErrorCode = s.lastErrorCode
          e.disabledReason = s.disabledReason
        }
      }
    },

    reload(keys) {
      build(keys)
    },

    states(provider) {
      if (provider !== undefined) return getEntries(provider).map(stripSecret)
      const all: KeyState[] = []
      for (const entries of pools.values()) all.push(...entries.map(stripSecret))
      // 稳定顺序：active → cooldown → disabled，组内按 keyId（仅展示用）
      return all.sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.keyId.localeCompare(b.keyId),
      )
    },
  }
}
