/**
 * 短期记忆：按会话将近期对话按行追加到 JSONL，滑动窗口裁剪。
 * @module src/core/short-term
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { countTokens } from './tokenizer.mjs'

/** 数据根目录：环境变量可覆盖，默认 ~/.dsh/memory。 */
export function defaultBaseDir() {
  return process.env.DSH_MEMORY_DIR || path.join(os.homedir(), '.dsh', 'memory')
}

/** sessionId 文件名安全化。 */
export function safeSessionId(sessionId) {
  return String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '_')
}

export class ShortTermStore {
  /**
   * @param {string} baseDir
   */
  constructor(baseDir) {
    this.baseDir = baseDir
    this.dir = path.join(baseDir, 'short_term')
    this._counts = new Map() // sessionId -> 消息条数（内存计数，避免每次 count() 全量读文件）
  }

  fileFor(sessionId) {
    return path.join(this.dir, `${safeSessionId(sessionId)}.jsonl`)
  }

  async ensure() {
    await fsp.mkdir(this.dir, { recursive: true })
  }

  /**
   * 追加一条消息（role: 'user' | 'assistant'）。
   * maxLines > 0 时在文件超过该行数后裁剪为最后 maxLines 行（滑动窗口存储裁剪，
   * 避免长会话文件无限增长、count()/getRecent 每次全量读文件的 O(n²) 退化）。
   */
  async append(sessionId, role, content, { maxLines = 0 } = {}) {
    await this.ensure()
    const file = this.fileFor(sessionId)
    const line = JSON.stringify({ role, content: String(content), time: Date.now() })
    await fsp.appendFile(file, line + '\n', 'utf8')
    const n = (this._counts.get(sessionId) ?? 0) + 1
    if (maxLines > 0 && n > maxLines) {
      const kept = await this.trim(file, maxLines)
      this._counts.set(sessionId, kept)
    } else {
      this._counts.set(sessionId, n)
    }
  }

  /** 保留文件最后 maxLines 行，返回裁剪后的行数。 */
  async trim(file, maxLines) {
    try {
      const raw = await fsp.readFile(file, 'utf8')
      const lines = raw.split('\n').filter((l) => l.trim().length > 0)
      if (lines.length > maxLines) {
        await fsp.writeFile(file, lines.slice(-maxLines).join('\n') + '\n', 'utf8')
      }
      return Math.min(lines.length, maxLines)
    } catch {
      return maxLines
    }
  }

  /** 读取最近 maxMessages 条，并按 token 预算从最旧向前裁剪。 */
  async getRecent(sessionId, { maxMessages = 20, maxTokens = 4000 } = {}) {
    await this.ensure()
    let lines = []
    try {
      const raw = await fsp.readFile(this.fileFor(sessionId), 'utf8')
      lines = raw.split('\n').filter((l) => l.trim().length > 0)
    } catch {
      lines = []
    }
    let items = lines.slice(-Math.max(1, Math.floor(Number(maxMessages) || 20)))
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    let truncated = false
    if (items.length > 0) {
      let tokens = 0
      const kept = []
      // 从最新开始往前保留，直到 token 预算耗尽（超预算的消息被丢弃）。
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const t = countTokens(items[i].content)
        if (tokens + t > maxTokens && kept.length > 0) {
          truncated = true
          break
        }
        kept.unshift(items[i])
        tokens += t
      }
      items = kept
      // 重新计算 token 数（与返回的 messages 严格对应）
      tokens = items.reduce((s, m) => s + countTokens(m.content), 0)
      return {
        messages: items.map((m) => ({ role: m.role, content: m.content })),
        token_count: tokens,
        window_size: items.length,
        truncated,
      }
    }
    return { messages: [], token_count: 0, window_size: 0, truncated: false }
  }

  /** 删除某会话短期文件。 */
  async clear(sessionId) {
    this._counts.delete(sessionId)
    try {
      await fsp.unlink(this.fileFor(sessionId))
    } catch { /* 文件不存在则忽略 */ }
  }

  /** 会话消息条数（内存计数优先，冷启动回退读文件一次）。 */
  async count(sessionId) {
    const cached = this._counts.get(sessionId)
    if (cached !== undefined) return cached
    let n = 0
    try {
      const raw = await fsp.readFile(this.fileFor(sessionId), 'utf8')
      n = raw.split('\n').filter((l) => l.trim().length > 0).length
    } catch { /* 文件不存在视为 0 */ }
    this._counts.set(sessionId, n)
    return n
  }
}

export function dirSizeMb(dir) {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else total += fs.statSync(p).size
    }
  }
  walk(dir)
  return total / (1024 * 1024)
}
