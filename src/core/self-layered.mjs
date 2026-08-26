/**
 * 自持分层数据读取（P9）：仅安装 manager 时，分层浏览（L0-L3）读取 manager 自己蒸馏产出的数据。
 * 数据源策略 = manager 自己的数据目录（engine.baseDir）：
 *  - L0：conversations/YYYY-MM-DD.jsonl（persistL0 写入，日期 JSONL 镜像）
 *  - L1：long_term/memories.db 中 source='distill' 的记录（family/type 从 tags 提取）
 *  - L2：scenes/{chat,work}/*.md（与 layered 相同的 META 前块布局）
 *  - L3：persona-{chat,work}.md（含导航头，读时剥离）
 * 接口与 LayeredReader 对齐（stats/l1/scenes/scene/persona/l0/sessions/mode/modeSet），
 * 使 routes 能在 layered 缺席时透明降级到自持数据（stats.source='self' 供 GUI 区分）。
 * @module src/core/self-layered
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseSceneMeta, stripSceneNavigation, recordTimeRange } from './layered.mjs'
import { MemoryError } from './types.mjs'

const FAMILIES = new Set(['chat', 'work'])
const L1_TYPE_ORDER = ['persona', 'episodic', 'instruction', 'work_fact', 'work_task', 'work_method', 'work_artifact']

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

export class SelfLayerReader {
  /**
   * @param {{baseDir: string}} opts  manager 数据根（engine.baseDir）
   */
  constructor({ baseDir }) {
    if (!baseDir) throw new Error('SelfLayerReader: baseDir 必填')
    this.baseDir = baseDir
    this._db = null
    this._dbPath = path.join(baseDir, 'long_term', 'memories.db')
  }

  /** 只读打开 manager 长期库（存在且有 distill 记录即可用）。 */
  _openDb() {
    if (!fs.existsSync(this._dbPath)) return null
    try {
      return new DatabaseSync(this._dbPath, { readOnly: true })
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

  /** 自持数据是否在场（有蒸馏记忆 或 有 L0/场景/画像文件）。 */
  isPresent() {
    if (this._dbOrNull() !== null) {
      try {
        const n = this._db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source='distill'").get().n
        if (n > 0) return true
      } catch { /* 表不存在则继续 */ }
    }
    const conv = path.join(this.baseDir, 'conversations')
    try { if (fs.readdirSync(conv).some((f) => f.endsWith('.jsonl'))) return true } catch {}
    for (const fam of FAMILIES) {
      const dir = path.join(this.baseDir, 'scenes', fam)
      try { if (fs.readdirSync(dir).some((f) => f.endsWith('.md'))) return true } catch {}
    }
    return false
  }

  /** 从 tags 提取 family / type（distill 写入时编码为 family:X / type:Y）。 */
  _tagsMeta(tagsJson) {
    let tags = []
    try { tags = JSON.parse(tagsJson || '[]') } catch {}
    let family = 'chat'
    let type = 'unknown'
    for (const t of tags) {
      if (typeof t === 'string') {
        if (t.startsWith('family:')) family = t.slice(7)
        else if (t.startsWith('type:')) type = t.slice(5)
      }
    }
    return { family: FAMILIES.has(family) ? family : 'chat', type }
  }

  /** 分层汇总统计（与 LayeredReader.stats 形状一致，source='self'）。 */
  async stats() {
    const db = this._dbOrNull()
    const out = {
      present: false,
      source: 'self',
      dataDir: this.baseDir,
      l0: { total: 0, sessions: 0, bySession: [] },
      l1: { total: 0, families: {}, types: {} },
      scenes: { chat: 0, work: 0 },
      persona: { chat_chars: 0, work_chars: 0 },
      modes: { default: null, per_session: {} },
      available: false,
    }
    if (db) {
      try {
        const n = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source='distill'").get().n
        out.l1.total = n
        for (const r of db.prepare("SELECT family, COUNT(*) AS n FROM (SELECT id, (SELECT value FROM json_each(tags) WHERE value LIKE 'family:%') AS family FROM memories WHERE source='distill') WHERE family IS NOT NULL GROUP BY family").all()) {
          const f = r.family.replace('family:', '')
          if (FAMILIES.has(f)) out.l1.families[f] = r.n
        }
        for (const r of db.prepare("SELECT value AS t, COUNT(*) AS n FROM memories, json_each(memories.tags) WHERE memories.source='distill' AND value LIKE 'type:%' GROUP BY value").all()) {
          const t = r.t.replace('type:', '')
          out.l1.types[t] = r.n
        }
      } catch { /* 单表失败不致命 */ }
    }
    // L0：conversations/*.jsonl
    const conv = path.join(this.baseDir, 'conversations')
    const bySession = {}
    try {
      for (const f of fs.readdirSync(conv).filter((x) => x.endsWith('.jsonl'))) {
        const raw = fs.readFileSync(path.join(conv, f), 'utf8')
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const j = JSON.parse(line)
            bySession[j.session_id || 'default'] = (bySession[j.session_id || 'default'] || 0) + 1
          } catch {}
        }
      }
    } catch {}
    out.l0.bySession = Object.entries(bySession).map(([id, n]) => ({ id, count: n })).sort((a, b) => b.count - a.count)
    out.l0.total = out.l0.bySession.reduce((s, x) => s + x.count, 0)
    out.l0.sessions = out.l0.bySession.length
    // L2 场景
    for (const fam of FAMILIES) {
      const dir = path.join(this.baseDir, 'scenes', fam)
      try { out.scenes[fam] = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length } catch { out.scenes[fam] = 0 }
    }
    // L3 画像
    for (const fam of FAMILIES) {
      const p = path.join(this.baseDir, `persona-${fam}.md`)
      try { out.persona[`${fam}_chars`] = stripSceneNavigation(fs.readFileSync(p, 'utf8')).length } catch { out.persona[`${fam}_chars`] = 0 }
    }
    // 模式（manager 自己的档位文件）
    const modes = this._modes()
    out.modes.per_session = modes
    out.modes.default = Object.values(modes)[0] ?? 'auto'
    out.present = this.isPresent()
    out.available = out.present
    return out
  }

  _modes() {
    const file = path.join(this.baseDir, 'session-modes.json')
    let modes = {}
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      modes = j?.sessions && typeof j.sessions === 'object' ? j.sessions : {}
    } catch { /* 缺省空 */ }
    const out = {}
    const MODES = new Set(['auto', 'chat', 'work', 'off'])
    for (const [sid, v] of Object.entries(modes)) {
      const mode = v?.mode
      if (mode && MODES.has(mode)) out[sid] = mode
    }
    return out
  }

  /** L1 原子记忆（source='distill'，family/type 从 tags 提取）。 */
  l1({ type, family, offset = 0, limit = 20 } = {}) {
    const db = this._dbOrNull()
    if (!db) throw new MemoryError('LAYERED_UNAVAILABLE', 'manager 自持蒸馏记忆不可用')
    const where = ["source='distill'"]
    const params = []
    if (type) { where.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)"); params.push(`type:${type}`) }
    if (family && FAMILIES.has(family)) { where.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)"); params.push(`family:${family}`) }
    const w = `WHERE ${where.join(' AND ')}`
    const total = db.prepare(`SELECT COUNT(*) AS n FROM memories ${w}`).get(...params).n
    const off = clampOffset(offset)
    const lim = clampLimit(limit)
    const rows = db.prepare(`SELECT * FROM memories ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off)
    const items = rows.map((r) => {
      const { family: fam, type: typ } = this._tagsMeta(r.tags)
      return {
        id: r.id,
        content: r.content,
        type: typ,
        priority: r.importance * 10,
        scene_name: '',
        session_id: r.session_id || '',
        family: fam,
        version: 1,
        timestamp: r.created_at,
        timestamp_end: null,
        created_at: r.created_at,
        updated_at: r.last_accessed_at,
        source_message_ids: [],
        metadata: { distilled: true, source: r.source },
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

  /** 单个场景内容。 */
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

  /** L3 画像。 */
  persona({ family }) {
    if (!family || !FAMILIES.has(family)) throw new MemoryError('VALIDATION_ERROR', 'family 必须是 chat 或 work')
    const p = path.join(this.baseDir, `persona-${family}.md`)
    if (!fs.existsSync(p)) throw new MemoryError('NOT_FOUND', `画像 persona-${family}.md 不存在`)
    return { family, content: stripSceneNavigation(fs.readFileSync(p, 'utf8')) }
  }

  /** L0 原始对话（conversations/*.jsonl，按会话过滤 + 分页，倒序）。与 LayeredReader 同步接口对齐。 */
  l0({ session, offset = 0, limit = 20 } = {}) {
    const conv = path.join(this.baseDir, 'conversations')
    let recs = []
    try {
      for (const f of fs.readdirSync(conv).filter((x) => x.endsWith('.jsonl'))) {
        const raw = fs.readFileSync(path.join(conv, f), 'utf8')
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try { recs.push(JSON.parse(line)) } catch {}
        }
      }
    } catch { recs = [] }
    if (session) recs = recs.filter((r) => r.session_id === session)
    recs.sort((a, b) => (b.time || 0) - (a.time || 0))
    const total = recs.length
    const off = clampOffset(offset)
    const lim = clampLimit(limit)
    const items = recs.slice(off, off + lim).map((r, i) => ({
      id: `${r.time || 0}-${off + i}`,
      session_id: r.session_id || '',
      role: r.role || '',
      content: r.content || '',
      recorded_at: new Date(r.time || 0).toISOString(),
      timestamp: r.time || 0,
    }))
    return { items, total, offset: off, limit: lim }
  }

  /** 会话维度。 */
  sessions() {
    const l0 = this.l0({ limit: 200 })
    const bySession = {}
    for (const r of l0.items) bySession[r.session_id] = (bySession[r.session_id] || 0) + 1
    const modes = this._modes()
    return {
      items: Object.entries(bySession).map(([id, count]) => ({ id, count, mode: modes[id] ?? null })),
      total: Object.keys(bySession).length,
    }
  }

  /** 记忆模式读取（manager 档位）。 */
  mode({ session } = {}) {
    const modes = this._modes()
    if (session) return { session, mode: modes[session] ?? null }
    return { session: null, mode: Object.values(modes)[0] ?? 'auto' }
  }
}

/** 便捷工厂。 */
export function createSelfLayerReader(opts = {}) {
  return new SelfLayerReader(opts)
}
