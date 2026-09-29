/**
 * providers/searxng.ts — SearXNG JSON Search API 适配（无 key 的最终 fallback）。
 *
 * 依据 docs/api-research-providers-2.md §3：
 * - GET {baseUrl}/search?q=&format=json，无认证
 * - 参数 language / pageno / time_range(day|week|month|year) / safesearch(0..2) / engines
 *   非致命参数容错：本地先做形状校验，非法值直接不发（避免实例 400 SearxParameterException）
 * - 结果字段：url / title / content（非 snippet）/ score（融合分）/ publishedDate（ISO，可 null）
 * - 无 position 字段：数组顺序即 rank；无官方结果数参数 → 上游返回后按 maxResults 裁剪
 * - 错误：400/500 = {"error": "<msg>"} JSON；403 = HTML（实例禁用 format=json）→ UNKNOWN，不算 key 失效
 * - 200 + HTML（格式静默回退）→ JSON 解析失败 → UNKNOWN
 * 边界：不重试、不 fetch（architecture.md §3）。
 */
import type {
  ProviderAdapter,
  ProviderSearchInput,
  ProviderSearchOutput,
  SearchResult,
} from "../types"
import {
  errorFromStatus,
  errorFromThrown,
  fail,
  nonJsonError,
  parseDateMs,
  safeJson,
  safeText,
} from "./base"

export interface SearXNGAdapterOptions {
  /** 默认 https://search.658658.xyz（config.ts DEFAULT_BASE_URL 同值） */
  baseUrl?: string
  /** providers.searxng.options.engines：逗号分隔或数组。实例不识别的引擎名被忽略（不产生 400） */
  engines?: string | string[]
  /** 单请求超时（HttpRequest.timeoutMs）；缺省走 HttpClient 默认 */
  timeoutMs?: number
}

const DEFAULT_BASE_URL = "https://search.658658.xyz"

interface SearxRawResult {
  url?: unknown
  title?: unknown
  content?: unknown
  score?: unknown
  publishedDate?: unknown
}

interface SearxRawResponse {
  results?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** 保守语言码形状（如 en / zh-CN / zh-Hans / all / auto）；不合法则丢弃，避免实例 400 */
function safeLanguage(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const s = v.trim()
  if (!s) return undefined
  if (s === "all" || s === "auto") return s
  return /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/.test(s) ? s : undefined
}

export function createSearxngAdapter(opts: SearXNGAdapterOptions = {}): ProviderAdapter {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const engines =
    typeof opts.engines === "string"
      ? opts.engines.trim()
      : Array.isArray(opts.engines)
        ? opts.engines.filter((e) => typeof e === "string" && e).join(",")
        : ""

  return {
    id: "searxng",
    displayName: "SearXNG",
    requiresKey: false,
    cost: () => 1, // 无 key、无上游配额；实例滥用保护由 budget 的 provider scope 配置

    async search(input: ProviderSearchInput): Promise<ProviderSearchOutput> {
      const provider = "searxng" as const
      const r = input.request

      const query: Record<string, string | number> = { q: r.query, format: "json" }
      const language = safeLanguage(r.language)
      if (language) query.language = language
      // day/week/month/year 均为源码合法取值（week 官方页漏列但 parse_time_range 接受）
      if (r.timeRange) query.time_range = r.timeRange
      if (r.safeSearch !== undefined) query.safesearch = r.safeSearch ? 2 : 0
      if (engines) query.engines = engines
      // 丢弃：country / startDate / endDate / includeDomains / excludeDomains（SearXNG 无对应参数；
      // site: 语法可表达 include，但属查询改写，router 层决策，不在 adapter 私改 query）

      try {
        const res = await input.http.request({
          url: `${baseUrl}/search`,
          method: "GET",
          query,
          timeoutMs: opts.timeoutMs,
          signal: input.signal ?? r.signal,
        })

        if (res.status >= 400) {
          // 403 = HTML 页（实例禁 format=json）→ classifyStatus(searxng,403)=UNKNOWN；
          // 400/500 = {"error": "..."} JSON
          const errBody = await safeText(res)
          const parsed = safeJson<unknown>(errBody)
          const msg =
            isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : undefined
          return fail(
            errorFromStatus({
              provider,
              status: res.status,
              body: errBody,
              headers: res.headers,
              http: input.http,
              tag: msg, // JSON 错误信封的 {"error": msg}；HTML 403 时退回整段 body（截断+脱敏）
            }),
          )
        }

        const raw = await safeText(res)
        const data = safeJson<SearxRawResponse>(raw)
        if (!data) return fail(nonJsonError(provider)) // 200 + HTML → UNKNOWN

        const rawList = Array.isArray(data.results) ? data.results : []
        const limit = typeof r.maxResults === "number" && r.maxResults > 0 ? Math.floor(r.maxResults) : rawList.length
        const results: SearchResult[] = []
        for (let i = 0; i < rawList.length && results.length < limit; i++) {
          const item = rawList[i]
          if (!isRecord(item)) continue
          const rr = item as SearxRawResult
          const url = typeof rr.url === "string" && rr.url ? rr.url : undefined
          if (!url) continue
          const title = typeof rr.title === "string" && rr.title ? rr.title : undefined
          const content = typeof rr.content === "string" && rr.content ? rr.content : undefined
          const score =
            typeof rr.score === "number" && Number.isFinite(rr.score) ? rr.score : undefined
          const published = parseDateMs(rr.publishedDate) // 可 null → 不设 published
          const out: SearchResult = {
            url,
            time: published !== undefined ? { published } : {},
            provider,
            rank: i + 1, // 无 position 字段，顺序即名次
          }
          if (title !== undefined) out.title = title
          if (content !== undefined) out.content = content
          if (score !== undefined) out.score = score // searxng 融合分：仅同 provider 内可比
          results.push(out)
        }
        return { results }
      } catch (e) {
        return fail(errorFromThrown(e, provider))
      }
    },
  }
}
