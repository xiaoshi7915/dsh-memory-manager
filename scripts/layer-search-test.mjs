// 全层语义检索聚焦测试（scope='all' 并入 L0/L2/L3/日志；默认/scope=memory 仅长时记忆）。
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEngine } from '../src/core/index.mjs'
import { searchLayers } from '../src/core/search.mjs'

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-layer-search-'))
const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

const { persistL0, sceneFileContent } = await import('../src/core/distill.mjs')
const fsp = await import('node:fs/promises')

const e = await MemoryEngine.create({ baseDir: base, config: { storage: { encryption_enabled: false }, long_term: { embedding_model: 'local', similarity_threshold: 0.05 } } })

// 种子：L1 长时记忆 + L0 对话 + L2 场景 + L3 画像 + 日志
await e.addMemory({ sessionId: 'default', content: '我的长期记忆：偏好使用 Python 做数据分析', importance: 6 })
await persistL0(e, 'default', [
  { role: 'user', content: '对话中提到了量子计算的进展' },
  { role: 'assistant', content: '量子计算目前仍处于早期阶段' },
])
await fsp.mkdir(join(base, 'scenes', 'chat'), { recursive: true })
await fsp.writeFile(join(base, 'scenes', 'chat', 'quantum.md'), sceneFileContent({ summary: '量子计算场景', body: '用户对量子计算的兴趣与学习路径' }), 'utf8')
await fsp.writeFile(join(base, 'persona-chat.md'), '## 用户画像\n用户关注量子计算、Python 与机器学习', 'utf8')
e.log?.info('本插件日志：今日完成量子计算文档整理')

// ---- searchLayers 直接断言 ----
{
  const ls = searchLayers(e, '量子计算')
  check('searchLayers 命中 L0 对话', ls.some((r) => r.layer === 'l0' && r.content.includes('量子计算')), JSON.stringify(ls.map((x) => x.layer)))
  check('searchLayers 命中 L2 场景', ls.some((r) => r.layer === 'l2'), JSON.stringify(ls.map((x) => x.layer)))
  check('searchLayers 命中 L3 画像', ls.some((r) => r.layer === 'l3'), JSON.stringify(ls.map((x) => x.layer)))
  check('searchLayers 命中日志', ls.some((r) => r.layer === 'log'), JSON.stringify(ls.map((x) => x.layer)))
  check('searchLayers 每层封顶 3 条', Object.values(ls.reduce((m, r) => ((m[r.layer] = (m[r.layer] || 0) + 1), m), {})).every((n) => n <= 3))
}

// ---- engine.search scope='all' 并入层结果 ----
{
  const all = await e.search('量子计算', { scope: 'all', topK: 10, threshold: 0.05 })
  check('scope=all 返回层结果', all.results.some((r) => r.isLayer === true && r.layer === 'l2'), JSON.stringify(all.results.map((r) => r.layer)))
  check('scope=all 含 P4 source/layer 可观测', all.results.every((r) => r.source && r.layer), JSON.stringify(all.results.map((r) => `${r.source}/${r.layer}`)))
  // 层数据专属词（L1 无命中）→ 仍返回层结果（嵌入/向量缺失不阻断层检索）
  check('scope=all 仅层命中也返回', all.results.length >= 1 && all.results.every((r) => r.isLayer), JSON.stringify(all.results.map((r) => r.layer)))
  // L1 命中：查询与长时记忆内容匹配的词
  const l1 = await e.search('数据分析', { scope: 'all', topK: 10, threshold: 0.05 })
  check('scope=all 返回 L1 长时记忆', l1.results.some((r) => r.isLayer !== true && r.source === 'memory-manager'), JSON.stringify(l1.results.map((r) => r.layer)))
  // 默认 scope（memory）→ 仅长时记忆
  const mem = await e.search('量子计算', { topK: 10, threshold: 0.05 })
  check('默认 scope 不含层结果', !mem.results.some((r) => r.isLayer), JSON.stringify(mem.results.map((r) => r.layer)))
}

await e.close()

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ 全层语义检索聚焦测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
