/**
 * You.com adapter — 只做 request / response / error 映射（architecture.md §3、§9）。
 * 依据 docs/api-research-providers-2.md §1（2026-09-29）。
 * 边界：不重试、不切 key、不调 fetch——HTTP 全部经注入的 HttpClient。
 * 认证：header X-API-Key（唯一正式方式；无 query key）。
 * 响应：无顶层扁平 results[]，web/news 两分区；日期字段 page_age；无 position（数组顺序即名次）。
 */
import type {
  HttpClient,
  HttpResponse,
  ProviderAdapter,
  ProviderError,
  ProviderSearchInput,
  SearchRequest,
  SearchResult,
} from "../types"
import { classifyStatus, createProviderError, isProviderError } from "../utils/errors"
import { registerSecret } from "../utils/logging"

export const YOU_DEFAULT_BASE_URL = "https://ydc-index.io"

/** adapter 额外携带丢弃字段（types.ts 无挂载点 → 交叉类型上报给 router） */
export type YouOutput = import("../types").ProviderSearchOutput & { droppedParams?: string[] }

type Loose = Record<string, unknown>

function optString(o: Loose, k: string): string | undefined {
  return typeof o[k] === "string" ? (o[k] as string) : undefined
}

/** 官方 `country` enum 子集（request-controls）；未命中 → 丢弃（硬传 4xx） */
const YOU_COUNTRIES = new Set([
  "AR", "AU", "AT", "BE", "BR", "CA", "CL", "DK", "FI", "FR", "DE", "HK", "IN", "ID", "IT",
  "JP", "KR", "MY", "MX", "NL", "NZ", "NO", "CN", "PL", "PT", "PH", "RU", "SA", "ZA", "ES",
  "SE", "CH", "TW", "TR", "GB", "US",
])

/** 官方 `language` BCP-47 子集已知值（全表见 reference，未命中即丢弃避免 4xx） */
const YOU_LANGS = new Set([
  "EN", "EN-GB", "ZH-HANS", "ZH-HANT", "JA", "KO", "FR", "DE", "ES", "IT", "PT", "RU", "AR",
  "HI", "NL", "PL", "TR", "SV", "DA", "FI", "NO", "TH", "VI", "ID", "UK", "CS", "EL", "HE",
  "HU", "RO", "SK", "SL", "BG", "HR", "LT", "LV", "ET",
])

/** 地区码 → 官方语言枚举的显式映射；其余走大写 + 白名单校验 */
const LANG_ALIAS: Record<string, string> = {
  "zh-cn": "ZH-HANS", "zh-sg": "ZH-HANS", "zh-hans": "ZH-HANS",
  "zh-tw": "ZH-HANT", "zh-hk": "ZH-HANT", "zh-mo": "ZH-HANT", "zh-hant": "ZH-HANT",
}

function youLanguage(code: string): string | undefined {
  const lower = code.toLowerCase()
  if (LANG_ALIAS[lower]) return LANG_ALIAS[lower]
  const up = code.toUpperCase()
  return YOU_LANGS.has(up) ? up : undefined
}

/** 时间字段 → epoch ms（architecture.md #8：统一毫秒；page_age 可为 ISO 串或时间戳） */
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

/** 非 2xx 错误信封 → ProviderError（you: {"detail":"..."} / {"error":...} / {"message":...}） */
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
    if (typeof body.detail === "string") upstream = body.detail
    else if (typeof body.error === "string") upstream = body.error
    else if (typeof body.message === "string") upstream = body.message
    else if (body.detail && typeof body.detail === "object") {
      const e = (body.detail as Loose).error
      if (typeof e === "string") upstream = e
    }
  } catch {
    /* 非 JSON 错误体 → 保留原文，由 createProviderError 截断脱敏 */
  }
  const code = classifyStatus("you", res.status, { bodyHint: upstream })
  const retryAfterMs = http.parseRetryAfter(res.headers["retry-after"])
  return createProviderError({
    code,
    provider: "you",
    message: `HTTP ${res.status}: ${upstream}`,
    httpStatus: res.status,
    retryAfterMs,
    upstreamTag: upstream,
  })
}

interface YouResultRow {
  url?: unknown
  title?: unknown
  description?: unknown
  snippets?: unknown
  page_age?: unknown
}

interface YouPayload {
  results?: { web?: YouResultRow[]; news?: YouResultRow[] }
}

export interface YouAdapterOptions {
  baseUrl?: string
  /** ProviderOptions.options 不透明透传（safesearch 默认值、count 覆盖等） */
  options?: Record<string, unknown>
  [k: string]: unknown
}

function resolveOpts(opts: YouAdapterOptions): { baseUrl: string; options: Loose } {
  const raw = (opts ?? {}) as Loose
  const nested = raw.options && typeof raw.options === "object" ? (raw.options as Loose) : undefined
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl ? raw.baseUrl : YOU_DEFAULT_BASE_URL
  return { baseUrl: baseUrl.replace(/\/+$/, ""), options: nested ?? raw }
}

