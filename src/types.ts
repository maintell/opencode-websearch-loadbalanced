/**
 * opencode-websearch-loadbalanced — Phase 2 类型契约
 *
 * 范围：仅接口 / 类型 / 运行时常量表。无业务逻辑。
 * 依据：docs/api-research-opencode.md、docs/api-research-providers-1.md、docs/api-research-providers-2.md
 * 约束：
 *  - 日志 / 工具输出绝不出现 API key 明文 → 一切对外字段只用 keyId（脱敏指纹）。
 *  - 本文件不得 import 其他 src 模块（叶子节点，依赖方向单向指向这里）。
 */

/* ============================================================
 * 0. Provider 身份与错误码（运行时常量 + 类型）
 * ============================================================ */

export const PROVIDER_IDS = [
  "parallel",
  "exa",
  "tavily",
  "you",
  "serpapi",
  "searxng",
] as const

export type ProviderID = (typeof PROVIDER_IDS)[number]

export const ERROR_CODES = [
  "AUTH", // 401/403：key 失效或 scope 不足 → 禁用该 key
  "RATE_LIMIT", // 429：限流 → 冷却该 key（优先 Retry-After）
  "QUOTA_EXCEEDED", // 402 / 额度耗尽：本月不再用该 provider/key
  "BAD_REQUEST", // 400/404/422：请求本身有问题 → 不重试、不切 key
  "SERVER_ERROR", // 5xx：重试 N 次后切 key → 仍失败则熔断 provider
  "NETWORK_ERROR", // 连接/DNS/TLS 失败 → 切 key
  "TIMEOUT", // AbortController 超时 → 切 key
  "UNKNOWN", // 其余
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * 统一错误体。设计为纯数据（可序列化），不继承 Error：
 * 便于写入 attempt 轨迹、直接 JSON 输出，也强制「message 必须已脱敏」。
 * message 中禁止携带 key、完整 URL query（serpapi 的 key 在 query 里）。
 */
export interface ProviderError {
  code: ErrorCode
  provider: ProviderID
  /** 已脱敏的人类可读描述 */
  message: string
  httpStatus?: number
  /** 服务端 Retry-After（已换算为 ms）；服务端未返回时由上层用退避策略兜底 */
  retryAfterMs?: number
  /** 出错时使用的 key 指纹，绝不为明文 */
  keyId?: string
  attempt?: number
  /** 第三方原始错误 tag（exa 的 tag、parallel 的 error.detail 等），已截断脱敏 */
  upstreamTag?: string
}

/* ============================================================
 * 1. 搜索请求 / 结果 / 响应
 * ============================================================ */

/** 跨 provider 的时间范围统一值。各 adapter 能力不同，不支持则丢弃并记入 attempt 警告。 */
export type TimeRange = "day" | "week" | "month" | "year"

/**
 * 归一化后的搜索请求（router → adapter 的入参基底）。
 * 语义为「最大公约数」：某 provider 不支持某字段（如 Parallel 无 language/time_range）
 * → adapter 丢弃该字段，不报错；丢弃行为在 ProviderAttempt.warnings 记录。
 */
export interface SearchRequest {
  query: string
  /** 目标结果条数；adapter 按各 API 上限裁剪（parallel ≤20 / tavily ≤20 / exa ≤100 / you 每分区 ≤100） */
  maxResults?: number
  /** BCP-47 风格语言码；仅 tavily / you / serpapi / searxng 支持 */
  language?: string
  /** ISO 3166-1 alpha-2；tavily 用小写英文国名，adapter 内部转换 */
  country?: string
  timeRange?: TimeRange
  /** YYYY-MM-DD 绝对区间；parallel=source_policy.after_date、exa=startPublishedDate、tavily=start_date */
  startDate?: string
  endDate?: string
  includeDomains?: string[]
  excludeDomains?: string[]
  safeSearch?: boolean
  /** 调用方取消信号（来自 ctx.websearch execute 的 { signal }） */
  signal?: AbortSignal
}

/**
 * 单条结果 = OpenCode 官方 WebSearch.Result 的超集。
 * 内部排序 / 归因用 provider / rank / score；返回给 OpenCode 前由
 * toWebSearchResult() 剥离为 { url, title?, content?, time } 四字段。
 */
export interface SearchResult {
  url: string
  title?: string
  /** 归一化正文片段（parallel: excerpts.join、you: description+snippets、serpapi: snippet、searxng: content） */
  content?: string
  /** published 语义单位（秒 vs 毫秒）官方未明说 → 见 architecture.md「未决项」；adapter 统一产出毫秒 */
  time: { published?: number }

  /** 归因：来自哪个 provider（去重合并的主键之一） */
  provider: ProviderID
  /** provider 响应内的名次（1 起）。跨 provider 排序的唯一可靠信号 */
  rank: number
  /** provider 原生分（tavily 0..1、searxng 融合分）。仅同 provider 内可比，跨 provider 禁止直接比较 */
  score?: number
  /** 本次命中的 key 指纹（脱敏），供预算归因到 key scope */
  keyId?: string
}

/** 单个 provider 一次尝试的完整轨迹（可观测性 + 排序归因） */
export interface ProviderAttempt {
  provider: ProviderID
  outcome: "ok" | "empty" | "error" | "skipped"
  keyId?: string
  httpStatus?: number
  error?: ProviderError
  resultCount: number
  latencyMs: number
  /** 被跳过的原因（router 在尝试前过滤） */
  skippedReason?: "circuit_open" | "budget_exhausted" | "no_active_key" | "disabled" | "not_selected"
  /** adapter 因能力不支持而丢弃的请求字段 */
  droppedParams?: string[]
}

export interface SearchResponse {
  query: string
  /** 已按「provider 层级 → provider 内 rank」排序、URL 已去重的最终结果 */
  results: SearchResult[]
  attempts: ProviderAttempt[]
  cacheHit: boolean
  totalMs: number
  /** adapter 因能力不支持而丢弃的请求字段（透传自命中 attempt；attempt 轨迹各自带） */
  droppedParams?: string[]
  /** 全部 provider 失败时 router 抛出，不产生 SearchResponse */
}

/** OpenCode ctx.websearch execute 的返回元素（官方 WebSearch.Result 的本地镜像） */
export interface WebSearchResult {
  url: string
  title?: string
  content?: string
  time: { published?: number }
}

/* ============================================================
 * 2. Provider 适配层
 * ============================================================ */

/** 解析后的单个 key：secret 仅在内存内传递给 adapter，任何日志/输出只允许用 id */
export interface ResolvedKey {
  /** 稳定脱敏指纹，如 "exa:9f3a7c21"（sha256(secret) 前 8 hex） */
  id: string
  /** 明文密钥。禁止出现在任何日志、错误 message、SearchResponse、attempt 中 */
  secret: string
}

export interface ProviderSearchInput {
  request: SearchRequest
  /** requiresKey=false（searxng）时为 undefined */
  key?: ResolvedKey
  /** 统一 HTTP 出口，adapter 不得直接调 fetch */
  http: HttpClient
  signal?: AbortSignal
}

export interface ProviderSearchOutput {
  results: SearchResult[] // provider / rank 已填；score 仅有则填
  /** 解析到的第三方错误（adapter 把各家错误信封归一为 ProviderError，但不抛出——由 router 决策） */
  error?: ProviderError
  /** 上游给出的用量提示（you 的 X-RateLimit-*、tavily usage.credits）→ 喂给 Budget */
  usage?: { units: number; detail?: string }
}

export interface ProviderAdapter {
  readonly id: ProviderID
  readonly displayName: string
  readonly requiresKey: boolean
  /** 默认 1；tavily advanced=2 credits 等由 adapter 按配置报告，禁止硬编码死值（可覆盖） */
  cost(request: SearchRequest): number
  /** 单次上游调用。不得内部重试（重试/切 key/熔断全部由 router 负责） */
  search(input: ProviderSearchInput): Promise<ProviderSearchOutput>
}

/* ============================================================
 * 3. Key Pool
 * ============================================================ */

export type KeyStatus = "active" | "cooldown" | "disabled"

export interface KeyState {
  keyId: string
  provider: ProviderID
  status: KeyStatus
  /** cooldown 解除的 epoch ms（429：优先 Retry-After，否则指数退避） */
  cooldownUntil?: number
  consecutiveErrors: number
  lastErrorCode?: ErrorCode
  /** disabled 原因（401/403）；禁用到进程结束或配置重载，不自动恢复 */
  disabledReason?: string
}

export interface KeyPoolConfig {
  /** 5xx/网络/超时连续 N 次后该 provider 视为全 key 不可用 → 触发 CB */
  errorThreshold: number
  /** 无 Retry-After 时的 429 基础冷却 ms（指数，封顶 maxCooldownMs） */
  baseCooldownMs: number
  maxCooldownMs: number
}

/* ============================================================
 * 4. Circuit Breaker
 * ============================================================ */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export interface CircuitBreakerConfig {
  /** CLOSED → OPEN：连续失败次数（或滑动窗口内失败率，Phase 2 取连续次数，YAGNI） */
  failureThreshold: number
  /** OPEN 持续时长 ms，到点转 HALF_OPEN */
  openMs: number
  /** HALF_OPEN 允许的探测并发数 */
  halfOpenMaxCalls: number
  /** HALF_OPEN → CLOSED：连续成功次数 */
  successThreshold: number
}

export interface CircuitBreakerView {
  provider: ProviderID
  state: CircuitState
  consecutiveFailures: number
  consecutiveSuccesses: number
  openedAt?: number
  nextProbeAt?: number
}

/* ============================================================
 * 5. Budget Manager（月度，YYYY-MM）
 * ============================================================ */

export type BudgetScope = "provider" | "key"

/** 计数口径：serpapi 官方「仅成功计数」→ success；其余默认 attempt */
export type BudgetCountMode = "attempt" | "success"

export interface BudgetLimit {
  scope: BudgetScope
  /** scope=provider → ProviderID；scope=key → keyId 指纹 */
  target: string
  limit: number
}

export interface BudgetConfig {
  enabled: boolean
  /** 计量单位：requests=调用次数；credits=按 adapter.cost() 加权 */
  unit: "requests" | "credits"
  countMode: BudgetCountMode
  limits: BudgetLimit[]
}

export interface BudgetEntry {
  scope: BudgetScope
  target: string
  period: string // "YYYY-MM"
  limit: number
  used: number
  unit: "requests" | "credits"
}

export interface BudgetState {
  period: string
  entries: Record<string, BudgetEntry> // key = `${scope}:${target}:${period}`
}

/** router 判定用：耗尽即 skip，不发请求 */
export type BudgetVerdict = { ok: true } | { ok: false; scope: BudgetScope; target: string; limit: number; used: number }

/* ============================================================
 * 6. Router（provider 级 fallback）
 * ============================================================ */

export type RoutingStrategy = "priority" | "round_robin"

export interface ProviderPolicy {
  id: ProviderID
  enabled: boolean
  /** 数字小者优先（SearXNG 作为最终 fallback 应给最大值） */
  priority: number
}

export interface RouterConfig {
  strategy: RoutingStrategy
  /** 单次请求最多尝试多少个 provider（不含缓存命中），防御性上限 */
  maxProviderAttempts: number
}

/** router 对一个候选 provider 的放行条件全部满足才真正发请求：enabled ∧ budget ∧ key ∧ CB */

/* ============================================================
 * 7. HttpClient / Cache
 * ============================================================ */

export interface HttpRequest {
  url: string
  method: "GET" | "POST"
  headers?: Record<string, string>
  /** query 序列化在此完成；serpapi 的 api_key 走这里 → 错误 message 中必须抹除 query */
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  /** key 已小写 */
  headers: Record<string, string>
  latencyMs: number
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
  /** 统一解析 Retry-After（秒数或 HTTP-date）→ ms；缺失返回 undefined */
  parseRetryAfter(headerValue: string | undefined, now?: number): number | undefined
}

export interface HttpConfig {
  timeoutMs: number
  /** 单 key 内 5xx/网络错误重试次数（重试后仍失败 → 切 key） */
  retriesPerKey: number
  retryBackoffMs: number
  maxRetryBackoffMs: number
}

export interface CacheConfig {
  ttlMs: number
  maxEntries: number
}

/** 缓存键 = 归一化 query + 全部影响结果的请求字段（不含 signal/key） */
export type CacheKey = string

/* ============================================================
 * 8. 配置 schema（opencode.jsonc → plugins[].options → ctx.options）
 * ============================================================ */

export interface ProviderOptions {
  enabled?: boolean
  priority?: number
  /** searxng 默认 https://search.658658.xyz；其余 provider 有官方默认 baseUrl */
  baseUrl?: string
  /**
   * key 来源：**环境变量引用**（推荐，明文不进配置文件）。三种等价写法：
   * - `"EXA_API_KEY"`（纯 env 名，architecture.md §7 推荐）
   * - `"${EXA_API_KEY}"`（插值字符串，examples 模板写法）
   * - `{ id: "primary", value: "${EXA_API_KEY}" }`（对象，显式槽位 id）
   * 三者统一归一为 ResolvedKeyRef；缺失 env → 该 key/provider 不可用（不抛错）。
   */
  keys?: KeyEntry[]
  /** 直接写明文（不推荐，仅兜底）。日志与输出中一律脱敏为 keyId */
  keysInline?: string[]
  /** adapter 专属参数（parallel.mode / tavily.search_depth / serpapi.engine …），不透明透传 */
  options?: Record<string, unknown>
  timeoutMs?: number
}

/** keys 条目的对象写法：value 为环境变量引用 */
export interface KeyRef {
  /** 槽位别名（诊断/配对用，与 keyId 指纹无关）；缺省由 env 名派生 */
  id?: string
  /** 环境变量引用，如 "${EXA_API_KEY}"；也接受裸 env 名 "EXA_API_KEY" */
  value: string
}

/** keys 条目联合：env 名字符串 / "${ENV}" 字符串 / 对象 */
export type KeyEntry = string | KeyRef

/** config 归一化后的 key 引用（三种写法的统一内部结构） */
export interface ResolvedKeyRef {
  /** 槽位 id；缺省 = envName */
  id: string
  /** 待读取的环境变量名 */
  envName: string
}

/** budget.unit 输入侧枚举（config.ts 归一）：credit→credits、usd→credits、unlimited→丢弃 limits */
export type BudgetUnitInput = "requests" | "credits" | "credit" | "usd" | "unlimited"

export interface WebSearchPluginOptions {
  providers?: Partial<Record<ProviderID, ProviderOptions>>
  routing?: Partial<RouterConfig>
  http?: Partial<HttpConfig>
  cache?: Partial<CacheConfig>
  circuitBreaker?: Partial<CircuitBreakerConfig>
  keyPool?: Partial<KeyPoolConfig>
  /** unit 为输入侧枚举（含别名）；resolveConfig 归一后落 ResolvedConfig.budget.unit（BudgetConfig） */
  budget?: Partial<Omit<BudgetConfig, "limits" | "unit">> & {
    unit?: BudgetUnitInput
    limits?: BudgetLimit[]
  }
  logging?: { level?: "silent" | "error" | "info" | "debug" }
}

/** config.ts 校验/补默认后的产物；router/key-pool/budget 只读它 */
export interface ResolvedConfig {
  providers: Record<
    ProviderID,
    Required<Omit<ProviderOptions, "keys">> & { keys: ResolvedKeyRef[]; keysInline: string[] }
  >
  routing: RouterConfig
  http: HttpConfig
  cache: CacheConfig
  circuitBreaker: CircuitBreakerConfig
  keyPool: KeyPoolConfig
  budget: BudgetConfig
  logging: { level: "silent" | "error" | "info" | "debug" }
}

/** 配置校验结果：warning 不阻断，error 阻断该 provider 启用 */
export interface ConfigValidation {
  resolved: ResolvedConfig
  errors: string[]
  warnings: string[]
}
