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
import { loadConfig, saveConfig as saveConfigImpl, embeddingFingerprint, defaultBaseDir, isSharedLegacyDir } from '../config.mjs'
import { newId, nowMs, clampImportance, MemoryError, assertString, assertOptionalString, assertTags } from './types.mjs'
import { countTokens, tokenizeTerms } from './tokenizer.mjs'
import { DirLock } from './lock.mjs'
import { maybeMigrateLegacy } from './migrate.mjs'

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
    this._decryptFailed = new Set() // 解密失败记录 id（密钥变更等；stats 上报，不再静默吞成乱码）
    this.inverted = new InvertedIndex() // 内存倒排索引（检索时若失步会自愈重建）
  }

  /** 创建并初始化引擎。 */
  static async create(opts = {}) {
    const explicit = Boolean(opts.baseDir || process.env.DSH_MEMORY_DIR)
    const baseDir = opts.baseDir || process.env.DSH_MEMORY_DIR || defaultBaseDir()
    if (explicit && isSharedLegacyDir(baseDir)) {
      console.warn('[dsh-memory-manager] 警告：DSH_MEMORY_DIR 指向 ~/.dsh/memory（与 dsh-layered-memory 共享目录），存在数据冲突风险，建议改用专属目录（默认 ~/.dsh/memory-manager）')
    }
    const engine = new MemoryEngine({ baseDir, masterPassword: opts.masterPassword })
    // P0 单写者锁：任何读写前先获取；已被其他进程持有 → 快速失败（LOCKED）
    engine.acquireDirLock()
    try {
      // P0 目录迁移：仅默认目录自动迁移（显式指定目录不动，尊重用户）
      const migrated = await maybeMigrateLegacy(baseDir, { allow: !explicit })
      if (migrated.migrated) {
        console.warn(`[dsh-memory-manager] 数据目录已迁移：${migrated.from} → ${migrated.to}（${migrated.moved.join(', ')}）`)
      }
      engine.config = await loadConfig(baseDir)
      engine.masterPassword = opts.masterPassword ?? engine.config?.storage?.master_password ?? ''
      engine.shortTerm = new ShortTermStore(baseDir)
      engine.store = new MemoryStore(path.join(baseDir, 'long_term', 'memories.db'))
      engine.store.open()
      engine.vector = new VectorStore(path.join(baseDir, 'long_term', 'vector.index'))
      engine.vector.load()
      await engine.vector.recoverTmp()
      engine.crypto = new MemoryCrypto({
        enabled: engine.config.storage.encryption_enabled,
        masterPassword: engine.masterPassword,
        saltFile: path.join(baseDir, '.salt'),
        keyFile: path.join(baseDir, '.key'),
      })
      await engine.crypto.init()
      engine.embedding = new EmbeddingProvider({
        model: engine.config.long_term.embedding_model,
        apiKey: engine.config.long_term.openai_api_key ?? '',
        modelId: engine.config.long_term.embedding_model_id,
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
    } catch (e) {
      engine.releaseDirLock()
      throw e
    }
  }

  /** P0 单写者锁：获取数据目录锁（已被其他进程持有则抛 LOCKED）。 */
  acquireDirLock() {
    this.lock = new DirLock(this.baseDir, { mode: 'plugin' })
    this.lock.acquire()
    return this.lock
  }

  /** 释放单写者锁（仅创建者删除）。 */
  releaseDirLock() {
    if (this.lock) {
      try { this.lock.release() } catch { /* 忽略 */ }
      this.lock = null
    }
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
      // 解密失败：不静默把密文当明文用（否则关键词/嵌入拿乱码当真、GUI 显乱码）。
      // 显式标记 + 限频告警 + 计入 stats.decrypt_failed。
      this._decryptFailed.add(rec.id)
      if (this._decryptFailed.size <= 3) {
        console.warn(`[dsh-memory-manager] 记忆 ${rec.id} 解密失败（密钥可能已变更，历史记忆不可读）`)
      }
      return '[解密失败：密钥可能已变更，历史记忆不可读]'
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
      try {
        await this.vector.save()
      } catch (err) {
        // P0 原子写容错：吞错 + 保留 dirty，下次写入自愈；不阻断 addMemory 主流程
        console.warn(`[dsh-memory-manager] 向量索引持久化失败（将稍后重试）: ${err.message}`)
      }
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
    // 数据丢失保护：库里有记录时，禁止任何会改变「既有记忆可读性」的加密配置变更。
    // 危险路径（原守卫只挡 scrypt 分支，random→主密码 / 开关双向均漏网）：
    //   改主密码 / 清空主密码（scrypt↔random 切换、换新密码）→ 新写用新 key，历史密文全不可读；
    //   关闭加密 → 旧密文被 decryptContent 原样返回 = 乱码；
    //   开启加密 → 存量明文不重加密，decryptContent 把明文当密文解 = 乱码。
    // 无重加密迁移能力前，一律 fail-closed 拒绝（空库时允许配置加密，不破坏任何数据）。
    if (patch?.storage && this.store.count() > 0) {
      const p = patch.storage
      const passChanged = typeof p.master_password === 'string' && p.master_password !== this.config.storage.master_password
      const enabledChanged = p.encryption_enabled !== undefined && p.encryption_enabled !== this.config.storage.encryption_enabled
      if (passChanged || enabledChanged) {
        throw new MemoryError('CONFIG_ERROR', '已有记忆数据时不能修改主密码或加密开关（会导致历史记忆不可读）；请先导出明文备份，或保持原值')
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
    try { this.store.close() } catch { /* 忽略 */ }
    this.releaseDirLock()
  }
}

export { MemoryError }
