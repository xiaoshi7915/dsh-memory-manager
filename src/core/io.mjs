/**
 * 导入导出：JSON / JSONL 备份与恢复。
 * v2 全量：L0 对话 / L1 原子记忆 / L2 场景 / L3 画像 / 日志 全包含（JSON 格式）；
 * JSONL 仍为 L1 记忆逐行（向后兼容）。
 * @module src/core/io
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { newId, nowMs, clampImportance } from './types.mjs'
import { countTokens, tokenizeTerms } from './tokenizer.mjs'
import { parseSceneMeta } from './layered.mjs'
import { safeSceneName, sceneFileContent } from './distill.mjs'

/** 读 L0 对话（conversations/*.jsonl，全部会话，倒序）。 */
export function readAllConversations(baseDir) {
  const conv = path.join(baseDir, 'conversations')
  const recs = []
  try {
    for (const f of fs.readdirSync(conv).filter((x) => x.endsWith('.jsonl'))) {
      const raw = fs.readFileSync(path.join(conv, f), 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try { recs.push(JSON.parse(line)) } catch { /* 单行损坏跳过 */ }
      }
    }
  } catch { /* 无对话目录 */ }
  return recs
}

/** 读 L2 场景（scenes/{family}/*.md → {name, meta, content}）。 */
export function readAllScenes(baseDir) {
  const out = { chat: [], work: [] }
  for (const family of ['chat', 'work']) {
    const dir = path.join(baseDir, 'scenes', family)
    let files = []
    try { files = fs.readdirSync(dir).filter((x) => x.endsWith('.md')) } catch { continue }
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8')
        const meta = parseSceneMeta(raw)
        // content = META-END 之后的正文（剥离前块）
        const body = raw.split('-----META-END-----').slice(1).join('-----META-END-----').trim()
        out[family].push({ name: path.basename(f, '.md'), meta, content: body })
      } catch { /* 跳过损坏 */ }
    }
  }
  return out
}

/** 读 L3 画像（persona-{family}.md → 原文）。 */
export function readAllPersonas(baseDir) {
  const out = { chat: null, work: null }
  for (const family of ['chat', 'work']) {
    const p = path.join(baseDir, `persona-${family}.md`)
    try { out[family] = fs.readFileSync(p, 'utf8') } catch { /* 缺席 */ }
  }
  return out
}

/** 读日志（memory.log + .1，原始行）。 */
export function readAllLogs(baseDir) {
  const out = []
  for (const f of ['memory.log.1', 'memory.log']) {
    const p = path.join(baseDir, f)
    try {
      const raw = fs.readFileSync(p, 'utf8')
      for (const line of raw.split('\n')) if (line.trim()) out.push(line)
    } catch { /* 缺席 */ }
  }
  return out
}

