/**
 * Tavily adapter — 只做 request / response / error 映射（architecture.md §3、§9）。
 * 依据 docs/api-research-providers-1.md §3（2026-09-29）。
 * 边界：不重试、不切 key、不调 fetch——HTTP 全部经注入的 HttpClient。
 * 认证：Authorization: Bearer tvly-…（现行文档；旧 Tavily-API-Key header 已废弃）。
 */
import type {
  HttpClient,
  HttpResponse,
  ProviderAdapter,
  ProviderError,
  ProviderSearchInput,
  ProviderSearchOutput,
  SearchRequest,
  SearchResult,
} from "../types"
import { classifyStatus, createProviderError, isProviderError } from "../utils/errors"
import { registerSecret } from "../utils/logging"

export const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com"

/** adapter 额外携带丢弃字段（types.ts 无 droppedParams 挂载点 → 交叉类型上报给 router） */
export type TavilyOutput = ProviderSearchOutput & { droppedParams?: string[] }

type Loose = Record<string, unknown>

function optString(o: Loose, k: string): string | undefined {
  return typeof o[k] === "string" ? (o[k] as string) : undefined
}

/**
 * ISO 3166-1 alpha-2 → tavily `country`（小写英文国名，且仅 topic=general）。
 * ponytail: 只覆盖常见国别表；未命中 → 丢弃 country 字段（tavily 不认 ISO 码，硬传会 400/被忽略）。
 * 升级路径：接入完整 ISO 表或改为读取上游国名枚举。
 */
const COUNTRY_NAMES: Record<string, string> = {
  us: "united states", gb: "united kingdom", uk: "united kingdom", cn: "china", jp: "japan",
  kr: "south korea", de: "germany", fr: "france", ca: "canada", au: "australia", in: "india",
  it: "italy", es: "spain", br: "brazil", mx: "mexico", ru: "russia", nl: "netherlands",
  se: "sweden", no: "norway", fi: "finland", dk: "denmark", ch: "switzerland", at: "austria",
  be: "belgium", ie: "ireland", pt: "portugal", pl: "poland", tr: "turkey", sa: "saudi arabia",
  ar: "argentina", cl: "chile", co: "colombia", za: "south africa", eg: "egypt", il: "israel",
  sg: "singapore", hk: "hong kong", tw: "taiwan", th: "thailand", vn: "vietnam", id: "indonesia",
  my: "malaysia", ph: "philippines", nz: "new zealand", ua: "ukraine", cz: "czech republic",
  gr: "greece", hu: "hungary", ro: "romania", ng: "nigeria", pk: "pakistan", bd: "bangladesh",
}

/** 时间字段 → epoch ms（architecture.md #8：adapter 统一产出毫秒） */
function parseTimeMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v) // 秒/毫秒双兼容
  }
  if (typeof v === "string" && v) {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return undefined
}

/** 非 2xx 错误信封 → ProviderError（tavily: {"detail":{"error":...}} / {"detail":"..."}） */
async function mapHttpError(http: HttpClient, res: HttpResponse): Promise<ProviderError> {
  let text = ""
  try {
    text = await res.text()
  } catch {
    text = ""
  }
  let upstream = text
  try {
    const body = JSON.parse(text) as Loose
    const detail = body.detail
    if (typeof detail === "string") upstream = detail
    else if (detail && typeof detail === "object") {
      const e = (detail as Loose).error
      if (typeof e === "string") upstream = e
    } else if (typeof body.error === "string") upstream = body.error
  } catch {
    /* 非 JSON 错误体（HTML 等）→ 保留原文，由 createProviderError 截断脱敏 */
  }
  const code = classifyStatus("tavily", res.status, { bodyHint: upstream })
  const retryAfterMs = http.parseRetryAfter(res.headers["retry-after"])
  return createProviderError({
    code,
    provider: "tavily",
    message: `HTTP ${res.status}: ${upstream}`,
    httpStatus: res.status,
    retryAfterMs,
    upstreamTag: upstream,
  })
}

interface TavilyResultRow {
  url?: unknown
  title?: unknown
  content?: unknown
  score?: unknown
  published_date?: unknown
}

interface TavilyPayload {
  results?: TavilyResultRow[]
  usage?: { credits?: unknown }
}

export interface TavilyAdapterOptions {
  baseUrl?: string
  /** ProviderOptions.options 不透明透传（search_depth / topic / include_answer / …） */
  options?: Record<string, unknown>
  /** 直接传扁平 options 记录亦可（两种形态运行时归一） */
  [k: string]: unknown
}

function resolveOpts(opts: TavilyAdapterOptions): { baseUrl: string; options: Loose } {
  const raw = (opts ?? {}) as Loose
  const nested = raw.options && typeof raw.options === "object" ? (raw.options as Loose) : undefined
  const baseUrl =
    typeof raw.baseUrl === "string" && raw.baseUrl ? raw.baseUrl : TAVILY_DEFAULT_BASE_URL
  return { baseUrl: baseUrl.replace(/\/+$/, ""), options: nested ?? raw }
}

