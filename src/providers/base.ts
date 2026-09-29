/**
 * providers/base.ts — parallel / exa / searxng 三个 adapter 的共享小工具。
 *
 * 只抽真实重复：HTTP 状态/异常 → ProviderError 归类、日期解析、整数裁剪、JSON 容错。
 * 边界（architecture.md §3）：不重试、不切 key、不熔断、不直接 fetch——只用注入的 HttpClient。
 */
import type {
  HttpClient,
  HttpResponse,
  ProviderError,
  ProviderID,
  ProviderSearchOutput,
} from "../types"
import { classifyStatus, createProviderError, isProviderError } from "../utils/errors"

export interface StatusErrorInit {
  provider: ProviderID
  status: number
  /** 响应体原文（已由 createProviderError 截断 ≤512B + redact） */
  body?: string
  headers?: Record<string, string>
  /** 用于解析 Retry-After（秒 / HTTP-date → ms） */
  http?: HttpClient
  keyId?: string
  /** 第三方原始 tag（exa 的 tag）；缺省用 body */
  tag?: string
}

/**
 * 非 2xx 响应 → ProviderError。
 * 分类走 utils/errors.classifyStatus（provider×status 表：searxng 403=UNKNOWN）；
 * Retry-After 有则带上（缺失时由 router 用退避兜底，不算异常）。
 */
export function errorFromStatus(init: StatusErrorInit): ProviderError {
  const raw = init.body ?? ""
  const retryAfterMs =
    init.headers && init.http ? init.http.parseRetryAfter(init.headers["retry-after"]) : undefined
  return createProviderError({
    code: classifyStatus(init.provider, init.status, { bodyHint: raw }),
    provider: init.provider,
    message: `HTTP ${init.status}${raw ? `: ${raw.slice(0, 200)}` : ""}`,
    httpStatus: init.status,
    retryAfterMs,
    keyId: init.keyId,
    upstreamTag: init.tag ?? raw,
  })
}

/**
 * adapter 的 catch 兜底：
 * - ProviderError 透传（provider 归一为本 adapter，补 keyId）
 * - AbortError / TimeoutError → TIMEOUT
 * - 其余（DNS/TLS/连接拒绝…）→ NETWORK_ERROR
 */
export function errorFromThrown(e: unknown, provider: ProviderID, keyId?: string): ProviderError {
  if (isProviderError(e)) {
    const out: ProviderError = { ...e, provider }
    if (out.keyId === undefined && keyId !== undefined) out.keyId = keyId
    return out
  }
  const aborted = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")
  return createProviderError({
    code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
    provider,
    message: e instanceof Error ? e.message : String(e),
    keyId,
  })
}

/** 2xx 但 body 不可解析为 JSON（如 SearXNG 实例回退 HTML 200）→ UNKNOWN */
export function nonJsonError(provider: ProviderID, keyId?: string): ProviderError {
  return createProviderError({
    code: "UNKNOWN",
    provider,
    message: "upstream returned a non-JSON body (format=json unsupported or proxy interference)",
    keyId,
  })
}

/** key 型 provider 防御分支（正常由 router 的 no_active_key 前置拦截）：不重试、换 provider */
export function missingKeyError(provider: ProviderID): ProviderError {
  return createProviderError({
    code: "BAD_REQUEST",
    provider,
    message: "no API key injected for this provider",
  })
}

/** 上游日期（ISO 8601 / YYYY-MM-DD / null）→ epoch ms；不可解析返回 undefined。统一毫秒口径（architecture.md §10.8） */
export function parseDateMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined
  const s = v.trim()
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

/** 有限数 → 取整并裁剪到 [min,max]；非法返回 undefined */
export function boundedInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined
  return Math.min(max, Math.max(min, Math.round(v)))
}

/** 读响应体（读失败返回空串，不让 body 读取异常逃逸出 adapter） */
export async function safeText(res: HttpResponse): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

/** JSON.parse 容错 → undefined（不抛） */
export function safeJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/** 统一失败出参（adapter 不抛错——决策归 router，types.ts ProviderSearchOutput） */
export function fail(error: ProviderError): ProviderSearchOutput {
  return { results: [], error }
}
