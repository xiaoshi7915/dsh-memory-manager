/**
 * 只读读取 dsh-layered-memory 的真实分层记忆（L0-L3 + 记忆模式）。
 * 决策（后端架构师合议）：数据源策略 = 只读直连 layered 的 SQLite（WAL 支持并发读）+ 自解析 JSONL/MD。
 * - 绝不写 layered 数据（mode PUT 是唯一写点，原子写 session-modes.json + mtime 校验，标实验性）。
 * - 数据不可用/表结构不符 → fail-closed（present:false / 抛 LAYERED_UNAVAILABLE），绝不返回猜测数据。
 * @module src/core/layered
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { writeFileAtomic } from './atomic.mjs'
import { MemoryError } from './types.mjs'

/** layered 数据根目录（环境变量可覆盖，供测试注入临时目录）。 */
export function layeredBaseDir() {
  return process.env.DSH_LAYERED_DIR || path.join(os.homedir(), '.dsh', 'memory')
}

const MODES = new Set(['auto', 'chat', 'work', 'off'])
const FAMILIES = new Set(['chat', 'work'])
const L1_TYPE_ORDER = ['persona', 'episodic', 'instruction', 'work_fact', 'work_task', 'work_method', 'work_artifact']
const NAV_HEADER = '## 🗺️ Scene Navigation'

/** 场景导航段：剥离到下一个空行或 ## 分隔（与 layered persona 的 stripSceneNavigation 语义一致）。 */
export function stripSceneNavigation(md) {
  if (typeof md !== 'string') return md
  const idx = md.indexOf(NAV_HEADER)
  if (idx === -1) return md
  return md.slice(0, idx).replace(/\s+$/, '')
}

/** 解析 L2 场景 .md 的 -----META-START----- front-matter。 */
export function parseSceneMeta(md) {
  const meta = { created: '', updated: '', summary: '', heat: 0 }
  const m = /^-----META-START-----\n([\s\S]*?)\n-----META-END-----/.exec(md)
  if (!m) return meta
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (k === 'heat') meta.heat = Number(v) || 0
    else if (k in meta) meta[k] = v
  }
  return meta
}

/** 拆解 L1 记录的 timestamps（[{start?,end?}] 或 number[]），返回起止毫秒时间戳。 */
export function recordTimeRange(rec) {
  const pick = (t) => (typeof t === 'number' && Number.isFinite(t) ? t : null)
  let ts = rec.timestamp_str ? Number(rec.timestamp_str) : NaN
  const start = pick(rec.timestamp_start) || (Number.isFinite(ts) ? ts : null)
  const end = pick(rec.timestamp_end) || null
  return { start, end }
}

function clampLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return 20
  return Math.min(Math.floor(n), 200)
}
function clampOffset(offset) {
  const n = Number(offset)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}
function sanitizeSceneName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return null
  if (!/^[a-zA-Z0-9._\-\u4e00-\u9fff ()（）]+$/.test(name)) return null
  const base = path.basename(name.replace(/\.md$/i, ''))
  return base.length ? base : null
}

export class LayeredReader {
  /**
   * @param {{baseDir?: string}} [opts]
   */
  constructor({ baseDir } = {}) {
    this.baseDir = baseDir || layeredBaseDir()
    this._db = null
  }

