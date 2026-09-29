# OpenCode v2 Plugin / WebSearch API 调研报告

> 调研日期：2026-09-29
> 来源基准：**OpenCode v2 官方文档** `https://opencode.ai/v2/docs/`（机器索引 `https://opencode.ai/v2/llms.txt`）。
> 注意：`https://opencode.ai/docs/` 是 **V1 文档**，本报告不以其为准（除第 6 节迁移对照外）。
> 标注约定：**【文档确认】** = 官方 v2 文档原文可查；**【推断】** = 由文档多处表述推导或本机 AGENTS.md 经验，未在文档逐字出现。

---

## 0. 摘要（TL;DR）

1. V2 插件默认导出 `Plugin.define({ id, setup(ctx) })`，包名 `@opencode/plugin`。【文档确认】
2. 工具注册：`await ctx.tool.transform((editor) => editor.add({ name, description, input( JSON Schema ), execute }))`，回调必须同步、无副作用。【文档确认】
3. **OpenCode v2 存在专门的 WebSearch Provider 扩展接口 `ctx.websearch`**，与普通 tool 注册是**两个独立 domain**。官方推荐用 `ctx.websearch.transform(editor => editor.add({ id, name, execute }))` 注册搜索 provider，而不是注册一个叫 `web_search` 的普通工具。【文档确认】
4. 插件读配置的官方方式：`opencode.jsonc` 的 `plugins` 数组对象形式 `{ package, options }` → 在 `setup(ctx)` 里读 `ctx.options`；持久化用 `ctx.storage`。**没有独立 yaml**。【文档确认】
5. 包格式 = 普通 npm 包（`package.json`，`type: module`，`exports` 可直接指向 `.ts`）；**TypeScript 直接加载，无需编译**；本地插件放 `.opencode/plugins/` 自动发现。【文档确认】
6. V1→V2 最大差异：入口从「导出插件函数返回 hooks 对象」改为「`Plugin.define` + `setup(ctx)`」；V1 实现在 V2 **完全不运行**。【文档确认】

---

## 1. V2 Plugin API：默认导出、生命周期、ctx 字段

### 1.1 默认导出形态 【文档确认】

