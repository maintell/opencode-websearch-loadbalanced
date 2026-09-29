/**
 * 内存 LRU + TTL 缓存（architecture.md §3）。
 *
 * - key = hash(provider + query + params)（sha256；provider 缺省 = 插件级缓存，router 之上）
 * - 命中返回 { value, cached: true } → 上层置 SearchResponse.cacheHit；命中不消耗 budget
 * - ttlMs/maxEntries 全配置驱动；LRU = Map 插入序，命中刷新、超限删最旧
 * - 不持久化（ctx.storage 属 Phase 3）
 */
import { createHash } from "node:crypto"
import type { CacheConfig } from "./types"

export interface CacheHit<T> {
  value: T
  cached: true
}

export interface Cache<T = unknown> {
  get(key: string): CacheHit<T> | undefined
  set(key: string, value: T, now?: number): void
  has(key: string, now?: number): boolean
  delete(key: string): boolean
  clear(): void
  readonly size: number
}

/** 稳定序列化：对象键排序，undefined 丢弃，保证同参同 key */
function stable(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export interface CacheKeyParts {
  query: string
  provider?: string
  params?: Record<string, unknown>
}

/** key = sha256(provider + query + params) 前 32 hex */
export function buildCacheKey(parts: CacheKeyParts): string {
  const raw = `${parts.provider ?? "*"}\n${parts.query.trim().toLowerCase()}\n${stable(parts.params ?? {})}`
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32)
}

export function createCache<T = unknown>(config: CacheConfig, now: () => number = Date.now): Cache<T> {
  const map = new Map<string, { value: T; expires: number }>()

  function alive(key: string, t: number): { value: T; expires: number } | undefined {
    const e = map.get(key)
    if (!e) return undefined
    if (t >= e.expires) {
      map.delete(key)
      return undefined
    }
    return e
  }

  return {
    get(key) {
      const t = now()
      const e = alive(key, t)
      if (!e) return undefined
      // LRU：命中移到队尾
      map.delete(key)
      map.set(key, e)
      return { value: e.value, cached: true }
    },

    set(key, value, t = now()) {
      if (map.has(key)) map.delete(key)
      map.set(key, { value, expires: t + config.ttlMs })
      while (map.size > config.maxEntries) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },

    has(key, t = now()) {
      return alive(key, t) !== undefined
    },

    delete(key) {
      return map.delete(key)
    },

    clear() {
      map.clear()
    },

    get size() {
      return map.size
    },
  }
}
