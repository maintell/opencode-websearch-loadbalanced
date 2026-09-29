import { describe, expect, it } from "vitest"
import { resolveConfig, resolveProviderKeys } from "../src/config"
import type { KeyEntry } from "../src/types"

const ENV = {
  EXA_API_KEY: "exa-secret-plaintext-0000000001",
  EXA_API_KEY_2: "exa-secret-plaintext-0000000002",
  TAVILY_API_KEY: "tvly-secret-plaintext-0000001",
}

function withExa(keys: KeyEntry[]) {
  return resolveConfig({ providers: { exa: { enabled: true, keys } } }, { env: ENV })
}

describe("config keys 三种写法等价归一（orchestrator 裁定）", () => {
  it("纯 env 名：[\"EXA_API_KEY\"]", () => {
    const { resolved, errors } = withExa(["EXA_API_KEY"])
    expect(errors).toEqual([])
    expect(resolved.providers.exa.enabled).toBe(true)
    expect(resolved.providers.exa.keys).toEqual([{ id: "EXA_API_KEY", envName: "EXA_API_KEY" }])
  })

  it("插值字符串：[\"${EXA_API_KEY}\"]", () => {
    const { resolved, errors } = withExa(["${EXA_API_KEY}"])
    expect(errors).toEqual([])
    expect(resolved.providers.exa.enabled).toBe(true)
    expect(resolved.providers.exa.keys).toEqual([{ id: "EXA_API_KEY", envName: "EXA_API_KEY" }])
  })

  it("对象写法：[{id, value}]，id 显式保留", () => {
    const { resolved, errors } = withExa([{ id: "primary", value: "${EXA_API_KEY}" }])
    expect(errors).toEqual([])
    expect(resolved.providers.exa.enabled).toBe(true)
    expect(resolved.providers.exa.keys).toEqual([{ id: "primary", envName: "EXA_API_KEY" }])
  })

  it("对象写法缺 id → id 由 env 名派生", () => {
    const { resolved } = withExa([{ value: "${EXA_API_KEY}" }])
    expect(resolved.providers.exa.keys).toEqual([{ id: "EXA_API_KEY", envName: "EXA_API_KEY" }])
  })

  it("混用多种写法 → 同一内部结构，重复 envName 去重", () => {
    const { resolved, warnings } = withExa([
      "EXA_API_KEY",
      { id: "second", value: "${EXA_API_KEY_2}" },
      "${EXA_API_KEY}", // 与第 1 条重复
    ])
    expect(resolved.providers.exa.keys).toEqual([
      { id: "EXA_API_KEY", envName: "EXA_API_KEY" },
      { id: "second", envName: "EXA_API_KEY_2" },
    ])
    expect(warnings.some((w) => w.includes("EXA_API_KEY") && w.includes("去重"))).toBe(true)
  })
})

describe("config 缺失 env → 不可用而非抛错", () => {
  it("唯一 key 的 env 缺失 → provider disabled + warning，errors 为空", () => {
    const { resolved, errors, warnings } = resolveConfig(
      { providers: { exa: { enabled: true, keys: ["MISSING_EXA_KEY"] } } },
      { env: ENV },
    )
    expect(resolved.providers.exa.enabled).toBe(false)
    expect(errors).toEqual([]) // 不阻断、不抛错
    expect(warnings.some((w) => w.includes("MISSING_EXA_KEY"))).toBe(true)
  })

  it("对象写法 env 缺失 → 同样 disabled + warning", () => {
    const { resolved, errors } = resolveConfig(
      { providers: { exa: { enabled: true, keys: [{ id: "p", value: "${MISSING_EXA_KEY}" }] } } },
      { env: ENV },
    )
    expect(resolved.providers.exa.enabled).toBe(false)
    expect(errors).toEqual([])
  })

  it("多 key 部分缺失 → 保留可用 key，provider 仍 enabled", () => {
    const { resolved, warnings } = resolveConfig(
      { providers: { exa: { enabled: true, keys: ["EXA_API_KEY", "MISSING_EXA_KEY"] } } },
      { env: ENV },
    )
    expect(resolved.providers.exa.enabled).toBe(true)
    expect(resolved.providers.exa.keys.map((k) => k.envName)).toEqual([
      "EXA_API_KEY",
      "MISSING_EXA_KEY", // 归一保留（诊断可见），仅「存在性检查」时视为不可用
    ])
    expect(warnings.some((w) => w.includes("MISSING_EXA_KEY"))).toBe(true)
  })

  it("全部 env 缺失但有 keysInline 兜底 → 仍可用 + 明文告警", () => {
    const { resolved, warnings } = resolveConfig(
      { providers: { exa: { enabled: true, keys: ["MISSING"], keysInline: ["inline-fallback-key-123456"] } } },
      { env: ENV },
    )
    expect(resolved.providers.exa.enabled).toBe(true)
    expect(warnings.some((w) => w.includes("明文"))).toBe(true)
  })

  it("searxng 无 key → 仍 enabled", () => {
    const { resolved } = resolveConfig({ providers: { searxng: { enabled: true } } }, { env: ENV })
    expect(resolved.providers.searxng.enabled).toBe(true)
  })

  it("非法 keys 条目 → error + provider 不可用（不抛错）", () => {
    const { resolved, errors } = resolveConfig(
      { providers: { exa: { enabled: true, keys: [{ id: "p", value: "not-an-env-ref" }, 42 as never] } } },
      { env: ENV },
    )
    expect(resolved.providers.exa.enabled).toBe(false)
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })
})