官方示例（https://opencode.ai/v2/docs/build/plugins ）：

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.storage.set("loaded", true)
  },
})
```

- 包名：**`@opencode/plugin`**（Effect 版为 `@opencode/plugin/effect`，TUI 版 `@opencode/plugin/tui`）。
- 每个 V2 插件**必须有稳定的 `id`**：插件存储按该 ID 隔离，状态/诊断也用它标识。【文档确认】
- 关于 `module.exports = { id, setup }`（CJS）：官方文档只展示 ESM `export default Plugin.define({...})`。文档在「Support V1」一节明确「**V2 reads the default export's `id` and `setup()`**」——即 V2 读取默认导出的 `id` 与 `setup()` 字段。因此 CJS 下 `module.exports = { id, setup }`（plain object，字段齐备）**形态上被接受**。**【推断】**（本机 AGENTS.md 已实测可用，官方文档未逐字给出 CJS 写法）
- `Plugin.define` 运行时为恒等/构造函数，返回含 `id`/`setup` 的定义对象。**【推断】**（本机 AGENTS.md：「运行时是恒等函数，CJS 用 plain object literal 即可」）

### 1.2 生命周期 【文档确认】

来源：https://opencode.ai/v2/docs/build/plugins （Lifecycle 节）

- `setup` 在插件加载时执行；**可返回一个 cleanup 函数**，在插件卸载时执行。
- `setup` 返回的 cleanup 用于释放定时器、子进程、socket 等资源；hook / transform 注册随插件生命周期自动清理。
- 需要提前移除某个 hook/transform 时，保留其返回的 `registration` 并调用 `registration.dispose()`。
- `transform` / `hook` 调用返回 `Promise<Registration>`，`Registration.dispose(): Promise<void>`。

### 1.3 ctx 可用字段 【文档确认】

来源：https://opencode.ai/v2/docs/build/plugins （Context 节 + API 各小节）、Effect 版 Context interface。

- **ctx 本质是「OpenCode server client + 插件扩展方法」**：读/操作方法与 client 同输入同响应，另加 transform / hook / reload / registration / options。
- **`ctx.location`**：插件实例加载位置，含 `directory`、可选 `workspaceID`、`project`（`id`、`directory`、`canonical`）。
  - ⚠️ **`ctx` 顶层没有 `directory`**，路径必须取 **`ctx.location.directory`**（与 AGENTS.md 已知事实一致，且被 V1 迁移表逐字确认）。
- Promise 插件 ctx 主要 domain（据文档 API Reference 与 Effect Context）：

| domain | 用途 |
|---|---|
| `ctx.app` | 应用元信息（`ctx.app.version`） |
| `ctx.location` | 加载位置 / 目录 / project 元数据 |
| `ctx.options` | 插件 options（来自 config `plugins[].options`） |
| `ctx.agent` | agent list/get/transform/reload |
| `ctx.provider` | provider transform/reload |
| `ctx.model` | model list/default/transform/reload |
| `ctx.command` | 命令 transform |
| `ctx.integration` | 集成/OAuth/API key |
| `ctx.mcp` | MCP server transform |
| `ctx.reference` / `ctx.skill` | 引用 / skill transform |
| `ctx.tool` | **工具 list/transform/reload/hook** |
| `ctx.shell` | shell hook（`create.before`） |
| `ctx.session` | session 读写 + `hook(prompt/context/compaction/retry/…)` |
| `ctx.permission` | permission hook（`evaluate`） |
| `ctx.event` | `subscribe({ signal })` 事件流 |
| `ctx.storage` | 插件级持久化 JSON（get/set/remove/scan） |
| `ctx.websearch` | **WebSearch provider domain**（见第 3 节） |
| `ctx.vcs` / `ctx.worktree` | 版本库 / worktree |
| `ctx.generate` | 无会话生成文本 |
| `ctx.rpc` | 自定义 RPC |
| `ctx.plugin` | `list()` 当前活跃插件 |
| `ctx.model` / `ctx.provider` / `ctx.aisdk` / `ctx.experimental` | 见 Effect Context |

- V1 迁移表确认的路径差异（https://opencode.ai/v2/docs/build/plugins/migrate-v1 ）：`directory → ctx.location.directory`、`project → ctx.location.project`、`client → ctx.session 等 domain 方法`、`options 参数 → ctx.options`。

---

## 2. 工具注册：`ctx.tool.transform` 签名与返回值

### 2.1 注册签名 【文档确认】

来源：https://opencode.ai/v2/docs/build/plugins （Tools 节）

```ts
interface ToolContext {
  list(): Promise<readonly (ToolInfo & { readonly id: string })[]>
  transform(callback: (editor: ToolEditor) => void): Promise<Registration>
  reload(): Promise<void>
}

interface ToolEditor {
  list(): readonly (ToolInfo & { readonly id: string })[]
  get(id: string): (ToolInfo & { readonly id: string }) | undefined
  namespace(namespace: { name: string; description: string }): void
  add(tool: ToolInfo): void
  update(id: string, update: (tool: Types.Mutable<ToolInfo>) => void): void
  remove(id: string): void
}
```

官方注册示例：

```ts
const registration = await ctx.tool.transform((editor) => {
  editor.namespace({ name: "acme", description: "Customer account tools" })
  editor.add({
    name: "greeting",
    description: "Create a greeting",
    input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    options: { namespace: "acme", codemode: true },
    execute: async (input, context) => {
      await context.progress({ status: "greeting" })
      return { content: `Hello ${(input as { name: string }).name}!` }
    },
  })
})
```

关键约束（均【文档确认】）：
- **transform 回调必须同步、廉价、无一次性副作用**（「Transforms are replayable state edits. Keep their callback synchronous, cheap, and free of one-time side effects.」）。需要外部数据 → 在注册前加载、闭包捕获，数据变化后调 `ctx.tool.reload()` 重放。
- 回调会被**重放（replay）**：任何注册/移除/reload 标记 registry 变化，下一次读取会在全新 editor 上按注册顺序重放所有活跃 transform。⇒ 与 AGENTS.md「回调会被重放，必须同步无副作用」一致。【文档确认】
- `input` 是 **JSON Schema**（`{ type:"object", properties, required, additionalProperties }`），不是 zod（zod 的 `tool()` helper 是 V1 形态）。
- 同名（effective name）后注册覆盖先注册；`registration.dispose()` 移除该 transform 并从其余 transform 重建。
- `execute` 收到 `context.signal`（AbortSignal）与 `context.progress(...)`。
- 工具 `id` = 生效名（含 namespace，如 `acme_greeting`）；命名空间点号/非法字符转 `_`。

### 2.2 执行返回值 `Tool.Result` 【文档确认（结构）/ 推断（别名）】

- 官方示例 execute 返回 **`{ content: string }`**；文档明确「execution returns structured content」。【文档确认】
- `Tool.Content = Tool.TextContent | Tool.FileContent`（OpenAPI：`https://opencode.ai/v2/docs/api`，schema `Tool.Content` / `Tool.TextContent` / `Tool.FileContent`）。【文档确认】
  - `Tool.TextContent`: `{ type: "text", text: string }`
  - `Tool.FileContent`: `{ type: "file", uri: string, mime: string, name?: string | null }`
