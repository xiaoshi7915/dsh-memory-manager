// P3 GUI 分层视图纯逻辑验证：从 app.js 抽取「分层记忆视图」区块，用 stub 依赖 eval，
// 直接调用渲染/卡片函数断言输出结构正确 + 无运行时引用错误。
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../gui/js/app.js', import.meta.url), 'utf8')

// 抽取分层区块（start/end 标记之间）
const startMark = '/* ---------------- 分层记忆视图（P3'
const endMark = '/* ---------------- 导入导出模态'
const si = src.indexOf(startMark)
const ei = src.indexOf(endMark)
if (si === -1 || ei === -1 || ei <= si) {
  console.log('✗ 找不到分层区块标记')
  process.exit(1)
}
const layeredSrc = src.slice(si, ei)

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

// ---- 依赖 stub ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (ts) => { if (!ts) return '-'; const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }
const spinner = () => '<div class="spinner"></div>'
const emptyBox = (t, s) => `<div class="empty">${t} ${s}</div>`
const renderPager = () => {}
function mkEl() { return { innerHTML: '', textContent: '', hidden: false, value: '', dataset: {}, style: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){return false} }, addEventListener(){}, setAttribute(){}, querySelector(){return null}, querySelectorAll(){return []}, onchange:null, onclick:null } }
const registry = new Map()
const el = (id) => { if (!registry.has(id)) registry.set(id, mkEl()); return registry.get(id) }
const $ = (s) => (s.startsWith('#') ? el(s.slice(1)) : null)
const $$ = (s) => []
const api = {
  layeredStats: async () => ({ present: true, l1: { total: 22, types: { work_fact: 5 } }, scenes: { chat: 0, work: 2 }, persona: { chat_chars: 100, work_chars: 200 }, l0: { total: 466, bySession: [{ id: 'sess-abc', count: 313 }] }, modes: { default: 'auto' }, dataDir: 'x' }),
  layeredL1: async () => ({ items: [{ id: 'm1', content: '<b>x</b>', type: 'work_fact', family: 'work', priority: 80, scene_name: 'S', version: 2, updated_at: '2026-08-25T07:47:36.140Z', session_id: 's1', timestamp: 1787636000000 }], total: 1 }),
  layeredScenes: async () => ({ items: [{ path: 'work/a.md', family: 'work', name: 'a', summary: '概要', heat: 3, updated: '2026-08-25T07:47:36.140Z', content: '正文' }], total: 1 }),
  layeredPersona: async () => ({ family: 'chat', content: '我是画像' }),
  layeredSessions: async () => ({ items: [{ id: 's1', count: 10, mode: 'auto' }], total: 1 }),
  layeredL0: async () => ({ items: [{ id: 'x1', session_id: 's1', role: 'user', content: 'hi & bye', recorded_at: '2026-08-25T05:46:35.715Z', timestamp: 0 }], total: 1 }),
}

// 全局 state（分层渲染依赖）
const state = {
  lvl: {
    seq: 0,
    l1: { page: 0, pageSize: 20, total: 0, type: '', family: '', scene: '' },
    l0: { page: 0, pageSize: 20, total: 0, session: '' },
    scenes: { family: '' },
    sceneOpen: null,
    l3Fam: 'chat',
  },
}

// eval 分层区块（把 stub 注入作用域）
const factory = new Function('esc', 'fmtTime', 'spinner', 'emptyBox', 'renderPager', '$', '$$', 'api', 'state', `${layeredSrc}\n;return { L1_TYPE_LABELS, l1TypeLabel, famLabel, lvlRenderer, l1Card, sceneCard, convLine, renderL1View, renderL2View, renderL3View, renderL0View, loadLayeredOverview }`)
let L
try {
  L = factory(esc, fmtTime, spinner, emptyBox, renderPager, $, $$, api, state)
  console.log('✅ 分层区块加载无引用错误')
} catch (e) {
  console.log(`✗ 分层区块加载失败：${e.message}`)
  console.log(e.stack?.split('\n').slice(0, 3).join('\n'))
  process.exit(1)
}

// ---- L1 类型标签 ----
check('L1_TYPE_LABELS 7 类', Object.keys(L.L1_TYPE_LABELS).length === 7)
check('l1TypeLabel(work_fact)=工作事实', L.l1TypeLabel('work_fact') === '工作事实')
check('famLabel(work)=工作', L.famLabel('work') === '工作')

// ---- l1Card ----
const l1 = L.l1Card({ id: 'mem_1', content: 'hello <b>world</b>', type: 'work_fact', family: 'work', priority: 80, scene_name: '场景A', version: 2, updated_at: '2026-08-25T07:47:36.140Z', session_id: 's1' })
check('l1Card 转义内容', l1.includes('hello &lt;b&gt;world&lt;/b&gt;'))
check('l1Card 类型/族标签', l1.includes('工作事实') && l1.includes('工作'))
check('l1Card 场景/优先级/版本', l1.includes('场景A') && l1.includes('重要度 80') && l1.includes('v2'))

// ---- sceneCard 折叠 ----
const sc = L.sceneCard({ path: 'work/a.md', summary: '概要', heat: 3, updated: '2026-08-25T07:47:36.140Z', content: '正文' })
check('sceneCard summary/heat', sc.includes('概要') && sc.includes('🔥 3'))
check('sceneCard 折叠 body hidden', sc.includes('hidden'))

// ---- convLine ----
const cl = L.convLine({ role: 'user', recorded_at: '2026-08-25T05:46:35.715Z', content: 'hi & bye' })
check('convLine 用户中文+转义+类', cl.includes('用户') && cl.includes('hi &amp; bye') && cl.includes('conv-line u'))
check('convLine assistant 中文', L.convLine({ role: 'assistant', recorded_at: '', content: 'ok' }).includes('助手'))

// ---- lvlRenderer 竞态 ----
{
  const a = L.lvlRenderer()
  const b = L.lvlRenderer()
  check('竞态：旧 seq 丢弃', a.render('A') === null && b.render('B') === 'B')
}

// ---- 概览渲染（真实 api stub） ----
{
  const box = el('layered-overview')
  await L.loadLayeredOverview()
  check('loadLayeredOverview 填卡', box.innerHTML.includes('分层记忆（dsh-layered-memory）') && box.innerHTML.includes('L1 原子记忆') && box.innerHTML.includes('默认记忆模式'))
}

// ---- L1 视图渲染 ----
{
  await L.renderL1View()
  const listBox = el('l1-list')
  check('renderL1View 填列表', listBox.innerHTML.includes('mem-list') && listBox.innerHTML.includes('工作事实'))
}

// ---- L3 渲染 ----
{
  await L.renderL3View()
  const l3 = el('lvl-l3')
  check('renderL3View 填画像 pre', l3.innerHTML.includes('persona-md') && l3.innerHTML.includes('我是画像'))
}

// ---- L0 渲染 ----
{
  await L.renderL0View()
  const listBox = el('l0-list')
  check('renderL0View 填对话', listBox.innerHTML.includes('conv-list') && listBox.innerHTML.includes('hi &amp; bye'))
}

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ P3 GUI 分层纯逻辑验证：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
