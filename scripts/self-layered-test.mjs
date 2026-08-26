// P9 独立验收聚焦测试：仅安装 manager 时分层浏览读自持蒸馏数据（SelfLayerReader + routes 降级）。
//  1. SelfLayerReader.stats：source='self'，L0/L1/L2/L3 统计
//  2. SelfLayerReader.l1：memories.db source='distill'，family/type 从 tags 提取 + 过滤
//  3. SelfLayerReader.l0：conversations/*.jsonl 按会话过滤 + 分页
//  4. SelfLayerReader.scenes/scene：META 前块 + 穿越守卫
//  5. SelfLayerReader.persona：剥离导航头
//  6. SelfLayerReader.sessions/mode：档位
//  7. routes 降级：layered 缺席 → /api/memory/layered/stats source='self' present=true
//  8. 共存不回归：layered 在场 → 仍读 layered（source 非 self）
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

/** 造一份 manager 蒸馏产出（L1 distill + L0 对话 + L2 场景 + L3 画像 + 档位）。 */
async function seedSelfData(base) {
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({ baseDir: base })
  // L1 蒸馏记忆（family/type 入 tags）
  await e.addMemory({ sessionId: 'sess-x', content: '用户偏好用中文交流', importance: 7, source: 'distill', tags: ['distill', 'l1', 'family:chat', 'type:persona'] })
  await e.addMemory({ sessionId: 'sess-x', content: '团队决定用 pnpm 管理依赖', importance: 8, source: 'distill', tags: ['distill', 'l1', 'family:work', 'type:work_fact'] })
  await e.addMemory({ sessionId: 'other', content: '一条手动记忆不算蒸馏', importance: 5, source: 'manual', tags: ['普通'] })
  // L0 对话
  const { persistL0, dateKey } = await import('../src/core/distill.mjs')
  await persistL0(e, 'sess-x', [
    { role: 'user', content: '我喜欢用中文' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '计划周五发布' },
  ])
  await persistL0(e, 'other', [{ role: 'user', content: '另一个会话' }])
  // L2 场景 + L3 画像
  const { distillScenes, distillPersona } = await import('../src/core/distill.mjs')
  const llmScenes = async () => JSON.stringify([{ scene_name: '沟通偏好', summary: '用户偏好中文', content: '## 沟通\n- 中文' }])
  await distillScenes(e, 'chat', [{ content: 'a', type: 'persona', priority: 70 }], { llm: llmScenes })
  const llmPersona = async () => '## 用户画像\n- 偏好中文'
  await distillPersona(e, 'chat', [{ name: '沟通偏好', summary: 'x' }], { llm: llmPersona })
  // 档位
  await e.setMode('sess-x', 'chat')
  await e.close()
}

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-p9-'))
process.env.DSH_MEMORY_DIR = base
await seedSelfData(base)
const { SelfLayerReader, createSelfLayerReader } = await import('../src/core/self-layered.mjs')

// ---- 1. stats ----
{
  const lr = new SelfLayerReader({ baseDir: base })
  const st = await lr.stats()
  check('1 stats.source=self', st.source === 'self', st.source)
  check('1 stats.present=true', st.present === true)
  check('1 L1 total=2（蒸馏）', st.l1.total === 2, `l1.total=${st.l1.total}`)
  check('1 L1 families 含 chat/work', st.l1.families.chat === 1 && st.l1.families.work === 1, JSON.stringify(st.l1.families))
  check('1 L1 types 含 persona/work_fact', st.l1.types.persona === 1 && st.l1.types.work_fact === 1, JSON.stringify(st.l1.types))
  check('1 L0 total=4', st.l0.total === 4, `l0.total=${st.l0.total}`)
  check('1 L2 场景 chat=1', st.scenes.chat === 1, JSON.stringify(st.scenes))
  check('1 L3 画像 chat>0', st.persona.chat_chars > 0, `chat_chars=${st.persona.chat_chars}`)
  check('1 默认档位', st.modes.default === 'chat', st.modes.default)
  lr.close()
}