- 会话工具状态 `Session.Message.ToolState.Completed` 含 `content: Tool.Content[]`（min 1）+ `metadata?: object`。【文档确认】
- `execute.after` 钩子示例写 `event.result = { ...event.result, metadata: { observed: true } }` ⇒ **result 含 `metadata`**。【文档确认】
- Effect 版 execute 返回 `{ output: {...} }` 或 content（typed output）。【文档确认，见 Effect 插件文档】
- ⚠️ 关于 **`Tool.Result = { output?, content?, metadata? }`** 这一**具体 TS 类型别名**：官方 HTML 文档正文未逐字给出名为 `Tool.Result` 的 interface；证据链为「`{ content }` 结构 + `metadata` 字段 + Effect 的 `output`」。AGENTS.md 的该命名**方向正确但属推断**。**裸字符串（返回 `Hello` 而非 `{ content: "Hello" }`）会失败** —— 文档用结构化返回且 V1→V2 迁移明确对照「V1 返回裸字符串 → V2 返回 `{ content }`」，此点为**文档确认**的语义变化。

---

## 3. 【关键】是否有专门的 WebSearch / WebSearch Provider 扩展接口

### 结论：**有，且推荐用它** 【文档确认】

OpenCode v2 有一个**独立于普通 tool 的 `ctx.websearch` domain**，用于注册「搜索 provider」。这与「注册一个叫 `web_search` 的普通工具」是两条不同路径。

来源：
- 插件 API：https://opencode.ai/v2/docs/build/plugins （Websearch 节）
- 用户配置：https://opencode.ai/v2/docs/websearch/
- HTTP API：`websearch.providers`（GET）、`websearch.query`（POST），schema `WebSearch.Provider` / `WebSearch.Result`（https://opencode.ai/v2/docs/api）

**插件注册自定义搜索 provider：**

