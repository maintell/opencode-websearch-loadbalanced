/**
 * URL 规范化 + 去重（architecture.md §5）。
 *
 * 规范化：去跟踪参数（utm_* 等）、去 fragment、query 排序、host 小写、
 * 去默认端口（WHATWG URL 自动）、尾斜杠归一。
 * dedupe：同 URL（规范化后）合并，保留 providers 列表，首见者字段优先（层级高者先到）。
 */
import type { ProviderID, SearchResult } from "../types"

/** 非前缀型跟踪参数 */
const TRACKING_PARAMS = new Set([
  "gclid", "dclid", "gclsrc", "fbclid", "msclkid", "yclid", "igshid",
  "mc_cid", "mc_eid", "_ga", "_gl", "twclid", "vero_conv", "vero_id",
  "srsltid", "spm", "scm",
])
/** 前缀型跟踪参数 */
const TRACKING_PREFIXES = ["utm_"]

function isTracking(name: string): boolean {
  const lower = name.toLowerCase()
  if (TRACKING_PARAMS.has(lower)) return true
  return TRACKING_PREFIXES.some((p) => lower.startsWith(p))
}

/** 尾斜杠归一：非根路径去掉尾斜杠；根路径保留单个 "/" */
function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "")
  return pathname
}

/**
 * 规范化 URL。无法解析时返回去 fragment 的 trim 串（不抛错——坏 URL 不该炸掉去重）。
 */
export function normalizeUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim()
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    // 解析失败仍保证 fragment 剥离（坏 URL 不炸去重，也不因 # 差异漏合并）
    return trimmed.split("#")[0]
  }
  u.hash = ""
  u.hostname = u.hostname.toLowerCase()
  const params = [...u.searchParams.entries()].filter(([k]) => !isTracking(k))
  params.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  u.search = ""
  for (const [k, v] of params) u.searchParams.append(k, v)
  const path = normalizePathname(u.pathname)
  const port = u.port ? `:${u.port}` : ""
  const query = u.search ? u.search : ""
  const proto = u.protocol.toLowerCase()
  return `${proto}//${u.hostname}${port}${path}${query}`
}

/**
 * hostname+pathname 回退键：query 无法参与比较（或 URL 解析失败）时使用。
 * 解析失败 → 退化为整串（去 fragment 后）。
 */
export function hostPathKey(raw: string): string {
  const trimmed = String(raw ?? "").trim()
  try {
    const u = new URL(trimmed)
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${normalizePathname(u.pathname)}`
  } catch {
    const noHash = trimmed.split("#")[0]
    return noHash
  }
}

/** 去重主键：优先规范化全 URL；规范化结果为空/不可解析时回退 host+path */
export function dedupeKey(raw: string): string {
  const normalized = normalizeUrl(raw)
  if (!normalized) return hostPathKey(raw)
  // 纯 hash/跟踪差异已消除；若解析失败 normalize 返回原串，同样可用
  return normalized
}

/** 合并后的结果：在 SearchResult 之上附带 providers 归因列表 */
export type DedupedResult = SearchResult & { providers: ProviderID[] }

/**
 * 合并同 URL 结果。输入应已按「provider 层级 → rank」排序（首见优先）。
 * - 首见结果的字段保留；后续同 URL 结果只补齐缺失字段（title/content/published）
 * - providers 保留全部去重后的 provider 列表
 */
export function dedupe(results: SearchResult[]): DedupedResult[] {
  const byKey = new Map<string, DedupedResult>()
  const order: string[] = []
  for (const r of results) {
    const key = dedupeKey(r.url)
    const existing = byKey.get(key)
    if (!existing) {
      const copy: DedupedResult = { ...r, time: { ...r.time }, providers: [r.provider] }
      byKey.set(key, copy)
      order.push(key)
      continue
    }
    if (!existing.providers.includes(r.provider)) existing.providers.push(r.provider)
    if (!existing.title && r.title) existing.title = r.title
    if (!existing.content && r.content) existing.content = r.content
    const pub = r.time?.published
    if (existing.time.published === undefined && pub !== undefined) existing.time.published = pub
    if (existing.score === undefined && r.score !== undefined) existing.score = r.score
    if (existing.keyId === undefined && r.keyId !== undefined) existing.keyId = r.keyId
    if (existing.rank > r.rank) existing.rank = r.rank // 同 URL 内取更好名次
  }
  return order.map((k) => byKey.get(k)!)
}
