/**
 * 配置加载/保存/校验，嵌入模型指纹（重建索引检测）。
 * @module src/config
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { writeFileAtomic } from './core/atomic.mjs'
import { DEFAULT_CONFIG } from './core/types.mjs'

const CONFIG_FILE = 'config.json'

/**
 * 数据根目录（环境变量可覆盖，默认 ~/.dsh/memory-manager）。
 * P0 目录迁移：旧默认 ~/.dsh/memory 曾与 dsh-layered-memory 混居，
 * 现切到专属目录，启动时把 manager 白名单文件自动迁移过去（见 core/migrate.mjs）。
 */
export function defaultBaseDir() {
  return process.env.DSH_MEMORY_DIR || path.join(os.homedir(), '.dsh', 'memory-manager')
}

/** 旧默认目录（与 dsh-layered-memory 混居的 ~/.dsh/memory）。DSH_MEMORY_LEGACY_DIR 供测试注入。 */
export function legacyBaseDir() {
  return process.env.DSH_MEMORY_LEGACY_DIR || path.join(os.homedir(), '.dsh', 'memory')
}

/** 是否显式指到了共享旧目录（存在与 layered-memory 混居的风险，需告警）。 */
export function isSharedLegacyDir(dir) {
  return Boolean(dir) && path.resolve(dir) === path.resolve(legacyBaseDir())
}

/** 深合并默认配置与用户配置（用户值优先）。 */
export function mergeConfig(user = {}) {
  const out = structuredClone(DEFAULT_CONFIG)
  if (user && typeof user === 'object') {
    for (const section of Object.keys(out)) {
      if (user[section] && typeof user[section] === 'object') {
        for (const key of Object.keys(out[section])) {
          if (user[section][key] !== undefined) out[section][key] = user[section][key]
        }
      }
    }
  }
  // 基本校验/钳制
  const clampInt = (v, min, max, d) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : d
  }
  out.short_term.max_messages = clampInt(out.short_term.max_messages, 1, 1000, 20)
  out.short_term.max_tokens = clampInt(out.short_term.max_tokens, 100, 1_000_000, 4000)
  out.long_term.auto_summarize_threshold = clampInt(out.long_term.auto_summarize_threshold, 0, 1000, 10) // 0 = 关闭自动摘要（钩子有 threshold>0 判断）
  out.long_term.retrieval_top_k = clampInt(out.long_term.retrieval_top_k, 1, 100, 5)
  const sim = Number(out.long_term.similarity_threshold)
  out.long_term.similarity_threshold = Number.isFinite(sim) ? Math.max(0, Math.min(1, sim)) : 0.75
  const hw = Number(out.long_term.hybrid_weight)
  out.long_term.hybrid_weight = Number.isFinite(hw) ? Math.max(0, Math.min(1, hw)) : 0.7
  // LLM 摘要成本护栏钳制（max_tokens_per_day=0 表示不限制）
  const lg = out.long_term.llm_guardrails ?? {}
  out.long_term.llm_guardrails = {
    max_concurrency: clampInt(lg.max_concurrency, 1, 8, 1),
    fail_threshold: clampInt(lg.fail_threshold, 1, 100, 3),
    cooldown_ms: clampInt(lg.cooldown_ms, 0, 86_400_000, 600_000),
    max_calls_per_hour: clampInt(lg.max_calls_per_hour, 1, 100_000, 30),
    max_tokens_per_day: clampInt(lg.max_tokens_per_day, 0, 100_000_000, 50_000),
  }
  out.storage.max_storage_mb = clampInt(out.storage.max_storage_mb, 1, 1_000_000, 500)
  out.storage.encryption_enabled = out.storage.encryption_enabled !== false
  out.global_memory.enabled = out.global_memory.enabled !== false
  return out
}

export function configPath(baseDir) {
  return path.join(baseDir || defaultBaseDir(), CONFIG_FILE)
}

/** 读取配置（文件不存在则返回默认并写入）。 */
export async function loadConfig(baseDir) {
  baseDir = baseDir || defaultBaseDir()
  const file = configPath(baseDir)
  let user = {}
  try {
    if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    user = {}
  }
  const config = mergeConfig(user)
  if (!fs.existsSync(file)) {
    await fsp.mkdir(baseDir, { recursive: true })
    // config.json 含 api_token / 主密码，原子写 + 0600（避免半写损坏与弱权限暴露）
    await writeFileAtomic(file, JSON.stringify(config, null, 2), { mode: 0o600 })
  }
  return config
}

/** 保存配置（局部补丁）。 */
export async function saveConfig(baseDir, patch = {}) {
  baseDir = baseDir || defaultBaseDir()
  const current = await loadConfig(baseDir)
  const merged = mergeConfig({ ...current, ...patch })
  await fsp.mkdir(baseDir, { recursive: true })
  await writeFileAtomic(configPath(baseDir), JSON.stringify(merged, null, 2), { mode: 0o600 })
  return merged
}

/** 嵌入模型指纹：用于与 vector.index 的模型指纹比对，检测"需重建索引"。 */
export function embeddingFingerprint(config) {
  const model = config.long_term.embedding_model
  const modelId = config.long_term.embedding_model_id || ''
  if (model === 'openai') return `openai:${modelId || 'text-embedding-3-small'}`
  if (model === 'local' && modelId) return `local:${modelId}`
  return 'hash:512'
}
