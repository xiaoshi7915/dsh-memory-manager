/**
 * 长期记忆元数据存储：Node 内置 node:sqlite。
 * @module src/core/store
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { MEMORY_TABLE_SQL, rowToRecord } from './types.mjs'

export class MemoryStore {
  /** @param {string} dbFile */
  constructor(dbFile) {
    this.dbFile = dbFile
    this.db = null
  }

  migrate() {
    if (!this.db) return
    this.db.exec(MEMORY_TABLE_SQL)
  }

  open() {
    fs.mkdirSync(path.dirname(this.dbFile), { recursive: true })
    this.db = new DatabaseSync(this.dbFile)
    // WAL：大幅减少独立提交的 fsync，提升批量写入与并发读性能（node:sqlite 默认回滚日志模式，逐条提交很慢）
    try { this.db.exec('PRAGMA journal_mode = WAL') } catch { /* 个别环境不支持则忽略 */ }
    this.migrate()
  }

  close() {
    try { this.db?.close() } catch { /* 忽略 */ }
    this.db = null
  }

  /** WAL checkpoint：尽力回收 WAL 磁盘页（TRUNCATE 失败时回退普通 checkpoint）。 */
  checkpoint() {
    if (!this.db) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)') } catch { /* 忽略 */ }
    }
  }

  insert(rec) {
    this.db.prepare(
      `INSERT INTO memories (id, content, tags, importance, is_global, session_id, created_at, last_accessed_at, ttl, source, tokens, summary_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.id, rec.content, JSON.stringify(rec.tags), rec.importance,
      rec.is_global ? 1 : 0, rec.session_id, rec.created_at, rec.last_accessed_at,
      rec.ttl, rec.source, rec.tokens, rec.summary_of,
    )
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    return rowToRecord(row)
  }

  update(id, patch) {
    const allowed = [
      'content', 'tags', 'importance', 'is_global', 'session_id', 'last_accessed_at', 'ttl', 'source', 'tokens', 'summary_of',
    ]
    const sets = []
    const values = []
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`)
        values.push(key === 'tags' ? JSON.stringify(patch[key]) : (key === 'is_global' ? (patch[key] ? 1 : 0) : patch[key]))
      }
    }
    if (sets.length === 0) return
    values.push(id)
    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0
    const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?')
    let n = 0
    for (const id of ids) n += Number(stmt.run(id).changes)
    return n
  }

  list() {
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all()
    return rows.map(rowToRecord).filter(Boolean)
  }

  count() {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM memories').get()
    return Number(row?.c ?? 0)
  }

  touch(id) {
    this.db.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(Date.now(), id)
  }

  clear() {
    this.db.prepare('DELETE FROM memories').run()
  }
}
