/**
 * 语义/混合检索：向量分（余弦）+ 关键词分（词项重叠），融合打分。
 * 会话隔离：结果仅含当前会话或 is_global（且 global_memory.enabled）。
 * @module src/core/search
 */

import { countTokens } from './tokenizer.mjs'
import { tokenizeTerms } from './tokenizer.mjs'

/**
 * 关键词分数（倒排索引加速）：只对与查询共享词项的候选文档打分，
 * 替代旧版"全表扫描 + 逐条解密 + 分词"（O(全库) → O(命中集)）。
 * balanced = 0.5*recall + 0.5*coverage + 短语命中加成(0.3)。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string[]} queryTerms
 * @param {string} queryRaw
 */
function keywordScores(engine, queryTerms, queryRaw) {
  const out = new Map()
  if (queryTerms.length === 0) return out
  // 倒排索引与存储失步（旁路直插/恢复等不走 addMemory 的写入）→ 就地重建后继续
  if (engine.inverted.docCount() !== engine.store.count()) {
    engine.inverted.clear()
    for (const rec of engine.store.list()) {
      engine.inverted.add(rec.id, tokenizeTerms(engine.decryptContent(rec)))
    }
  }
  const qset = new Set(queryTerms)
  const qn = String(queryRaw || '').replace(/\s+/g, '')
  const hits = engine.inverted.lookup(queryTerms)
  for (const [id, { common, total }] of hits) {
    if (!total) continue
    const recall = common / total
    const coverage = common / Math.min(qset.size, total)
    let kw = 0.5 * recall + 0.5 * coverage
    if (qn.length >= 2) {
      const rec = engine.store.get(id)
      if (rec && engine.decryptContent(rec).replace(/\s+/g, '').includes(qn)) kw += 0.3
    }
    out.set(id, { recall, balanced: Math.min(1, kw) })
  }
  return out
}

/**
 * 检索入口。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} query
 * @param {{topK?: number, threshold?: number, hybridWeight?: number, sessionId?: string, includeGlobal?: boolean}} opts
 */
export async function search(engine, query, opts = {}) {
  const t0 = Date.now()
  const topK = Math.max(1, Math.floor(opts.topK ?? engine.config.long_term.retrieval_top_k ?? 5))
  const sessionId = opts.sessionId ?? 'default'
  const includeGlobal = opts.includeGlobal !== false && engine.config.global_memory.enabled !== false

  const queryVec = await engine.embedding.embed(query)
  const kind = engine.embedding.status().kind
  // 降级判定：哈希嵌入、API 嵌入降级、或需重建索引（向量为旧模型）时走关键词为主分支
  const needsReindex = engine.needsReindex()
  const degraded = kind === 'hash' || engine.embedding.status().degraded === true || needsReindex
  // 降级（哈希嵌入）会把相似度压缩到较低区间：将配置阈值映射到哈希尺度，
  // 避免真实命中被 0.75 阈值误杀；配置了真实嵌入模型时仍用配置阈值。
  let threshold = opts.threshold ?? engine.config.long_term.similarity_threshold ?? 0.75
  if (degraded) threshold = Math.max(0.38, threshold * 0.5)

  // 向量候选（扩大召回：取 topK * 8 或全部）。需重建索引时向量陈旧 → 不参与打分
  let vecMap = new Map()
  if (!needsReindex) {
    const vectorHits = engine.vector.search(queryVec, Math.max(topK * 8, 64))
    vecMap = new Map(vectorHits.map((h) => [h.id, h.score]))
  }

  const kwScores = keywordScores(engine, tokenizeTerms(query), query)

  // 候选并集：向量命中 + 关键词命中
  const ids = new Set([...vecMap.keys(), ...kwScores.keys()])
  // '*' / 'all' = 全部会话（GUI 管理视图用；DSH agent 侧仍按真实会话隔离）
  const noSessionFilter = sessionId === '*' || sessionId === 'all'
  const results = []
  for (const id of ids) {
    const rec = engine.store.get(id)
    if (!rec) continue
    if (!includeGlobal && rec.is_global) continue
    if (!noSessionFilter && !rec.is_global && rec.session_id !== sessionId) continue
    const vec = vecMap.get(id) ?? 0
    const kw = kwScores.get(id)
    let fused
    if (degraded) {
      // 降级（离线哈希嵌入）：关键词为主（0.75），向量为辅（0.25）
      const kwS = kw ? kw.balanced : 0
      fused = 0.25 * vec + 0.75 * kwS
    } else {
      // 正常（真实嵌入模型）：向量为主
      const kwS = kw ? kw.balanced : 0
      const w = engine.config.long_term.hybrid_weight ?? 0.7
      fused = w * vec + (1 - w) * kwS
    }
    if (fused < threshold) continue
    results.push({
      id: rec.id,
      content: engine.decryptContent(rec),
      score: Number(fused.toFixed(4)),
      session_id: rec.session_id,
      timestamp: new Date(rec.created_at).toISOString(),
      is_global: rec.is_global,
    })
  }

  results.sort((a, b) => b.score - a.score)
  const top = results.slice(0, topK)
  for (const r of top) {
    const rec = engine.store.get(r.id)
    if (rec) engine.store.touch(rec.id)
  }
  return {
    results: top,
    total: results.length,
    latency_ms: Date.now() - t0,
  }
}
