/**
 * providers/parallel.ts — Parallel Search API 适配。
 *
 * 依据 docs/api-research-providers-1.md §1：
 * - POST {baseUrl}/v1/search，header x-api-key，search_queries 必填（string[]）
 * - mode 可配置（默认 turbo；上游 API 默认 advanced，本插件默认 turbo，勿写死在请求里）
 * - 结果在 results[].excerpts[]（非 content），无 score；日期 publish_date 可 null
 * - 错误体 {"error":{message,detail}}；Retry-After 未承诺（有则带上，缺则 router 退避兜底）
 * - 能力边界：无 language / time_range / safe_search 参数 → 丢弃（startDate → source_policy.after_date）
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

export interface ParallelAdapterOptions {
  /** 默认 https://api.parallel.ai（config.ts DEFAULT_BASE_URL 同值） */
  baseUrl?: string
  /** providers.parallel.options.mode；默认 turbo */
  mode?: string
  /** 单请求超时（HttpRequest.timeoutMs）；缺省走 HttpClient 默认 */
  timeoutMs?: number
}

const DEFAULT_BASE_URL = "https://api.parallel.ai"
const DEFAULT_MODE = "turbo"
/** 公开模式 max_results 上限 20（超出上游降为 20 + warning，这里直接裁剪） */
const MAX_RESULTS_CAP = 20

/** 上游响应的最小结构（未知字段忽略） */
interface ParallelRawResult {
  url?: unknown
  title?: unknown
  publish_date?: unknown
  excerpts?: unknown
}

interface ParallelRawResponse {
  results?: unknown
  usage?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function createParallelAdapter(opts: ParallelAdapterOptions = {}): ProviderAdapter {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const mode = opts.mode ?? DEFAULT_MODE

  return {
    id: "parallel",
    displayName: "Parallel",
    requiresKey: true,
    // 平价无分级计费（turbo/fast/basic/advanced 单价差异由 budget.limits 配置吸收，不硬编码）
    cost: () => 1,

    async search(input: ProviderSearchInput): Promise<ProviderSearchOutput> {
      const provider = "parallel" as const
      const key = input.key
      if (!key) return fail(missingKeyError(provider))
      const keyId = key.id

      const r = input.request
      const advanced: Record<string, unknown> = {}
      const maxResults = boundedInt(r.maxResults, 1, MAX_RESULTS_CAP)
      if (maxResults !== undefined) advanced.max_results = maxResults
      if (r.country) advanced.location = r.country // ISO 3166-1 alpha-2；非法值上游忽略 + warning

      const sourcePolicy: Record<string, unknown> = {}
      if (r.startDate) sourcePolicy.after_date = r.startDate
      if (r.includeDomains?.length) sourcePolicy.include_domains = [...r.includeDomains]
      if (r.excludeDomains?.length) sourcePolicy.exclude_domains = [...r.excludeDomains]
      if (Object.keys(sourcePolicy).length > 0) advanced.source_policy = sourcePolicy

      const body: Record<string, unknown> = { search_queries: [r.query], mode }
      if (Object.keys(advanced).length > 0) body.advanced_settings = advanced

      // 丢弃：language / timeRange（endDate 同）/ safeSearch —— 上游无对应参数
      try {
        const res = await input.http.request({
          url: `${baseUrl}/v1/search`,
          method: "POST",
          headers: { "x-api-key": key.secret, "content-type": "application/json" },
          body,
          timeoutMs: opts.timeoutMs,
          signal: input.signal ?? r.signal,
        })

        if (res.status >= 400) {
          const errBody = await safeText(res)
          return fail(
            errorFromStatus({
              provider,
              status: res.status,
              body: errBody,
              headers: res.headers,
              http: input.http,
              keyId,
            }),
          )
        }

        const data = safeJson<ParallelRawResponse>(await safeText(res))
        if (!data) return fail(nonJsonError(provider, keyId))

        const rawList = Array.isArray((data as { results?: unknown }).results)
          ? ((data as { results: unknown[] }).results)
          : []
        const results: SearchResult[] = []
        for (let i = 0; i < rawList.length; i++) {
          const item = rawList[i]
          if (!isRecord(item)) continue
          const rr = item as ParallelRawResult
          const url = typeof rr.url === "string" && rr.url ? rr.url : undefined
          if (!url) continue // 缺 url 的条目跳过（容错）
          const title = typeof rr.title === "string" && rr.title ? rr.title : undefined
          const excerpts = Array.isArray(rr.excerpts)
            ? rr.excerpts.filter((e): e is string => typeof e === "string" && e.length > 0)
            : []
          const published = parseDateMs(rr.publish_date)
          const out: SearchResult = {
            url,
            time: published !== undefined ? { published } : {},
            provider,
            rank: i + 1, // 数组顺序即名次（无 position 字段）
            keyId,
          }
          if (title !== undefined) out.title = title
          if (excerpts.length > 0) out.content = excerpts.join("\n") // excerpts → content；无 score 字段，不发明
          results.push(out)
        }

        const output: ProviderSearchOutput = { results }
        // usage（[{"name","count"}]）→ 只透传计数和；计费语义（credits/requests）由 budget 配置决定
        const usage = (data as ParallelRawResponse).usage
        if (Array.isArray(usage) && usage.length > 0) {
          const units = usage.reduce<number>((n, u) => {
            const c = isRecord(u) && typeof u.count === "number" ? u.count : 0
            return n + c
          }, 0)
          if (units > 0) {
            output.usage = { units, detail: JSON.stringify(usage).slice(0, 200) }
          }
        }
        return output
      } catch (e) {
        return fail(errorFromThrown(e, provider, keyId))
      }
    },
  }
}