```ts
await ctx.websearch.transform((editor) => {
  editor.add({
    id: "internal",
    name: "Internal search",
    execute: async ({ query }, { signal }) => {
      const response = await fetch(`https://search.example.com?q=${encodeURIComponent(query)}`, { signal })
      const result = await response.json()
      return [{ url: result.url, title: result.title, content: result.content, time: {} }]
    },
  })
  editor.default.set("internal")   // 或 editor.default.set(false) 禁用 websearch
})
await ctx.websearch.reload()
```

接口 Reference（【文档确认】）：

```ts
interface WebSearchContext {
  providers(...): Promise<WebsearchProvidersOutput>   // 列出 provider
  query(input, ...): Promise<WebsearchQueryOutput>    // 用选中 provider 跑一次搜索
  transform(cb: (editor: WebSearchEditor) => void): Promise<Registration>
  reload(): Promise<void>
}
interface WebSearchEditor {
  add(provider: WebSearchDefinition): void
  default: { get(): string | false | undefined; set(providerID: string | false): void }
}
```

- `WebSearch.Provider` = `{ id: string, name: string }`；`WebSearch.Result` = `{ url: required, title?, content?, time: { published?: number } required }`。【文档确认，OpenAPI schema】
- `execute` 返回 `WebSearch.Result[]`，接受 `{ query }` 入参和 `{ signal }` 上下文。【文档确认】

**内置 4 个 provider**（https://opencode.ai/v2/docs/websearch/ ）：【文档确认】

| Provider | ID | 环境变量 |
|---|---|---|
| Exa | `exa` | `EXA_API_KEY` |
| Firecrawl | `firecrawl` | `FIRECRAWL_API_KEY` |
| Parallel | `parallel` | `PARALLEL_API_KEY` |
| Tavily | `tavily` | `TAVILY_API_KEY` |

配置选择（跳过选择弹窗）：

```jsonc
{ "$schema": "https://opencode.ai/config.json", "websearch": { "provider": "tavily" } }   // 或 "random"
{ "websearch": false }   // 彻底移除 web search 工具
```

- 权限：web 搜索使用 `websearch` permission action，resource = 搜索 query。【文档确认】
- 429 限流：`random` 模式自动换 provider 重试，冷却共享。【文档确认】

### 对本项目的选型含义 【推断】

- 若目标是「让模型能搜网页」，**优先用官方 `ctx.websearch.transform` 注册 provider**（可自建 `loadbalanced` 逻辑在 `execute` 内做多上游负载均衡），它天然接入 OpenCode 的 provider 选择、限流、权限、`websearch.query` API。
- 若只是「给模型一个多一个普通工具」，注册普通 tool 也可，但**放弃了** OpenCode 的 provider 选择/429 冷却/`websearch` 权限语义，且与内置 web search 工具并存会造成两套搜索入口。
- **推荐：用 `ctx.websearch` domain。** 是否存在名为 `web_search` 的内置普通工具、以及它与 `ctx.websearch` 的关系：文档只说 `websearch: false` 会「remove the web search tool from model requests」，未给出该内置工具的确切 tool 名。**【不确定】**（见第 7 节）。

---

## 4. 插件配置加载方式

### 4.1 官方推荐：`opencode.jsonc` 的 `plugins` 数组 + `ctx.options` 【文档确认】

来源：https://opencode.ai/v2/docs/plugins 、https://opencode.ai/v2/docs/config 、https://opencode.ai/v2/docs/build/plugins （Options 节）

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-acme-plugin",
    { "package": "./plugins/company", "options": { "strict": true, "agent": "reviewer" } }
  ]
}
```

插件内读取：

```ts
export default Plugin.define({
  id: "company",
  setup(ctx) {
    const strict = ctx.options.strict === true   // ← 读 options
  },
})
```

- **配置字段名是 `plugins`（复数，V2）**，条目为 `string | { package, options }`（OpenAPI：`plugins: string | Config.Plugin.EntryEncoded[]`）。【文档确认】
- **没有独立 yaml**。配置就是 JSON/JSONC 的 `opencode.json(c)`。【文档确认】
- 持久化状态（非配置）用 **`ctx.storage`**（get/set/remove/scan，按插件 id 隔离）。【文档确认】
- 环境变量不是插件配置通道（内置 provider 密钥用 env，但插件自身配置走 `options`）。**【推断】**（文档未提供「插件读 env 配置」的专门机制）

### 4.2 配置优先级与发现 【文档确认】（https://opencode.ai/v2/docs/plugins ）

- 多份配置的 `plugins` 数组**从低到高优先级合并**（不整体替换）：
  `~/.config/opencode/opencode.jsonc` → `./opencode.jsonc` → `./.opencode/opencode.jsonc`
- 相对路径相对**包含该条目的配置文件**解析。
- 自动发现：每个 `.opencode/plugins/` 下的 `.ts`/`.js` 文件及插件包目录；全局为 `~/.config/opencode/plugins/`。
- 控制：`plugins: ["*", "-opencode.provider.*", "opencode.provider.openai"]`（`-` 禁用、`*` 全部、`.*` 前缀匹配，后者重新启用）。两个内置插件 `opencode.config.policy`、`opencode.provider.opencode` 忽略移除。

---

## 5. 包格式、安装方式、运行目录、TS/JS 要求

### 5.1 包格式 【文档确认】（https://opencode.ai/v2/docs/build/plugins Publish 节）

```json
{
  "name": "opencode-acme-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts", "./rpc": "./src/rpc.ts" },
  "dependencies": { "@opencode/plugin": "latest" }
}
```

- **`exports` 可直接指向 `.src/index.ts`** ⇒ **TypeScript 直接加载，无需编译**。【文档确认】
- 包插件与本地插件**使用同一套实现 API**（默认导出 `Plugin.define`）。【文档确认】
- `./rpc` 导出可选，用于共享 RPC 契约。

