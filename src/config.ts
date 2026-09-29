/**
 * config.ts：ctx.options（opencode.jsonc plugins[].options 形态）→ ResolvedConfig（architecture.md §7）。
 *
 * - 默认值合并、${ENV_VAR} 解析、schema 校验、key 脱敏
 * - 缺失 env → 该 provider 标记不可用（enabled=false + warning），不抛错
 * - 零硬编码额度：budget.limits 只来自配置
 * - 所有 errors/warnings 过 redact()，绝不携带 key 明文
 */
import {
  PROVIDER_IDS,
  type BudgetLimit,
  type ConfigValidation,
  type ProviderID,
  type ProviderOptions,
  type ResolvedConfig,
  type ResolvedKey,
  type ResolvedKeyRef,
  type WebSearchPluginOptions,
} from "./types"
import { fingerprint, keyIdOf, redact, registerSecret } from "./utils/logging"

/** 无 key 通道（requiresKey=false，adapter 属性——config 不 import adapter，本地声明） */
const KEYLESS_PROVIDERS: ReadonlySet<ProviderID> = new Set<ProviderID>(["searxng"])

const DEFAULT_BASE_URL: Record<ProviderID, string> = {
  parallel: "https://api.parallel.ai",
  exa: "https://api.exa.ai",
  tavily: "https://api.tavily.com",
  you: "https://ydc-index.io",
  serpapi: "https://serpapi.com",
  searxng: "https://search.658658.xyz",
}

/** 默认 priority：数字小者优先，searxng 作最终 fallback 给最大值（architecture.md §7 示例） */
const DEFAULT_PRIORITY: Record<ProviderID, number> = {
  parallel: 10,
  exa: 20,
  tavily: 30,
  you: 40,
  serpapi: 50,
  searxng: 99,
}

type Env = Record<string, string | undefined>

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** 提取 key 条目引用的环境变量名（支持 "NAME"、"${NAME}" 及含 ${NAME} 的字符串） */
function envNameOfValue(entry: string): string | undefined {
  const trimmed = entry.trim()
  const m = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(trimmed)
  if (m) return m[1]
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed
  return undefined
}

/**
 * keys 条目归一（orchestrator 裁定的三种写法 → 同一内部结构）：
 * - "EXA_API_KEY"（纯 env 名）
 * - "${EXA_API_KEY}"（插值字符串）
 * - { id: "primary", value: "${EXA_API_KEY}" }（id 缺省由 env 名派生）
 */
function normalizeKeyEntry(entry: unknown): ResolvedKeyRef | undefined {
  if (typeof entry === "string") {
    const envName = envNameOfValue(entry)
    return envName ? { id: envName, envName } : undefined
  }
  if (isRecord(entry) && typeof entry.value === "string") {
    const envName = envNameOfValue(entry.value)
    if (!envName) return undefined
    const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : envName
    return { id, envName }
  }
  return undefined
}

