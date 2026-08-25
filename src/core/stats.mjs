/**
 * 统计信息。
 * @module src/core/stats
 */

import { dirSizeMb } from './short-term.mjs'

export async function stats(engine) {
  const longTermCount = engine.store.count()
  const shortTerm = await engine.shortTerm.getRecent('__all__', {
    maxMessages: Number.MAX_SAFE_INTEGER,
    maxTokens: Number.MAX_SAFE_INTEGER,
  })
  // 遍历各会话的短期 token 总量
  const fs = await import('node:fs')
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')
  let shortTermTokens = 0
  let shortTermMessages = 0
  const stDir = path.join(engine.baseDir, 'short_term')
  try {
    if (fs.existsSync(stDir)) {
      const files = fs.readdirSync(stDir)
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const lines = (await fsp.readFile(path.join(stDir, f), 'utf8')).split('\n').filter(Boolean)
        shortTermMessages += lines.length
        for (const line of lines) {
          try {
            const m = JSON.parse(line)
            shortTermTokens += engine.countTokens(m.content ?? '')
          } catch { /* 忽略坏行 */ }
        }
      }
    }
  } catch { /* 目录不存在 */ }

  return {
    total_memories: longTermCount + shortTermMessages,
    short_term_tokens: shortTermTokens,
    long_term_count: longTermCount,
    storage_size_mb: Number(dirSizeMb(engine.baseDir).toFixed(2)),
    last_compacted: engine.lastCompacted ? new Date(engine.lastCompacted).toISOString() : null,
    embedding_model: engine.config.long_term.embedding_model,
    embedding_status: engine.embedding.status().kind === 'hash' ? 'degraded' : 'completed',
    needs_reindex: engine.needsReindex(),
  }
}