// ---- 2. l1 ----
{
  const lr = new SelfLayerReader({ baseDir: base })
  const all = lr.l1({})
  check('2 L1 仅蒸馏（不含 manual）', all.total === 2, `total=${all.total}`)
  check('2 L1 首条 family=chat/type=persona', all.items.some((x) => x.family === 'chat' && x.type === 'persona'))
  const work = lr.l1({ family: 'work' })
  check('2 L1 按 family=work 过滤', work.total === 1 && work.items[0].family === 'work')
  const persona = lr.l1({ type: 'persona' })
  check('2 L1 按 type=persona 过滤', persona.total === 1)
  const paged = lr.l1({ limit: 1, offset: 0 })
  check('2 L1 分页 limit=1', paged.items.length === 1)
  lr.close()
}

// ---- 3. l0 ----
{
  const lr = new SelfLayerReader({ baseDir: base })
  const all = await lr.l0({})
  check('3 L0 total=4', all.total === 4)
  check('3 L0 倒序（最新在前）', all.items[0].content === '计划周五发布' || all.items[0].content === '另一个会话')
  const bySess = await lr.l0({ session: 'sess-x' })
  check('3 L0 按会话过滤', bySess.total === 3, `total=${bySess.total}`)
  check('3 L0 行含 role/content', bySess.items[0].role === 'user' && typeof bySess.items[0].content === 'string')
  const paged = await lr.l0({ session: 'sess-x', limit: 2, offset: 0 })
  check('3 L0 分页 limit=2', paged.items.length === 2)
  lr.close()
}

// ---- 4. scenes ----
{
  const lr = new SelfLayerReader({ baseDir: base })
  const sc = lr.scenes({})
  check('4 scenes 含 chat 沟通偏好', sc.items.some((x) => x.family === 'chat' && x.name === '沟通偏好'))
  const one = lr.scene({ family: 'chat', name: '沟通偏好' })
  check('4 scene 含 META + 正文', one.meta.summary === '用户偏好中文' && one.content.includes('## 沟通'))
  let threw = false
  try { lr.scene({ family: 'chat', name: '../x' }) } catch { threw = true }
  check('4 scene 穿越被拒', threw)
  lr.close()
}

// ---- 5. persona ----
{
  const lr = new SelfLayerReader({ baseDir: base })
  const p = lr.persona({ family: 'chat' })
  check('5 persona 剥离导航头', !p.content.includes('Scene Navigation') && p.content.includes('用户画像'))
  let threw = false
  try { lr.persona({ family: 'chat' }) /* 存在 */ } catch { threw = true }
  check('5 persona 存在不抛', !threw)
  const miss = new SelfLayerReader({ baseDir: base })
  let missThrew = false
  try { miss.persona({ family: 'work' }) } catch { missThrew = true }
  check('5 persona-work 缺席抛 NOT_FOUND', missThrew)
  lr.close(); miss.close()
}

// ---- 6. sessions/mode ----
{
  const lr = new SelfLayerReader({ baseDir: base })
  const sess = await lr.sessions()
  check('6 sessions 含 sess-x', sess.items.some((x) => x.id === 'sess-x'))
  const m = await lr.mode({ session: 'sess-x' })
  check('6 mode=chat', m.mode === 'chat', m.mode)
  lr.close()
}

