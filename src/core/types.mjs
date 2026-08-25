/**
 * 共享类型、常量、校验与错误类。
 * @module src/core/types
 */

import crypto from 'node:crypto'

/** 生成 UUID。 */
export function newId() {
  return crypto.randomUUID()
}

/** 当前毫秒时间戳。 */
export function nowMs() {
  return Date.now()
}

/** 钳制重要性到 1..10 的整数。 */
export function clampImportance(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 5
  return Math.max(1, Math.min(10, Math.round(v)))
}

/** 内置错误类：code 对应 contracts/tools.md 错误码表。 */
export class MemoryError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

/** 默认配置（对应 TASK-spec.md §5，全部默认值）。 */
export const DEFAULT_CONFIG = Object.freeze({
  short_term: {
    max_messages: 20,
    max_tokens: 4000,
  },
  long_term: {
    auto_summarize_threshold: 10,
    retrieval_top_k: 5,
    similarity_threshold: 0.75,
    embedding_model: 'local',
    embedding_model_id: '',
    openai_api_key: '',
    hybrid_weight: 0.7,
    // LLM 生成式摘要成本护栏（plugin 钩子消费）
    llm_guardrails: {
      max_concurrency: 1, // 全局并发上限（忙则回退抽取式，不排队阻塞）
      fail_threshold: 3, // 连续失败熔断阈值
      cooldown_ms: 600_000, // 熔断冷却时长（ms）
      max_calls_per_hour: 30, // 小时调用上限
      max_tokens_per_day: 50_000, // 日 token 预算（输入+输出近似）
    },
  },
  storage: {
    max_storage_mb: 500,
    encryption_enabled: true,
    master_password: '',
    api_token: '',
  },
  global_memory: {
    enabled: true,
  },
  // 与 dsh-layered-memory 共存选项（P1 起；bareSearch 实际生效值读插件配置 cordis config.compat.bareSearch）
  compat: {
    bareSearch: false, // true=额外 best-effort 注册旧名 memory_* 别名（被他人占用则跳过）
  },
})

/** SQLite memories 建表语句。 */
export const MEMORY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 5,
  is_global INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  ttl INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  tokens INTEGER NOT NULL DEFAULT 0,
  summary_of TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
`

/** 校验工具。 */
export function assertString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MemoryError('VALIDATION_ERROR', `参数 ${name} 必须是非空字符串`)
  }
  return value
}

export function assertOptionalString(value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new MemoryError('VALIDATION_ERROR', `参数 ${name} 必须是字符串`)
  }
  return value
}

export function assertNumber(value, name, { min, max } = {}) {
  const v = Number(value)
  if (!Number.isFinite(v)) {
    throw new MemoryError('VALIDATION_ERROR', `参数 ${name} 必须是数字`)
  }
  if (min !== undefined && v < min) {
    throw new MemoryError('VALIDATION_ERROR', `参数 ${name} 必须 >= ${min}`)
  }
  if (max !== undefined && v > max) {
    throw new MemoryError('VALIDATION_ERROR', `参数 ${name} 必须 <= ${max}`)
  }
  return v
}

export function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new MemoryError('VALIDATION_ERROR', `参数 ${name} 必须是布尔值`)
  }
  return value
}

export function assertTags(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new MemoryError('VALIDATION_ERROR', '参数 tags 必须是字符串数组')
  }
  return value.map(String).filter((t) => t.length > 0).slice(0, 20)
}

/** 将记录行（SQLite 行）转为 MemoryRecord。 */
export function rowToRecord(row) {
  if (!row) return null
  let tags = []
  try { tags = JSON.parse(row.tags ?? '[]') } catch { tags = [] }
  return {
    id: row.id,
    content: row.content,
    tags,
    importance: Number(row.importance),
    is_global: Number(row.is_global) === 1,
    session_id: row.session_id,
    created_at: Number(row.created_at),
    last_accessed_at: Number(row.last_accessed_at),
    ttl: row.ttl === null ? null : Number(row.ttl),
    source: row.source,
    tokens: Number(row.tokens),
    summary_of: row.summary_of,
  }
}