### 5.2 安装 / 加载方式 【文档确认】（https://opencode.ai/v2/docs/plugins ）

- **本地文件**：放 `.opencode/plugins/`（项目级）或 `~/.config/opencode/plugins/`（全局），自动加载。
- **`plugins` 数组**：npm 名（含 `@scope`、`name@version`）、相对/绝对路径、`file://`、对象 `{ package, options }`。
- **CLI**：`opencode plugin add|list|check|update|remove`（安装全局包插件，支持 npm/Git 规格）。
- npm 包插件由 Bun 在启动时安装/缓存；服务启动先加载缓存包，后台补装缺失包，未固定（unpinned）的 npm/Git 插件检查更新。【文档确认】

### 5.3 运行目录 / 进程 【文档确认 + 推断】

- 插件运行在 **OpenCode 后台服务（server）** 进程内，不是 TUI 进程；TUI 扩展需单独的 CLI/TUI 插件入口（`@opencode/plugin/tui`，配置在 `cli.json` 的 `plugins`）。【文档确认】
- 插件日志：V1 文档推荐 `client.app.log()` 替代 `console.log`；V2 迁移示例里 `setup` 用了 `console.log`。**V2 是否把插件 `console.log` 落到 `opencode.log` 文档未明确**。**【不确定】**（AGENTS.md 记载「console.log 不进 opencode.log」属本机观察，非官方文档结论，标注为**本机经验**）

---

## 6. V1 → V2 废弃差异清单

来源：https://opencode.ai/v2/docs/build/plugins/migrate-v1 【全部文档确认】

> ⚠️ 官方警告：**V1 插件实现在 V2 完全不运行**——仅移动文件或改配置条目名不够。

| 维度 | V1 | V2 |
|---|---|---|
| 配置字段 | `plugin: [...]`（数组，可含 `["path", {...}]` 元组） | `plugins: [...]`（数组，选项用 `{ package, options }` 对象） |
| 入口 | 导出插件函数 `export const P: Plugin = async (ctx) => ({ ...hooks })` | `export default Plugin.define({ id, setup(ctx) })` |
| 包名 | `@opencode-ai/plugin` | **`@opencode/plugin`**（Effect: `/effect`，TUI: `/tui`） |
| 上下文路径 | `ctx.directory` / `ctx.project` / `ctx.client` | `ctx.location.directory` / `ctx.location.project` / domain 方法 |
| 配置读取 | 第二参 options | `ctx.options` |
| 清理 | 返回 `dispose()` | `setup` 返回 cleanup 函数 |
| 事件 | 返回 `event` 钩子 | `ctx.event.subscribe()` |
| 工具注册 | `tool: { name: tool({ args(zod), execute }) }`（zod，可返回裸字符串） | `ctx.tool.transform(editor => editor.add({ input(JSON Schema), execute → { content } }))` |
| 全局 config 改写 | `config` 钩子（单一可变全局对象） | **无全局 config 对象**，按 domain `transform`（`ctx.agent/provider/model/command/integration/mcp/reference/skill/tool/vcs/websearch/worktree`） |
| `tool.execute.before/after` | 字符串键 + `(input, output)` 双参 | `ctx.tool.hook("execute.before"/"execute.after", event => …)`（**单一可变 event**） |
| `shell.env` | `output.env` | `ctx.shell.hook("create.before", event => event.env)` |
| `chat.params` / `chat.headers` / `chat.message` | — | `ctx.session.hook("context"/"model.request"/"prompt", …)` |
| `permission.ask` | — | `ctx.permission.hook("evaluate", …)` |
| `experimental.session.compacting` | — | `ctx.session.hook("compaction", …)` |
| `auth` | `auth` 钩子 | `ctx.integration.transform(...)` + integration API |
| `provider` | `provider` 钩子 | `ctx.provider.transform` + `ctx.model.transform` |
| Bun shell `$` | 传入 `ctx.$` | 不再提供，插件自行管理进程 API |
| 双版本 | — | 同一入口可 `export default { ...Plugin.define({ id, setup }), async server() {...} }`（V1 调 `server()`，V2 调 `setup()`，互不转换） |

