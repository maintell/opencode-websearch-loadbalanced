/**
 * 结构化日志 + key 脱敏。
 *
 * 铁律（architecture.md §8）：
 * - 输出白名单：provider / keyId / status / latency(+ms) / level / msg，别的一律不进日志。
 * - keyId = sha256(secret) 前 8 hex。
 * - 脱敏在序列化层，不靠日志级别开关：level=debug 也不打印 secret。
 * - registerSecret() 登记过的明文，任何字符串经 redact() 必被抹除。
 */
import { createHash } from "node:crypto"

export type LogLevel = "silent" | "error" | "info" | "debug"

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 }

/** 已知 secret 注册表（进程内）：redact() 会把它们从任何字符串中抹除 */
const secrets = new Set<string>()

export function registerSecret(secret: string | undefined): void {
  if (secret && secret.length >= 6) secrets.add(secret)
}

/** keyId = sha256(secret) 前 8 hex；永不返回明文 */
export function keyIdOf(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8)
}

/** 形如 "exa:9f3a7c21" 的稳定指纹 */
export function fingerprint(provider: string, secret: string): string {
  return `${provider}:${keyIdOf(secret)}`
}

/* 常见 key 形态（architecture.md §8.4：tvly-…、sk-… 等）+ query 参数名 + Bearer */
const PATTERNS: Array<[RegExp, string]> = [
  [/([?&](?:api_key|apikey|key|token|access_token|private_key|secret|auth)[=])[^\s&"']+/gi, "$1***"],
  [/\b(tvly-)[A-Za-z0-9_-]{8,}/g, "$1***"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "$1-***"],
  [/\b(AIza)[A-Za-z0-9_-]{16,}/g, "$1***"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  [/\b(x-api-key|X-API-Key|api-key)(["']?\s*[:=]\s*["']?)[^\s,"']+/gi, "$1$2***"],
  [/\b([A-Fa-f0-9]{32,})\b/g, "***"], // 长 hex 串（可能为 key/签名）
]

/** 任何字符串过一遍保证不泄露 key / secret / 密钥型 query 参数 */
export function redact(input: unknown): string {
  if (input === null || input === undefined) return ""
  let s = typeof input === "string" ? input : String(input)
  for (const secret of secrets) {
    if (secret && s.includes(secret)) s = s.split(secret).join("***")
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep)
  return s
}

/** 日志字段白名单 */
export interface LogFields {
  provider?: string
  keyId?: string
  status?: number | string
  latencyMs?: number
  [k: string]: unknown
}

export interface Logger {
  level: LogLevel
  error(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
}

/** 输出行构造（测试可注入 writer）；字段经白名单 + redact 双重过滤 */
export function formatLogLine(level: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields): string {
  const out: Record<string, unknown> = { level, msg: redact(msg) }
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue
      if (k === "provider" || k === "keyId" || k === "status" || k === "latencyMs") {
        out[k] = typeof v === "string" ? redact(v) : v
      }
      // 白名单外字段一律丢弃（level=debug 也不放过）
    }
  }
  return JSON.stringify(out)
}

export interface LoggerOptions {
  level: LogLevel
  /** 注入输出（默认 process.stdout.write） */
  write?: (line: string) => void
}

export function createLogger(opts: LoggerOptions): Logger {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"))
  const enabled = (want: LogLevel) =>
    LEVEL_ORDER[opts.level] >= LEVEL_ORDER[want] && opts.level !== "silent"
  const emit = (level: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields) => {
    if (enabled(level)) write(formatLogLine(level, msg, fields))
  }
  return {
    level: opts.level,
    error: (m, f) => emit("error", m, f),
    info: (m, f) => emit("info", m, f),
    debug: (m, f) => emit("debug", m, f),
  }
}

/** 静默 logger（测试 / logging.level=silent） */
export const silentLogger: Logger = createLogger({ level: "silent", write: () => {} })
