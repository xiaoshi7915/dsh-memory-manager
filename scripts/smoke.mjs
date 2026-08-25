#!/usr/bin/env node
/**
 * 冒烟测试：7 个工具 handler + 独立 REST 服务器端到端。输出 smoke-report.md。
 * 用法：node scripts/smoke.mjs
 * @module scripts/smoke
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { MemoryEngine } from '../src/core/index.mjs'
import { HANDLERS } from '../src/tools/handlers.mjs'
import { detectTrigger, isOpenPanel } from '../src/triggers/index.mjs'
import { attachRoutes } from '../src/server/routes.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function check(name, pass, detail) {
  return { name, pass, detail }
}

async function main() {
  const smokeDir = path.join(ROOT, 'test-data', `smoke-${Date.now()}`)
  fs.mkdirSync(smokeDir, { recursive: true })
  process.env.DSH_MEMORY_DIR = smokeDir

  const engine = await MemoryEngine.create({})
  const ctx = { engine, sessionId: 'smoke-sess' }
  const results = []
  const r = (x) => results.push(x)

  // ---- 7 个工具 handler ----
  const add = await HANDLERS.memory_add({ content: '我的宠物猫叫咪咪', tags: ['生活'], importance: 8 }, ctx)
  r(check('memory_add', add.success && add.memory_id && typeof add.embedding_status === 'string' && add.token_cost >= 0, JSON.stringify(add)))

  const addGlobal = await HANDLERS.memory_add({ content: '我喜欢用 Python 做数据分析', tags: ['偏好'], importance: 9, is_global: true }, ctx)
  r(check('memory_add(global)', addGlobal.success === true, JSON.stringify(addGlobal)))

  const search = await HANDLERS.memory_search({ query: '我的猫叫什么名字', top_k: 3 }, ctx)
  r(check('memory_search', Array.isArray(search.results) && search.total >= 1 && typeof search.latency_ms === 'number',
    `results=${search.total} top=${search.results[0]?.content ?? ''} score=${search.results[0]?.score ?? '-'} latency=${search.latency_ms}ms`))

  await engine.shortTerm.append(ctx.sessionId, 'user', '我们讨论一下周末去哪玩')
  const recent = await HANDLERS.memory_get_recent({ n: 5 }, ctx)
  r(check('memory_get_recent', recent.messages.length >= 1 && typeof recent.token_count === 'number' && recent.window_size === recent.messages.length, JSON.stringify(recent)))

  const sum = await HANDLERS.memory_summarize({}, ctx)
  r(check('memory_summarize', sum.summary && sum.memory_id && typeof sum.saved_tokens === 'number', JSON.stringify(sum)))

  const imp = await HANDLERS.memory_update_importance({ memory_id: add.memory_id, score: 10 }, ctx)
  r(check('memory_update_importance', imp.old_score === 8 && imp.new_score === 10, JSON.stringify(imp)))

  const del = await HANDLERS.memory_delete({ conditions: { tag: '生活' } }, ctx)
  r(check('memory_delete', del.deleted_count >= 1 && Array.isArray(del.affected_sessions) && del.freed_tokens >= 0, JSON.stringify(del)))

  const stats = await HANDLERS.memory_stats({}, ctx)
  r(check('memory_stats', typeof stats.total_memories === 'number' && typeof stats.storage_size_mb === 'number', JSON.stringify(stats)))

  // ---- 触发词 ----
  const t1 = detectTrigger('帮我记住我的生日是 5 月 20 号')
  const t2 = detectTrigger('我之前说过我喜欢喝茶')
  const t3 = detectTrigger('总结一下我们的对话')
  const t4 = detectTrigger('查看我的记忆')
  const t5 = detectTrigger('删除关于 工作 的记忆')
  const t6 = detectTrigger('这次对话的上下文是什么')
  r(check('触发词-记住', t1?.tool === 'memory_add' && t1.args.content === '我的生日是 5 月 20 号', JSON.stringify(t1)))
  r(check('触发词-检索', t2?.tool === 'memory_search' && t2.args.query === '我喜欢喝茶', JSON.stringify(t2)))
  r(check('触发词-总结', t3?.tool === 'memory_summarize', JSON.stringify(t3)))
  r(check('触发词-打开面板', isOpenPanel('查看我的记忆') === true, JSON.stringify(t4)))
  r(check('触发词-删除', t5?.tool === 'memory_delete' && t5.args.conditions?.tag === '工作', JSON.stringify(t5)))
  r(check('触发词-上下文', t6?.tool === 'memory_get_recent', JSON.stringify(t6)))

  // ---- REST 服务器端到端 ----
  const handler = attachRoutes(() => engine)
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const jget = async (p) => (await fetch(base + p)).json()
  const jpost = async (p, body) => {
    const resp = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return resp.json()
  }

  const hz = await jget('/api/memory/healthz')
  r(check('REST healthz', hz.ok === true && hz.embedding_status, JSON.stringify(hz)))
  const st = await jget('/api/memory/stats')
  r(check('REST stats', typeof st.total_memories === 'number', JSON.stringify(st)))
  const lst = await jget('/api/memory/memories?limit=10')
  r(check('REST list', lst.total >= 1 && Array.isArray(lst.items), `total=${lst.total}`))
  const sr = await jpost('/api/memory/search', { query: '我喜欢用什么语言做数据分析', session_id: 'other-sess' })
  r(check('REST search(cross-session global)', sr.results[0]?.content === '我喜欢用 Python 做数据分析' && sr.results[0]?.score > 0.85,
    `top=${sr.results[0]?.content ?? ''} score=${sr.results[0]?.score ?? '-'}`))
  const rn = await jget('/api/memory/recent?session=smoke-sess')
  r(check('REST recent', rn.messages.length >= 1, `messages=${rn.messages.length}`))
  const cfg = await jget('/api/memory/config')
  r(check('REST config', cfg.long_term?.similarity_threshold === 0.75, JSON.stringify({ max_messages: cfg.short_term?.max_messages })))
  const exp = await fetch(`${base}/api/memory/export?format=json`)
  const expText = await exp.text()
  r(check('REST export', expText.includes('memories'), `bytes=${expText.length}`))
  const impR = await jpost('/api/memory/import', { text: expText, mode: 'merge' })
  r(check('REST import', typeof impR.imported === 'number' && typeof impR.skipped === 'number', JSON.stringify(impR)))
  const clean = await jpost('/api/memory/cleanup', {})
  r(check('REST cleanup', typeof clean.expired === 'number', JSON.stringify(clean)))
  server.close()

  // ---- 汇总 ----
  const pass = results.filter((x) => x.pass).length
  const lines = [
    '# dsh-memory-manager 冒烟测试报告',
    '',
    `- 数据目录：\`${smokeDir}\``,
    `- 生成时间：${new Date().toISOString()}`,
    `- 结论：**${pass}/${results.length} 项通过**`,
    '',
    '| 检查项 | 结果 | 说明 |',
    '|--------|------|------|',
    ...results.map((x) => `| ${x.name} | ${x.pass ? '✅' : '❌'} | ${x.detail} |`),
  ]
  const reportPath = path.join(ROOT, 'scripts', 'smoke-report.md')
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
  console.log(lines.join('\n'))
  await engine.close()
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => { console.error('冒烟失败:', e); process.exit(1) })
