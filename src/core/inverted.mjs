/**
 * 内存倒排索引：term → Map<id, freq>，附 docTerms(id → 词项列表) 供删除时回撤。
 * 关键词检索从「全表扫描 + 逐条解密 + 分词」降到「按查询词项取倒排并集」，
 * 并在 add/remove 上增量维护（与 SQLite 元数据 + 向量索引并行）。
 * @module src/core/inverted
 */

export class InvertedIndex {
  constructor() {
    /** @type {Map<string, Map<string, number>>} term -> Map<id, freq> */
    this.map = new Map()
    /** @type {Map<string, string[]>} id -> 去重后的词项（用于删除时回撤 + recall 分母） */
    this.docTerms = new Map()
    this.size = 0
  }

  /** 添加/替换一篇文档的词项。 */
  add(id, terms) {
    if (this.docTerms.has(id)) this.removeDoc(id)
    const uniq = [...new Set(terms)]
    for (const t of uniq) {
      let m = this.map.get(t)
      if (!m) { m = new Map(); this.map.set(t, m) }
      m.set(id, (m.get(id) ?? 0) + 1)
    }
    this.docTerms.set(id, uniq)
    this.size += 1
  }

  /** 删除一篇文档（按记录的词项回撤所有倒排项）。 */
  removeDoc(id) {
    const terms = this.docTerms.get(id)
    if (!terms) return
    for (const t of terms) {
      const m = this.map.get(t)
      if (!m) continue
      m.delete(id)
      if (m.size === 0) this.map.delete(t)
    }
    this.docTerms.delete(id)
    this.size = Math.max(0, this.size - 1)
  }

  /**
   * 查询：返回与任一查询词项共享的文档 {id -> {common, total}}。
   * total = 文档去重词项数（recall 分母），common = 命中的查询词项数。
   */
  lookup(terms) {
    const qset = new Set(terms)
    const out = new Map()
    for (const t of qset) {
      const m = this.map.get(t)
      if (!m) continue
      for (const [id] of m) {
        const e = out.get(id)
        if (e) e.common += 1
        else out.set(id, { common: 1, total: this.docTerms.get(id)?.length ?? 1 })
      }
    }
    return out
  }

  /** 清空（替换导入/全量重建时）。 */
  clear() {
    this.map.clear()
    this.docTerms.clear()
    this.size = 0
  }

  docCount() {
    return this.size
  }
}