export function createYouAdapter(opts: YouAdapterOptions = {}): ProviderAdapter {
  const { baseUrl, options } = resolveOpts(opts)

  // Web Search 按调用计费（$5/1k calls）→ 每次调用 1 单位
  const cost = (_request: SearchRequest): number => 1

  async function search(input: ProviderSearchInput): Promise<YouOutput> {
    const req = input.request
    const dropped: string[] = []

    if (!input.key) {
      return {
        results: [],
        error: createProviderError({ code: "AUTH", provider: "you", message: "missing api key" }),
      }
    }

    // 上游错误体可能回显 key → 先登记，保证 redact() 覆盖（architecture.md §8）
    registerSecret(input.key.secret)

    /* ---------- request mapping ---------- */
    const body: Loose = { query: req.query }
    if (req.maxResults !== undefined) {
      body.count = Math.max(1, Math.min(100, Math.floor(req.maxResults))) // 每分区上限 100
    }
    const DATE = /^\d{4}-\d{2}-\d{2}$/
    if (req.startDate && req.endDate && DATE.test(req.startDate) && DATE.test(req.endDate)) {
      body.freshness = `${req.startDate}to${req.endDate}` // 官方区间格式
    } else if (req.timeRange) {
      body.freshness = req.timeRange // day/week/month/year 枚举一致
      if (req.startDate || req.endDate) dropped.push(req.startDate ? "startDate" : "endDate")
    } else if (req.startDate || req.endDate) {
      dropped.push(...[req.startDate ? "startDate" : "", req.endDate ? "endDate" : ""].filter(Boolean))
    }
    if (req.country) {
      const cc = req.country.toUpperCase()
      if (YOU_COUNTRIES.has(cc)) body.country = cc
      else dropped.push("country") // enum 外 → 硬传会 4xx
    }
    if (req.language) {
      const lang = youLanguage(req.language)
      if (lang) body.language = lang
      else dropped.push("language")
    }
    if (req.safeSearch !== undefined) body.safesearch = req.safeSearch ? "strict" : "off"
    if (req.includeDomains?.length) {
      body.include_domains = req.includeDomains
      if (req.excludeDomains?.length) dropped.push("excludeDomains") // include+exclude 同传 → 422，弃 exclude 保白名单语义
    } else if (req.excludeDomains?.length) {
      body.exclude_domains = req.excludeDomains
    }

    const keyId = input.key.id
    const httpRequest = {
      url: `${baseUrl}/v1/search`,
      method: "POST" as const,
      headers: { "X-API-Key": input.key.secret, "content-type": "application/json" },
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
              provider: "you",
              message: e instanceof Error ? e.message : String(e),
            }),
        droppedParams: dropped,
      }
    }
    if (res.status >= 400) {
      return { results: [], error: await mapHttpError(input.http, res), droppedParams: dropped }
    }

    let payload: YouPayload
    try {
      payload = await res.json<YouPayload>()
    } catch {
      return {
        results: [],
        error: createProviderError({
          code: "UNKNOWN",
          provider: "you",
          message: "invalid JSON response",
          httpStatus: res.status,
        }),
        droppedParams: dropped,
      }
    }

    /* ---------- response mapping：web 分区 → news 分区（顺序即名次） ---------- */
    const raw = payload.results
    const rows: YouResultRow[] = [
      ...(Array.isArray(raw?.web) ? raw.web : []),
      ...(Array.isArray(raw?.news) ? raw.news : []),
    ]
    const results: SearchResult[] = []
    for (const r of rows) {
      if (!r || typeof r.url !== "string" || !r.url) continue
      const parts: string[] = []
      if (typeof r.description === "string" && r.description) parts.push(r.description)
      if (Array.isArray(r.snippets)) {
        for (const s of r.snippets) if (typeof s === "string" && s) parts.push(s)
      }
      const out: SearchResult = {
        url: r.url,
        time: {},
        provider: "you",
        rank: results.length + 1, // you 无 position，数组顺序即名次
        keyId,
      }
      if (typeof r.title === "string") out.title = r.title
      if (parts.length) out.content = parts.join("\n")
      const published = parseTimeMs(r.page_age)
      if (published !== undefined) out.time.published = published
      results.push(out)
    }

    /* usage：X-RateLimit-* → 预节流 / 预算喂料（架构 §9） */
    const rl = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]
      .map((h) => (res.headers[h] !== undefined ? `${h.replace("x-ratelimit-", "")}=${res.headers[h]}` : undefined))
      .filter(Boolean)
      .join(";")
    return { results, droppedParams: dropped, usage: { units: cost(req), detail: rl || undefined } }
  }

  return { id: "you", displayName: "You.com", requiresKey: true, cost, search }
}

/** 默认实例（router 未按 provider 注入 options 时可用） */
export const youAdapter: ProviderAdapter = createYouAdapter()