export function createTavilyAdapter(opts: TavilyAdapterOptions = {}): ProviderAdapter {
  const { baseUrl, options } = resolveOpts(opts)
  const depth = () => optString(options, "search_depth") ?? optString(options, "searchDepth") ?? "basic"

  // cost：search_depth 推导 credits（advanced=2，其余=1），可用 cost_per_request 覆盖（禁死值）
  const cost = (_request: SearchRequest): number => {
    const override = options.cost_per_request ?? options.costPerRequest
    if (typeof override === "number" && Number.isFinite(override)) return override
    if (options.auto_parameters === true) return 2 // auto_parameters 可能升 advanced（2 credits），悲观取高
    return depth() === "advanced" ? 2 : 1
  }

  async function search(input: ProviderSearchInput): Promise<TavilyOutput> {
    const req = input.request
    const dropped: string[] = []

    if (!input.key) {
      return {
        results: [],
        error: createProviderError({ code: "AUTH", provider: "tavily", message: "missing api key" }),
      }
    }

    // 上游错误体可能回显 key → 先登记，保证 redact() 覆盖（architecture.md §8）
    registerSecret(input.key.secret)

    /* ---------- request mapping ---------- */
    const body: Loose = { query: req.query, search_depth: depth() }
    const topic = optString(options, "topic")
    if (topic) body.topic = topic

    if (req.maxResults !== undefined) {
      body.max_results = Math.max(0, Math.min(20, Math.floor(req.maxResults))) // 上限 20
    }
    if (req.timeRange) body.time_range = req.timeRange // day/week/month/year 枚举一致
    const DATE = /^\d{4}-\d{2}-\d{2}$/
    if (req.startDate) {
      if (DATE.test(req.startDate)) body.start_date = req.startDate
      else dropped.push("startDate")
    }
    if (req.endDate) {
      if (DATE.test(req.endDate)) body.end_date = req.endDate
      else dropped.push("endDate")
    }
    if (req.includeDomains?.length) body.include_domains = req.includeDomains
    if (req.excludeDomains?.length) body.exclude_domains = req.excludeDomains
    if (req.language) body.language = req.language
    if (req.safeSearch !== undefined) {
      if (depth() === "fast" || depth() === "ultra-fast") dropped.push("safeSearch") // 深度不支持 safe_search（2026-08）
      else body.safe_search = req.safeSearch
    }
    if (req.country) {
      const name = COUNTRY_NAMES[req.country.toLowerCase()]
      if (!name || (topic && topic !== "general")) dropped.push("country") // country 仅 topic=general、只认英文国名
      else body.country = name
    }
    // 归一 time.published + usage.credits 上报
    body.include_published_date = true
    body.include_usage = true
    const incAnswer = options.include_answer ?? options.includeAnswer
    if (typeof incAnswer === "boolean" || typeof incAnswer === "string") body.include_answer = incAnswer
    const incRaw = options.include_raw_content ?? options.includeRawContent
    if (typeof incRaw === "boolean" || typeof incRaw === "string") body.include_raw_content = incRaw

    const keyId = input.key.id
    const httpRequest = {
      url: `${baseUrl}/search`,
      method: "POST" as const,
      headers: { Authorization: `Bearer ${input.key.secret}`, "content-type": "application/json" },
      body,
      signal: input.signal ?? req.signal,
    }

    /* ---------- transport（错误不抛出 → 返回 error，由 router 决策） ---------- */
    let res: HttpResponse
    try {
      res = await input.http.request(httpRequest)
    } catch (e) {
      return {
        results: [],
        error: isProviderError(e)
          ? e
          : createProviderError({
              code: "UNKNOWN",
              provider: "tavily",
              message: e instanceof Error ? e.message : String(e),
            }),
        droppedParams: dropped,
      }
    }
    if (res.status >= 400) {
      return { results: [], error: await mapHttpError(input.http, res), droppedParams: dropped }
    }

    let payload: TavilyPayload
    try {
      payload = await res.json<TavilyPayload>()
    } catch {
      return {
        results: [],
        error: createProviderError({
          code: "UNKNOWN",
          provider: "tavily",
          message: "invalid JSON response",
          httpStatus: res.status,
        }),
        droppedParams: dropped,
      }
    }

    /* ---------- response mapping ---------- */
    const results: SearchResult[] = []
    for (const r of Array.isArray(payload.results) ? payload.results : []) {
      if (!r || typeof r.url !== "string" || !r.url) continue
      const out: SearchResult = {
        url: r.url,
        time: {},
        provider: "tavily",
        rank: results.length + 1, // 返回序即名次
        keyId,
      }
      if (typeof r.title === "string") out.title = r.title
      if (typeof r.content === "string") out.content = r.content
      if (typeof r.score === "number") out.score = r.score // tavily 有 0..1 相关分
      const published = parseTimeMs(r.published_date)
      if (published !== undefined) out.time.published = published
      results.push(out)
    }

    const output: TavilyOutput = { results, droppedParams: dropped }
    const credits = payload.usage?.credits
    output.usage =
      typeof credits === "number" && Number.isFinite(credits)
        ? { units: credits, detail: "credits(response)" }
        : { units: cost(req), detail: "credits(estimated)" } // include_usage 未返回时按配置估算
    return output
  }

  return { id: "tavily", displayName: "Tavily", requiresKey: true, cost, search }
}

/** 默认实例（router 未按 provider 注入 options 时可用） */
export const tavilyAdapter: ProviderAdapter = createTavilyAdapter()
