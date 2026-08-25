/**
 * 纯 JS 向量索引：内存 Map + 余弦检索，持久化到 vector.index（JSON）。
 * @module src/core/vector
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export class VectorStore {
  /** @param {string} indexFile */
  constructor(indexFile) {
    this.indexFile = indexFile
    this.entries = new Map() // id -> Float32Array
    this.model = null // {kind, dim, fingerprint}
    this.dirty = false
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

  async save() {
    const payload = {
      version: 1,
      model: this.model || null,
      entries: Object.fromEntries(
        [...this.entries.entries()].map(([id, vec]) => [id, Array.from(vec)]),
      ),
    }
    await fsp.mkdir(path.dirname(this.indexFile), { recursive: true })
    await fsp.writeFile(this.indexFile, JSON.stringify(payload), 'utf8')
    this.dirty = false
  }
}
