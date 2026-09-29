import { describe, expect, it } from "vitest"

// 占位集成测试：真实 provider 网络冒烟（需环境变量 key）。
// 单独跑：npm run test:providers（默认 npm test 排除本目录，避免外呼）
describe("providers integration", () => {
  it("placeholder", () => {
    expect(true).toBe(true)
  })
})