/** 非 key 字段的 ${VAR} 展开；缺失 → 保留原样 + 记入 missing */
function expandString(s: string, env: Env, missing: Set<string>): string {
  return s.replace(ENV_REF, (_all, name: string) => {
    const v = env[name]
    if (v === undefined || v === "") {
      missing.add(name)
      return `${"${"}${name}}`
    }
    return v
  })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function num(v: unknown, def: number, min = 0): number | undefined {
  if (v === undefined) return def
  if (typeof v === "number" && Number.isFinite(v) && v >= min) return v
  return undefined // 调用方负责记 warning/降级
}

export interface ResolveOptions {
  env?: Env
  /** 默认 process.env */
  now?: () => number
}

/**
 * 解析并校验配置。不抛错——问题全部进 errors/warnings（errors 阻断对应 provider 启用）。
 */
export function resolveConfig(
  options: WebSearchPluginOptions = {},
  resolveOpts: ResolveOptions = {},
): ConfigValidation {
  const env: Env = resolveOpts.env ?? process.env
  const errors: string[] = []
  const warnings: string[] = []
  const err = (m: string) => errors.push(redact(m))
  const warn = (m: string) => warnings.push(redact(m))

  /* ---- http ---- */
  const httpRaw = options.http ?? {}
  const http = {
    timeoutMs: num(httpRaw.timeoutMs, 8000, 1) ?? (warn("http.timeoutMs 非法，回退 8000"), 8000),
    retriesPerKey: num(httpRaw.retriesPerKey, 2) ?? (warn("http.retriesPerKey 非法，回退 2"), 2),
    retryBackoffMs: num(httpRaw.retryBackoffMs, 400) ?? (warn("http.retryBackoffMs 非法，回退 400"), 400),
    maxRetryBackoffMs:
      num(httpRaw.maxRetryBackoffMs, 8000) ?? (warn("http.maxRetryBackoffMs 非法，回退 8000"), 8000),
  }
  if (http.maxRetryBackoffMs < http.retryBackoffMs) {
    warn("http.maxRetryBackoffMs < retryBackoffMs，已取二者较大值")
    http.maxRetryBackoffMs = http.retryBackoffMs
  }

  /* ---- routing ---- */
  const routingRaw = options.routing ?? {}
  const strategy =
    routingRaw.strategy === "round_robin" || routingRaw.strategy === "priority"
      ? routingRaw.strategy
      : (routingRaw.strategy !== undefined && warn(`routing.strategy 非法（${String(routingRaw.strategy)}），回退 priority`),
        "priority")
  const routing = {
    strategy,
    maxProviderAttempts:
      num(routingRaw.maxProviderAttempts, 6, 1) ??
      (warn("routing.maxProviderAttempts 非法，回退 6"), 6),
  }

  /* ---- cache ---- */
  const cacheRaw = options.cache ?? {}
  const cache = {
    ttlMs: num(cacheRaw.ttlMs, 300000, 1) ?? (warn("cache.ttlMs 非法，回退 300000"), 300000),
    maxEntries: num(cacheRaw.maxEntries, 256, 1) ?? (warn("cache.maxEntries 非法，回退 256"), 256),
  }

  /* ---- circuitBreaker ---- */
  const cbRaw = options.circuitBreaker ?? {}
  const circuitBreaker = {
    failureThreshold: num(cbRaw.failureThreshold, 3, 1) ?? (warn("circuitBreaker.failureThreshold 非法，回退 3"), 3),
    openMs: num(cbRaw.openMs, 30000, 1) ?? (warn("circuitBreaker.openMs 非法，回退 30000"), 30000),
    halfOpenMaxCalls: num(cbRaw.halfOpenMaxCalls, 1, 1) ?? (warn("circuitBreaker.halfOpenMaxCalls 非法，回退 1"), 1),
    successThreshold: num(cbRaw.successThreshold, 2, 1) ?? (warn("circuitBreaker.successThreshold 非法，回退 2"), 2),
  }

  /* ---- keyPool ---- */
  const kpRaw = options.keyPool ?? {}
  const keyPool = {
    errorThreshold: num(kpRaw.errorThreshold, 3, 1) ?? (warn("keyPool.errorThreshold 非法，回退 3"), 3),
    baseCooldownMs: num(kpRaw.baseCooldownMs, 5000, 0) ?? (warn("keyPool.baseCooldownMs 非法，回退 5000"), 5000),
    maxCooldownMs: num(kpRaw.maxCooldownMs, 300000, 0) ?? (warn("keyPool.maxCooldownMs 非法，回退 300000"), 300000),
  }
  if (keyPool.maxCooldownMs < keyPool.baseCooldownMs) {
    warn("keyPool.maxCooldownMs < baseCooldownMs，已取二者较大值")
    keyPool.maxCooldownMs = keyPool.baseCooldownMs
  }

  /* ---- budget（额度零硬编码，全部来自配置） ---- */
  const budgetRaw = options.budget ?? {}
  const unitRaw = budgetRaw.unit
  // unit 别名归一（orchestrator 裁定，零行为改动于既有 requests/credits）：
  // - credit → credits；- usd → credits（ponytail: usd 数值=provider 计费单位，USD 换算表暂不做）；
  // - unlimited → 等价未设 limit：budget.limits 在下方整体丢弃，沿用现有「无 limit」行为
  const unlimited = unitRaw === "unlimited"
  const unit: "requests" | "credits" =
    unitRaw === "credits" || unitRaw === "credit" || unitRaw === "usd"
      ? "credits"
      : unitRaw === "requests" || unlimited
        ? "requests"
        : (unitRaw !== undefined && warn(`budget.unit 非法（${String(unitRaw)}），回退 requests`), "requests")
  const countModeRaw = budgetRaw.countMode
  const countMode: "attempt" | "success" =
    countModeRaw === "attempt" || countModeRaw === "success"
      ? countModeRaw
      : (countModeRaw !== undefined && warn(`budget.countMode 非法（${String(countModeRaw)}），回退 attempt`), "attempt")
  const limits: BudgetLimit[] = []
  const seenLimits = new Set<string>()
  if (budgetRaw.limits !== undefined && !Array.isArray(budgetRaw.limits)) {
    err("budget.limits 必须是数组")
  } else {
    for (const [i, l] of (budgetRaw.limits ?? []).entries()) {
      if (!isRecord(l)) {
        err(`budget.limits[${i}] 不是对象`)
        continue
      }
      const scope = l.scope === "provider" || l.scope === "key" ? l.scope : undefined
      if (!scope) {
        err(`budget.limits[${i}].scope 非法（仅 provider|key）`)
        continue
      }
      const target = typeof l.target === "string" ? l.target : undefined
      if (!target) {
        err(`budget.limits[${i}].target 缺失或非字符串`)
        continue
      }
      if (scope === "provider" && !(PROVIDER_IDS as readonly string[]).includes(target)) {
        err(`budget.limits[${i}].target 未知 provider "${target}"`)
        continue
      }
      if (scope === "key" && !/^[A-Za-z0-9]+:[0-9a-f]{8,64}$/.test(target)) {
        warn(`budget.limits[${i}].target "${target}" 不是 keyId 指纹形态（provider:8hex）`)
      }
      const limit = typeof l.limit === "number" && Number.isFinite(l.limit) && l.limit > 0 ? l.limit : undefined
      if (limit === undefined) {
        err(`budget.limits[${i}].limit 必须是正有限数`)
        continue
      }
      const k = `${scope}:${target}`
      if (seenLimits.has(k)) warn(`budget.limits 重复条目 ${k}，后者覆盖前者`)
      seenLimits.add(k)
      limits.push({ scope, target, limit })
    }
  }
  const budget = {
    enabled: typeof budgetRaw.enabled === "boolean" ? budgetRaw.enabled : true,
    unit,
    countMode,
    // unit=unlimited → 等价未设 limit（沿用现有无 limit 行为：check 恒放行、record 不落账）
    limits: unlimited ? [] : limits,
  }
  if (unlimited && limits.length > 0) {
    warn("budget.unit=unlimited，已忽略 budget.limits（等价未设 limit）")
  }

  /* ---- logging ---- */
  const logRaw = options.logging?.level
  const level: "silent" | "error" | "info" | "debug" =
    logRaw === "silent" || logRaw === "error" || logRaw === "info" || logRaw === "debug"
      ? logRaw
      : (logRaw !== undefined && warn(`logging.level 非法（${String(logRaw)}），回退 info`), "info")

  /* ---- providers ---- */
  const providersRaw = options.providers ?? {}
  for (const key of Object.keys(providersRaw)) {
    if (!(PROVIDER_IDS as readonly string[]).includes(key)) {
      err(`providers 未知 provider "${key}"（合法值：${PROVIDER_IDS.join(", ")}）`)
    }
  }

  const resolvedProviders = {} as ResolvedConfig["providers"]
  const enabledPriorities: Array<{ id: ProviderID; priority: number }> = []

  for (const id of PROVIDER_IDS) {
    const raw: ProviderOptions | undefined = (providersRaw as Record<string, ProviderOptions | undefined>)[id]
    const missingEnv = new Set<string>()
    const providerErrorsBefore = errors.length

    // 未配置的 provider → 全默认 + disabled
    const enabled = raw === undefined ? false : typeof raw.enabled === "boolean" ? raw.enabled : true

    let baseUrl = DEFAULT_BASE_URL[id]
    if (raw?.baseUrl !== undefined) {
      if (typeof raw.baseUrl === "string") {
        baseUrl = expandString(raw.baseUrl, env, missingEnv)
        try {
          const u = new URL(baseUrl)
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme")
        } catch {
          err(`providers.${id}.baseUrl 非法（${baseUrl}），该 provider 标记不可用`)
        }
      } else {
        err(`providers.${id}.baseUrl 必须是字符串，该 provider 标记不可用`)
      }
    }

    const priority =
      raw?.priority === undefined
        ? DEFAULT_PRIORITY[id]
        : num(raw.priority, Number.NaN, 0) ?? (warn(`providers.${id}.priority 非法，回退 ${DEFAULT_PRIORITY[id]}`), DEFAULT_PRIORITY[id])

    const timeoutMs =
      raw?.timeoutMs === undefined
        ? http.timeoutMs
        : num(raw.timeoutMs, Number.NaN, 1) ??
          (warn(`providers.${id}.timeoutMs 非法，回退 http.timeoutMs`), http.timeoutMs)

    // keys：三种写法归一为 ResolvedKeyRef（env 名，明文不落 ResolvedConfig）
    let keyRefs: ResolvedKeyRef[] = []
    if (raw?.keys !== undefined) {
      if (!Array.isArray(raw.keys)) {
        err(`providers.${id}.keys 必须是数组（KeyEntry[]），该 provider 标记不可用`)
      } else {
        const seenEnv = new Set<string>()
        raw.keys.forEach((entry, i) => {
          const ref = normalizeKeyEntry(entry)
          if (!ref) {
            err(
              `providers.${id}.keys[${i}] 非法（须为 env 名、\${ENV_VAR} 或 {id, value:"\${ENV_VAR}"}），该 provider 标记不可用`,
            )
            return
          }
          if (seenEnv.has(ref.envName)) {
            warn(`providers.${id}.keys 重复引用 ${ref.envName}，已去重`)
            return
          }
          seenEnv.add(ref.envName)
          keyRefs.push(ref)
        })
      }
    }
    let keysInline: string[] = []
    if (raw?.keysInline !== undefined) {
      if (Array.isArray(raw.keysInline) && raw.keysInline.every((k) => typeof k === "string")) {
        keysInline = raw.keysInline as string[]
        if (keysInline.length > 0) {
          warn(`providers.${id}.keysInline 使用明文密钥（不推荐），日志中将仅显示 keyId`)
        }
      } else {
        err(`providers.${id}.keysInline 必须是字符串数组`)
      }
    }

    let adapterOptions: Record<string, unknown> = {}
    if (raw?.options !== undefined) {
      if (isRecord(raw.options)) {
        // 展开 options 内字符串的 ${VAR}（缺失仅告警，不置灰 provider）
        adapterOptions = {}
        for (const [k, v] of Object.entries(raw.options)) {
          adapterOptions[k] =
            typeof v === "string" ? expandString(v, env, missingEnv) : v
        }
      } else {
        err(`providers.${id}.options 必须是对象`)
      }
    }

    // env 缺失检查（仅 keys 条目触发「不可用」）：缺失 → warning + 该 key 不可用，不抛错
    const presentRefs: ResolvedKeyRef[] = []
    for (const ref of keyRefs) {
      const v = env[ref.envName]
      if (v === undefined || v === "") {
        warn(`providers.${id} 环境变量 ${ref.envName} 未设置（key 不可用）`)
        continue
      }
      presentRefs.push(ref)
    }

    let finalEnabled = enabled
    if (errors.length > providerErrorsBefore) finalEnabled = false // provider 级 schema 错误 → 阻断

    if (finalEnabled && !KEYLESS_PROVIDERS.has(id) && presentRefs.length === 0 && keysInline.length === 0) {
      warn(`providers.${id} 无可用 key（env 缺失或未配置），标记为不可用`)
      finalEnabled = false
    }
    for (const name of missingEnv) {
      warn(`providers.${id} 引用了未设置的环境变量 ${name}`)
    }

    if (finalEnabled) enabledPriorities.push({ id, priority })

    resolvedProviders[id] = {
      enabled: finalEnabled,
      priority,
      baseUrl,
      keys: keyRefs,
      keysInline,
      options: adapterOptions,
      timeoutMs,
    }
  }

  // priority 冲突（仅 enabled 之间）
  const byPriority = new Map<number, ProviderID[]>()
  for (const { id, priority } of enabledPriorities) {
    const list = byPriority.get(priority) ?? []
    list.push(id)
    byPriority.set(priority, list)
  }
  for (const [priority, ids] of byPriority) {
    if (ids.length > 1) warn(`priority 冲突：${ids.join(", ")} 同为 ${priority}（排序将退化为配置枚举序）`)
  }

  return {
    resolved: {
      providers: resolvedProviders,
      routing,
      http,
      cache,
      circuitBreaker,
      keyPool,
      budget,
      logging: { level },
    },
    errors,
    warnings,
  }
}

/**
 * 从已解析配置生成 ResolvedKey 列表（key 材料唯一出口）。
 * - keys 条目（"NAME" / "${NAME}" / {id, value}，已归一 ResolvedKeyRef）→ 读 env；keysInline → 明文兜底
 * - id = `${provider}:${sha256(secret).slice(0,8)}`
 * - 每个 secret 注册进 redact() 池，保证日志层永不含明文
 */
export function resolveProviderKeys(
  config: ResolvedConfig,
  env: Env = process.env,
): Partial<Record<ProviderID, ResolvedKey[]>> {
  const out: Partial<Record<ProviderID, ResolvedKey[]>> = {}
  for (const id of PROVIDER_IDS) {
    const p = config.providers[id]
    if (!p?.enabled) continue
    const secrets: string[] = []
    for (const ref of p.keys) {
      const v = env[ref.envName]
      if (v) secrets.push(v)
    }
    secrets.push(...p.keysInline)
    const seen = new Set<string>()
    const list: ResolvedKey[] = []
    for (const secret of secrets) {
      registerSecret(secret)
      const id8 = keyIdOf(secret)
      if (seen.has(id8)) continue // 同一 secret 重复配置去重
      seen.add(id8)
      list.push({ id: fingerprint(id, secret), secret })
    }
    if (list.length > 0 || KEYLESS_PROVIDERS.has(id)) out[id] = list
  }
  return out
}
