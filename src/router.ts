/**
 * router.ts：请求编排（architecture.md §4 生命周期、§5 排序去重、§6 故障转移）。
 *
 * 职责边界（§3）：
 * - 唯一决策者：候选过滤（enabled → cache → budget → CB → key 可用）→ 策略排序 →
 *   逐个派发 → 错误分类决策（切 key / 切 provider / 放弃）。
 * - 不直接 fetch（统一出口 HttpClient 经 input 注入 adapter）；不实现 key/CB 状态机
 *   （只调 key-pool / circuit-breaker / budget 的 API 回灌）。
 * - provider 实例构造注入（id → SearchProvider 注册表），不 import providers/*。
 *
 * 路由规则：
 * - 策略：priority（默认，priority 升序，平手按配置枚举序）/ round_robin（按轮次旋转起点）。
 * - 单 provider 尝试流程：cache 查（命中不消耗预算）→ budget 前置闸 → CB 状态检查 →
 *   key-pool 取 key → adapter.search → 成功：dedup+rank 返回；错误：按 ErrorCode 分派。
 * - 首个非空成功即短路（§4 规则 1）；上游成功但零结果 → 继续下一 provider。
 * - SearXNG 最终 fallback：商业 provider 无结果后必试（不受 maxProviderAttempts 约束）。
 * - 全挂（无任何 ok/empty 尝试）→ 抛 RouterError（脱敏聚合 attempt 轨迹，绝不含 key 明文）。
 * - 跨 provider 排序：层级（本轮尝试顺序 = priority / round_robin 起点）→ provider 内
 *   rank → 新鲜度；URL 规范化去重（utils/url），同 URL 合并保留 providers 列表。
 *
 * 重试策略：retry.maxAttempts/baseDelayMs/maxDelayMs（缺省由 config.http 折算
 * retriesPerKey+1 / retryBackoffMs / maxRetryBackoffMs）。429 的 Retry-After 优先作用于
 * 当前 key 冷却（key-pool），健康 key 立即轮换不阻塞；其余可重试错误按指数退避等待。
 */