其他要点：
- V1 object 入口（`server()`）在 **OpenCode `1.18.29+`** 支持；更老的 V1 可能要求函数导出。
- 若非 API 的 V1 功能在 V2 失效，按官方指引当作兼容性 bug 报告。
- `command.execute.before` 无一一对应的全局钩子；部分 experimental 钩子无直接 V2 对应，需重新评估。

---

## 7. 与常规 tool 注册的差异 / 不确定项

### 7.1 `ctx.websearch`（Provider 接口） vs 普通 tool 注册

| 维度 | `ctx.websearch`（Provider） | 普通 `ctx.tool.transform` |
|---|---|---|
| 是否专用扩展点 | **是**，独立 domain | 否，通用工具编辑器 |
| 返回值 | `WebSearch.Result[]`（url/title/content/time） | `{ content: Tool.Content }` 结构化内容 |
| 入参 | `{ query }` + `{ signal }` | 任意 JSON Schema `input` + `{ signal, progress }` |
| 接入能力 | provider 选择/`default`/429 冷却/`websearch` 权限/`websearch.query` API | 模型可见的普通工具，权限走该 tool 的 action |
| 配置开关 | `websearch: { provider }` / `websearch: false` | 工具在 agent 的 tools 列表中开关 |
| 官方推荐场景 | **让模型能搜网页/自建搜索引擎** | 与搜索无关的任意能力 |

**结论**：若本项目目标是「websearch loadbalanced」（多上游负载均衡搜索），**应优先实现 `ctx.websearch` 的 provider**——在 `execute({ query }, { signal })` 内做多上游分发/负载均衡，再 `editor.default.set(<你的 id>)` 设为默认。这样复用 OpenCode 的限流、权限、provider 选择语义，而不是另起一个普通工具。

### 7.2 不确定项（未在官方 v2 文档逐字确认）

1. **`Tool.Result = { output?, content?, metadata? }` 的确切类型别名**：文档确认结构含 `content`（`Tool.Content`）与 `metadata`，Effect 版含 `output`；但名为 `Tool.Result` 的 interface 未在 HTML 文档正文出现。**【推断】**
2. **CJS `module.exports = { id, setup }`**：文档仅给 ESM `export default`；「V2 读默认导出的 `id`/`setup()`」支持该形态，但 CJS 写法本身未逐字出现。**【推断 + 本机验证】**
3. **内置搜索工具的确切 tool 名**：文档说 `websearch: false` 会「remove the web search tool」，但未给出该工具的 `name`（是否叫 `web_search` / `websearch`）。**【不确定】**
4. **插件 `console.log` 是否进 `opencode.log`**：V2 文档未说明插件 stdout 路由。AGENTS.md 的「不进日志」为本机观察。**【不确定/本机经验】**
5. **`ctx.websearch` 与普通 tool 注册是否可互换**：文档未说明二者能否桥接（例如把 provider 包装成 tool）。按现有文档应视为**两条独立路径**。**【推断】**
6. **Effect 版与 Promise 版 ctx 字段的细微差异**（如 `ctx.aisdk`、`ctx.experimental.terminal` 仅 Effect 版列出）：以各自文档为准。**【推断】**

### 7.3 关键来源 URL 清单

- V2 文档总索引：https://opencode.ai/v2/llms.txt
- 插件总览（生命周期/ctx/transform/tools/websearch/hooks/publish）：https://opencode.ai/v2/docs/build/plugins
- 插件加载与配置（plugins 数组/发现/CLI/重载）：https://opencode.ai/v2/docs/plugins
- 配置总览（plugins/websearch 字段）：https://opencode.ai/v2/docs/config
- **Websearch 用户文档（内置 provider/选择/限流/权限/禁用）**：https://opencode.ai/v2/docs/websearch
- **V1→V2 插件迁移**：https://opencode.ai/v2/docs/build/plugins/migrate-v1
- HTTP API（`Tool.Content`、`WebSearch.Provider`、`WebSearch.Result` schema）：https://opencode.ai/v2/docs/api
- Effect 插件入口：https://opencode.ai/v2/docs/build/plugins/effect
- TUI/CLI 插件：https://opencode.ai/v2/docs/build/plugins/cli
- V1（仅迁移参考，不作 V2 依据）：https://opencode.ai/docs/plugins
