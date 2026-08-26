// 🔴2-8 加固聚焦测试：
//  🔴2  向量防抖批量落盘（导入 N 条后只写一次；close 兜底刷盘）
//  🔴3  导入保真 created_at/summary_of/ttl/source/tokens
//  🔴4  schema 版本化（user_version=1，旧库平滑升级）
//  🔴5  嵌入降级自愈（degraded 置位后成功调用复位）
//  🔴6  深翻页检索 offset>95 不再翻空
//  🔴8  CSRF 同源校验（写方法 Origin 不匹配 403）+ 会话 Map 有界清理
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-h2-'))
process.env.DSH_MEMORY_DIR = base

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

// ---- 🔴4 schema 版本化 ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({ config: { storage: { encryption_enabled: false } } })
  check('🔴4 schemaVersion=1', e.store.schemaVersion() === 1, String(e.store.schemaVersion()))
  // 模拟"旧库无版本"：user_version 归 0 后重开仍可建表（幂等迁移）
  e.store.db.exec('PRAGMA user_version = 0')
  e.store.migrate()
  check('🔴4 旧库(v0)重迁移仍为 v1', e.store.schemaVersion() === 1)
  await e.close()
}

// ---- 🔴3 导入保真 + 🔴2 防抖落盘 ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({ config: { storage: { encryption_enabled: false } } })
  const fixedCreated = 1787000000000
  const fixedLast = 1787100000000
  const backup = JSON.stringify({
    version: 1, memories: [{
      id: 'imp-1', content: '导入保真测试记忆', tags: ['t1'], importance: 7, is_global: true,
      session_id: 's-imp', created_at: fixedCreated, last_accessed_at: fixedLast,
      ttl: 123456, source: 'summary', tokens: 42, summary_of: 'sess-origin',
    }],
  })
  const t0 = Date.now()
  const r = await e.importBackup(backup, { mode: 'merge' })
  const dur = Date.now() - t0
  check('🔴3 导入成功 1 条', r.imported === 1 && r.failed === 0, JSON.stringify(r))
  const rec = e.store.get('imp-1')
  check('🔴3 created_at 保真', rec.created_at === fixedCreated, `got ${rec.created_at}`)
  check('🔴3 last_accessed_at 保真', rec.last_accessed_at === fixedLast, `got ${rec.last_accessed_at}`)
  check('🔴3 summary_of 保真', rec.summary_of === 'sess-origin', `got ${rec.summary_of}`)
  check('🔴3 ttl/source/tokens 保真', rec.ttl === 123456 && rec.source === 'summary' && rec.tokens === 42, JSON.stringify({ ttl: rec.ttl, source: rec.source, tokens: rec.tokens }))
  check('🔴3 is_global/tags/importance 保真', rec.is_global === true && rec.tags.includes('t1') && rec.importance === 7)
  check('🔴3 内容解密可读', e.decryptContent(rec).includes('导入保真测试记忆'))
  // 向量索引已写入（导入末尾统一刷盘）
  check('🔴3 导入后向量索引非空', e.vector.size() >= 1, `size=${e.vector.size()}`)
  check('🔴2 单条导入未逐条全量写（耗时合理）', dur < 3000, `${dur}ms`)
  await e.close()
}

// ---- 🔴5 嵌入降级自愈 ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const { EmbeddingProvider } = await import('../src/core/embedding.mjs')
  // 直接构造 provider 模拟 openai 失败→降级→恢复
  const p = new EmbeddingProvider({ model: 'openai', apiKey: 'k' })
  await p.init()
  // 强制失败：把 _embedOpenai 换成抛错
  p._embedOpenai = async () => { throw new Error('network down') }
  await p.embed('测试')
  check('🔴5 失败后 degraded=true', p.status().degraded === true)
  p._embedOpenai = async () => Float32Array.from({ length: 1536 }, () => 0.1)
  await p.embed('恢复测试')
  check('🔴5 成功调用后 degraded 复位', p.status().degraded === false, `degraded=${p.status().degraded}`)
  // init 重置
  p._degraded = true
  await p.init()
  check('🔴5 init 重置 degraded', p.status().degraded === false)
}

// ---- 🔴6 深翻页检索 offset>95 ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({ config: { storage: { encryption_enabled: false }, long_term: { embedding_model: 'hash' } } })
  for (let i = 0; i < 130; i += 1) {
    await e.addMemory({ content: `翻页条目 ${i} 共有相同的关键词标记`, sessionId: 'deep', tags: [], importance: 5 })
  }
  await e.persistVectors()
  const r = await e.search('翻页条目', { sessionId: 'deep', topK: 5, threshold: 0, offset: 120, includeGlobal: true })
  check('🔴6 offset=120 有结果', r.results.length > 0, `n=${r.results.length}`)
  check('🔴6 分页字段正确', r.page.offset === 120 && r.page.total >= 125, JSON.stringify(r.page))
  await e.close()
}

// ---- 🔴8 CSRF 同源校验 ----
{
  const { attachRoutes } = await import('../src/server/routes.mjs')
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({ config: { storage: { encryption_enabled: false } } })
  const handler = attachRoutes(() => e)
  const call = (method, path, headers = {}, body = '') => new Promise((resolve) => {
    const req = new Readable({ read() {} })
    req.method = method; req.url = path
    req.headers = { host: '127.0.0.1:4599', ...headers }
    if (body) req.push(body)
    req.push(null)
    const res = { writeHead: (s, h) => { res.status = s; res.headers = h }, end: (b) => resolve({ status: res.status, body: b?.toString?.() || '' }) }
    handler(req, res).catch((err) => resolve({ status: 'ERR', body: String(err) }))
  })
  // 跨源写 → 403
  const r1 = await call('POST', '/api/memory/cleanup', { origin: 'http://evil.example.com' })
  check('🔴8 跨源 POST 403', r1.status === 403, `status=${r1.status}`)
  // 同源写 → 放行
  const r2 = await call('POST', '/api/memory/cleanup', { origin: 'http://127.0.0.1:4599' })
  check('🔴8 同源 POST 放行', r2.status === 200, `status=${r2.status}`)
  // 无 Origin（curl/脚本）→ 放行
  const r3 = await call('POST', '/api/memory/cleanup', {})
  check('🔴8 无 Origin POST 放行', r3.status === 200, `status=${r3.status}`)
  // 读方法不受影响
  const r4 = await call('GET', '/api/memory/stats', { origin: 'http://evil.example.com' })
  check('🔴8 GET 跨源放行（只防护写）', r4.status === 200, `status=${r4.status}`)
  await e.close()
}

// ---- 🔴8 会话 Map 有界清理（静态检查 pruneSessionMaps 存在且有界） ----
{
  const src = readFileSync(new URL('../src/dsh/plugin.mjs', import.meta.url), 'utf8')
  check('🔴8 plugin.mjs 含 pruneSessionMaps', src.includes('pruneSessionMaps'))
  check('🔴8 有界 CAP=512', src.includes('const CAP = 512'))
}

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ 🔴2-8 加固聚焦测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
