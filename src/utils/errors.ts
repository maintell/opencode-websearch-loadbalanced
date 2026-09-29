/**
 * ProviderError 工厂 + provider×status 分类表。
 *
 * 依据：docs/architecture.md §6.1（错误分类决策表）。
 * - types.ts 的 ProviderError 是纯数据 interface（不继承 Error）→ 本文件提供工厂。
 * - 分类必须按 provider 分派：SearXNG 403 = UNKNOWN（实例禁 format=json，与 key 无关）。
 * - 一切 message / upstreamTag 出厂前经 redact()，绝不携带 key 或带 query 的 URL。
 */
import {
  ERROR_CODES,
  PROVIDER_IDS,
  type ErrorCode,
  type ProviderError,
  type ProviderID,
} from "../types"
import { redact } from "./logging"

export type { ProviderError } from "../types"

const MAX_TAG_BYTES = 512

export interface ProviderErrorInit {
  code: ErrorCode
  provider: ProviderID
  message: string
  httpStatus?: number
  retryAfterMs?: number
  keyId?: string
  attempt?: number
  upstreamTag?: string
}

/** 是否为 ProviderError 纯数据体（鸭子类型，供 withRetries / router 判定） */
export function isProviderError(e: unknown): e is ProviderError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as ProviderError).code === "string" &&
    (ERROR_CODES as readonly string[]).includes((e as ProviderError).code) &&
    typeof (e as ProviderError).provider === "string" &&
    (PROVIDER_IDS as readonly string[]).includes((e as ProviderError).provider)
  )
}

/**
 * 构造脱敏后的 ProviderError。
 * - message 过 redact()（抹 key 模式 + 已注册 secret）
 * - upstreamTag 截断 ≤512B 并脱敏
 */
export function createProviderError(init: ProviderErrorInit): ProviderError {
  const err: ProviderError = {
    code: init.code,
    provider: init.provider,
    message: redact(String(init.message ?? "")).slice(0, 512),
  }
  if (init.httpStatus !== undefined) err.httpStatus = init.httpStatus
  if (init.retryAfterMs !== undefined && init.retryAfterMs >= 0) err.retryAfterMs = init.retryAfterMs
  if (init.keyId !== undefined) err.keyId = init.keyId
  if (init.attempt !== undefined) err.attempt = init.attempt
  if (init.upstreamTag !== undefined) {
    err.upstreamTag = redact(String(init.upstreamTag)).slice(0, MAX_TAG_BYTES)
  }
  return err
}

/**
 * provider × httpStatus → ErrorCode（architecture.md §6.1 表）。
 * 403 语义按 provider 分派，禁止全局一刀切：
 * - searxng: 403 = 实例禁用 format=json（HTML 页）→ UNKNOWN（不算 key 失效、不冷却 key）
 * - 其余 key 型 provider: 401/403 → AUTH（禁用该 key）
 * - tavily 403 官方仅 Research 端点提及 → 默认 UNKNOWN，响应体探测由 adapter 决定（bodyHint 含 auth 语义时才 AUTH）
 */
export function classifyStatus(
  provider: ProviderID,
  status: number,
  opts?: { bodyHint?: string },
): ErrorCode {
  if (status === 401) return "AUTH"
  if (status === 403) {
    if (provider === "searxng") return "UNKNOWN"
    if (provider === "tavily") {
      const hint = (opts?.bodyHint ?? "").toLowerCase()
      return /api key|unauthorized|invalid key|permission/.test(hint) ? "AUTH" : "UNKNOWN"
    }
    return "AUTH"
  }
  if (status === 429) return "RATE_LIMIT"
  if (status === 402) return "QUOTA_EXCEEDED"
  if (status === 400 || status === 404 || status === 422) return "BAD_REQUEST"
  if (status >= 500 && status <= 599) return "SERVER_ERROR"
  if (status >= 200 && status < 300) return "UNKNOWN" // 成功路径不会走到这里
  return "UNKNOWN"
}

/** 该 code 是否值得网络层重试（最终决策仍归 router） */
export function isRetryable(code: ErrorCode): boolean {
  return code === "RATE_LIMIT" || code === "SERVER_ERROR" || code === "NETWORK_ERROR" || code === "TIMEOUT"
}

/** 该 code 是否计入 circuit breaker（architecture.md §6.2：只统计 5xx/网络/超时） */
export function countsTowardCircuit(code: ErrorCode): boolean {
  return code === "SERVER_ERROR" || code === "NETWORK_ERROR" || code === "TIMEOUT"
}
