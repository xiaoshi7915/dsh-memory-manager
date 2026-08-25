/**
 * 导入导出：JSON / JSONL 备份与恢复。
 * @module src/core/io
 */

import { newId, nowMs, clampImportance } from './types.mjs'

/** 导出备份文本。 */
export async function exportBackup(engine, { format = 'json' } = {}) {
  const memories = engine.store.list().map((r) => ({ ...r, content: engine.decryptContent(r) }))
  const payload = {
    version: 1,
    exported_at: new Date(nowMs()).toISOString(),
    counts: memories.length,
    memories,
  }
  if (format === 'jsonl') {
    return memories.map((m) => JSON.stringify(m)).join('\n')
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * 导入备份文本。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} text
 * @param {{mode?: 'merge'|'replace'}} opts
 */
export async function importBackup(engine, text, { mode = 'merge' } = {}) {
  let records = []
  const text0 = String(text || '').trim()
  try {
    const parsed = JSON.parse(text0)
    records = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.memories) ? parsed.memories : [parsed]
  } catch {
    // 非单对象 JSON → 按 JSONL 逐行解析
    const lines = text0.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    try {
      records = lines.map((l) => JSON.parse(l))
    } catch {
      throw new Error('备份文件格式无效：仅支持 JSON 或 JSONL')
    }
  }

  if (mode === 'replace') {
    const all = engine.store.list().map((r) => r.id)
    if (all.length > 0) {
      engine.store.deleteByIds(all)
      for (const id of all) engine.vector.remove(id)
    }
  }

  let imported = 0
  let skipped = 0
  let failed = 0
  const existing = new Set(engine.store.list().map((r) => r.id))
  for (const raw of records) {
    try {
      if (!raw || typeof raw.content !== 'string' || raw.content.length === 0) {
        failed += 1
        continue
      }
      const id = typeof raw.id === 'string' && raw.id ? raw.id : newId()
      if (existing.has(id)) {
        skipped += 1
        continue
      }
      const rec = {
        id,
        content: raw.content,
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        importance: clampImportance(raw.importance ?? 5),
        is_global: raw.is_global === true || raw.is_global === 1,
        session_id: typeof raw.session_id === 'string' ? raw.session_id : 'default',
        created_at: Number(raw.created_at) || nowMs(),
        last_accessed_at: Number(raw.last_accessed_at) || nowMs(),
        ttl: raw.ttl === undefined || raw.ttl === null ? null : Number(raw.ttl),
        source: typeof raw.source === 'string' ? raw.source : 'import',
        tokens: Number(raw.tokens) || 0,
        summary_of: typeof raw.summary_of === 'string' ? raw.summary_of : null,
      }
      await engine.addMemory({ ...rec, sessionId: rec.session_id })
      existing.add(id)
      imported += 1
    } catch {
      failed += 1
    }
  }
  return { imported, skipped, failed }
}