import { buildCacheKey, type Cache } from "./cache"
import { backoffDelay } from "./http-client"
import type { CircuitBreaker } from "./circuit-breaker"
import type { KeyPool } from "./key-pool"
import type { MonthlyBudgetManager } from "./budget"
import {
  PROVIDER_IDS,
  type HttpClient,
  type ProviderAdapter,
  type ProviderAttempt,
  type ProviderError,
  type ProviderID,
  type ProviderSearchOutput,
  type ResolvedConfig,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from "./types"
import { createProviderError, isProviderError } from "./utils/errors"
import { redact } from "./utils/logging"
import { dedupe, type DedupedResult } from "./utils/url"

/** provider 实例（构造注入的注册表条目；不 import 具体 adapter） */
export type SearchProvider = ProviderAdapter

/** 单 provider 内的重试预算（缺省由 config.http 折算） */
export interface RetryPolicy {
  /** 含首次在内的最大尝试次数（默认 http.retriesPerKey + 1） */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface RouterDeps {
  config: ResolvedConfig
  /** id → provider 实例注册表（index.ts 在 setup() 内构造注入） */
  providers: Partial<Record<ProviderID, SearchProvider>>
  keyPool: KeyPool
  circuitBreaker: CircuitBreaker
  budget: MonthlyBudgetManager
  http: HttpClient
  /** provider 级结果缓存（命中不消耗预算、不打上游）；缺省不启用 */
  cache?: Cache<SearchResult[]>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  retry?: Partial<RetryPolicy>
}

/** SearchResponse 超集：附带可观测字段（types.ts 冻结，扩展字段在此声明） */
export interface RouteResponse extends SearchResponse {
  /** dedup 后每条带 providers 归因列表（utils/url DedupedResult） */
  results: DedupedResult[]
  /** = totalMs（对外两个别名都给） */
  elapsedMs: number
  /** = cacheHit */
  cached: boolean
  /** 命中（短路）成功时所用 key 指纹；缓存命中 / searxng 为 undefined */
  keyId?: string
  /** 上游用量聚合（you 的 X-RateLimit-* / tavily usage.credits → budget 归因） */
  usage?: { units: number; detail?: string }
  /** 可读告警：跳过原因、调用方取消等（keyId-only，已脱敏） */
  warnings: string[]
}

export interface Router {
  route(request: SearchRequest): Promise<RouteResponse>
}

/** 全挂时抛出：message 与 attempts 均已脱敏（不含 key 明文、不含带 query 的 URL） */
export class RouterError extends Error {
  readonly attempts: ProviderAttempt[]
  readonly provider?: ProviderID
  constructor(message: string, attempts: ProviderAttempt[]) {
    super(redact(message))
    this.name = "RouterError"
    this.attempts = attempts
    this.provider = attempts.find((a) => a.error !== undefined)?.provider
  }
}

export function isRouterError(e: unknown): e is RouterError {
  return e instanceof RouterError
}

/* ============================================================
 * 跨 provider 排序 + 去重（architecture.md §5）
 * ============================================================ */

/**
 * 排序键字典序：① provider 层级（groups 数组序 = 本轮尝试顺序；priority 下即配置
 * priority 序，round_robin 下为本轮旋转序）→ ② provider 内 rank → ③ 新鲜度
 * time.published（有则新者在前，缺省视为最旧）。native score 不参与跨 provider 比较。
 * 输入应已按层级排列；输出经 URL 规范化去重，同 URL 合并保留 providers 列表。
 */
export function rankAndDedupe(
  groups: Array<{ provider: ProviderID; results: SearchResult[] }>,
): DedupedResult[] {
  const layer = new Map<ProviderID, number>()
  groups.forEach((g, i) => {
    if (!layer.has(g.provider)) layer.set(g.provider, i)
  })
  const flat: SearchResult[] = []
  for (const g of groups) {
    for (const r of g.results) flat.push({ ...r, provider: g.provider, time: r.time ?? {} })
  }
  flat.sort((a, b) => {
    const la = layer.get(a.provider) ?? Number.MAX_SAFE_INTEGER
    const lb = layer.get(b.provider) ?? Number.MAX_SAFE_INTEGER
    if (la !== lb) return la - lb
    if (a.rank !== b.rank) return a.rank - b.rank
    const pa = a.time?.published
    const pb = b.time?.published
    if (pa !== undefined && pb !== undefined) return pb - pa
    if (pa !== undefined) return -1 // 有发布时间者排前
    if (pb !== undefined) return 1
    return 0
  })
  return dedupe(flat)
}

/** 聚合失败摘要（全挂时进 RouterError.message；只含 code/status，绝不含 message 原文） */
function aggregateMessage(attempts: ProviderAttempt[]): string {
  if (attempts.length === 0) return "无可用 provider（全部被禁用或未注册）"
  const parts = attempts.map((a) => {
    if (a.outcome === "skipped") return `${a.provider}:skipped(${a.skippedReason ?? "unknown"})`
    if (a.outcome === "error" && a.error) {
      const st = a.error.httpStatus !== undefined ? `/${a.error.httpStatus}` : ""
      return `${a.provider}:${a.error.code}${st}`
    }
    return `${a.provider}:${a.outcome}`
  })
  return `所有 provider 失败，无可用结果：${parts.join(", ")}`
}

function mergeUsage(
  prev: { units: number; detail?: string } | undefined,
  next: { units: number; detail?: string },
): { units: number; detail?: string } {
  return { units: (prev?.units ?? 0) + next.units, detail: next.detail ?? prev?.detail }
}

/* ============================================================
 * createRouter
 * ============================================================ */

interface RouteState {
  attempts: ProviderAttempt[]
  warnings: string[]
  usage?: { units: number; detail?: string }
  cacheHit: boolean
  /** 命中（成功）attempt 的丢弃字段透传到响应（裁决①） */
  droppedParams?: string[]
}

/** adapter 输出交叉扩展：droppedParams 由 adapter 以交叉类型上报（ProviderSearchOutput 无此字段，裁决①） */
type AdapterOutput = ProviderSearchOutput & { droppedParams?: string[] }

/** attempt 轨迹附带 droppedParams（有则带上） */
function withDrops<T extends ProviderAttempt>(a: T, drops: string[] | undefined): T {
  return drops && drops.length > 0 ? { ...a, droppedParams: drops } : a
}

/** 单 provider 一次完整尝试的结果（仅 ok 短路，其余一律继续下一候选） */
type TryOutcome =
  | { ok: true; results: SearchResult[]; keyId?: string; cached: boolean }
  | { ok: false }

export function createRouter(deps: RouterDeps): Router {
  const { config } = deps
  const now = deps.now ?? (() => Date.now())
  // 测试注入无副作用 sleep（记录退避序列）；生产默认真等待
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms)))
  const retry: RetryPolicy = {
    maxAttempts: deps.retry?.maxAttempts ?? Math.max(1, config.http.retriesPerKey + 1),
    baseDelayMs: deps.retry?.baseDelayMs ?? config.http.retryBackoffMs,
    maxDelayMs: deps.retry?.maxDelayMs ?? config.http.maxRetryBackoffMs,
  }
  /** round_robin 策略的跨请求轮转游标（每 route() 前进一格） */
  let rrCursor = 0

  /** 候选顺序：仅已启用的商业 provider 按策略排序（轮转游标只数真实候选），searxng 恒定压尾 */
  function candidateOrder(): ProviderID[] {
    const commercial = PROVIDER_IDS.filter(
      (id) => id !== "searxng" && config.providers[id]?.enabled === true,
    )
      .map((id) => ({ id, priority: config.providers[id]?.priority ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.priority - b.priority || PROVIDER_IDS.indexOf(a.id) - PROVIDER_IDS.indexOf(b.id))
      .map((x) => x.id)
    const tail: ProviderID[] = config.providers.searxng?.enabled === true ? ["searxng"] : []
    if (config.routing.strategy === "round_robin" && commercial.length > 0) {
      const k = rrCursor++ % commercial.length
      return [...commercial.slice(k), ...commercial.slice(0, k), ...tail]
    }
    return [...commercial, ...tail]
  }

  function cacheKeyOf(pid: ProviderID, request: SearchRequest): string {
    const { query, signal: _signal, ...params } = request
    return buildCacheKey({ provider: pid, query, params })
  }

  /** 归因补全：provider 强制为 pid、rank 1 起、keyId/缺省 time 兜底 */
  function normalizeResults(list: SearchResult[], pid: ProviderID, keyId?: string): SearchResult[] {
    return list.map((r, i) => ({
      ...r,
      provider: pid,
      rank: typeof r.rank === "number" && r.rank > 0 ? r.rank : i + 1,
      keyId: r.keyId ?? keyId,
      time: r.time ?? {},
    }))
  }

  /** 适配器错误 → 统一脱敏 ProviderError（强制 provider 归属 + attempt 序号） */
  function normalizeError(e: ProviderError, pid: ProviderID, keyId: string | undefined, attempt: number): ProviderError {
    // 裁决（Provider A②）：408 Request Timeout 分类决策表未列 → 按 retryable 处理，归 SERVER_ERROR
    //（TIMEOUT / SERVER_ERROR 均可，选 SERVER_ERROR：语义是上游服务端等待超时，非本地 AbortController 超时）。
    // utils/errors.classifyStatus 现仍输出 UNKNOWN+httpStatus=408 → router 出厂时归一，分类表未动。
    const code = e.httpStatus === 408 && e.code === "UNKNOWN" ? "SERVER_ERROR" : e.code
    return createProviderError({
      code,
      provider: pid,
      message: e.message,
      httpStatus: e.httpStatus,
      retryAfterMs: e.retryAfterMs,
      keyId: e.keyId ?? keyId,
      attempt,
      upstreamTag: e.upstreamTag,
    })
  }

  /**
   * 单 provider 完整尝试（含重试/切 key 循环）。放行条件全满足才发请求；
   * 任一闸不过 → attempt(outcome=skipped) 后返回，由 route 继续下一候选。
   */
  async function attemptProvider(
    pid: ProviderID,
    request: SearchRequest,
    state: RouteState,
  ): Promise<TryOutcome> {
    const adapter = deps.providers[pid]
    if (!config.providers[pid]?.enabled) return skip("disabled")
    if (!adapter) return skip("not_selected")

    function skip(reason: NonNullable<ProviderAttempt["skippedReason"]>): TryOutcome {
      state.attempts.push({ provider: pid, outcome: "skipped", resultCount: 0, latencyMs: 0, skippedReason: reason })
      state.warnings.push(`${pid}: skipped(${reason})`)
      return { ok: false }
    }

    // ① cache 查（命中直接返回：不消耗预算、不打上游、不看 CB/key）
    if (deps.cache) {
      const hit = deps.cache.get(cacheKeyOf(pid, request))
      if (hit) {
        // ponytail: 缓存条目只存 results，droppedParams/usage 不随缓存存 → 命中响应不带这两项；升级路径：缓存条目改为 {results, meta}
        state.attempts.push({ provider: pid, outcome: "ok", resultCount: hit.value.length, latencyMs: 0 })
        return { ok: true, results: hit.value, cached: true }
      }
    }

    // ② budget 前置闸（provider scope；key scope 在取到 key 后补查）——耗尽不发请求
    const pv = deps.budget.check({ provider: pid, now: now() })
    if (!pv.ok) {
      state.warnings.push(`${pid}: budget exhausted (${pv.scope}:${pv.target})`)
      return skip("budget_exhausted")
    }

    // ③ circuit-breaker 状态检查（OPEN → skip，不消耗 key 状态）
    if (!deps.circuitBreaker.canPass(pid, now())) return skip("circuit_open")

    // ④ key 可用性（searxng 等 requiresKey=false 直通）
    const requiresKey = adapter.requiresKey
    if (requiresKey && !deps.keyPool.hasActive(pid, now())) return skip("no_active_key")

    // ⑤ 派发 + 错误分类重试循环
    let lastError: ProviderError | undefined
    for (let n = 1; n <= retry.maxAttempts; n++) {
      if (request.signal?.aborted) {
        state.warnings.push(`${pid}: aborted by caller`)
        return { ok: false }
      }
      const key = requiresKey ? deps.keyPool.next(pid, now()) : undefined
      if (requiresKey && !key) {
        if (!lastError) return skip("no_active_key") // 闸后竞态：全 key 不可用
        return { ok: false } // 已有失败记录 → 全 key 耗尽，换 provider
      }
      if (key) {
        const kv = deps.budget.check({ provider: pid, keyId: key.id, now: now() })
        if (!kv.ok) {
          state.attempts.push({
            provider: pid,
            outcome: "skipped",
            keyId: key.id,
            resultCount: 0,
            latencyMs: 0,
            skippedReason: "budget_exhausted",
          })
          state.warnings.push(`${pid}: key budget exhausted (${kv.target})`)
          continue // 换下一个 key（受 maxAttempts 约束，不会死循环）
        }
      }

      const t1 = now()
      let out: AdapterOutput
      try {
        out = await adapter.search({ request, key, http: deps.http, signal: request.signal })
      } catch (e) {
        out = {
          results: [],
          error: isProviderError(e)
            ? e
            : createProviderError({
                code: "UNKNOWN",
                provider: pid,
                message: e instanceof Error ? e.message : String(e),
                keyId: key?.id,
                attempt: n,
              }),
        }
      }
      const latencyMs = Math.max(0, now() - t1)
      const drops = out.droppedParams
      // 裁决③：能力不支持被丢弃的过滤字段 → warnings 可读记录（attempt/response 各自带 droppedParams）
      if (drops && drops.length > 0) state.warnings.push(`${pid}: dropped params ${drops.join(",")}`)
      if (out.usage) state.usage = mergeUsage(state.usage, out.usage)

      if (!out.error) {
        // 裁决②：budget 只在成功后记一次，禁止 usage+attempt 叠加。
        // 裁决（Provider A①）usage.units 量纲分流，跨量纲不换算：
        // - credits（unit=credits）只信 tavily 上报 → units = tavily.usage.units
        // - parallel/you 的 usage 属 request 口径 → 不换算成 credits，恒按 1 计
        //   （unit=requests 下 budget.record 按每次成功调用计 1 次，与 request 口径一致；
        //   ponytail: 若要求 parallel usage.units=N 在 requests 口径计 N 次，需 budget.record
        //   支持 units 参与 requests 计数——budget.ts 未授权改动，升级时再改）
        // - exa 不报 usage → units=1，countMode（attempt/success）由 record 内部执行
        const units = pid === "tavily" && out.usage ? out.usage.units : 1
        deps.budget.record({ provider: pid, keyId: key?.id, ok: true, units, now: now() })
        if (drops && drops.length > 0) state.droppedParams = drops // 响应级透传命中 attempt 的丢弃字段
        deps.keyPool.reportSuccess(pid, key?.id)
        deps.circuitBreaker.onSuccess(pid)
        const results = normalizeResults(out.results ?? [], pid, key?.id)
        if (results.length === 0) {
          // 上游成功但空结果：不短路、不重试同 provider（同 query 大概率仍空）
          state.attempts.push(withDrops({ provider: pid, outcome: "empty", keyId: key?.id, resultCount: 0, latencyMs }, drops))
          return { ok: false }
        }
        if (deps.cache) deps.cache.set(cacheKeyOf(pid, request), results, now())
        state.attempts.push(withDrops({ provider: pid, outcome: "ok", keyId: key?.id, resultCount: results.length, latencyMs }, drops))
        return { ok: true, results, keyId: key?.id, cached: false }
      }

      const err = normalizeError(out.error, pid, key?.id, n)
      lastError = err
      state.attempts.push(
        withDrops(
          {
            provider: pid,
            outcome: "error",
            keyId: key?.id,
            httpStatus: err.httpStatus,
            error: err,
            resultCount: 0,
            latencyMs,
          },
          drops,
        ),
      )
      // 回灌 key-pool（429→cooldown 优先 Retry-After；401/403→disable；402→disable）
      deps.keyPool.report(pid, key?.id, err.code, { retryAfterMs: err.retryAfterMs, now: now() })
      // 回灌 CB：只统计 5xx/网络/超时（countsTowardCircuit 现状为代码权威——裁决：UNKNOWN 不计熔断，
      // architecture.md §6.1「UNKNOWN 计一次 CB 失败」与之冲突以代码为准；SearXNG 403=UNKNOWN 若计熔断
      // 会因实例配置问题误开电路）。
      // HALF_OPEN 下非计数型错误（UNKNOWN/429/…）→ 按 onSuccess 结算探测名额：既不误开电路（裁决），
      // 也避免 inFlight 名额泄漏导致 HALF_OPEN 永久卡死（onFailure 带 code 会 early-return 不减名额）。
      // 「或全 key 不可用」触发由 keyPool.errorThreshold 兜底（§6.2），仅计数型 code 生效。
      const counted = deps.circuitBreaker.onFailure(pid, err.code)
      if (!counted && deps.circuitBreaker.view(pid).state === "HALF_OPEN") deps.circuitBreaker.onSuccess(pid)
      if (!counted && deps.keyPool.thresholdExceeded(pid)) deps.circuitBreaker.onFailure(pid, err.code)

      switch (err.code) {
        case "BAD_REQUEST":
        case "UNKNOWN":
          return { ok: false } // 请求本身/未知问题：不重试、不切 key，换 provider
        case "AUTH":
        case "RATE_LIMIT":
          // key 动作已由 key-pool 完成 → 立即换同 provider 下一个 active key。
          // 429 的 Retry-After 作用于当前 key 冷却（不阻塞健康 key）；无可用 key → 换 provider
          if (!deps.keyPool.hasActive(pid, now())) return { ok: false }
          continue
        case "QUOTA_EXCEEDED":
          deps.budget.markExhausted("provider", pid, now()) // 本月该 provider 停用
          return { ok: false }
        default:
          // SERVER_ERROR / NETWORK_ERROR / TIMEOUT：退避等待后重试（round-robin 自动换 key）
          if (n < retry.maxAttempts) {
            await sleep(backoffDelay(n, retry.baseDelayMs, retry.maxDelayMs, err.retryAfterMs))
            continue
          }
          return { ok: false }
      }
    }
    return { ok: false }
  }

  async function route(request: SearchRequest): Promise<RouteResponse> {
    const t0 = now()
    const state: RouteState = { attempts: [], warnings: [], cacheHit: false }
    const groups: Array<{ provider: ProviderID; results: SearchResult[] }> = []
    let winKeyId: string | undefined

    // 候选顺序（config 未启用的 provider 完全不进轨迹；enabled 但未注册 → attempt 中记 not_selected）
    const commercial = candidateOrder().filter((pid) => pid !== "searxng")

    let evaluated = 0
    for (const pid of commercial) {
      if (request.signal?.aborted) {
        state.warnings.push("aborted: 调用方取消，停止路由")
        break
      }
      if (evaluated >= config.routing.maxProviderAttempts) break // 防御性上限（缓存命中不计入）
      const r = await attemptProvider(pid, request, state)
      if (r.ok && r.cached) {
        // 缓存命中不计入 maxProviderAttempts（types.ts RouterConfig 注释）
      } else {
        evaluated++
      }
      if (r.ok) {
        groups.push({ provider: pid, results: r.results })
        winKeyId = r.keyId
        state.cacheHit = r.cached
        break // 首个非空成功即短路（§4 规则 1）
      }
    }

    // SearXNG 最终 fallback：商业 provider 无结果且未被取消 → 必试（不受上限约束）
    if (groups.length === 0 && !request.signal?.aborted && config.providers.searxng?.enabled === true) {
      const r = await attemptProvider("searxng", request, state)
      if (r.ok) {
        groups.push({ provider: "searxng", results: r.results })
        winKeyId = r.keyId
        state.cacheHit = r.cached
      }
    }

    const results = groups.length > 0 ? rankAndDedupe(groups) : []
    const elapsedMs = Math.max(0, now() - t0)
    const hasOk = state.attempts.some((a) => a.outcome === "ok" || a.outcome === "empty")
    if (results.length === 0 && !hasOk) {
      // 全挂才抛（§4 规则 2）；部分成功或上游空结果属正常返回
      const msg =
        state.attempts.length === 0 && request.signal?.aborted
          ? "请求已被调用方取消"
          : aggregateMessage(state.attempts)
      throw new RouterError(msg, state.attempts)
    }

    const response: RouteResponse = {
      query: request.query,
      results,
      attempts: state.attempts,
      cacheHit: state.cacheHit,
      totalMs: elapsedMs,
      elapsedMs,
      cached: state.cacheHit,
      warnings: state.warnings,
    }
    if (winKeyId !== undefined) response.keyId = winKeyId
    if (state.usage !== undefined) response.usage = state.usage
    if (state.droppedParams !== undefined) response.droppedParams = state.droppedParams
    return response
  }

  return { route }
}
