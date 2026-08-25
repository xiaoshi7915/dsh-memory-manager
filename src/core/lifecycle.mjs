/**
 * 生命周期管理：TTL 过期、条件批量删除、存储超限清理（LRU + 低重要性优先）。
 * @module src/core/lifecycle
 */

import { nowMs } from './types.mjs'
import { dirSizeMb } from './short-term.mjs'

export class Lifecycle {
  /**
   * @param {import('./index.mjs').MemoryEngine} engine
   */
  constructor(engine) {
    this.engine = engine
  }

  /** 删除 TTL 过期记忆，返回删除数。 */
  expire() {
    const now = nowMs()
    const recs = this.engine.store.list()
    const expired = recs.filter((r) => {
      if (!r.ttl) return false
      const base = Math.max(r.created_at, r.last_accessed_at)
      return base + r.ttl < now
    })
    if (expired.length === 0) return 0
    const ids = expired.map((r) => r.id)
    const n = this.engine.store.deleteByIds(ids)
    // 与 deleteByConditions/enforceStorageLimit 保持一致：删除行同时删向量，避免孤儿向量累积
    for (const id of ids) this.engine.vector.remove(id)
    this.engine.invalidateCache(ids)
    return n
  }

  /**
   * 存储超限清理：按 (importance asc, last_accessed_at asc) 删低价值记忆。
   * 熔断：单次最多删除 50% 记录——SQLite DELETE 不归还文件页，靠磁盘字节数判断
   * 会陷入"删光了还超限"的死循环把库清空，因此必须以记录数上限兜底。
   */
  enforceStorageLimit() {
    const maxMb = Number(this.engine.config.storage.max_storage_mb) || 500
    const curMb = dirSizeMb(this.engine.baseDir)
    if (curMb <= maxMb) return 0
    const recs = this.engine.store.list()
    if (recs.length === 0) return 0
    recs.sort((a, b) => (a.importance - b.importance) || (a.last_accessed_at - b.last_accessed_at))
    // 熔断上限：单次最多删一半（防全量清空）；也不再逐条 dirSizeMb（O(N²)）
    const maxDeletable = Math.max(1, Math.floor(recs.length / 2))
    let deleted = 0
    for (let i = 0; i < recs.length && deleted < maxDeletable; i += 1) {
      this.engine.store.deleteByIds([recs[i].id])
      this.engine.vector.remove(recs[i].id)
      this.engine.invalidateCache([recs[i].id])
      deleted += 1
    }
    if (deleted > 0) {
      this.engine.lastCompacted = nowMs()
      // 尽力释放磁盘：WAL checkpoint；若仍超限则告警（不静默吞掉）
      try { this.engine.store.checkpoint?.() } catch { /* 忽略 */ }
      const afterMb = dirSizeMb(this.engine.baseDir)
      if (afterMb > maxMb) {
        console.warn(`[dsh-memory-manager] 存储超限清理：删除 ${deleted} 条后仍超限（${afterMb.toFixed(1)}MB > ${maxMb}MB）；建议增大上限或 VACUUM 释放磁盘页`)
      }
    }
    return deleted
  }

  /**
   * 条件批量删除。
   * @param {{sessionId?: string, tag?: string, isGlobal?: boolean, olderThan?: number, importanceLe?: number, ids?: string[]}} conditions
   */
  deleteByConditions(conditions = {}) {
    // 兜底：必须存在"有效过滤条件"才执行删除——空对象、`{ids:[]}` 等
    // 都代表"不匹配任何东西"，若放行会演变成清空全库。
    const hasEffective = Boolean(
      (Array.isArray(conditions.ids) && conditions.ids.length > 0) ||
      conditions.sessionId !== undefined ||
      conditions.tag !== undefined ||
      conditions.isGlobal !== undefined ||
      conditions.olderThan !== undefined ||
      conditions.importanceLe !== undefined
    )
    if (!hasEffective) {
      return { deleted_count: 0, affected_sessions: [], freed_tokens: 0 }
    }
    let recs = this.engine.store.list()
    if (Array.isArray(conditions.ids) && conditions.ids.length > 0) {
      recs = recs.filter((r) => conditions.ids.includes(r.id))
    }
    if (conditions.sessionId !== undefined) recs = recs.filter((r) => r.session_id === conditions.sessionId)
    if (conditions.tag !== undefined) recs = recs.filter((r) => r.tags.includes(conditions.tag))
    if (conditions.isGlobal !== undefined) recs = recs.filter((r) => r.is_global === conditions.isGlobal)
    if (conditions.olderThan !== undefined) recs = recs.filter((r) => r.created_at < conditions.olderThan)
    if (conditions.importanceLe !== undefined) recs = recs.filter((r) => r.importance <= conditions.importanceLe)

    const affected = new Set(recs.map((r) => r.session_id))
    const freed = recs.reduce((s, r) => s + r.tokens, 0)
    const ids = recs.map((r) => r.id)
    if (ids.length === 0) {
      return { deleted_count: 0, affected_sessions: [], freed_tokens: 0 }
    }
    const n = this.engine.store.deleteByIds(ids)
    for (const id of ids) this.engine.vector.remove(id)
    this.engine.invalidateCache(ids)
    return {
      deleted_count: n,
      affected_sessions: [...affected],
      freed_tokens: freed,
    }
  }
}
