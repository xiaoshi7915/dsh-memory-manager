/**
 * 会话记忆档位存储：sessionId → auto|chat|work|off 的持久化映射（P6）。
 * 复刻 dsh-layered-memory 的 session-modes 思路（独立实现）：
 *  - 热路径（捕获/蒸馏/召回）需同步读 → init() 一次性载入内存 Map，set() 写穿持久化。
 *  - 持久化失败仅降级内存态（warn 不崩），与插件存储降级不变式一致。
 *  - 原子写复用 writeFileAtomic（同目录 tmp + fsync + rename），串行写队列避免并发碰撞。
 *  - 过期清理（90 天未更新逐出）+ 条数上限（500，按 updatedAt 淘汰最旧）。
 * 档位语义（与 layered 对齐）：
 *  - off：会话对记忆系统完全隐身（不捕获、不蒸馏、不召回）
 *  - auto（默认）：跟随宿主协调（layered 在场则让位）
 *  - chat / work：强制捕获与蒸馏（工作域优先；chat/work 区分在蒸馏管线 P8 生效）
 * @module src/core/modes
 */

import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { writeFileAtomic, recoverOrphanTmp } from './atomic.mjs'

export const MEMORY_MODES = ['auto', 'chat', 'work', 'off']
export const DEFAULT_MODE = 'auto'
const PRUNE_MS = 90 * 24 * 3600_000
const MAX_ENTRIES = 500

/** 校验是否为合法档位。 */
export function isMemoryMode(v) {
  return typeof v === 'string' && MEMORY_MODES.includes(v)
}

export class SessionModeStore {
  /**
   * @param {string} dataDir 数据目录（session-modes.json 写在这里）
   * @param {{log?: {warn?: Function, info?: Function}}} [opts]
   */
  constructor(dataDir, opts = {}) {
    this.file = path.join(dataDir, 'session-modes.json')
    this.log = opts.log || null
    this.entries = new Map()
    this.defaultMode = DEFAULT_MODE
    this.onModeChange = null
    this.writeChain = Promise.resolve()
    this.persistFailed = false
  }

  /** 载入持久化映射（启动时 await；失败降级内存态）。 */
  async init() {
    try {
      if (!fs.existsSync(this.file)) return
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      if (!data?.sessions || typeof data.sessions !== 'object') return
      const now = Date.now()
      let count = 0
      for (const [sid, entry] of Object.entries(data.sessions)) {
        if (!isMemoryMode(entry?.mode)) continue
        if (now - (entry?.updatedAt ?? 0) > PRUNE_MS) continue
        this.entries.set(sid, { mode: entry.mode, updatedAt: entry.updatedAt ?? now })
        count += 1
      }
      if (count > 0) this.log?.info?.(`[memory-manager] 会话档位载入 ${count} 条（默认 ${this.defaultMode}）`)
    } catch {
      // 损坏/不可读 → 空映射起步（默认档位），下次 set 重建
    }
  }

  get default() {
    return this.defaultMode
  }

  /** 同步读：未设置的会话返回默认档位。 */
  get(sessionId) {
    return this.entries.get(sessionId)?.mode ?? this.defaultMode
  }

  /** 注册档位切换回调（同步调用；回调异常仅记日志不阻断写穿）。 */
  setModeChangeHandler(cb) {
    this.onModeChange = cb
  }

  /** 设置会话档位（写穿持久化；持久化失败保持内存态生效）。 */
  set(sessionId, mode) {
    if (!isMemoryMode(mode)) {
      throw new TypeError(`非法档位: ${mode}（允许 ${MEMORY_MODES.join('/')}）`)
    }
    const old = this.get(sessionId)
    this.entries.set(sessionId, { mode, updatedAt: Date.now() })
    this.writeChain = this.writeChain.then(() => this.persist()).catch(() => {})
    if (old !== mode && this.onModeChange) {
      try {
        this.onModeChange(sessionId, old, mode)
      } catch (err) {
        this.log?.warn?.(`[memory-manager] 档位切换回调失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { session_id: sessionId, mode, old_mode: old }
  }

  /** 等待在途持久化写完成（测试/停机用）。 */
  flush() {
    return this.writeChain
  }

  async persist() {
    try {
      await writeFileAtomic(this.file, JSON.stringify(this.serialize(), null, 2))
      this.persistFailed = false
    } catch (err) {
      if (!this.persistFailed) {
        this.persistFailed = true
        this.log?.warn?.(`[memory-manager] 会话档位持久化失败（降级内存态）: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** 序列化：过期清理 + 条数上限（按 updatedAt 淘汰最旧）。 */
  serialize() {
    const now = Date.now()
    for (const [sid, e] of this.entries) {
      if (now - e.updatedAt > PRUNE_MS) this.entries.delete(sid)
    }
    while (this.entries.size > MAX_ENTRIES) {
      let oldest
      let oldestAt = Infinity
      for (const [sid, e] of this.entries) {
        if (e.updatedAt < oldestAt) { oldest = sid; oldestAt = e.updatedAt }
      }
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    const sessions = {}
    for (const [sid, e] of this.entries) sessions[sid] = e
    return { version: 1, sessions }
  }

  /** 启动清理孤儿 tmp（崩溃残留）。 */
  async recoverTmp() {
    return recoverOrphanTmp(path.dirname(this.file), { pattern: /session-modes\.json\.tmp-\d+$/ })
  }
}
