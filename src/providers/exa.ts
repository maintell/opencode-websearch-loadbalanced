/**
 * providers/exa.ts — Exa Search API 适配。
 *
 * 依据 docs/api-research-providers-1.md §2：
 * - POST {baseUrl}/search，header x-api-key（也接受 Bearer，这里统一 x-api-key）
 * - 内容选项嵌套在 contents.*（text/highlights/summary），请求 contents.text 取正文
 * - results[] required 仅 title/url，无 score 字段 → 绝不发明 score
 * - publishedDate 实为 YYYY-MM-DD 估算（可 null）→ 统一产出毫秒
 * - 错误体 {requestId,error,tag}；429 有 Retry-After 则遵守（无则 router 退避兜底）
 * - 能力边界：timeRange / language / safeSearch(→moderation 仅 true 透传) 之外的丢弃
 * 边界：不重试、不 fetch（architecture.md §3）。
 */
import type {
  ProviderAdapter,
  ProviderSearchInput,
  ProviderSearchOutput,
  SearchResult,
} from "../types"
import {
  boundedInt,
  errorFromStatus,
  errorFromThrown,
  fail,
  missingKeyError,
  nonJsonError,
  parseDateMs,
  safeJson,
  safeText,
} from "./base"

export interface ExaAdapterOptions {
  /** 默认 https://api.exa.ai（config.ts DEFAULT_BASE_URL 同值） */
  baseUrl?: string
  /** 单请求超时（HttpRequest.timeoutMs）；缺省走 HttpClient 默认 */
  timeoutMs?: number
}

const DEFAULT_BASE_URL = "https://api.exa.ai"
/** 公开上限 100（请求 highlights 时 >100 直接 400 → 这里直接裁剪） */
const MAX_RESULTS_CAP = 100

interface ExaRawResult {
  url?: unknown
  title?: unknown
  publishedDate?: unknown
  text?: unknown
  highlights?: unknown
}

interface ExaRawResponse {
  results?: unknown
  requestId?: unknown
}

interface ExaRawError {
  requestId?: unknown
  error?: unknown
  tag?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function createExaAdapter(opts: ExaAdapterOptions = {}): ProviderAdapter {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")

  return {
    id: "exa",
    displayName: "Exa",
    requiresKey: true,
    cost: () => 1, // 计费美元制（costDollars），不折算 credits —— budget 用 requests 口径

    async search(input: ProviderSearchInput): Promise<ProviderSearchOutput> {
      const provider = "exa" as const
      const key = input.key
      if (!key) return fail(missingKeyError(provider))
      const keyId = key.id

      const r = input.request
      const body: Record<string, unknown> = { query: r.query }
      const numResults = boundedInt(r.maxResults, 1, MAX_RESULTS_CAP)
      if (numResults !== undefined) body.numResults = numResults
      if (r.includeDomains?.length) body.includeDomains = [...r.includeDomains]
      if (r.excludeDomains?.length) body.excludeDomains = [...r.excludeDomains]
      if (r.startDate) body.startPublishedDate = r.startDate
      if (r.endDate) body.endPublishedDate = r.endDate
      if (r.country) body.userLocation = r.country // ISO 3166-1 alpha-2
      if (r.safeSearch === true) body.moderation = true // 默认 false，仅 true 时显式
      // 内容选项必须嵌套在 contents 内（顶层 text/highlights 已废弃）
      body.contents = { text: true }

      // 丢弃：language / timeRange（绝对区间已用 startDate/endDate 覆盖）

      try {
        const res = await input.http.request({
          url: `${baseUrl}/search`,
          method: "POST",
          headers: { "x-api-key": key.secret, "content-type": "application/json" },
          body,
          timeoutMs: opts.timeoutMs,
          signal: input.signal ?? r.signal,
        })

        if (res.status >= 400) {
          const errBody = await safeText(res)
          const parsed = safeJson<ExaRawError>(errBody)
          return fail(
            errorFromStatus({
              provider,
              status: res.status,
              body: errBody,
              headers: res.headers,
              http: input.http,
              keyId,
              // tag 是 exa 错误分类的稳定字段（RATE_LIMIT_EXCEEDED / INVALID_API_KEY …）
              tag: isRecord(parsed) && typeof parsed.tag === "string" ? parsed.tag : undefined,
            }),
          )
        }

        const data = safeJson<ExaRawResponse>(await safeText(res))
        if (!data) return fail(nonJsonError(provider, keyId))

        const rawList = Array.isArray(data.results) ? data.results : []
        const results: SearchResult[] = []
        for (let i = 0; i < rawList.length; i++) {
          const item = rawList[i]
          if (!isRecord(item)) continue
          const rr = item as ExaRawResult
          const url = typeof rr.url === "string" && rr.url ? rr.url : undefined
          if (!url) continue // required 字段缺失的条目跳过（容错）
          const title = typeof rr.title === "string" && rr.title ? rr.title : undefined
          const published = parseDateMs(rr.publishedDate)
          // content 优先 text；未请求 text 时回落 highlights（schema 无 score，不填）
          const content =
            typeof rr.text === "string" && rr.text
              ? rr.text
              : Array.isArray(rr.highlights)
                ? rr.highlights.filter((h): h is string => typeof h === "string" && h.length > 0).join("\n") ||
                  undefined
                : undefined
          const out: SearchResult = {
            url,
            time: published !== undefined ? { published } : {},
            provider,
            rank: i + 1, // 返回序即名次
            keyId,
          }
          if (title !== undefined) out.title = title
          if (content !== undefined) out.content = content
          results.push(out)
        }
        return { results }
      } catch (e) {
        return fail(errorFromThrown(e, provider, keyId))
      }
    },
  }
}
