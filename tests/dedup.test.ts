import { describe, expect, it } from "vitest"
import { dedupe, dedupeKey, hostPathKey, normalizeUrl } from "../src/utils/url"
import type { SearchResult } from "../src/types"

function result(over: Partial<SearchResult> & { url: string }): SearchResult {
  return { time: {}, provider: "tavily", rank: 1, ...over }
}

describe("normalizeUrl", () => {
  it("去 utm_* / gclid 等跟踪参数", () => {
    expect(normalizeUrl("https://Example.com/a?utm_source=x&utm_medium=y&q=hello&gclid=zzz&fbclid=1")).toBe(
      "https://example.com/a?q=hello",
    )
  })

  it("去 fragment", () => {
    expect(normalizeUrl("https://example.com/a?x=1#section-2")).toBe("https://example.com/a?x=1")
    expect(normalizeUrl("https://example.com/page#top")).toBe("https://example.com/page")
  })

  it("query 参数排序（顺序不同 → 同一 key）", () => {
    expect(normalizeUrl("https://example.com/s?b=2&a=1")).toBe(normalizeUrl("https://example.com/s?a=1&b=2"))
  })

  it("尾斜杠归一（根路径保留单 /）", () => {
    expect(normalizeUrl("https://example.com/a/")).toBe("https://example.com/a")
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/")
  })

  it("去默认端口、host 小写", () => {
    expect(normalizeUrl("https://EXAMPLE.com:443/a")).toBe("https://example.com/a")
    expect(normalizeUrl("http://Example.com:80/a")).toBe("http://example.com/a")
  })

  it("无法解析的 URL 不抛错，原样返回", () => {
    expect(normalizeUrl("not a url")).toBe("not a url")
    expect(normalizeUrl("")).toBe("")
  })
})

describe("hostPathKey（hostname+pathname 回退键）", () => {
  it("丢弃 query 与 fragment", () => {
    expect(hostPathKey("https://example.com/a/b?utm_source=x&z=1#frag")).toBe("https://example.com/a/b")
  })

  it("不可解析时退化为去 fragment 原串", () => {
    expect(hostPathKey(" /a/b?x=1#f ")).toBe("/a/b?x=1")
  })
})

describe("dedupeKey", () => {
  it("仅跟踪参数 / fragment 差异 → 同 key", () => {
    const a = dedupeKey("https://example.com/post?utm_source=tw&ref=1")
    const b = dedupeKey("https://example.com/post?ref=1#comments")
    expect(a).toBe(b)
  })

  it("不同 pathname → 不同 key", () => {
    expect(dedupeKey("https://example.com/a")).not.toBe(dedupeKey("https://example.com/b"))
  })
})

describe("dedupe(results)", () => {
  it("合并同 URL，保留 providers 列表，首见者字段优先", () => {
    const out = dedupe([
      result({ url: "https://example.com/a?utm_source=x", title: "From Tavily", provider: "tavily", rank: 2 }),
      result({
        url: "https://example.com/a#section",
        title: "From Exa",
        content: "exa content",
        provider: "exa",
        rank: 5,
        time: { published: 1_700_000_000_000 },
      }),
      result({ url: "https://other.org/b", title: "Other", provider: "serpapi", rank: 1 }),
    ])
    expect(out).toHaveLength(2)
    const merged = out[0]
    expect(merged.title).toBe("From Tavily") // 首见优先
    expect(merged.content).toBe("exa content") // 缺失字段由后续补齐
    expect(merged.providers).toEqual(["tavily", "exa"])
    expect(merged.time.published).toBe(1_700_000_000_000)
    expect(merged.provider).toBe("tavily") // 归因主 provider 不改
    expect(out[1].providers).toEqual(["serpapi"])
  })

  it("保留首次出现顺序（层级高者先到）与更优 rank", () => {
    const out = dedupe([
      result({ url: "https://example.com/a", provider: "parallel", rank: 4 }),
      result({ url: "https://example.com/a", provider: "exa", rank: 2 }),
      result({ url: "https://example.com/z", provider: "exa", rank: 1 }),
    ])
    expect(out.map((r) => r.url)).toEqual(["https://example.com/a", "https://example.com/z"])
    expect(out[0].providers).toEqual(["parallel", "exa"])
    expect(out[0].rank).toBe(2) // 同 URL 内取更好名次
    expect(out[0].provider).toBe("parallel")
  })

  it("同 provider 重复 URL 不产生重复 providers 项", () => {
    const out = dedupe([
      result({ url: "https://example.com/a", provider: "you", rank: 1 }),
      result({ url: "https://example.com/a/", provider: "you", rank: 3 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].providers).toEqual(["you"])
  })

  it("query 参数顺序不同的同一 URL 合并", () => {
    const out = dedupe([
      result({ url: "https://example.com/s?b=2&a=1", provider: "serpapi", rank: 1 }),
      result({ url: "https://example.com/s?a=1&b=2", provider: "searxng", rank: 2 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].providers).toEqual(["serpapi", "searxng"])
  })

  it("坏 URL 不抛错且不误合并", () => {
    const out = dedupe([
      result({ url: "not-a-url", provider: "tavily" }),
      result({ url: "also-not-a-url", provider: "exa" }),
      result({ url: "not-a-url#x", provider: "exa" }),
    ])
    expect(out).toHaveLength(2) // "not-a-url" 与 "not-a-url#x" 合并
    expect(out[0].providers).toEqual(["tavily", "exa"])
    expect(out[1].providers).toEqual(["exa"])
  })

  it("空输入 → 空数组", () => {
    expect(dedupe([])).toEqual([])
  })
})
