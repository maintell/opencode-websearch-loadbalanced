/**
 * MonthlyBudgetManager：月度预算闸（architecture.md §6.4）。
 *
 * - 周期键 YYYY-MM（本地时区），每次 check/record 首个调用自动滚动重置
 * - 双 scope：provider:{id} 与 key:{keyId} 同时 check，任一耗尽即 skip
 * - 零硬编码额度：limit 全部来自 BudgetConfig.limits（无配置 = 不受闸）
 * - countMode：attempt=每次调用计；success=仅成功计（SerpApi 口径）
 * - unit：requests=1 次/调用；credits=按 adapter.cost() 加权
 * - 状态可序列化（BudgetState 超集，供 ctx.storage 留接口）
 */
import type {
  BudgetConfig,
  BudgetEntry,
  BudgetScope,
  BudgetState,
  BudgetVerdict,
  ProviderID,
} from "./types"

export interface BudgetSnapshot extends BudgetState {
  /** 上游 402/额度信号强制标记（配置无 limit 时也停用），key = `${scope}:${target}:${period}` */
  forced?: Record<string, true>
}

export interface RecordInput {
  provider: ProviderID
  keyId?: string
  ok: boolean
  /** adapter.cost() 加权值；unit=requests 时忽略 */
  units?: number
  now?: number
}

export interface CheckInput {
  provider: ProviderID
  keyId?: string
  now?: number
}

export interface MonthlyBudgetManager {
  check(input: CheckInput): BudgetVerdict
  record(input: RecordInput): void
  /** 上游额度耗尽信号（402 等）→ 本周期强制停用该 scope */
  markExhausted(scope: BudgetScope, target: string, now?: number): void
  entries(): BudgetEntry[]
  serialize(): BudgetSnapshot
  restore(snapshot: BudgetSnapshot): void
}

export interface MonthlyBudgetOptions {
  config: BudgetConfig
  now?: () => number
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 本地时区 YYYY-MM */
export function periodOf(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

function entryKey(scope: BudgetScope, target: string, period: string): string {
  return `${scope}:${target}:${period}`
}

export function createMonthlyBudgetManager(opts: MonthlyBudgetOptions): MonthlyBudgetManager {
  const now = opts.now ?? (() => Date.now())
  let config = opts.config
  let state: BudgetSnapshot = { period: periodOf(now()), entries: {}, forced: {} }

  function roll(t: number): void {
    const p = periodOf(t)
    if (state.period !== p) state = { period: p, entries: {}, forced: {} }
    if (!state.forced) state.forced = {}
  }

  function findLimit(scope: BudgetScope, target: string): number | undefined {
    for (const l of config.limits) {
      if (l.scope === scope && l.target === target) return l.limit
    }
    return undefined
  }

  function ensureEntry(scope: BudgetScope, target: string, limit: number): BudgetEntry {
    const k = entryKey(scope, target, state.period)
    let e = state.entries[k]
    if (!e) {
      e = {
        scope,
        target,
        period: state.period,
        limit,
        used: 0,
        unit: config.unit === "credits" ? "credits" : "requests",
      }
      state.entries[k] = e
    }
    return e
  }

  function verdictFor(scope: BudgetScope, target: string): BudgetVerdict {
    const k = entryKey(scope, target, state.period)
    if (state.forced![k]) {
      const limit = findLimit(scope, target) ?? 0
      return { ok: false, scope, target, limit, used: state.entries[k]?.used ?? limit }
    }
    const limit = findLimit(scope, target)
    if (limit === undefined) return { ok: true } // 未配置额度 = 不受闸（零硬编码）
    const used = state.entries[k]?.used ?? 0
    if (used >= limit) return { ok: false, scope, target, limit, used }
    return { ok: true }
  }

  return {
    check(input) {
      if (!config.enabled) return { ok: true }
      roll(input.now ?? now())
      const pv = verdictFor("provider", input.provider)
      if (!pv.ok) return pv
      if (input.keyId !== undefined) {
        const kv = verdictFor("key", input.keyId)
        if (!kv.ok) return kv
      }
      return { ok: true }
    },

    record(input) {
      if (!config.enabled) return
      if (config.countMode === "success" && !input.ok) return // SerpApi 口径：失败不计
      roll(input.now ?? now())
      const amount = config.unit === "credits" ? Math.max(0, input.units ?? 1) : 1
      const targets: Array<{ scope: BudgetScope; target: string }> = [
        { scope: "provider", target: input.provider },
      ]
      if (input.keyId !== undefined) targets.push({ scope: "key", target: input.keyId })
      for (const t of targets) {
        const limit = findLimit(t.scope, t.target)
        if (limit === undefined) continue // 无额度 → 不记（避免无意义状态增长）
        ensureEntry(t.scope, t.target, limit).used += amount
      }
    },

    markExhausted(scope, target, t = now()) {
      roll(t)
      const limit = findLimit(scope, target)
      if (limit === undefined) {
        state.forced![entryKey(scope, target, state.period)] = true
        return
      }
      const e = ensureEntry(scope, target, limit)
      e.used = Math.max(e.used, limit)
    },

    entries() {
      return Object.values(state.entries)
    },

    serialize() {
      return JSON.parse(JSON.stringify(state)) as BudgetSnapshot
    },

    restore(snapshot) {
      state = { period: snapshot.period, entries: snapshot.entries ?? {}, forced: snapshot.forced ?? {} }
    },
  }
}
