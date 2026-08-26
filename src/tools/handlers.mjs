/**
 * 7 个 Agent 工具的处理函数（纯逻辑，与 DSH/HTTP 解耦）。
 * 每个 handler 签名：(args, ctx) => Promise<result>，ctx = { engine, sessionId }。
 * 返回结构与 contracts/tools.md 完全一致；错误抛 MemoryError（含 code）。
 * 对外名（mm_*）与旧名（memory_*）统一经 names.mjs 映射；HANDLERS 两种键都挂同一实现。
 * @module src/tools/handlers
 */

import { MemoryError, assertString, assertNumber, assertBoolean, assertTags, newId, nowMs } from '../core/types.mjs'
import { countTokens } from '../core/tokenizer.mjs'
import { MM_NAMES, LEGACY_NAMES } from './names.mjs'

function wrap(fn) {
  return async (args, ctx) => {
    try {
      return await fn(args ?? {}, ctx)
    } catch (e) {
      if (e instanceof MemoryError) throw e
      throw new MemoryError('INTERNAL', e.message || '内部错误')
    }
  }
}

/** memory_add：添加一条长期记忆。 */
export const memory_add = wrap(async (args, ctx) => {
  const content = assertString(args.content, 'content')
  const tags = assertTags(args.tags)
  const importance = assertNumber(args.importance ?? 5, 'importance', { min: 1, max: 10 })
  const isGlobal = args.is_global === undefined ? false : assertBoolean(args.is_global, 'is_global')
  const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : ctx.sessionId
  return ctx.engine.addMemory({ content, tags, importance, is_global: isGlobal, sessionId })
})

/** memory_search：语义检索。 */
export const memory_search = wrap(async (args, ctx) => {
  const query = assertString(args.query, 'query')
  const topK = args.top_k ?? ctx.engine.config.long_term.retrieval_top_k
  const threshold = args.threshold ?? ctx.engine.config.long_term.similarity_threshold
  const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : ctx.sessionId
  const includeGlobal = args.include_global === undefined ? true : args.include_global
  return ctx.engine.search(query, { topK, threshold, sessionId, includeGlobal })
})

/** memory_get_recent：当前会话最近 N 轮短期记忆。 */
export const memory_get_recent = wrap(async (args, ctx) => {
  const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : ctx.sessionId
  return ctx.engine.getRecent(sessionId, {
    maxMessages: args.n ?? ctx.engine.config.short_term.max_messages,
    maxTokens: ctx.engine.config.short_term.max_tokens,
  })
})

/** memory_summarize：对对话区间生成摘要并入库（支持 ctx.llmSummarize 生成式）。 */
export const memory_summarize = wrap(async (args, ctx) => {
  const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : ctx.sessionId
  if (typeof args.content === 'string' && args.content.length > 0) {
    const { extractiveSummary } = await import('../core/summarize.mjs')
    const summary = extractiveSummary(args.content)
    const res = await ctx.engine.addMemory({
      content: `【对话摘要】${summary}`,
      tags: ['摘要'],
      importance: 6,
      is_global: false,
      sessionId,
      source: 'summary',
      summaryOf: sessionId,
    })
    return {
      summary,
      memory_id: res.memory_id,
      compressed_from: 0,
      saved_tokens: Math.max(0, countTokens(args.content) - countTokens(summary)),
      via: 'extractive',
    }
  }
  return ctx.engine.summarize(sessionId, { count: args.count, llm: ctx.llmSummarize })
})

/** memory_distill：分层蒸馏（P8）L0→L1→L2→L3，复用 llmSummarize（护栏包裹的宿主 LLM）。 */
export const memory_distill = wrap(async (args, ctx) => {
  const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : ctx.sessionId
  const family = args.family === 'work' ? 'work' : 'chat'
  const r = await ctx.engine.distill(sessionId, { llm: ctx.llmSummarize, family })
  return {
    l0_appended: r.l0.appended,
    l1_extracted: r.l1.extracted,
    l2_scenes: r.l2.scenes,
    l3_written: r.l3.written,
    family,
  }
})

/** memory_delete：按 ID 或条件批量删除。 */
export const memory_delete = wrap(async (args, ctx) => {
  const sessionId = typeof args.session_id === 'string' && args.session_id ? args.session_id : ctx.sessionId
  const allSessions = args.all_sessions === true
  return ctx.engine.deleteMemory(sessionId, {
    ids: args.ids,
    conditions: args.conditions,
    allSessions,
  })
})

/** memory_update_importance：修改重要性 1-10。 */
export const memory_update_importance = wrap(async (args, ctx) => {
  const memoryId = assertString(args.memory_id, 'memory_id')
  const score = assertNumber(args.score, 'score', { min: 1, max: 10 })
  return ctx.engine.updateImportance(memoryId, score)
})

/** memory_stats：整体统计。 */
export const memory_stats = wrap(async (args, ctx) => ctx.engine.stats())

/** 全部 handler 的注册表（mm_* 与 memory_* 双键，指向同一实现）。 */
const IMPL = {
  add: memory_add,
  search: memory_search,
  get_recent: memory_get_recent,
  summarize: memory_summarize,
  distill: memory_distill,
  delete: memory_delete,
  update_importance: memory_update_importance,
  stats: memory_stats,
}

export const HANDLERS = {}
for (const key of Object.keys(IMPL)) {
  HANDLERS[MM_NAMES[key]] = IMPL[key]
  HANDLERS[LEGACY_NAMES[key]] = IMPL[key]
}
/** 逻辑键 → handler（供按 key 取用）。 */
export const HANDLERS_BY_KEY = IMPL
