/**
 * 语义/混合检索：向量分（余弦）+ 关键词分（词项重叠），融合打分。
 * 会话隔离：结果仅含当前会话或 is_global（且 global_memory.enabled）。
 * 全层检索（scope='all'）：额外并入 L0 对话 / L2 场景 / L3 画像 / 日志 的关键词命中，
 * 结果带 source/layer 标记（P4 可观测），GUI 语义检索默认全层。
 * @module src/core/search
 */

import { countTokens } from './tokenizer.mjs'
import { tokenizeTerms } from './tokenizer.mjs'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 关键词对单文本打分（词项重叠，0..1）；queryTerms 为空返回 null。 */
function keywordScoreFor(text, queryTerms, queryRaw) {
  if (!text || queryTerms.length === 0) return null
  const toks = tokenizeTerms(text)
  if (toks.length === 0) return null
  const qset = new Set(queryTerms)
  let common = 0
  for (const t of toks) if (qset.has(t)) common += 1
  if (common === 0) return null
  const recall = common / toks.length
  const coverage = common / Math.min(qset.size, toks.length)
  let kw = 0.5 * recall + 0.5 * coverage
  const qn = String(queryRaw || '').replace(/\s+/g, '')
  if (qn.length >= 2 && text.replace(/\s+/g, '').includes(qn)) kw += 0.3
  return Math.min(1, kw)
}

/**
 * 全层关键词检索（L0/L2/L3/日志）：scope='all' 时并入主结果。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} query
 * @returns {Array<{content:string, score:number, source:string, layer:string, session_id:string, timestamp:number}>}
 */
export function searchLayers(engine, query) {
  const queryTerms = tokenizeTerms(query)
  const out = []
  const baseDir = engine.baseDir
  if (queryTerms.length === 0) return out
  const push = (content, layer, source, session_id, timestamp) => {
    const sc = keywordScoreFor(content, queryTerms, query)
    if (sc == null) return
    out.push({ content: content.slice(0, 2000), score: sc, source, layer, session_id, timestamp })
  }
  // L0 对话（conversations/*.jsonl）
  const conv = join(baseDir, 'conversations')
  try {
    for (const f of readdirSync(conv).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(conv, f), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          push(r.content || '', 'l0', 'conversation', r.session_id || 'default', Number(r.time) || 0)
        } catch { /* 跳过损坏行 */ }
      }
    }
  } catch { /* 无对话 */ }
  // L2 场景
  for (const family of ['chat', 'work']) {
    const dir = join(baseDir, 'scenes', family)
    let files = []
    try { files = readdirSync(dir).filter((x) => x.endsWith('.md')) } catch { continue }
    for (const f of files) {
      try {
        const md = readFileSync(join(dir, f), 'utf8')
        // 剥 META 前块，保留正文
        const body = md.split('-----META-END-----').slice(1).join('').trim()
        if (body) push(body, 'l2', 'scene', 'default', 0)
      } catch { /* 跳过 */ }
    }
  }
  // L3 画像
  for (const family of ['chat', 'work']) {
    const p = join(baseDir, `persona-${family}.md`)
    try {
      if (existsSync(p)) {
        const body = readFileSync(p, 'utf8')
        if (body.trim()) push(body, 'l3', 'persona', 'default', 0)
      }
    } catch { /* 跳过 */ }
  }
  // 日志
  for (const f of ['memory.log', 'memory.log.1']) {
    const p = join(baseDir, f)
    try {
      if (existsSync(p)) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          if (line.trim()) push(line, 'log', 'memory-log', 'default', 0)
        }
      }
    } catch { /* 跳过 */ }
  }
  // 每层最多保留 3 条最高分（避免日志/对话刷屏），排序取 top
  const perLayer = new Map()
  for (const r of out) {
    const k = r.layer
    if (!perLayer.has(k)) perLayer.set(k, [])
    perLayer.get(k).push(r)
  }
  const capped = []
  for (const list of perLayer.values()) {
    list.sort((a, b) => b.score - a.score)
    capped.push(...list.slice(0, 3))
  }
  return capped.sort((a, b) => b.score - a.score)
}

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
 * @param {{topK?: number, threshold?: number, hybridWeight?: number, sessionId?: string, includeGlobal?: boolean, offset?: number}} opts
 */
export async function search(engine, query, opts = {}) {
  const t0 = Date.now()
  const topK = Math.max(1, Math.floor(opts.topK ?? engine.config.long_term.retrieval_top_k ?? 5))
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const sessionId = opts.sessionId ?? 'default'
  const includeGlobal = opts.includeGlobal !== false && engine.config.global_memory.enabled !== false

  const queryVec = await engine.embedding.embed(query)
  const kind = engine.embedding.status().kind
  // 降级判定：哈希嵌入、API 嵌入降级、需重建索引、或嵌入关闭（off=纯关键词）时走关键词为主分支
  const needsReindex = engine.needsReindex()
  const degraded = kind === 'hash' || kind === 'off' || engine.embedding.status().degraded === true || needsReindex
  // 降级（哈希嵌入）会把相似度压缩到较低区间：将配置阈值映射到哈希尺度，
  // 避免真实命中被 0.75 阈值误杀；配置了真实嵌入模型时仍用配置阈值。
  let threshold = opts.threshold ?? engine.config.long_term.similarity_threshold ?? 0.75
  if (degraded) threshold = Math.max(0.38, threshold * 0.5)

  // 向量候选（P3 召回池下限 64；🔴6 取消 100 硬封顶——否则 offset>95 深翻页必翻空。
  // 改为覆盖当前页的「下限」，候选池随 offset 线性增长，保证任意 offset 都能取到结果；
  // 代价是深翻页召回量增大，但语义检索本就是 topK 排序，极少深翻，正确性优先。）
  const pool = Math.max(topK * 8, 64, offset + topK)
  let vecMap = new Map()
  if (!needsReindex) {
    const vectorHits = engine.vector.search(queryVec, pool)
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
      // P4 可观测：Agent 跨源融合时能分辨来源与层级（本库 / 摘要）
      source: 'memory-manager',
      layer: rec.source === 'summary' || rec.summary_of ? 'summary' : 'long_term',
    })
  }

  results.sort((a, b) => b.score - a.score)

  // scope='all'（GUI 语义检索默认）：并入 L0 对话 / L2 场景 / L3 画像 / 日志 关键词命中。
  // 层结果与长时记忆结果统一按 score 排序、分页，均带 source/layer（P4 可观测）。
  let layerResults = []
  if (opts.scope === 'all') {
    for (const lr of searchLayers(engine, query)) {
      if (lr.score < threshold) continue
      layerResults.push({
        id: `layer:${lr.layer}:${lr.source}:${lr.timestamp}:${lr.content.slice(0, 16)}`,
        content: lr.content,
        score: Number(lr.score.toFixed(4)),
        session_id: lr.session_id,
        timestamp: lr.timestamp ? new Date(lr.timestamp).toISOString() : '',
        is_global: false,
        source: lr.source,
        layer: lr.layer,
        isLayer: true,
      })
    }
  }

  const merged = [...results, ...layerResults].sort((a, b) => b.score - a.score)
  const top = merged.slice(offset, offset + topK)
  for (const r of top) {
    if (r.isLayer) continue
    const rec = engine.store.get(r.id)
    if (rec) engine.store.touch(rec.id)
  }
  return {
    results: top,
    total: merged.length,
    latency_ms: Date.now() - t0,
    page: { offset, limit: topK, total: merged.length },
  }
}
