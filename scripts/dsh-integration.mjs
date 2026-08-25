/**
 * DSH ctx.tools 集成验证（在 DSH workspace 内装载插件）。
 *
 * 用真实 Cordis Context + 真实 @deepseek-ai/dsh-tools ToolRuntime 装载
 * dsh-memory-manager 插件，验证：
 *   A) 7 个工具经真实 ctx.tools.register 注册（ctx.tools.get / schemas()）
 *   B) 通过真实 ctx.tools.execute 全链路执行 memory_add / memory_search /
 *      memory_get_recent / memory_summarize（LLM 生成式优先 + 抽取式回退）/
 *      memory_delete / memory_update_importance / memory_stats
 *   C) webServer 路由注册 + 会话事件钩子（短期记忆自动写入）
 *
 * 依赖解析：本项目 node_modules/@deepseek-ai/{cordis,dsh-tools,dsh-llm}
 * 为指向 DSH checkout 真实包目录的 junction（安装方式见 README）。
 *
 * 运行：node scripts/dsh-integration.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

process.env.DSH_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'dsh-mem-verify-'))

const TOOL_NAMES = [
  'mm_add', 'mm_search', 'mm_get_recent',
  'mm_summarize', 'mm_delete', 'mm_update_importance', 'mm_stats',
]
// P1 共存：compat.bareSearch=true 时额外 best-effort 注册旧名 memory_* 别名
const LEGACY_TOOL_NAMES = [
  'memory_add', 'memory_search', 'memory_get_recent',
  'memory_summarize', 'memory_delete', 'memory_update_importance', 'memory_stats',
]

// ---------- 桩服务（非验证目标的服务缝） ----------
class SystemPromptStub extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt') }
  tools() {}
  section() {}
}
class WebServerStub extends Service {
  constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
  register(route) { this.routes.push(route); return () => {} }
}
class SessionsStub extends Service {
  constructor(ctx) { super(ctx, 'sessions') }
}
// 假 LLM：验证真实 LLM 生成式摘要代码路径（makeLlmSummarize → ctx.get('llm') → llm.stream + BlockAssembler）
class FakeLlm extends Service {
  constructor(ctx) { super(ctx, 'llm') }
  listProviders() { return [{ name: 'fake-provider', model: 'fake-model' }] }
  async listModels() { return [{ id: 'fake-model' }] }
  async *stream() {
    const text = '用户偏好使用 Python 做数据分析，工具链为 pandas 与 matplotlib。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: text.slice(0, 6) }
    yield { type: 'text-delta', index: 0, text: text.slice(6) }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: 'stop' }
  }
}

const ctx = new Context()
await ctx.plugin(SystemPromptStub)
await ctx.plugin(WebServerStub)
await ctx.plugin(SessionsStub)
await ctx.plugin(FakeLlm)
await ctx.plugin(ToolRuntime)

const plugin = await import('../src/dsh/plugin.mjs')
// bareSearch=true：验证旧名别名注册路径（DSH 场景 layered 缺席时老提示词仍可用）
await ctx.plugin(plugin, { compat: { bareSearch: true } })

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); if (!cond) console.error(`  ✗ ${name} ${detail}`) }
const sig = (ms) => AbortSignal.timeout(ms)

// ---------- A) 注册 ----------
for (const n of TOOL_NAMES) {
  const def = ctx.tools.get(n)
  check(`register ${n}`, !!def, `def=${JSON.stringify(def ? { name: def.name } : null)}`)
}
const schemaNames = ctx.tools.schemas().map((s) => s.name)
check('schemas 覆盖 7 工具(mm_*)', TOOL_NAMES.every((n) => schemaNames.includes(n)), `schemas=${JSON.stringify(schemaNames)}`)
// P1 别名：bareSearch=true → 旧名也注册
for (const n of LEGACY_TOOL_NAMES) {
  const def = ctx.tools.get(n)
  check(`bare 别名 register ${n}`, !!def, `def=${JSON.stringify(def ? { name: def.name } : null)}`)
}

// ---------- B) 全链路执行 ----------
const addRes = await ctx.tools.execute({
  callId: 'v-add-1', name: 'mm_add', signal: sig(10000),
  arguments: { content: '我喜欢用 Python 做数据分析，常用 pandas 和 matplotlib。', tags: ['偏好', '技术'], importance: 7, session_id: 'sess-A' },
})
check('execute mm_add 成功', addRes.isError === false, JSON.stringify(addRes).slice(0, 200))
check('mm_add value 有 memory_id', !addRes.isError && !!addRes.value?.memory_id)
check('mm_add 渲染含中文', !addRes.isError && addRes.content.some((b) => b.type === 'text' && b.text.includes('已保存记忆')))
const addVal = addRes.value

await new Promise((r) => setTimeout(r, 30))
const searchRes = await ctx.tools.execute({
  callId: 'v-search-1', name: 'mm_search', signal: sig(10000),
  arguments: { query: '我平时用什么语言做数据分析', session_id: 'sess-A' },
})
check('execute mm_search 成功', searchRes.isError === false, JSON.stringify(searchRes).slice(0, 200))
const hit = searchRes.isError ? null : searchRes.value?.results?.find((r) => r.id === addVal.memory_id)
check('mm_search 召回新增记忆', !!hit && hit.score > 0.4, `hit=${JSON.stringify(hit)}`)

// bare 别名执行：memory_search 与 mm_search 等效
const searchBare = await ctx.tools.execute({
  callId: 'v-search-bare', name: 'memory_search', signal: sig(10000),
  arguments: { query: '我平时用什么语言做数据分析', session_id: 'sess-A' },
})
check('bare 别名 memory_search 可执行', searchBare.isError === false && !!searchBare.value?.results?.some((r) => r.id === addVal.memory_id),
  JSON.stringify(searchBare).slice(0, 160))

// 会话事件钩子：user/assistant 消息写入短期记忆（parallel 等待监听器完成）
// 真实 DSH 事件形状：user/message 的 data 为 UserMessage（content 为 ContentBlock[]），
// assistant/message 的 data = { turn, step, message: AssistantMessage, ... }（正文在 message.content）。
await ctx.parallel('session/event', { id: 'sess-A' }, {
  type: 'user/message',
  data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '帮我看看这个数据集的缺失值怎么处理' }], source: { kind: 'plugin', plugin: 'test' } },
})
await ctx.parallel('session/event', { id: 'sess-A' }, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '可以用 dropna 或 fillna 处理缺失值' }], source: { kind: 'model' } } },
})
const recentRes = await ctx.tools.execute({
  callId: 'v-recent-1', name: 'mm_get_recent', signal: sig(10000),
  arguments: { session_id: 'sess-A' },
})
check('execute mm_get_recent 成功', recentRes.isError === false, JSON.stringify(recentRes).slice(0, 200))
check('会话事件钩子写入短期记忆', !recentRes.isError && recentRes.value?.messages?.some((m) => m.content.includes('缺失值')))

// 摘要：FakeLlm 生效 → 生成式摘要
const sumRes = await ctx.tools.execute({
  callId: 'v-sum-1', name: 'mm_summarize', signal: sig(10000),
  arguments: { session_id: 'sess-A' },
})
check('execute mm_summarize 成功', sumRes.isError === false, JSON.stringify(sumRes).slice(0, 200))
check('mm_summarize 经 LLM 生成', !sumRes.isError && !!sumRes.value?.memory_id && sumRes.value.summary.includes('Python'),
  `summary=${JSON.stringify(sumRes.isError ? null : sumRes.value?.summary)}`)

// 删除守卫：空目标（无 ids/conditions）必须被拦截，防止静默清空会话/全库
const delEmpty = await ctx.tools.execute({
  callId: 'v-del-0', name: 'mm_delete', signal: sig(10000),
  arguments: { session_id: 'sess-A' },
})
check('mm_delete 空目标被守卫拦截', delEmpty.isError === true, JSON.stringify(delEmpty).slice(0, 200))

// 按显式 ids 删除（修正语义：必须给出删除目标）
const delIds = [addVal.memory_id, sumRes.value?.memory_id].filter(Boolean)
const delRes = await ctx.tools.execute({
  callId: 'v-del-1', name: 'mm_delete', signal: sig(10000),
  arguments: { ids: delIds, session_id: 'sess-A' },
})
check('execute mm_delete 成功', delRes.isError === false, JSON.stringify(delRes).slice(0, 200))
check('mm_delete 清理指定记忆', !delRes.isError && delRes.value?.deleted_count >= 2, `deleted=${JSON.stringify(delRes.value)}`)

const statsRes = await ctx.tools.execute({
  callId: 'v-stats-1', name: 'mm_stats', signal: sig(10000),
  arguments: {},
})
check('execute mm_stats 成功', statsRes.isError === false, JSON.stringify(statsRes).slice(0, 200))
check('mm_stats 字段完整', !statsRes.isError && 'embedding_status' in statsRes.value && 'storage_size_mb' in statsRes.value)

const add2 = await ctx.tools.execute({
  callId: 'v-add-2', name: 'mm_add', signal: sig(10000),
  arguments: { content: '季度目标：Q3 完成模型性能调优', importance: 5, session_id: 'sess-A' },
})
const impRes = await ctx.tools.execute({
  callId: 'v-imp-1', name: 'mm_update_importance', signal: sig(10000),
  arguments: { memory_id: add2.value.memory_id, score: 9 },
})
check('execute mm_update_importance 成功', impRes.isError === false, JSON.stringify(impRes).slice(0, 200))
check('mm_update_importance 更新生效', !impRes.isError && impRes.value?.new_score === 9 && impRes.value?.old_score === 5)

// ---------- C) 路由 ----------
check('webServer 注册 /api/memory 前缀路由', Array.isArray(ctx.webServer.routes) && ctx.webServer.routes.some((r) => r.kind === 'prefix' && r.path === '/api/memory'))
check('webServer 注册 /memory-manager GUI 托管路由', Array.isArray(ctx.webServer.routes) && ctx.webServer.routes.some((r) => r.kind === 'prefix' && r.path === '/memory-manager'))

// 注：Cordis Context 无公开 dispose/stop；脚本结束由进程回收。

const passed = results.filter((r) => r.ok).length
const total = results.length
console.log(`\n═══ DSH ctx.tools 集成验证：${passed}/${total} 通过 ═══`)
if (passed === total) {
  console.log('插件已通过真实 Cordis + ToolRuntime 装载：7 工具注册、真实 execute 全链路、路由与事件钩子全部正常。')
} else {
  console.error(`仍有 ${total - passed} 项失败。`)
}

// 落盘报告
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const lines = [
  '# dsh-memory-manager · DSH ctx.tools 集成验证报告',
  '',
  `- 生成时间：${new Date().toISOString()}`,
  `- 数据目录：\`${process.env.DSH_MEMORY_DIR}\``,
  `- 结论：**${passed}/${total} 项通过**`,
  '',
  '| 检查项 | 结果 | 说明 |',
  '|--------|------|------|',
  ...results.map((r) => `| ${r.name} | ${r.ok ? '✅' : '❌'} | ${r.detail.slice(0, 140)} |`),
  '',
  '> 验证方式：真实 Cordis Context + 真实 @deepseek-ai/dsh-tools ToolRuntime 装载插件；桩仅用于非目标服务缝（systemPrompt/webServer/sessions/llm）。',
]
writeFileSync(join(__dirname, 'integration-report.md'), lines.join('\n'), 'utf8')
console.log('集成报告已生成：scripts/integration-report.md')
