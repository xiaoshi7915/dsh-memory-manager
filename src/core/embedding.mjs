/**
 * 嵌入 Provider：默认 local（优先动态加载 @huggingface/transformers，
 * 不可用时回退确定性哈希 n-gram 嵌入），可选 openai 外部 API。
 * 全程零强制依赖；transformers 为可选增强（动态 import，失败静默降级）。
 * @module src/core/embedding
 */

import { tokenizeTerms } from './tokenizer.mjs'

/** FNV-1a 32 位哈希。 */
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 确定性哈希 n-gram 嵌入：词项哈希到 512 维桶（一正一负），L2 归一化。
 * CJK 二元组权重 2，拉丁词权重 2，单字权重 1 —— 提升内容重叠的相似度。
 * @param {string} text
 * @param {number} dim
 */
export function hashVector(text, dim = 512) {
  const vec = new Float32Array(dim)
  const terms = tokenizeTerms(text)
  const weight = (t) => (/^[\u4e00-\u9fff]$/.test(t) ? 1 : 2)
  for (const term of terms) {
    const h = fnv1a(term)
    const idx = h % dim
    const sign = (h >> 31) & 1 ? -1 : 1
    vec[idx] += sign * weight(term)
  }
  let norm = 0
  for (let i = 0; i < dim; i += 1) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < dim; i += 1) vec[i] /= norm
  }
  return vec
}

export class EmbeddingProvider {
  /**
   * @param {{model?: string, apiKey?: string, dataDir?: string, modelId?: string}} opts
   */
  constructor({ model = 'local', apiKey = '', dataDir, modelId = '' } = {}) {
    this.model = model
    this.apiKey = apiKey
    this.dataDir = dataDir
    this.modelId = modelId
    this.kind = 'hash'
    this.dim = 512
    this.detail = '离线确定性哈希 n-gram 嵌入（未加载真实模型）'
    this._pipeline = null
    this._cache = new Map()
  }

  /** 探测可用模型。 */
  async init() {
    if (this.model === 'openai' && this.apiKey) {
      this.kind = 'openai'
      this.dim = 1536
      this.detail = 'OpenAI text-embedding-3-small'
      return
    }
    // local：尝试真实本地模型（可选依赖）
    try {
      const mod = await import('@huggingface/transformers')
      const pipeline = mod.pipeline || mod.default?.pipeline
      if (pipeline) {
        this.kind = 'local'
        this.dim = 384
        this.modelId = this.modelId || 'Xenova/all-MiniLM-L6-v2'
        this.detail = `本地模型 ${this.modelId}`
        this._pipeline = pipeline
        return
      }
    } catch {
      // 未安装 transformers —— 静默回退哈希嵌入
    }
    this.kind = 'hash'
    this.dim = 512
    this.detail = '离线确定性哈希 n-gram 嵌入（未加载真实模型，建议配置嵌入模型）'
  }

  status() {
    return { kind: this.kind, dim: this.dim, detail: this.detail, degraded: this._degraded === true }
  }

  /** 模型身份指纹（用于重建索引检测）。 */
  fingerprint() {
    if (this.kind === 'local') return `local:${this.modelId}`
    if (this.kind === 'openai') return `openai:${this.modelId || 'text-embedding-3-small'}`
    return `hash:${this.dim}`
  }

  async _ensurePipeline() {
    if (this.kind === 'local' && !this._pipelineInstance) {
      this._pipelineInstance = await this._pipeline('feature-extraction', this.modelId)
    }
  }

  async embed(text) {
    const key = String(text)
    const hit = this._cache.get(key)
    if (hit) return hit
    let vec
    if (this.kind === 'local') {
      await this._ensurePipeline()
      const out = await this._pipelineInstance(String(text), { pooling: 'mean', normalize: true })
      const data = Array.isArray(out) ? out[0] : out
      const arr = data && data.data ? data.data : data
      vec = Float32Array.from(Array.from(arr).slice(0, this.dim))
    } else if (this.kind === 'openai') {
      try {
        vec = await this._embedOpenai(String(text))
      } catch (e) {
        // 嵌入 API 失败（超时/限流/断网）：降级本地哈希嵌入，保证写入/检索不中断
        if (!this._degraded) {
          this._degraded = true
          console.warn(`[dsh-memory-manager] OpenAI 嵌入失败，降级本地哈希嵌入: ${e?.message ?? e}`)
        }
        vec = hashVector(String(text), this.dim)
      }
    } else {
      vec = hashVector(String(text), this.dim)
    }
    this._cache.set(key, vec)
    if (this._cache.size > 4096) this._cache.clear()
    return vec
  }

  async embedMany(texts) {
    const out = []
    for (const t of texts) out.push(await this.embed(t))
    return out
  }

  async _embedOpenai(text) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId || 'text-embedding-3-small',
        input: text,
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      throw new Error(`openai embedding failed: ${res.status}`)
    }
    const data = await res.json()
    return Float32Array.from(data.data[0].embedding)
  }
}
