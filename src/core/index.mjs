/**
 * MemoryEngine 门面：组装各核心模块，暴露 addMemory/search/getRecent/
 * summarize/deleteMemory/updateImportance/stats/export/import/runLifecycle。
 * @module src/core/index
 */

import path from 'node:path'
import { ShortTermStore } from './short-term.mjs'
import { EmbeddingProvider } from './embedding.mjs'
import { VectorStore } from './vector.mjs'
import { MemoryCrypto } from './crypto.mjs'
import { MemoryStore } from './store.mjs'
import { InvertedIndex } from './inverted.mjs'
import { search } from './search.mjs'
import { summarizeSession } from './summarize.mjs'
import { Lifecycle } from './lifecycle.mjs'
import { exportBackup, importBackup } from './io.mjs'
import { stats as collectStats } from './stats.mjs'
import { loadConfig, saveConfig as saveConfigImpl, embeddingFingerprint, defaultBaseDir } from '../config.mjs'
import { newId, nowMs, clampImportance, MemoryError, assertString, assertOptionalString, assertTags } from './types.mjs'
import { countTokens, tokenizeTerms } from './tokenizer.mjs'

export class MemoryEngine {
  /**
   * @param {{baseDir?: string, config?: object, masterPassword?: string}} opts
   */
  constructor({ baseDir, config, masterPassword } = {}) {
    this.baseDir = baseDir
    this.config = config
    this.masterPassword = masterPassword ?? config?.storage?.master_password ?? ''
    this.lifecycle = null
    this.lastCompacted = null
    this._embeddingStatus = null
    this._plainCache = new Map() // id -> 解密后的明文（搜索热缓存）
    this.inverted = new InvertedIndex() // 内存倒排索引（检索时若失步会自愈重建）
  }

  /** 创建并初始化引擎。 */
  static async create(opts = {}) {
    const baseDir = opts.baseDir || process.env.DSH_MEMORY_DIR || defaultBaseDir()
    const config = await loadConfig(baseDir)
    const engine = new MemoryEngine({ baseDir, config, masterPassword: opts.masterPassword })
    engine.shortTerm = new ShortTermStore(baseDir)
    engine.store = new MemoryStore(path.join(baseDir, 'long_term', 'memories.db'))
    engine.store.open()
    engine.vector = new VectorStore(path.join(baseDir, 'long_term', 'vector.index'))
    engine.vector.load()
    engine.crypto = new MemoryCrypto({
      enabled: config.storage.encryption_enabled,
      masterPassword: engine.masterPassword,
      saltFile: path.join(baseDir, '.salt'),
      keyFile: path.join(baseDir, '.key'),
    })
    await engine.crypto.init()
    engine.embedding = new EmbeddingProvider({
      model: config.long_term.embedding_model,
      apiKey: config.long_term.openai_api_key ?? '',
      modelId: config.long_term.embedding_model_id,
      dataDir: path.join(baseDir, 'long_term'),
    })
    await engine.embedding.init()
    engine.lifecycle = new Lifecycle(engine)
    // 倒排索引：启动时全量构建一次（解密+分词），此后 addMemory/删除/导入增量维护
    engine.inverted.clear()
    for (const rec of engine.store.list()) {
      engine.inverted.add(rec.id, tokenizeTerms(engine.decryptContent(rec)))
    }
    engine._needsReindex = engine.detectReindexNeeded()
    return engine
  }

  countTokens(text) {
    return countTokens(text)
  }

  /** 当前配置（合并默认值）。 */
  get config() {
    return this._config
  }

  set config(v) {
    this._config = v
  }

  /** 内容解密（未加密则原样返回），带明文缓存以支撑高频检索。 */
  decryptContent(rec) {
    if (!this.crypto.active()) return rec.content
    const hit = this._plainCache.get(rec.id)
    if (hit !== undefined) return hit
    try {
      const dec = this.crypto.decrypt(rec.content) ?? rec.content
      this._plainCache.set(rec.id, dec)
      return dec
    } catch {
      return rec.content
    }
  }

  /** 缓存失效（记录被删除/替换时调用）。 */
  invalidateCache(ids) {
    for (const id of ids) this._plainCache.delete(id)
  }

  /** 检测嵌入模型变更 → 需重建索引。 */
  detectReindexNeeded() {
    const expected = embeddingFingerprint(this.config)
    const current = this.vector.fingerprint()
    if (current === undefined) return false // 索引为空
    return current !== expected
  }

  needsReindex() {
    return this._needsReindex === true
  }