describe("resolveProviderKeys", () => {
  it("三种写法产出相同 ResolvedKey 形态（指纹 id + secret），且不泄露明文", () => {
    const variants: KeyEntry[][] = [
      ["EXA_API_KEY"],
      ["${EXA_API_KEY}"],
      [{ id: "primary", value: "${EXA_API_KEY}" }],
    ]
    const outputs = variants.map((keys) => resolveProviderKeys(withExa(keys).resolved, ENV))
    for (const out of outputs) {
      expect(out.exa).toHaveLength(1)
      const k = out.exa![0]
      expect(k.id).toMatch(/^exa:[0-9a-f]{8}$/) // 指纹来自 sha256(secret)，与槽位 id 无关
      expect(k.secret).toBe(ENV.EXA_API_KEY)
    }
    // 指纹一致性：三种写法 → 同一 keyId
    expect(outputs[0].exa![0].id).toBe(outputs[1].exa![0].id)
    expect(outputs[0].exa![0].id).toBe(outputs[2].exa![0].id)
    // 配置对象序列化不含明文（ResolvedKey.secret 仅内存传递，不落配置/日志）
    const cfg = withExa([{ id: "primary", value: "${EXA_API_KEY}" }]).resolved
    expect(JSON.stringify(cfg)).not.toContain(ENV.EXA_API_KEY)
  })

  it("disabled provider 不产出 key；env 缺失条目被跳过", () => {
    const disabled = resolveProviderKeys(withExa(["EXA_API_KEY"]).resolved, { EXA_API_KEY: "" })
    expect(disabled.exa).toBeUndefined()

    const partial = resolveConfig(
      { providers: { exa: { enabled: true, keys: ["EXA_API_KEY", "MISSING"] } } },
      { env: ENV },
    )
    const keys = resolveProviderKeys(partial.resolved, ENV)
    expect(keys.exa).toHaveLength(1)
    expect(keys.exa![0].secret).toBe(ENV.EXA_API_KEY)
  })

  it("同 secret 重复配置 → 去重为一个 ResolvedKey", () => {
    const cfg = withExa(["EXA_API_KEY", { id: "dup", value: "${EXA_API_KEY}" }]).resolved
    // 归一层已按 envName 去重 → 只剩一条
    expect(cfg.providers.exa.keys).toHaveLength(1)
    expect(resolveProviderKeys(cfg, ENV).exa).toHaveLength(1)
  })
})

describe("budget.unit 别名归一（credit / usd / unlimited）", () => {
  function unitOf(unit: string, extra: Record<string, unknown> = {}) {
    return resolveConfig({ budget: { unit, ...extra } } as never, { env: ENV })
  }

  it("credit → credits（零 warning）", () => {
    const { resolved, warnings } = unitOf("credit")
    expect(resolved.budget.unit).toBe("credits")
    expect(warnings.filter((w) => w.includes("budget.unit"))).toEqual([])
  })

  it("usd → credits（ponytail：数值=provider 计费单位，不做 USD 换算）", () => {
    const { resolved, warnings } = unitOf("usd")
    expect(resolved.budget.unit).toBe("credits")
    expect(warnings.filter((w) => w.includes("budget.unit"))).toEqual([])
  })

  it("requests / credits 原样保留（零行为改动）", () => {
    expect(unitOf("requests").resolved.budget.unit).toBe("requests")
    expect(unitOf("credits").resolved.budget.unit).toBe("credits")
  })

  it("unlimited → 丢弃 limits（等价未设 limit，沿用现有无 limit 行为）", () => {
    const { resolved, warnings } = unitOf("unlimited", {
      limits: [{ scope: "provider", target: "serpapi", limit: 250 }],
    })
    expect(resolved.budget.limits).toEqual([])
    expect(warnings.some((w) => w.includes("budget.unit=unlimited"))).toBe(true)
  })

  it("unlimited 无 limits → 不告警", () => {
    const { resolved, warnings } = unitOf("unlimited")
    expect(resolved.budget.limits).toEqual([])
    expect(warnings.some((w) => w.includes("budget.unit=unlimited"))).toBe(false)
  })

  it("非法值 → 回退 requests + warning（既有行为不变）", () => {
    const { resolved, warnings } = unitOf("dollars")
    expect(resolved.budget.unit).toBe("requests")
    expect(warnings.some((w) => w.includes("budget.unit 非法"))).toBe(true)
  })
})
