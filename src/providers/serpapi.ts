/**
 * SerpApi adapter — 只做 request / response / error 映射（architecture.md §3、§9）。
 * 依据 docs/api-research-providers-2.md §2（2026-09-29）。
 * 边界：不重试、不切 key、不调 fetch——HTTP 全部经注入的 HttpClient。
 * 认证：query 参数 api_key（HttpClient 的 query 序列化承载；错误 message 绝不带 URL query）。
 * 事实约束：无 `num` 参数（结果数靠切片）、organic_results[].date/snippet/position 均可缺失、
 * 错误信封单键 {"error":"..."}、429/Retry-After 官方未公开（有 header 则遵守）、time/域名过滤无稳定参数 → 丢弃。
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

export const SERPAPI_DEFAULT_BASE_URL = "https://serpapi.com"

/** adapter 额外携带丢弃字段（types.ts 无挂载点 → 交叉类型上报给 router） */
export type SerpApiOutput = ProviderSearchOutput & { droppedParams?: string[] }

type Loose = Record<string, unknown>

function optString(o: Loose, k: string): string | undefined {
  return typeof o[k] === "string" ? (o[k] as string) : undefined
}

/** 时间字段 → epoch ms（date 是条件字段：可缺失、可为 "3 days ago" 类文案 → 解析失败即无） */
function parseTimeMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
  }
  if (typeof v === "string" && v) {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return undefined
}

/** 非 2xx 错误信封 → ProviderError（serpapi: 单键 {"error":"..."}，401 实测） */
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
    if (typeof body.error === "string") upstream = body.error
    else if (typeof body.detail === "string") upstream = body.detail
  } catch {
    /* 非 JSON 错误体 → 保留原文，由 createProviderError 截断脱敏 */
  }
  const code = classifyStatus("serpapi", res.status, { bodyHint: upstream })
  const retryAfterMs = http.parseRetryAfter(res.headers["retry-after"])
  return createProviderError({
    code,
    provider: "serpapi",
    message: `HTTP ${res.status}: ${upstream}`,
    httpStatus: res.status,
    retryAfterMs,
    upstreamTag: upstream,
  })
}

interface SerpApiResultRow {
  position?: unknown
  title?: unknown
  link?: unknown
  snippet?: unknown
  date?: unknown
}

interface SerpApiPayload {
  organic_results?: SerpApiResultRow[]
  error?: unknown
}

export interface SerpApiAdapterOptions {
  baseUrl?: string
  /** ProviderOptions.options 不透明透传（engine 默认 google） */
  options?: Record<string, unknown>
  [k: string]: unknown
}

function resolveOpts(opts: SerpApiAdapterOptions): { baseUrl: string; options: Loose } {
  const raw = (opts ?? {}) as Loose
  const nested = raw.options && typeof raw.options === "object" ? (raw.options as Loose) : undefined
  const baseUrl =
    typeof raw.baseUrl === "string" && raw.baseUrl ? raw.baseUrl : SERPAPI_DEFAULT_BASE_URL
  return { baseUrl: baseUrl.replace(/\/+$/, ""), options: nested ?? raw }
}

export function createSerpApiAdapter(opts: SerpApiAdapterOptions = {}): ProviderAdapter {
  const { baseUrl, options } = resolveOpts(opts)

  // 计费口径「仅成功计数」由 budget.countMode=success 承担 → adapter 按每次成功 1 次报
  const cost = (_request: SearchRequest): number => 1

  async function search(input: ProviderSearchInput): Promise<SerpApiOutput> {
    const req = input.request
    const dropped: string[] = []

    if (!input.key) {
      return {
        results: [],
        error: createProviderError({ code: "AUTH", provider: "serpapi", message: "missing api key" }),
      }
    }

    // 上游错误体可能回显 key（serpapi 401 文案即一例）→ 先登记，保证 redact() 覆盖（architecture.md §8）
    registerSecret(input.key.secret)

    /* ---------- request mapping（key 在 query；无 num、无 time/域名参数 → 丢弃并记录） ---------- */
    if (req.timeRange) dropped.push("timeRange")
    if (req.startDate) dropped.push("startDate")
    if (req.endDate) dropped.push("endDate")
    if (req.includeDomains?.length) dropped.push("includeDomains")
    if (req.excludeDomains?.length) dropped.push("excludeDomains")

    const query: Record<string, string | number | boolean | undefined> = {
      engine: optString(options, "engine") ?? "google", // engine 可配置，默认 google
      q: req.query,
      api_key: input.key.secret,
    }
    if (req.country) query.gl = req.country.toLowerCase() // gl = 两位国家码
    if (req.language) query.hl = req.language.toLowerCase() // hl = 2–3 位语言码
    if (req.safeSearch !== undefined) query.safe = req.safeSearch ? "active" : "off"

    const keyId = input.key.id
    const httpRequest = {
      url: `${baseUrl}/search`,
      method: "GET" as const,
      query,
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
              provider: "serpapi",
              message: e instanceof Error ? e.message : String(e),
            }),
        droppedParams: dropped,
      }
    }
    if (res.status >= 400) {
      return { results: [], error: await mapHttpError(input.http, res), droppedParams: dropped }
    }

    let payload: SerpApiPayload
    try {
      payload = await res.json<SerpApiPayload>()
    } catch {
      return {
        results: [],
        error: createProviderError({
          code: "UNKNOWN",
          provider: "serpapi",
          message: "invalid JSON response",
          httpStatus: res.status,
        }),
        droppedParams: dropped,
      }
    }

    // 2xx 但 body 带 error（实测：非法输出格式返回 200/4xx {"error":...}）→ 请求本身有问题，不重试
    if (typeof payload.error === "string") {
      return {
        results: [],
        error: createProviderError({
          code: "BAD_REQUEST",
          provider: "serpapi",
          message: `HTTP ${res.status}: ${payload.error}`,
          httpStatus: res.status,
          upstreamTag: payload.error,
        }),
        droppedParams: dropped,
      }
    }

    /* ---------- response mapping ---------- */
    const rows = Array.isArray(payload.organic_results) ? payload.organic_results : []
    const limit = req.maxResults !== undefined ? Math.max(0, Math.floor(req.maxResults)) : rows.length
    const results: SearchResult[] = []
    for (const r of rows) {
      if (results.length >= limit) break // 无 num 参数 → 本地切片裁剪
      if (!r || typeof r.link !== "string" || !r.link) continue
      const out: SearchResult = {
        url: r.link,
        time: {},
        provider: "serpapi",
        rank: typeof r.position === "number" && r.position >= 1 ? r.position : results.length + 1,
        keyId,
      }
      if (typeof r.title === "string") out.title = r.title
      if (typeof r.snippet === "string") out.content = r.snippet // snippet 可缺失 → 容错省略
      const published = parseTimeMs(r.date) // date 是条件字段，稳定缺失属正常
      if (published !== undefined) out.time.published = published
      results.push(out)
    }

    return { results, droppedParams: dropped }
  }

  return { id: "serpapi", displayName: "SerpApi", requiresKey: true, cost, search }
}

/** 默认实例（router 未按 provider 注入 options 时可用） */
export const serpapiAdapter: ProviderAdapter = createSerpApiAdapter()
