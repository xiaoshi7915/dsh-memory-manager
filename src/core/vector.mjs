/**
 * 纯 JS 向量索引：内存 Map + 余弦检索，持久化到 vector.index（JSON）。
 * 持久化走原子写（writeFileAtomic）+ 串行合并队列：并发 save 折叠、
 * 快照在写时抓取，崩溃不留半写文件（启动时 recoverTmp 清理孤儿 tmp）。
 * @module src/core/vector
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic, recoverOrphanTmp } from './atomic.mjs'

export class VectorStore {
  /** @param {string} indexFile */
  constructor(indexFile) {
    this.indexFile = indexFile
    this.entries = new Map() // id -> Float32Array
    this.model = null // {kind, dim, fingerprint}
    this.dirty = false
    this._saving = null // 串行写链
    this._dirtyQueued = false
  }

  load() {
    try {
      if (!fs.existsSync(this.indexFile)) return
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
      if (raw && raw.version === 1) {
        this.model = raw.model || null
        for (const [id, arr] of Object.entries(raw.entries || {})) {
          this.entries.set(id, Float32Array.from(arr))
        }
      }
    } catch {
      this.entries = new Map()
      this.model = null
    }
  }

  /** 清理崩溃残留的孤儿 tmp（启动时调用一次）。 */
  async recoverTmp() {
    return recoverOrphanTmp(path.dirname(this.indexFile), { pattern: /\.tmp-\d+$/ })
  }

  setModel(model) {
    this.model = model
    this.dirty = true
  }

  fingerprint() {
    return this.model ? this.model.fingerprint : undefined
  }

  upsert(id, vec) {
    this.entries.set(id, vec)
    this.dirty = true
  }

  remove(id) {
    this.dirty = this.entries.delete(id) || this.dirty
  }

  clear() {
    this.entries = new Map()
    this.model = null
    this.dirty = true
  }

  size() {
    return this.entries.size
  }

  /** 余弦相似度检索，返回按 score 降序的 [{id, score}]。 */
  search(queryVec, topK = 5) {
    const results = []
    for (const [id, vec] of this.entries) {
      // 维度不一致（换模型/降级嵌入的混合）跳过——否则点积得 NaN 污染排序
      if (vec.length !== queryVec.length) continue
      let dot = 0
      for (let i = 0; i < vec.length; i += 1) dot += vec[i] * queryVec[i]
      if (dot < 0) dot = 0
      results.push({ id, score: dot })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, Math.max(0, Math.floor(topK)))
  }

  /**
   * 持久化：串行合并队列。并发 save() 共享同一条写链（折叠），
   * 每次写前抓快照（快照即执行点状态），写后清 dirty；写期间又有变更
   * （dirty 或新 save 入队）则再写一轮，收敛到最新状态。
   * @returns {Promise<void>} 解析时「排队结束前的最新脏状态」已落盘
   */
  save() {
    this._dirtyQueued = true
    if (this._saving) return this._saving
    this._saving = this._drain().finally(() => {
      this._saving = null
    })
    return this._saving
  }

  async _drain() {
    let rounds = 0
    do {
      this._dirtyQueued = false
      rounds += 1
      await this._writeSnapshot()
      this.dirty = false
    } while ((this.dirty || this._dirtyQueued) && rounds < 8) // 有界收敛，防活锁
  }

  async _writeSnapshot() {
    const payload = {
      version: 1,
      model: this.model || null,
      entries: Object.fromEntries(
        [...this.entries.entries()].map(([id, vec]) => [id, Array.from(vec)]),
      ),
    }
    await writeFileAtomic(this.indexFile, JSON.stringify(payload))
  }
}
