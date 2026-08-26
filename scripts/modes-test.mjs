// P6 记忆档位聚焦测试：
//  1. SessionModeStore 基本：init/get/set/flush/持久化重载
//  2. 过期清理（90 天）+ 条数上限（500）
//  3. 引擎集成：engine.getMode/setMode + close flush 后重载保留
//  4. REST GET/PUT /api/memory/mode + 非法档位校验
//  5. plugin gating 逻辑（off 隐身 / chat|work 强制 / auto 跟随）——静态断言
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-mode-'))
process.env.DSH_MEMORY_DIR = base

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

// ---- 1. SessionModeStore 基本 ----
{
  const { SessionModeStore, MEMORY_MODES, isMemoryMode } = await import('../src/core/modes.mjs')
  check('1 MEMORY_MODES 为四档', JSON.stringify(MEMORY_MODES) === JSON.stringify(['auto', 'chat', 'work', 'off']))
  check('1 isMemoryMode 校验', isMemoryMode('work') && isMemoryMode('off') && !isMemoryMode('bad'))
  const s = new SessionModeStore(base, { log: null })
  await s.init()
  check('1 默认档位 auto', s.get('any-session') === 'auto', s.get('any-session'))
  s.set('s1', 'work')
  s.set('s2', 'off')
  await s.flush()
  check('1 set 后 get 生效', s.get('s1') === 'work' && s.get('s2') === 'off')
  check('1 session-modes.json 已写盘', existsSync(join(base, 'session-modes.json')))
  // 重载
  const s2 = new SessionModeStore(base, { log: null })
  await s2.init()
  check('1 持久化重载保留', s2.get('s1') === 'work' && s2.get('s2') === 'off')
  check('1 set 非法档位抛错', (() => { try { s.set('x', 'nope'); return false } catch { return true } })())
  // onModeChange 回调
  let changed = null
  s.setModeChangeHandler((sid, old, next) => { changed = `${sid}:${old}->${next}` })
  s.set('s1', 'chat')
  await s.flush()
  check('1 onModeChange 回调触发', changed === 's1:work->chat', String(changed))
  check('1 同档位不触发回调', (() => { changed = null; s.set('s1', 'chat'); await_flush(s); return changed === null })())
}

// ---- 2. 过期清理 + 条数上限 ----
{
  const { SessionModeStore } = await import('../src/core/modes.mjs')
  const s = new SessionModeStore(base, { log: null })
  s.entries.set('stale', { mode: 'chat', updatedAt: Date.now() - 100 * 24 * 3600_000 }) // 100 天前
  s.entries.set('fresh', { mode: 'work', updatedAt: Date.now() })
  const ser = s.serialize()
  check('2 过期(100天)被清理', !ser.sessions.stale && !!ser.sessions.fresh)
  // 上限 500：塞 550 条 → serialize 后 ≤500 且保留最新的
  const s2 = new SessionModeStore(base, { log: null })
  const t = Date.now()
  for (let i = 0; i < 550; i += 1) s2.entries.set(`k${i}`, { mode: 'auto', updatedAt: t - i }) // k0 最新
  const ser2 = s2.serialize()
  const keys = Object.keys(ser2.sessions)
  check('2 条数上限 500', keys.length <= 500, `len=${keys.length}`)
  check('2 保留最新的 k0', !!ser2.sessions.k0)
  check('2 淘汰最旧的 k549', !ser2.sessions.k549)
}

// ---- 3. 引擎集成 ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({})
  check('3 引擎 modes 就绪', !!e.modes && e.getMode('zzz') === 'auto')
  e.setMode('eng-sess', 'off')
  check('3 engine.setMode 生效', e.getMode('eng-sess') === 'off')
  await e.close()
  const e2 = await MemoryEngine.create({})
  check('3 引擎重启后档位保留', e2.getMode('eng-sess') === 'off')
  await e2.close()
}

// ---- 4. REST mode 端点 ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const { attachRoutes } = await import('../src/server/routes.mjs')
  const e = await MemoryEngine.create({})
  const handler = attachRoutes(() => e)
  const call = (method, path, body) => new Promise((resolve) => {
    const req = new Readable({ read() {} })
    req.method = method; req.url = path
    req.headers = { host: '127.0.0.1:4599', 'content-type': 'application/json' }
    if (body) req.push(JSON.stringify(body))
    req.push(null)
    const res = { writeHead: (s) => { res.status = s }, end: (b) => resolve({ status: res.status, body: b ? JSON.parse(b.toString()) : null }) }
    handler(req, res)
  })
  const g1 = await call('GET', '/api/memory/mode?session=rest-s')
  check('4 GET mode 默认 auto', g1.status === 200 && g1.body.mode === 'auto', JSON.stringify(g1.body))
  const p1 = await call('PUT', '/api/memory/mode', { session: 'rest-s', mode: 'work' })
  check('4 PUT mode 成功', p1.status === 200 && p1.body.mode === 'work', JSON.stringify(p1.body))
  const g2 = await call('GET', '/api/memory/mode?session=rest-s')
  check('4 GET 读到已设档位', g2.body.mode === 'work')
  const p2 = await call('PUT', '/api/memory/mode', { session: 'rest-s', mode: 'bad' })
  check('4 PUT 非法档位 400', p2.status === 400, `status=${p2.status}`)
  await e.close()
}

// ---- 5. plugin gating 静态断言 ----
{
  const src = readFileSync(new URL('../src/dsh/plugin.mjs', import.meta.url), 'utf8')
  check('5 handleSessionEvent 读档位', src.includes('engine.getMode(sid)'))
  check('5 off 隐身 gating', src.includes("mode !== 'off'"))
  check('5 chat/work 强制', src.includes("forceOn = mode === 'chat' || mode === 'work'"))
}

async function await_flush(s) { await s.flush() }
const passed = results.filter((r) => r.ok).length
console.log(`\n═══ P6 记忆档位聚焦测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