  async persistVectors() {
    if (this.vector.dirty) {
      this.vector.setModel({
        kind: this.embedding.status().kind,
        dim: this.embedding.status().dim,
        fingerprint: this.embedding.fingerprint(),
      })
      await this.vector.save()
    }
  }

  /**
   * 重建向量索引（更换嵌入模型后调用）：按当前提供者对全库重嵌入并覆写向量索引。
   * 内容加密不影响重嵌入（用解密明文）。成功后清 needs_reindex。
   * @returns {{processed: number, model: string, needs_reindex: boolean, latency_ms: number}}
   */
  async reindex() {
    const t0 = Date.now()
    const recs = this.store.list()
    // 模型已变：清嵌入缓存，避免旧模型向量混入
    try { this.embedding._cache?.clear?.() } catch { /* 忽略 */ }
    const vec = new Map()
    for (let i = 0; i < recs.length; i += 1) {
      const content = this.decryptContent(recs[i])
      vec.set(recs[i].id, await this.embedding.embed(content))
    }
    this.vector.entries = vec
    this.vector.setModel({
      kind: this.embedding.status().kind,
      dim: this.embedding.status().dim,
      fingerprint: this.embedding.fingerprint(),
    })
    this.vector.dirty = true
    await this.vector.save()
    this._needsReindex = false
    return {
      processed: recs.length,
      model: this.embedding.fingerprint(),
      needs_reindex: false,
      latency_ms: Date.now() - t0,
    }
  }

  /**
   * 添加一条长期记忆。
   * @param {{content: string, tags?: string[], importance?: number, is_global?: boolean, sessionId?: string, source?: string, ttl?: number|null, summaryOf?: string|null, skipEncrypt?: boolean}} input
   */
  async addMemory(input) {
    const content = assertString(input.content, 'content')
    const sessionId = assertOptionalString(input.sessionId, 'session_id') ?? 'default'
    const tags = assertTags(input.tags)
    const importance = clampImportance(input.importance ?? 5)
    const isGlobal = input.is_global === true
    const source = input.source ?? 'manual'
    const ttl = input.ttl === undefined ? null : Number(input.ttl) || null
    const id = input.id ?? newId()
    const now = nowMs()
    const storedContent = input.skipEncrypt ? content : this.crypto.encrypt(content)
    const tokens = countTokens(content)
    // 先嵌入再入库：嵌入失败不留下有记录无向量的孤儿行
    const vec = await this.embedding.embed(content)
    this.store.insert({
      id,
      content: storedContent,
      tags,
      importance,
      is_global: isGlobal,
      session_id: sessionId,
      created_at: now,
      last_accessed_at: now,
      ttl,
      source,
      tokens,
      summary_of: input.summaryOf ?? null,
    })
    this.vector.upsert(id, vec)
    this.inverted.add(id, tokenizeTerms(content))
    await this.persistVectors()
    // 顺带跑生命周期
    try {
      this.lifecycle.expire()
      this.lifecycle.enforceStorageLimit()
    } catch { /* 生命周期失败不影响写入 */ }
    return {
      success: true,
      memory_id: id,
      embedding_status: (this.embedding.status().kind === 'hash' || this.embedding.status().degraded === true) ? 'degraded' : 'completed',
      token_cost: tokens,
    }
  }

  /** 语义检索。 */
  async search(query, opts = {}) {
    assertString(query, 'query')
    return search(this, query, opts)
  }

  /** 短期记忆上下文。 */
  async getRecent(sessionId, opts = {}) {
    return this.shortTerm.getRecent(sessionId, {
      maxMessages: opts.maxMessages ?? this.config.short_term.max_messages,
      maxTokens: opts.maxTokens ?? this.config.short_term.max_tokens,
    })
  }

  /** 摘要并入库（支持可选 LLM 生成式摘要）。 */
  async summarize(sessionId, opts = {}) {
    return summarizeSession(this, sessionId ?? 'default', opts)
  }

