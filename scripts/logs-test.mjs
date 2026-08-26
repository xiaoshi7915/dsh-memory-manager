// P5 日志聚焦测试：
//  1. withFileLog 写 memory.log（info/warn/error）→ readLog 读回 + parseLogLine 解析
//  2. 轮转（超 2MB 触发 rename → memory.log.1，读回合并两段）
//  3. REST GET /api/memory/logs 分页 + 级别过滤
//  4. 引擎初始化写入 memory.log（engine.log 存在）
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-log-'))
process.env.DSH_MEMORY_DIR = base

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

// ---- 1. withFileLog 写入 + readLog/parseLogLine ----
{
  const { withFileLog, readLog, parseLogLine, errDetail } = await import('../src/util/filelog.mjs')
  const log = withFileLog(base, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
  log.info('测试信息日志')
  log.warn('测试警告日志')
  log.error('测试错误日志')
  const logPath = join(base, 'memory.log')
  check('1 memory.log 已创建', existsSync(logPath))
  const raw = readFileSync(logPath, 'utf8')
  check('1 三级别均写入', raw.includes('[info]') && raw.includes('[warn]') && raw.includes('[error]'))
  const { items, total } = readLog(base, { limit: 10 })
  check('1 readLog 读回 3 条', total >= 3 && items.length >= 3, `total=${total} items=${items.length}`)
  const lvlSet = new Set(items.map((i) => i.level))
  check('1 级别字段正确', lvlSet.has('info') && lvlSet.has('warn') && lvlSet.has('error'), JSON.stringify([...lvlSet]))
  const p = parseLogLine('2026-08-25T12:00:00.000Z [warn] hello')
  check('1 parseLogLine 解析', p.level === 'warn' && p.message === 'hello' && !!p.ts, JSON.stringify(p))
  check('1 errDetail 单行化', errDetail(new Error('boom')).includes('boom'))
  // 级别过滤
  const errs = readLog(base, { level: 'error' })
  check('1 level 过滤只返回 error', errs.items.every((i) => i.level === 'error') && errs.total >= 1, `total=${errs.total}`)
  // 分页
  const page2 = readLog(base, { offset: 1, limit: 1 })
  check('1 offset/limit 分页', page2.items.length <= 1 && page2.offset === 1)
}

// ---- 2. 轮转（写满 2MB+ 触发 rename） ----
{
  const { withFileLog, readLog } = await import('../src/util/filelog.mjs')
  const { writeFileSync } = await import('node:fs')
  const logPath = join(base, 'memory.log')
  // 直接预写一个超过 MAX 的 memory.log，再写一条触发轮转
  writeFileSync(logPath, 'x'.repeat(2 * 1024 * 1024 + 10) + '\n')
  const log = withFileLog(base, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  // 强制走一次 size 检查：写 SIZE_CHECK_INTERVAL 条（抽样每 32 条查一次）
  for (let i = 0; i < 33; i += 1) log.info(`轮转填充 ${i}`)
  check('2 轮转后 memory.log.1 存在（或被截断重开）', existsSync(`${logPath}.1`) || statSync(logPath).size < 2 * 1024 * 1024)
  const r = readLog(base, { limit: 200 })
  check('2 读回合并轮转档案', r.total >= 33)
}

// ---- 3. REST GET /api/memory/logs ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const { attachRoutes } = await import('../src/server/routes.mjs')
  const e = await MemoryEngine.create({})
  e.log?.info('[memory-manager] REST 测试日志条目')
  const handler = attachRoutes(() => e)
  const call = (path) => new Promise((resolve) => {
    const req = new Readable({ read() {} })
    req.method = 'GET'; req.url = path
    req.headers = { host: '127.0.0.1:4599' }
    req.push(null)
    const res = { writeHead: (s) => { res.status = s }, end: (b) => resolve({ status: res.status, body: b ? JSON.parse(b.toString()) : null }) }
    handler(req, res)
  })
  const r1 = await call('/api/memory/logs')
  check('3 REST /logs 200', r1.status === 200, `status=${r1.status}`)
  check('3 REST 返回 items/total', Array.isArray(r1.body?.items) && r1.body.total >= 1)
  check('3 REST 含引擎初始化日志', r1.body.items.some((i) => i.message.includes('引擎初始化')), `msg=${r1.body.items[0]?.message}`)
  const r2 = await call('/api/memory/logs?level=error&limit=5')
  check('3 REST level+limit 过滤', r2.status === 200 && r2.body.items.every((i) => i.level === 'error'))
  await e.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ P5 日志聚焦测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
