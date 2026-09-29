/**
 * HttpClient：fetch 封装（architecture.md §3）。
 *
 * 职责：AbortController 超时、latency、Retry-After 解析（秒 / HTTP-date）、
 * 按 provider×status 映射 ProviderError（SearXNG 403=UNKNOWN）、指数退避重试封装。
 *
 * 边界：request() 单发不自动重试；重试决策与 key 切换在 router，
 * withRetries() 只是可复用的退避封装（router 调用它，配置驱动）。
 * 对外错误 message 一律去 query（serpapi 的 key 在 query 里）并过 redact()。
 */
import type {
  ErrorCode,
  HttpClient,
  HttpConfig,
  HttpRequest,
  HttpResponse,
  ProviderID,
} from "./types"
import { classifyStatus, countsTowardCircuit, createProviderError, isProviderError, isRetryable } from "./utils/errors"
import { redact } from "./utils/logging"

export interface HttpClientOptions {
  config: HttpConfig
  /** 用于 provider×status 分类（SearXNG 403 特例）；缺省走通用映射 */
  provider?: ProviderID
  fetchImpl?: typeof fetch
}

/** URL 脱敏展示：origin + pathname，绝不带 query */
function safeUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return "[invalid-url]"
  }
}

function buildUrl(req: HttpRequest): string {
  const u = new URL(req.url) // 相对路径不支持——adapter 一律给绝对 URL
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (v === undefined) continue
      u.searchParams.set(k, String(v))
    }
  }
  return u.toString()
}

function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v
  })
  return out
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const provider: ProviderID = opts.provider ?? "searxng" // 未指定时仅影响分类文案，router 会补 provider

  function parseRetryAfter(headerValue: string | undefined, now: number = Date.now()): number | undefined {
    if (headerValue === undefined || headerValue === "") return undefined
    const trimmed = headerValue.trim()
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const sec = Number(trimmed)
      return Math.max(0, Math.round(sec * 1000))
    }
    const at = Date.parse(trimmed)
    if (Number.isNaN(at)) return undefined
    return Math.max(0, at - now)
  }

  async function request(req: HttpRequest): Promise<HttpResponse> {
    const url = buildUrl(req)
    const timeoutMs = req.timeoutMs ?? opts.config.timeoutMs
    const started = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onExternalAbort = () => controller.abort()
    if (req.signal) {
      if (req.signal.aborted) controller.abort()
      else req.signal.addEventListener("abort", onExternalAbort, { once: true })
    }

    const headers: Record<string, string> = { ...req.headers }
    let body: string | undefined
    if (req.method === "POST" && req.body !== undefined) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body)
      if (!headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/json"
      }
    }

    try {
      const res = await doFetch(url, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      })
      const latencyMs = Date.now() - started
      const resHeaders = lowerHeaders(res.headers)

      if (!res.ok) {
        let bodyText = ""
        try {
          bodyText = (await res.text()).slice(0, 512)
        } catch {
          bodyText = ""
        }
        const retryAfterMs = parseRetryAfter(resHeaders["retry-after"])
        const code: ErrorCode = classifyStatus(provider, res.status, { bodyHint: bodyText })
        throw createProviderError({
          code,
          provider,
          // message 不带 query、过 redact
          message: `${req.method} ${safeUrl(url)} -> HTTP ${res.status}: ${redact(bodyText).slice(0, 200)}`,
          httpStatus: res.status,
          retryAfterMs,
          upstreamTag: bodyText,
        })
      }

      let cachedText: string | undefined
      const readText = async (): Promise<string> => {
        if (cachedText === undefined) cachedText = await res.text()
        return cachedText
      }
      return {
        status: res.status,
        headers: resHeaders,
        latencyMs,
        text: readText,
        json: async <T>() => JSON.parse(await readText()) as T,
      }
    } catch (e) {
      if (isProviderError(e)) throw e
      const latencyMs = Date.now() - started
      const aborted = e instanceof Error && e.name === "AbortError"
      const code: ErrorCode = timedOut ? "TIMEOUT" : aborted ? "TIMEOUT" : "NETWORK_ERROR"
      const reason = timedOut
        ? `timeout after ${timeoutMs}ms`
        : aborted
          ? "request aborted"
          : `network failure: ${redact(e instanceof Error ? e.message : String(e))}`
      throw createProviderError({
        code,
        provider,
        message: `${req.method} ${safeUrl(url)} -> ${reason}`,
        attempt: undefined,
      })
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener("abort", onExternalAbort)
    }
  }

  return { request, parseRetryAfter }
}

/* ============================================================
 * 指数退避重试封装（配置驱动：retry.maxAttempts/baseDelayMs/maxDelayMs）
 * ============================================================ */

export interface RetryOptions {
  /** 含首次在内的最大尝试次数（http.retriesPerKey + 1 由 router 折算） */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** 默认：isRetryable(code) 的 ProviderError 才重试；RATE_LIMIT 优先用 retryAfterMs */
  retryOn?: (e: unknown) => boolean
  signal?: AbortSignal
  onRetry?: (e: unknown, nextAttempt: number, delayMs: number) => void
  /** 测试注入 */
  sleep?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** 指数退避：delay = min(base * 2^(n-1), max)，RATE_LIMIT 且有 Retry-After 时以服务端值为准 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, retryAfterMs?: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
  if (retryAfterMs !== undefined && retryAfterMs > 0) return retryAfterMs // 服务端 Retry-After 优先
  return exp
}

export async function withRetries<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const retryOn =
    opts.retryOn ??
    ((e: unknown) => isProviderError(e) && isRetryable(e.code))
  const sleep = opts.sleep ?? ((ms: number) => defaultSleep(ms, opts.signal))
  let lastError: unknown
  for (let attempt = 1; attempt <= Math.max(1, opts.maxAttempts); attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      lastError = e
      if (attempt >= opts.maxAttempts || !retryOn(e)) throw e
      const retryAfterMs = isProviderError(e) ? e.retryAfterMs : undefined
      const delay = backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, retryAfterMs)
      opts.onRetry?.(e, attempt + 1, delay)
      await sleep(delay)
    }
  }
  throw lastError
}

export { countsTowardCircuit }