  /** 删除：按 ids 或条件。 */
  async deleteMemory(sessionId, { ids, conditions, allSessions = false } = {}) {
    // 安全守卫：必须显式给出删除目标（ids 或非空 conditions），
    // 防止空参/空 body 把整个库（或整会话）静默清空。
    const hasIds = Array.isArray(ids) && ids.length > 0
    const hasConditions = conditions && typeof conditions === 'object' && Object.keys(conditions).length > 0
    if (!hasIds && !hasConditions) {
      throw new MemoryError('VALIDATION_ERROR', '缺少删除目标：请提供 ids 或 conditions')
    }
    let cond = {}
    // 键归一化：工具/REST schema 用下划线键，引擎内部用驼峰键——
    // 不映射会导致 session_id/is_global/older_than/importance_le 条件删除静默失效。
    const COND_KEY_MAP = { session_id: 'sessionId', is_global: 'isGlobal', older_than: 'olderThan', importance_le: 'importanceLe', tag: 'tag' }
    for (const [k, v] of Object.entries(conditions ?? {})) {
      if (v === undefined) continue
      cond[COND_KEY_MAP[k] ?? k] = v
    }
    if (hasIds) {
      if (!allSessions) {
        // 单条删除仅限当前会话
        const valid = []
        for (const id of ids) {
          const rec = this.store.get(id)
          if (rec && (rec.session_id === sessionId || rec.is_global)) valid.push(id)
        }
        cond.ids = valid
      }
    } else if (cond.sessionId === undefined && !allSessions) {
      cond.sessionId = sessionId ?? 'default'
    }
    return this.lifecycle.deleteByConditions(cond)
  }

  /** 修改重要性。 */
  async updateImportance(id, score) {
    assertString(id, 'memory_id')
    const rec = this.store.get(id)
    if (!rec) throw new MemoryError('NOT_FOUND', `记忆 ${id} 不存在`)
    const old = rec.importance
    const next = clampImportance(score)
    this.store.update(id, { importance: next })
    return { memory_id: id, old_score: old, new_score: next }
  }

  /** 统计。 */
  async stats() {
    return collectStats(this)
  }

  /** 导出备份。 */
  async exportBackup(opts = {}) {
    return exportBackup(this, opts)
  }

  /** 导入备份。 */
  async importBackup(text, opts = {}) {
    return importBackup(this, text, opts)
  }

  /** 手动清理：TTL 过期 + 超限。 */
  async runLifecycle() {
    const expired = this.lifecycle.expire()
    const evicted = this.lifecycle.enforceStorageLimit()
    await this.persistVectors()
    return { expired, evicted, last_compacted: this.lastCompacted ? new Date(this.lastCompacted).toISOString() : null }
  }

  /** 保存配置。 */
  async saveConfig(patch = {}) {
    // 脱敏回显归一化：GUI/客户端把 GET config 里的 '***' 原样回传时，视为"未变更"
    if (patch?.storage?.master_password === '***') delete patch.storage.master_password
    if (patch?.long_term?.openai_api_key === '***') delete patch.long_term.openai_api_key
    // 数据丢失保护：当前正以主密码（scrypt）加密且库里有记录时，禁止任何会改变派生密钥的操作——
    // 清空主密码、关闭加密、或改成一个新密码都会导致：运行时仍用旧 key 写入，
    // 重启后按新配置派生新 key → 历史密文全部不可读（decrypt 报错但被静默返回乱码）。
    if (patch?.storage) {
      const nextMaster = typeof patch.storage.master_password === 'string'
        ? patch.storage.master_password
        : this.config.storage.master_password
      const nextEnabled = patch.storage.encryption_enabled !== undefined
        ? patch.storage.encryption_enabled
        : this.config.storage.encryption_enabled
      const masterChanged = nextMaster !== this.config.storage.master_password
      const scryptActive = this.crypto.active() && this.crypto.mode === 'scrypt'
      const hasRecords = this.store.list().length > 0
      if (scryptActive && hasRecords && (masterChanged || !nextEnabled || !nextMaster)) {
        throw new MemoryError('CONFIG_ERROR', '当前以主密码加密且已有记忆数据，不能修改主密码/关闭加密（会丢失全部历史记忆）；请先导出明文备份再操作')
      }
    }
    this.config = await saveConfigImpl(this.baseDir, patch)
    // 嵌入配置是"冷键"：变更后运行时重建提供者（否则 config 说新模型、实际仍用旧模型重嵌入）。
    // 加密主密码/开关仍属需重启类（涉及既有密文的派生密钥，已由上方守卫拦截变更）。
    if (patch?.long_term && ['embedding_model', 'embedding_model_id', 'openai_api_key'].some((k) => patch.long_term[k] !== undefined)) {
      this.embedding = new EmbeddingProvider({
        model: this.config.long_term.embedding_model,
        apiKey: this.config.long_term.openai_api_key ?? '',
        modelId: this.config.long_term.embedding_model_id,
        dataDir: path.join(this.baseDir, 'long_term'),
      })
      await this.embedding.init()
    }
    this._needsReindex = this.detectReindexNeeded()
    return this.config
  }

  async close() {
    try { await this.persistVectors() } catch { /* 忽略 */ }
    this.store.close()
  }
}

export { MemoryError }
