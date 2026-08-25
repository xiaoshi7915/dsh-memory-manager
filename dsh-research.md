# dsh-memory-manager — DSH 机制调研结论（dsh-research.md）

调研对象：`C:\Users\50251\deepseek-harness\`（只读）。结论按"问题→答案→证据路径"组织。

## 1. 插件形态与清单
- DSH 插件即 pnpm workspace 内的一个包，位于 `packages/<域>/<插件名>/`，`package.json` 中 `name` 形如 `@deepseek-ai/dsh-<名>`。
- 插件入口 `src/index.ts`，导出三样东西：`export const name`（短名）、`export const inject`（依赖的能力名数组）、`export function apply(ctx: Context, config: Config): void`。
- 配置用 `@deepseek-ai/schemastery` 的 `z` 定义 schema：`export const Config: z<Config> = z.object({...})`，`apply` 第二参即校验后的配置。
- 证据：`packages/interaction/tool-ask-user/src/index.ts`（name/inject/apply 最小示例）；`packages/session/session-title-first-prompt-llm/src/index.ts`（Config schema + apply(ctx, config)）。

## 2. 向 Agent 暴露工具的注册 API
- 从 `@deepseek-ai/dsh-tools` 引入 `defineTool`，在 `apply` 里 `ctx.tools.register(defineTool({...}))`；返回值是 dispose 函数。
- `defineTool` 的字段：`name`、`description`（模型可见）、`parameters`（ParameterSchemaSpec 精简 DSL：`type/required/properties/items/enum/description`）、`output`（`{schema, render(args, value)}`，schema 为 JSON-Schema 风格）、`execute(args, exec)`。
- `exec` 含 `exec.agent`（`@deepseek-ai/dsh-agent` 的 Agent，`exec.agent.session` 即当前 Session）与 `exec.signal`。
- 证据：`packages/interaction/tool-ask-user/src/index.ts`（完整示例，含 parameters/output/execute）；`packages/core/tools/src/schema.ts:482-545`（defineTool 选项）；`packages/core/tools/src/index.ts:324`（`readonly agent?: Agent`）。

## 3. 侧边栏 / Web UI 的 client-plugin 接入
- 侧边栏是 **slot 插槽体系**：`ctx.slots.register({name, ...}, Component)` 与 `ctx.slots.inject('槽位', ...)`。侧边栏外壳（`packages/client/ui-sidebar`）声明这些洞：`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.workspaces`、`sidebar.settings`、`sidebar.footer.action`。
- client 插件放在包的 `src/client/` 目录，用 tsdown 的 `clientBundle` 打包（见 `packages/client/ui-settings/tsdown.config.ts`），宿主加载浏览器端 bundle。
- 证据：`packages/client/ui-sidebar/src/client/index.ts:42-56`（注册 sidebar 槽与洞声明）；`packages/client/ui-sidebar/src/client/contract/slots.ts`（槽契约）；`packages/client/ui-settings/src/client/index.ts:141`（`ctx.slots.inject('sidebar.settings', ...)` 占用示例）。

## 4. 插件配置读取
- 惯例：插件自己的配置经 DSH 配置目录/`apply(ctx, config)` 注入，schema 校验（schemastery）。无"读取 ~/.dsh 下自有 json"的统一约定。
- 本插件需求指定 `~/.dsh/memory/config.json` 为自有配置文件（SPEC §5），因此采用：DSH 配置可选叠加，底层以 `~/.dsh/memory/config.json` 为准（合并默认值）。此点作为"假设 A"记录。

## 5. 会话 ID 如何传入
- 工具内：`exec.agent.session` 即当前 Session 对象（含 `session.id`）。证据：`packages/core/tools/src/index.ts:324-325`；session 服务为 `@deepseek-ai/dsh-session`（`packages/core/session`）。
- 宿主侧：`ctx.on('session/event', (session, event) => ...)`，需 `inject: ['sessions']`；session 有 `id`、`events`（`session.events` 可回放）。证据：`packages/core/tools/src/invariant.ts:76-90`。

## 6. 插件可调用的 LLM API（供摘要）
- 有。注入 `llm` 能力（`inject: ['llm']`），使用 `@deepseek-ai/dsh-llm` 的类型与组装工具（`createUserMessage`、`BlockAssembler`、`GenerateOptions`、`Message`）。
- 参考实现 `packages/session/session-title-llm/src/index.ts`：`inject = ['sessionTitle','llm','sessions']`，发起一次辅助请求，记录 `session/title-llm-request` 事件；可指定 `provider/model` 或用当前主请求路由。
- 结论：memory_summarize 的**生成式摘要**可走 `ctx.llm`；离线环境用本地抽取式摘要兜底。作为"可选增强"实现，默认抽取式（零依赖、离线可用）。

## 7. "Agent 生成回复前"的钩子
- 会话事件流提供 `turn/start`（每轮开始，即回复生成前）、`user/message`（用户消息落库）、`assistant/message`、`turn/end`。事件类型见 `packages/core/session/src/known-event-types.ts:64-66` 与 `types.ts:243-264`。
- 结论：隐式记忆注入的挂点 = `ctx.on('session/event')` 监听 `turn/start`（注入相关记忆到上下文）与 `user/message`（写短期记忆、触发自动总结）。此钩子在会话日志模型上成立，无需依赖特定 agent 循环。

## 8. Web 服务路由
- `ctx.webServer.register({kind:'exact'|'prefix', path, handler})`；`handler(req, res)` 为 Node `IncomingMessage/ServerResponse`，最长前缀匹配（先注册优先，前缀路由按长度）。证据：`packages/host/webserver/src/index.ts:25-28,94`；`packages/host/webserver/tests/webserver.spec.ts:108-109`。

## 9. 其他技术事实
- Node 运行版本 v24.19.0，内置 `node:sqlite`（`DatabaseSync`）可用，无需原生依赖。证据：本机 `node -v` 与 `require('node:sqlite')` 冒烟通过。
- 工具执行时存在 `tools/result`、`tools/dispatch` 等事件与 scope 分发（`exec.agent` 为路由键）。证据：`packages/core/tools/src/index.ts:1666`。

## 假设清单
- A：配置以 `~/.dsh/memory/config.json` 为权威，DSH 配置仅作可选叠加。
- B：嵌入模型本地不可用（无网络/未安装）时使用确定性哈希 n-gram 嵌入（`embedding_status: 'degraded'`），保证离线可检索、可满足验收 2。
- C：SQLite 采用 Node 内置 `node:sqlite`；向量索引为自定 JSON 格式 `vector.index`（纯 JS 暴力余弦，2000 条 <300ms 可达）。
- D：摘要默认本地抽取式；`ctx.llm` 生成式为可选增强，探测可用才启用。
