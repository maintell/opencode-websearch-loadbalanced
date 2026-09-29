import { defineConfig } from "vitest/config"

// ponytail: 用 argv 探测「本次运行是否显式指向 tests/integration」来决定是否排除；
// 上限 = 只认路径子串。若将来引入 vitest projects（unit / integration 分项目），删掉此探测。
const targetsIntegration = process.argv.some((a) => a.includes("integration"))

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 集成测试（tests/integration，真实外呼）默认排除：npm test 只跑单元占位
    // 单独跑：npm run test:providers
    exclude: targetsIntegration
      ? ["node_modules/**"]
      : ["tests/integration/**", "node_modules/**"],
  },
})
