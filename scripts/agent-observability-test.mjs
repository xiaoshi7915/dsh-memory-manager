/**
 * P4 Agent 可观测聚焦测试：
 *  A) mm_search 结果带 source:'memory-manager' 与 layer（long_term/summary）。
 *  B) mm_stats 带 layered_present（默认 false；引擎设 true 后上报 true）。
 *  C) buildInjection 死代码已移除（plugin.mjs 不再导出）。
 *  D) TOOL_DEFS schema 声明了 source/layer/layered_present。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-p4-'))
process.env.DSH_MEMORY_DIR = base

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

// ---- A) search 结果带 source/layer ----
const { MemoryEngine } = await import('../src/core/index.mjs')
const engine = await MemoryEngine.create({ config: { long_term: { embedding_model: 'hash' }, storage: { encryption_enabled: false } } })
await engine.addMemory({ content: 'P4 测试记忆：加密守卫与分层视图', sessionId: 'p4', tags: ['test'], importance: 5 })
await engine.addMemory({ content: 'P4 摘要记忆：本条由自动摘要生成', sessionId: 'p4', source: 'summary', importance: 6 })
// 降级模式（hash）阈值强制下限 0.38：分别搜两类记忆的高相关词，各验证其 layer 归属
const rn = await engine.search('测试记忆', { sessionId: 'p4', topK: 5, threshold: 0, includeGlobal: true })
const rs = await engine.search('自动摘要生成', { sessionId: 'p4', topK: 5, threshold: 0, includeGlobal: true })
check('A1 两类检索均非空', rn.results.length > 0 && rs.results.length > 0, `normal=${rn.results.length} summary=${rs.results.length}`)
const normal = rn.results.find((x) => x.layer === 'long_term')
const summary = rs.results.find((x) => x.layer === 'summary')
check('A2 普通检索命中 layer=long_term', Boolean(normal), JSON.stringify(rn.results.map((x) => x.layer)))
check('A3 普通命中 source=memory-manager', normal && normal.source === 'memory-manager', normal?.source)
check('A4 摘要检索命中 layer=summary', Boolean(summary), JSON.stringify(rs.results.map((x) => x.layer)))

// ---- B) stats 带 layered_present ----
let st = await engine.stats()
check('B1 stats.layered_present 默认 false', st.layered_present === false, String(st.layered_present))
engine.layered_present = true
st = await engine.stats()
check('B2 engine.layered_present=true 后 stats 上报 true', st.layered_present === true, String(st.layered_present))

// ---- C) buildInjection 已移除 ----
const pluginSrc = readFileSync(new URL('../src/dsh/plugin.mjs', import.meta.url), 'utf8')
check('C1 buildInjection 导出定义已删除', !/export function buildInjection/.test(pluginSrc), '导出仍在')
// 但决策注释保留
check('C2 注入决策注释保留', pluginSrc.includes('记忆仅显式工具召回'), '')

// ---- D) TOOL_DEFS schema 声明新字段 ----
const schemaSrc = readFileSync(new URL('../src/dsh/plugin.mjs', import.meta.url), 'utf8')
check('D1 mm_search 结果 schema 含 source', /source: str\('来源/.test(schemaSrc))
check('D2 mm_search 结果 schema 含 layer', /layer: str\('层级/.test(schemaSrc))
check('D3 mm_stats schema 含 layered_present', /layered_present: bool\('/.test(schemaSrc))

await engine.close()
const passed = results.filter((r) => r.ok).length
console.log(`\n═══ P4 Agent 可观测聚焦测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
