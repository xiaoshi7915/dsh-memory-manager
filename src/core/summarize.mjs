/**
 * 本地抽取式摘要：句频（去停用词）+ 位置加权，挑选高分句至预算。
 * @module src/core/summarize
 */

import { segmentSentences, countTokens, tokenizeTerms } from './tokenizer.mjs'
import { newId, nowMs, clampImportance } from './types.mjs'

const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '有', '和', '与', '及',
  '就', '都', '而', '及', '也', '很', '把', '被', '让', '给', '对', '于', '会', '能',
  '这', '那', '个', '之', '以', '吗', '呢', '吧', '啊', 'the', 'a', 'an', 'and', 'to',
  'of', 'in', 'is', 'it', 'on', 'for', 'with', 'as', 'at', 'by',
])

/** 抽取式摘要。 */
export function extractiveSummary(text, { maxChars = 400 } = {}) {
  const sentences = segmentSentences(String(text || ''))
  if (sentences.length === 0) return ''
  if (sentences.length === 1) {
    return sentences[0].length > maxChars ? sentences[0].slice(0, maxChars) + '…' : sentences[0]
  }
  // 词频统计（去停用词）
  const freq = new Map()
  for (const s of sentences) {
    for (const t of tokenizeTerms(s)) {
      if (STOPWORDS.has(t)) continue
      freq.set(t, (freq.get(t) ?? 0) + 1)
    }
  }
  const scored = sentences.map((s, i) => {
    let score = 0
    const seen = new Set()
    for (const t of tokenizeTerms(s)) {
      if (STOPWORDS.has(t) || seen.has(t)) continue
      seen.add(t)
      score += (freq.get(t) ?? 0) / Math.max(1, sentences.length)
    }
    // 位置加权：开头句更重要
    score *= 1 + (1 - i / sentences.length) * 0.5
    return { s, score }
  })
  scored.sort((a, b) => b.score - a.score)
  // 按预算拼接（保持原顺序）
  const chosen = new Set(scored.slice(0, Math.max(1, Math.min(3, sentences.length))).map((x) => x.s))
  let out = ''
  let tokens = 0
  for (const s of sentences) {
    if (!chosen.has(s)) continue
    if (tokens + countTokens(s) > maxChars / 4 && out.length > 0) break
    out += (out ? '；' : '') + s
    tokens += countTokens(s)
  }
  if (out.length === 0) out = sentences[0].slice(0, maxChars)
  return out
}

/**
 * 对某会话的短期对话生成摘要并存入长期记忆。
 * 支持可选 LLM 生成式摘要：`opts.llm` 为 async (text) => string，失败时回退抽取式。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} sessionId
 * @param {{count?: number, llm?: (text: string) => Promise<string|null>}} opts
 */
export async function summarizeSession(engine, sessionId, opts = {}) {
  const recent = await engine.shortTerm.getRecent(sessionId, {
    maxMessages: opts.count ?? engine.config.short_term.max_messages,
    maxTokens: engine.config.short_term.max_tokens,
  })
  const raw = recent.messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n')
  let summary = ''
  let via = 'extractive'
  if (opts.llm && raw) {
    try {
      const gen = await opts.llm(raw)
      if (gen && gen.trim().length > 0) {
        summary = gen.trim()
        via = 'llm'
      }
    } catch { /* LLM 失败 → 回退抽取式 */ }
  }
  if (!summary) summary = extractiveSummary(raw)
  if (!summary) {
    return { summary: '', memory_id: null, compressed_from: 0, saved_tokens: 0, via }
  }
  const result = await engine.addMemory({
    content: `【对话摘要】${summary}`,
    tags: ['摘要'],
    importance: 6,
    is_global: false,
    sessionId,
    source: via === 'llm' ? 'summary-llm' : 'summary',
    summaryOf: sessionId,
  })
  return {
    summary,
    memory_id: result.memory_id,
    compressed_from: recent.window_size,
    saved_tokens: Math.max(0, recent.token_count - countTokens(summary)),
    via,
  }
}