/** 导出备份文本。format=json（默认）：v2 全量含 L0-L3 + 日志；format=jsonl：L1 逐行（兼容）。 */
export async function exportBackup(engine, { format = 'json' } = {}) {
  const memories = engine.store.list().map((r) => ({ ...r, content: engine.decryptContent(r) }))
  if (format === 'jsonl') {
    return memories.map((m) => JSON.stringify(m)).join('\n')
  }
  const payload = {
    version: 2,
    exported_at: new Date(nowMs()).toISOString(),
    counts: {
      memories: memories.length,
      conversations: readAllConversations(engine.baseDir).length,
      scenes: { chat: readAllScenes(engine.baseDir).chat.length, work: readAllScenes(engine.baseDir).work.length },
      personas: Object.values(readAllPersonas(engine.baseDir)).filter(Boolean).length,
      logs: readAllLogs(engine.baseDir).length,
    },
    memories,
    conversations: readAllConversations(engine.baseDir),
    scenes: readAllScenes(engine.baseDir),
    personas: readAllPersonas(engine.baseDir),
    logs: readAllLogs(engine.baseDir),
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * 导入备份文本。
 * v2 全量：L1 记忆（merge/replace）+ L0 对话追加 + L2 场景落盘 + L3 画像落盘 + 日志追加。
 * v1/纯记忆/JSONL：仅 L1 记忆（向后兼容）。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} text
 * @param {{mode?: 'merge'|'replace'}} opts
 */
export async function importBackup(engine, text, { mode = 'merge' } = {}) {
  const text0 = String(text || '').trim()
  // 识别 v2 全量对象
  let parsed = null
  let records = []
  let isFull = false
  try {
    parsed = JSON.parse(text0)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version === 2) {
      isFull = true
      records = Array.isArray(parsed.memories) ? parsed.memories : []
    } else {
      records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.memories) ? parsed.memories : [parsed]
    }
  } catch {
    const lines = text0.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    try { records = lines.map((l) => JSON.parse(l)) } catch { throw new Error('备份文件格式无效：仅支持 JSON 或 JSONL') }
  }

  // ---- L1 记忆 ----
  if (mode === 'replace') {
    const all = engine.store.list().map((r) => r.id)
    if (all.length > 0) {
      engine.store.deleteByIds(all)
      engine.vector.clear()
      engine.inverted.clear()
    }
  }
  let imported = 0, skipped = 0, failed = 0
  const existing = new Set(engine.store.list().map((r) => r.id))
  for (const raw of records) {
    try {
      if (!raw || typeof raw.content !== 'string' || raw.content.length === 0) { failed += 1; continue }
      const id = typeof raw.id === 'string' && raw.id ? raw.id : newId()
      if (existing.has(id)) { skipped += 1; continue }
      const content = String(raw.content)
      const rec = {
        id,
        content,
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        importance: clampImportance(raw.importance ?? 5),
        is_global: raw.is_global === true || raw.is_global === 1,
        session_id: typeof raw.session_id === 'string' ? raw.session_id : 'default',
        created_at: Number(raw.created_at) || nowMs(),
        last_accessed_at: Number(raw.last_accessed_at) || nowMs(),
        ttl: raw.ttl === undefined || raw.ttl === null ? null : Number(raw.ttl),
        source: typeof raw.source === 'string' ? raw.source : 'import',
        tokens: Number(raw.tokens) || countTokens(content),
        summary_of: typeof raw.summary_of === 'string' && raw.summary_of ? raw.summary_of : null,
      }
      const vec = await engine.embedding.embed(content)
      engine.store.insert({
        id: rec.id,
        content: engine.crypto.active() ? engine.crypto.encrypt(content) : content,
        tags: rec.tags, importance: rec.importance, is_global: rec.is_global,
        session_id: rec.session_id, created_at: rec.created_at, last_accessed_at: rec.last_accessed_at,
        ttl: rec.ttl, source: rec.source, tokens: rec.tokens, summary_of: rec.summary_of,
      })
      engine.vector.upsert(rec.id, vec)
      engine.inverted.add(rec.id, tokenizeTerms(content))
      existing.add(id)
      imported += 1
    } catch { failed += 1 }
  }
  try { await engine.persistVectors() } catch { /* 忽略 */ }

  // ---- L0/L2/L3/日志（仅 v2 全量） ----
  let conversations = 0, scenes = 0, personas = 0, logs = 0
  if (isFull && parsed) {
    // L0 对话 → 追加 conversations/YYYY-MM-DD.jsonl
    if (Array.isArray(parsed.conversations) && parsed.conversations.length > 0) {
      const { persistL0 } = await import('./distill.mjs')
      const grouped = new Map()
      for (const c of parsed.conversations) {
        if (!c || typeof c.content !== 'string') continue
        const sid = typeof c.session_id === 'string' && c.session_id ? c.session_id : 'default'
        if (!grouped.has(sid)) grouped.set(sid, [])
        grouped.get(sid).push({ role: c.role || 'user', content: c.content, time: c.time || c.timestamp || nowMs() })
      }
      for (const [sid, turns] of grouped) {
        const r = await persistL0(engine, sid, turns)
        conversations += r.appended
      }
    }
    // L2 场景 → 写 scenes/{family}/{name}.md
    if (parsed.scenes && typeof parsed.scenes === 'object') {
      for (const family of ['chat', 'work']) {
        const list = parsed.scenes[family]
        if (!Array.isArray(list)) continue
        for (const sc of list) {
          if (!sc || typeof sc !== 'object') continue
          const name = safeSceneName(sc.name || sc.scene_name)
          const dir = path.join(engine.baseDir, 'scenes', family)
          await fsp.mkdir(dir, { recursive: true })
          await fsp.writeFile(path.join(dir, `${name}.md`), sceneFileContent({
            summary: sc.summary || sc.meta?.summary || '',
            heat: sc.heat || sc.meta?.heat || 1,
            body: sc.content || sc.body || '',
          }), 'utf8')
          scenes += 1
        }
      }
    }
    // L3 画像 → 写 persona-{family}.md
    if (parsed.personas && typeof parsed.personas === 'object') {
      for (const family of ['chat', 'work']) {
        const body = parsed.personas[family]
        if (typeof body !== 'string' || !body.trim()) continue
        await fsp.writeFile(path.join(engine.baseDir, `persona-${family}.md`), body, 'utf8')
        personas += 1
      }
    }
    // 日志 → 追加 memory.log（去重：跳过已存在的行）
    if (Array.isArray(parsed.logs) && parsed.logs.length > 0) {
      const logPath = path.join(engine.baseDir, 'memory.log')
      const existingLines = new Set()
      try {
        for (const l of readAllLogs(engine.baseDir)) existingLines.add(l)
      } catch { /* 忽略 */ }
      const fresh = parsed.logs.filter((l) => typeof l === 'string' && l.trim() && !existingLines.has(l.trim()))
      if (fresh.length > 0) {
        await fsp.appendFile(logPath, fresh.map((l) => l.trim()).join('\n') + '\n', 'utf8')
        logs += fresh.length
      }
    }
  }

  return { imported, skipped, failed, conversations, scenes, personas, logs }
}
