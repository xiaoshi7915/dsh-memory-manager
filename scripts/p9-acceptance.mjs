// P9 独立安装全功能验收（only-manager 场景）：在临时数据目录上走 REST 全链路。
// 验证：分层浏览（self 降级 L0-L3）+ 档位 + 日志 + 模型下载端点 + 语义检索 + 导入导出 + 蒸馏。
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-p9acc-'))
process.env.DSH_MEMORY_DIR = base
process.env.DSH_LAYERED_DIR = join(tmpdir(), 'dsh-no-layered-' + Date.now()) // 确保 layered 缺席
const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

const { MemoryEngine } = await import('../src/core/index.mjs')
const { attachRoutes } = await import('../src/server/routes.mjs')
const e = await MemoryEngine.create({ baseDir: base })
const handler = attachRoutes(() => e)

const call = (method, path, body) => new Promise((resolve) => {
  const req = new Readable({ read() {} })
  req.method = method; req.url = path
  req.headers = { host: '127.0.0.1:4703', 'content-type': 'application/json' }
  if (body) req.push(JSON.stringify(body))
  req.push(null)
  const res = { writeHead: (s, h) => { res.status = s }, end: (b) => resolve({ status: res.status, body: b ? JSON.parse(b.toString()) : null }) }
  handler(req, res).catch((err) => resolve({ status: 500, body: { error: { message: String(err) } } }))
})

// ---- 1. 基础 + 档位 + 日志端点存在 ----
const health = await call('GET', '/api/memory/healthz')
check('1 healthz 200', health.status === 200)

// ---- 2. 添加记忆（engine 侧；Agent 工具 mm_add 走同一路径）→ REST 语义检索 ----
await e.addMemory({ sessionId: 's1', content: '用户喜欢用 Python 做数据分析' })
await e.addMemory({ sessionId: 's1', content: '团队约定用 pnpm 管理依赖', tags: ['工作'] })
const sr = await call('POST', '/api/memory/search', { query: '数据分析用什么语言', top_k: 3, session_id: 's1' })
check('2 语义检索命中 Python 记忆', (sr.body?.results || []).some((x) => x.content.includes('Python')), JSON.stringify(sr.body?.results?.[0]))

// ---- 3. 蒸馏（LLM mock 经 engine 注入）→ L0-L3 自持 ----
const llmMock = async () => JSON.stringify([
  { content: '用户喜欢用 Python 做数据分析', type: 'persona', priority: 80 },
  { content: '团队约定用 pnpm 管理依赖', type: 'work_fact', priority: 75 },
])
const dist = await e.distill('s1', { llm: llmMock, family: 'chat', turns: [
  { role: 'user', content: '我喜欢用 Python 做数据分析' },
  { role: 'assistant', content: '好的，已记录' },
] })
check('3 蒸馏 L1 抽取 2', dist.l1.extracted === 2, `l1=${dist.l1.extracted}`)
check('3 蒸馏 L0 持久化 2', dist.l0.appended === 2)
check('3 蒸馏 L3 画像写入', dist.l3.written === true)

// ---- 4. 分层浏览（self 降级）----
const st = await call('GET', '/api/memory/layered/stats')
check('4 stats.source=self（only-manager）', st.body?.source === 'self', JSON.stringify(st.body?.source))
check('4 stats.present=true', st.body?.present === true)
const l1 = await call('GET', '/api/memory/layered/l1?limit=20')
check('4 L1 自持含 2 蒸馏', l1.body?.total === 2, `total=${l1.body?.total}`)
const l0 = await call('GET', '/api/memory/layered/l0?session=s1')
check('4 L0 自持含 2 对话', l0.body?.total === 2, `total=${l0.body?.total}`)
const scenes = await call('GET', '/api/memory/layered/scenes')
check('4 L2 自持场景', scenes.body?.items?.length >= 1)
const persona = await call('GET', '/api/memory/layered/persona?family=chat')
check('4 L3 自持画像', persona.status === 200 && (persona.body?.content || '').includes('Python'), String(persona.body?.content || '').slice(0, 40))

// ---- 5. 档位（P6）----
const mset = await call('PUT', '/api/memory/mode', { session: 's1', mode: 'work' })
check('5 档位设置 work', mset.body?.mode === 'work', JSON.stringify(mset.body))
const mget = await call('GET', '/api/memory/mode?session=s1')
check('5 档位读取 work', mget.body?.mode === 'work')

// ---- 6. 模型下载端点（P7，白名单 + 状态；不真下载）----
const models = await call('GET', '/api/memory/models')
check('6 模型白名单 3 款', (models.body?.models || []).length === 3, `n=${models.body?.models?.length}`)
const msw = await call('POST', '/api/memory/models/switch', { source: 'off' })
check('6 切换嵌入源 off', msw.body?.kind === 'off', JSON.stringify(msw.body))

// ---- 7. 导入导出（P1/P3 兼容）----
const exp = await call('GET', '/api/memory/export?format=json')
check('7 导出 JSON 200', exp.status === 200 && exp.body?.memories?.length >= 2, JSON.stringify(exp.body?.memories?.length))
const imp = await call('POST', '/api/memory/import', { text: JSON.stringify({ version: 2, memories: [{ content: '导入的测试记忆', importance: 5, source: 'manual', tags: [] }] }), mode: 'merge' })
check('7 导入成功', imp.body?.ok === true || imp.status === 200, JSON.stringify(imp.body))

// ---- 8. 日志端点（P5）----
const logs = await call('GET', '/api/memory/logs?limit=5')
check('8 日志端点 200', logs.status === 200 && Array.isArray(logs.body?.items), JSON.stringify(logs.status))

// ---- 9. 短期上下文（P1；捕获由插件事件驱动，REST 侧只读 recent）----
await e.shortTerm.append('s1', 'user', '临时消息', { maxLines: 50 })
const recent = await call('GET', '/api/memory/recent?session=s1&n=20')
check('9 短期上下文含临时消息', (recent.body?.messages || []).some((x) => x.content === '临时消息'), JSON.stringify(recent.body?.messages?.slice(-2)))

await e.close()
console.log(`\n═══ P9 独立安装全功能验收：${results.filter((r) => r.ok).length}/${results.length} 通过 ═══`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