// ---- 7. routes 降级：layered 缺席 → self ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const { attachRoutes } = await import('../src/server/routes.mjs')
  process.env.DSH_LAYERED_DIR = join(tmpdir(), 'dsh-no-layered-' + Date.now())
  const e = await MemoryEngine.create({ baseDir: base })
  const handler = attachRoutes(() => e)
  const call = (method, path) => new Promise((resolve) => {
    const req = new Readable({ read() {} })
    req.method = method; req.url = path
    req.headers = { host: '127.0.0.1:4701' }
    req.push(null)
    const res = { writeHead: (s) => { res.status = s }, end: (b) => resolve({ status: res.status, body: b ? JSON.parse(b.toString()) : null }) }
    handler(req, res)
  })
  const st = await call('GET', '/api/memory/layered/stats')
  check('7 stats 200', st.status === 200)
  check('7 stats.source=self（降级）', st.body?.source === 'self', JSON.stringify(st.body?.source))
  check('7 stats.present=true', st.body?.present === true)
  const l1 = await call('GET', '/api/memory/layered/l1?limit=10')
  check('7 l1 自持 total=2', l1.body?.total === 2, `total=${l1.body?.total}`)
  const l0 = await call('GET', '/api/memory/layered/l0')
  check('7 l0 自持 total=4', l0.body?.total === 4, `total=${l0.body?.total}`)
  const scenes = await call('GET', '/api/memory/layered/scenes')
  check('7 scenes 自持 含沟通偏好', (scenes.body?.items || []).some((x) => x.name === '沟通偏好'))
  const persona = await call('GET', '/api/memory/layered/persona?family=chat')
  check('7 persona 自持 200', persona.status === 200 && persona.body?.content?.includes('用户画像'))
  await e.close()
  delete process.env.DSH_LAYERED_DIR
}

// ---- 8. 共存不回归：layered 在场仍读 layered ----
{
  // 造一个假的 layered 数据目录（含 memory.db 结构），验证 routes 优先 layered
  const ldir = mkdtempSync(join(tmpdir(), 'dsh-layered-present-'))
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(ldir, 'memory.db')
  const db = new DatabaseSync(dbPath)
  db.exec("CREATE TABLE l1_records (record_id TEXT PRIMARY KEY, content TEXT, type TEXT, family TEXT, priority INTEGER, scene_name TEXT, session_id TEXT, version INTEGER, timestamp_start INTEGER, timestamp_end INTEGER, timestamp_str TEXT, created_time TEXT, updated_time TEXT, metadata_json TEXT)")
  db.exec("CREATE TABLE l0_conversations (record_id TEXT PRIMARY KEY, session_id TEXT, role TEXT, message_text TEXT, recorded_at TEXT, timestamp INTEGER)")
  db.prepare("INSERT INTO l1_records (record_id, content, type, family, priority, session_id, version, updated_time) VALUES (?,?,?,?,?,?,?,?)").run('r1', 'layered 专属记忆', 'persona', 'chat', 80, 's1', 1, new Date().toISOString())
  db.prepare("INSERT INTO l0_conversations (record_id, session_id, role, message_text, timestamp) VALUES (?,?,?,?,?)").run('m1', 's1', 'user', 'layered 原始消息', Date.now())
  db.close()
  process.env.DSH_LAYERED_DIR = ldir
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const { attachRoutes } = await import('../src/server/routes.mjs')
  const e = await MemoryEngine.create({ baseDir: base })
  const handler = attachRoutes(() => e)
  const call = (method, path) => new Promise((resolve) => {
    const req = new Readable({ read() {} })
    req.method = method; req.url = path
    req.headers = { host: '127.0.0.1:4702' }
    req.push(null)
    const res = { writeHead: (s) => { res.status = s }, end: (b) => resolve({ status: res.status, body: b ? JSON.parse(b.toString()) : null }) }
    handler(req, res)
  })
  const st = await call('GET', '/api/memory/layered/stats')
  check('8 layered 在场 source 非 self', st.body?.source !== 'self', JSON.stringify(st.body?.source))
  check('8 layered 在场读 layered L1', st.body?.l1?.total === 1, JSON.stringify(st.body?.l1?.total))
  const l1 = await call('GET', '/api/memory/layered/l1')
  check('8 layered L1 内容是 layered 专属', (l1.body?.items || [])[0]?.content === 'layered 专属记忆', JSON.stringify((l1.body?.items || [])[0]?.content))
  await e.close()
  delete process.env.DSH_LAYERED_DIR
}

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ P9 自持分层独立验收测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
