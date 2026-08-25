// 启动激活探针：用 PROFILE 的包版本（经 junction）装载插件，模拟真实 boot 的 apply()。
// 关键：若 apply() 抛错，真实 web 启动会挂（assertEntriesActivated 拒绝）。此探针在重启前抓出这类错误。
// 同时注册 layered 桩（memory_search 裸名）验证 mm_* 共存无冲突。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'

const PLUGIN_PATH = 'C:/Users/50251/.dsh/profiles/web/node_modules/dsh-memory-manager/src/dsh/plugin.mjs'
process.env.DSH_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'dsh-mem-activate-'))

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
  }
}

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

const ctx = new Context()
await ctx.plugin(SystemPromptStub)
await ctx.plugin(WebServerStub)
await ctx.plugin(SessionsStub)
await ctx.plugin(ToolRuntime)
await ctx.plugin(FakeLlm)

// 模拟真实 layered：注册裸名 memory_search（我们的插件默认 bareSearch=false，不该冲突）
await ctx.plugin({
  name: 'dsh-layered-memory',
  inject: ['tools'],
  apply(fctx) {
    fctx.tools.register(defineTool({
      name: 'memory_search', description: 'layered 桩',
      parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => '' },
    }))
  },
})

// 经 profile junction 装载真实插件
const plugin = await import(pathToFileURL(PLUGIN_PATH).href)
const ev = plugin.resolveEventMode(ctx, {})
check('P2 探测到 layered（内存桩）', ev.layered === true && ev.captureEnabled === false && ev.summarizeEnabled === false, JSON.stringify(ev))

let applyError = null
try {
  await ctx.plugin(plugin, {})
} catch (e) {
  applyError = e
}
check('apply() 无抛错（真实 boot 前提）', applyError === null, applyError?.message ?? '')

const names = ctx.tools.schemas().map((s) => s.name)
check('mm_* 工具已注册', names.includes('mm_add') && names.includes('mm_search') && names.includes('mm_summarize'), names.join(','))
check('7 个 mm_* 工具全部注册', ['mm_add', 'mm_search', 'mm_get_recent', 'mm_summarize', 'mm_delete', 'mm_update_importance', 'mm_stats'].every((n) => names.includes(n)), names.join(','))
// 注：memory_search 在此探针中由 layered 桩注册（故意模拟真实 layered）；我们的插件未注册任何裸 memory_*
// 名（兼容别名仅 bareSearch=true 时注册），真正的共存证明是上面 apply() 在 memory_search 已被占用时不抛重名错误。
check('webServer 路由注册 /api/memory + /memory-manager',
  Array.isArray(ctx.webServer.routes) && ctx.webServer.routes.some((r) => r.kind === 'prefix' && r.path === '/api/memory')
  && ctx.webServer.routes.some((r) => r.kind === 'prefix' && r.path === '/memory-manager'), JSON.stringify(ctx.webServer.routes))

// 事件让位行为：layered 在场 → 不写短期
await ctx.parallel('session/event', { id: 'sess-X' }, {
  type: 'user/message',
  data: { id: 'xu1', role: 'user', content: [{ type: 'text', text: '共存时不应捕获' }], source: { kind: 'plugin', plugin: 'test' } },
})
const recent = await ctx.tools.execute({ callId: 'v-recent', name: 'mm_get_recent', signal: AbortSignal.timeout(10000), arguments: { session_id: 'sess-X' } })
check('让位生效：事件未写短期', !recent.isError && (recent.value?.messages?.length ?? 0) === 0, JSON.stringify(recent.value?.messages))

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ profile 路径启动激活探针：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