  /** 只读打开 SQLite（WAL 并发读安全）；失败返回 null（不抛，fail-closed 由调用方决策）。 */
  _openDb() {
    const dbPath = path.join(this.baseDir, 'memory.db')
    if (!fs.existsSync(dbPath)) return null
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      // 探测权威表存在；表结构不符 → 视为不可用
      const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('l1_records','l0_conversations')").all()
      if (t.length < 2) { try { db.close() } catch {} return null }
      return db
    } catch {
      return null
    }
  }

  _dbOrNull() {
    if (this._db) return this._db
    this._db = this._openDb()
    return this._db
  }

  close() {
    if (this._db) { try { this._db.close() } catch {} this._db = null }
  }

  /** layered 数据是否在场且可读。 */
  isPresent() {
    return this._dbOrNull() !== null
  }

  /** 会话→L0 消息计数（供 sessions 端点）。 */
  _l0CountBySession(db) {
    const rows = db.prepare('SELECT session_id AS id, COUNT(*) AS n FROM l0_conversations GROUP BY session_id ORDER BY n DESC').all()
    return rows.map((r) => ({ id: r.id, count: r.n }))
  }

  /** 会话→模式映射。 */
  _modes() {
    const file = path.join(this.baseDir, 'session-modes.json')
    let modes = {}
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      modes = j?.sessions && typeof j.sessions === 'object' ? j.sessions : {}
    } catch { /* 缺省空 */ }
    const out = {}
    for (const [sid, v] of Object.entries(modes)) {
      const mode = v?.mode
      if (mode && MODES.has(mode)) out[sid] = mode
    }
    return out
  }

  /** 分层汇总统计。 */
  async stats() {
    const db = this._dbOrNull()
    const present = db !== null
    const out = {
      present,
      dataDir: present ? this.baseDir : null,
      l0: { total: 0, sessions: 0, bySession: [] },
      l1: { total: 0, families: {}, types: {} },
      scenes: { chat: 0, work: 0 },
      persona: { chat_chars: 0, work_chars: 0 },
      modes: { default: null, per_session: {} },
      available: false,
    }
    if (!present) return out
    try {
      const l1Count = db.prepare('SELECT COUNT(*) AS n FROM l1_records').get()
      out.l1.total = l1Count.n
      for (const r of db.prepare('SELECT family AS f, COUNT(*) AS n FROM l1_records GROUP BY family').all()) out.l1.families[r.f] = r.n
      for (const r of db.prepare("SELECT type AS t, COUNT(*) AS n FROM l1_records WHERE type != '' GROUP BY type").all()) out.l1.types[r.t] = r.n
      const l0Count = db.prepare('SELECT COUNT(*) AS n FROM l0_conversations').get()
      out.l0.total = l0Count.n
      out.l0.bySession = this._l0CountBySession(db)
      out.l0.sessions = out.l0.bySession.length
    } catch { /* 单表失败不致命，present 已判 */ }
    // L2 场景计数
    for (const fam of FAMILIES) {
      const dir = path.join(this.baseDir, 'scenes', fam)
      try { out.scenes[fam] = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length } catch { out.scenes[fam] = 0 }
    }
    // L3 画像字符数
    for (const fam of FAMILIES) {
      const p = path.join(this.baseDir, `persona-${fam}.md`)
      try { out.persona[`${fam}_chars`] = stripSceneNavigation(fs.readFileSync(p, 'utf8')).length } catch { out.persona[`${fam}_chars`] = 0 }
    }
    // 模式
    const modes = this._modes()
    out.modes.per_session = modes
    out.modes.default = Object.values(modes)[0] ?? 'auto'
    out.available = true
    return out
  }

  /** L1 原子记忆（只读，支持 type/family/scene 过滤 + 分页）。 */
  l1({ type, family, scene, offset = 0, limit = 20 } = {}) {
    const db = this._dbOrNull()
    if (!db) throw new MemoryError('LAYERED_UNAVAILABLE', 'layered 记忆数据不可用')
    const where = []
    const params = []
    if (type) { where.push('type = ?'); params.push(type) }
    if (family && FAMILIES.has(family)) { where.push('family = ?'); params.push(family) }
    if (scene) { where.push('scene_name = ?'); params.push(scene) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) AS n FROM l1_records ${w}`).get(...params).n
    const off = clampOffset(offset)
    const lim = clampLimit(limit)
    const rows = db.prepare(`SELECT * FROM l1_records ${w} ORDER BY updated_time DESC, record_id LIMIT ? OFFSET ?`).all(...params, lim, off)
    const items = rows.map((r) => {
      let metadata = {}
      try { metadata = JSON.parse(r.metadata_json || '{}') } catch {}
      const { start, end } = recordTimeRange(r)
      return {
        id: r.record_id,
        content: r.content,
        type: r.type || 'unknown',
        priority: r.priority,
        scene_name: r.scene_name || '',
        session_id: r.session_id || '',
        family: r.family || 'chat',
        version: r.version,
        timestamp: start,
        timestamp_end: end,
        created_at: r.created_time || r.timestamp_str || '',
        updated_at: r.updated_time || '',
        source_message_ids: Array.isArray(metadata.source_message_ids) ? metadata.source_message_ids : [],
        metadata,
      }
    })
    return { items, total, offset: off, limit: lim }
  }

  /** L2 场景列表。 */
  scenes({ family } = {}) {
    const list = []
    const fams = family && FAMILIES.has(family) ? [family] : [...FAMILIES]
    for (const fam of fams) {
      const dir = path.join(this.baseDir, 'scenes', fam)
      let files = []
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { continue }
      for (const f of files) {
        const p = path.join(dir, f)
        let md = ''
        try { md = fs.readFileSync(p, 'utf8') } catch { continue }
        const meta = parseSceneMeta(md)
        list.push({
          path: `${fam}/${f}`,
          family: fam,
          name: f.replace(/\.md$/i, ''),
          created: meta.created,
          updated: meta.updated,
          summary: meta.summary,
          heat: meta.heat,
        })
      }
    }
    list.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))
    return { items: list, total: list.length }
  }

  /** 单个场景内容（含 META 解析）。 */
  scene({ family, name }) {
    if (!family || !FAMILIES.has(family)) throw new MemoryError('VALIDATION_ERROR', 'family 必须是 chat 或 work')
    const safe = sanitizeSceneName(name)
    if (!safe) throw new MemoryError('VALIDATION_ERROR', '场景名非法')
    const p = path.join(this.baseDir, 'scenes', family, `${safe}.md`)
    const resolved = path.resolve(p)
    if (!resolved.startsWith(path.resolve(path.join(this.baseDir, 'scenes')) + path.sep)) throw new MemoryError('VALIDATION_ERROR', '场景路径越界')
    if (!fs.existsSync(resolved)) throw new MemoryError('NOT_FOUND', `场景 ${family}/${safe} 不存在`)
    const md = fs.readFileSync(resolved, 'utf8')
    const meta = parseSceneMeta(md)
    return { name: safe, family, content: md, meta }
  }

  /** L3 画像（剥离场景导航段）。 */
  persona({ family }) {
    if (!family || !FAMILIES.has(family)) throw new MemoryError('VALIDATION_ERROR', 'family 必须是 chat 或 work')
    const p = path.join(this.baseDir, `persona-${family}.md`)
    if (!fs.existsSync(p)) throw new MemoryError('NOT_FOUND', `画像 persona-${family}.md 不存在`)
    return { family, content: stripSceneNavigation(fs.readFileSync(p, 'utf8')) }
  }

  /** L0 原始对话（按会话过滤 + 分页，倒序）。 */
  l0({ session, offset = 0, limit = 20 } = {}) {
    const db = this._dbOrNull()
    if (!db) throw new MemoryError('LAYERED_UNAVAILABLE', 'layered 记忆数据不可用')
    const where = []
    const params = []
    if (session) { where.push('session_id = ?'); params.push(session) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) AS n FROM l0_conversations ${w}`).get(...params).n
    const off = clampOffset(offset)
    const lim = clampLimit(limit)
    const rows = db.prepare(`SELECT * FROM l0_conversations ${w} ORDER BY timestamp DESC, record_id LIMIT ? OFFSET ?`).all(...params, lim, off)
    const items = rows.map((r) => ({
      id: r.record_id,
      session_id: r.session_id || '',
      role: r.role || '',
      content: r.message_text,
      recorded_at: r.recorded_at || '',
      timestamp: r.timestamp || 0,
    }))
    return { items, total, offset: off, limit: lim }
  }

  /** 会话维度（id/count/mode）。 */
  sessions() {
    const db = this._dbOrNull()
    if (!db) throw new MemoryError('LAYERED_UNAVAILABLE', 'layered 记忆数据不可用')
    const bySession = this._l0CountBySession(db)
    const modes = this._modes()
    return {
      items: bySession.map((s) => ({ id: s.id, count: s.count, mode: modes[s.id] ?? null })),
      total: bySession.length,
    }
  }

  /** 记忆模式读取（默认档优先返回存在的会话档位）。 */
  mode({ session } = {}) {
    const modes = this._modes()
    if (session) return { session, mode: modes[session] ?? null }
    return { session: null, mode: Object.values(modes)[0] ?? 'auto' }
  }

  /** 记忆模式写入（唯一写点，实验性）：原子写 session-modes.json，mtime 并发校验。 */
  async modeSet({ session, mode }) {
    if (!session || typeof session !== 'string' || session.length > 200) throw new MemoryError('VALIDATION_ERROR', 'session 必填')
    if (!MODES.has(mode)) throw new MemoryError('VALIDATION_ERROR', `mode 必须是 ${[...MODES].join('/')}`)
    const file = path.join(this.baseDir, 'session-modes.json')
    await fsp.mkdir(this.baseDir, { recursive: true })
    // 读现状（带 mtime 快照用于并发守卫）
    let cur = { version: 1, sessions: {} }
    let mtime = null
    try {
      const st = fs.statSync(file)
      mtime = st.mtimeMs
      cur = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch { /* 不存在则新建 */ }
    cur.sessions = cur.sessions && typeof cur.sessions === 'object' ? cur.sessions : {}
    // 只写本会话档位，保留其他
    const before = cur.sessions[session]
    cur.sessions[session] = { mode, updatedAt: Date.now() }
    // 并发守卫：写前再查一次 mtime，若变化则放弃（避免覆盖 layered 并发写的状态）
    if (mtime !== null) {
      try {
        const now = fs.statSync(file).mtimeMs
        if (Math.abs(now - mtime) > 5) {
          throw new MemoryError('CONCURRENT_WRITE', 'session-modes.json 被其他进程并发修改，已放弃写入；请重试')
        }
      } catch (e) {
        if (e.code === 'CONCURRENT_WRITE') throw e
      }
    }
    await writeFileAtomic(file, JSON.stringify(cur, null, 2), { mode: 0o600 })
    return { session, mode, previous: before?.mode ?? null }
  }
}

/** 便捷工厂：读取器单例（供 routes 复用）。 */
export function createLayeredReader(opts = {}) {
  return new LayeredReader(opts)
}
