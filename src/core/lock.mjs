/**
 * 单写者锁：数据目录下原子创建 .lock（fs.openSync 'wx'），只允许一个进程写。
 * - 内容：{pid, hostname, mode, startedAt, heartbeat}
 * - 陈旧判定：持有者 pid 不再存活 → 接管（Windows 友好，process.kill(pid,0)）。
 * - 释放：仅创建者删除（内容身份匹配，防误删他人新锁）。
 * - 第二个持有者：抛 MemoryError('LOCKED', ...) → 插件/服务快速失败。
 * @module src/core/lock
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MemoryError } from './types.mjs'

const LOCK_FILE = '.lock'
const DEFAULT_HEARTBEAT_MS = 15000

/** pid 是否存活（Windows 友好：信号 0 探测存在性）。 */
export function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // 存在但无权限
  }
}

export class DirLock {
  /**
   * @param {string} dir 数据目录
   * @param {{mode?: 'plugin'|'serve', heartbeatMs?: number}} [opts]
   */
  constructor(dir, { mode = 'plugin', heartbeatMs = DEFAULT_HEARTBEAT_MS } = {}) {
    this.dir = dir
    this.lockPath = path.join(dir, LOCK_FILE)
    this.mode = mode
    this.heartbeatMs = heartbeatMs
    this.owned = false
    this.meta = null
    this._heartbeatTimer = null
  }

  /** 尝试获取锁。已持有时抛 MemoryError('LOCKED')；陈旧锁自动接管。 */
  acquire() {
    fs.mkdirSync(this.dir, { recursive: true })
    const meta = {
      pid: process.pid,
      hostname: os.hostname(),
      mode: this.mode,
      startedAt: Date.now(),
      heartbeat: Date.now(),
    }
    try {
      const fd = fs.openSync(this.lockPath, 'wx') // 原子创建，绝不覆盖已存在
      try {
        fs.writeFileSync(fd, JSON.stringify(meta, null, 2), 'utf8')
      } finally {
        fs.closeSync(fd)
      }
      this.owned = true
      this.meta = meta
      this._startHeartbeat()
      return this
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const holder = this._read()
      if (holder && ownerAlive(holder.pid)) {
        throw new MemoryError(
          'LOCKED',
          `数据目录被其他进程占用（pid=${holder.pid}, mode=${holder.mode ?? '?'}, 起始于 ${new Date(holder.startedAt ?? Date.now()).toISOString()}）：${this.lockPath}`,
        )
      }
      // 陈旧锁（持有者已死）→ 删除后重试接管
      try { fs.unlinkSync(this.lockPath) } catch { /* 忽略 */ }
      return this.acquire()
    }
  }

  /** 是否由本进程持有。 */
  isOwned() {
    return this.owned
  }

  /** 刷新心跳（写入 heartbeat 时间戳）。 */
  touch() {
    if (!this.owned || !this.meta) return
    this.meta.heartbeat = Date.now()
    try {
      fs.writeFileSync(this.lockPath, JSON.stringify(this.meta, null, 2), 'utf8')
    } catch { /* 忽略：写失败不致命，释放时仍按身份匹配删除 */ }
  }

  /** 仅创建者释放（内容身份匹配才删）。 */
  release() {
    if (!this.owned) return
    this._stopHeartbeat()
    try {
      const cur = this._read()
      if (cur && cur.pid === process.pid && cur.startedAt === this.meta?.startedAt) {
        fs.unlinkSync(this.lockPath)
      }
    } catch { /* 忽略 */ }
    this.owned = false
    this.meta = null
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath, 'utf8'))
    } catch { return null }
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this._heartbeatTimer = setInterval(() => this.touch(), this.heartbeatMs)
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref()
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }
}

/** 便捷：探测目录当前是否被他人持有（不获取）。 */
export function isLockedByOther(dir) {
  try {
    const holder = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'))
    return Boolean(holder && ownerAlive(holder.pid))
  } catch { return false }
}
