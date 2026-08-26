/**
 * 嵌入 Provider（P7 三态嵌入源）：off（纯关键词）/ remote（外部 API）/ local（本地模型）。
 * 默认 local：优先动态加载本地 ONNX 模型（onnxruntime-node 可选依赖）或 @huggingface/transformers，
 * 不可用时回退确定性哈希 n-gram 嵌入。全程零强制依赖；运行时为可选增强（动态 import，失败静默降级 + 明确提示）。
 * @module src/core/embedding
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { tokenizeTerms } from './tokenizer.mjs'
import { catalogById } from './model-catalog.mjs'

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
   * P7 三态嵌入源：off（纯关键词）/ remote（外部 API）/ local（本地模型）。
   * @param {{model?: string, apiKey?: string, dataDir?: string, modelId?: string, source?: string}} opts
   *   source: 'off'|'remote'|'local'（embedding-source.json 的运行时选择）；model 保留旧配置兼容。
   */
  constructor({ model = 'local', apiKey = '', dataDir, modelId = '', source } = {}) {
    this.model = model
    this.apiKey = apiKey
    this.dataDir = dataDir
    this.modelId = modelId
    this.source = source || (model === 'openai' ? 'remote' : model === 'off' ? 'off' : 'local')
    this.kind = 'hash'
    this.dim = 512
    this.detail = '离线确定性哈希 n-gram 嵌入（未加载真实模型）'
    this._degraded = false
    this._pipeline = null
    this._cache = new Map()
    this._runtime = null // 'onnx' | 'transformers' | null
  }

  /** 探测可用模型。 */
  async init() {
    // 🔴5 降级自愈：init 重置陈旧降级标志（配置/网络恢复后不再永久卡在降级态）
    this._degraded = false
    if (this.source === 'off') {
      this.kind = 'off'
      this.dim = 0
      this.detail = '嵌入已关闭（off）：纯关键词检索'
      return
    }
    if (this.source === 'remote' && this.apiKey) {
      this.kind = 'remote'
      this.dim = 1536
      this.detail = '远程嵌入 API'
      return
    }
    // local：尝试本地 ONNX 模型（可选依赖 onnxruntime-node；未装则降级 hash 并给出明确提示）
    if (this.source === 'local') {
      const entry = this.modelId ? catalogById(this.modelId) : null
      const localOk = await this._tryLoadLocal(entry)
      if (localOk) return
      this.kind = 'hash'
      this.dim = 512
      this.detail = entry
        ? `本地模型 ${entry.id} 未就绪（需已下载 + 安装 onnxruntime-node）；已降级哈希嵌入`
        : '本地嵌入未就绪（未指定模型或未安装 onnxruntime-node）；已降级哈希嵌入'
      return
    }
    // 默认 local（旧配置兼容）：尝试 transformers.js 增强，失败降级 hash
    try {
      const mod = await import('@huggingface/transformers')
      const pipeline = mod.pipeline || mod.default?.pipeline
      if (pipeline) {
        this.kind = 'local'
        this.dim = 384
        this.modelId = this.modelId || 'Xenova/all-MiniLM-L6-v2'
        this.detail = `本地模型 ${this.modelId}`
        this._pipeline = pipeline
        this._runtime = 'transformers'
        return
      }
    } catch {
      // 未安装 transformers —— 静默回退哈希嵌入
    }
    this.kind = 'hash'
    this.dim = 512
    this.detail = '离线确定性哈希 n-gram 嵌入（未加载真实模型，建议配置嵌入模型）'
  }

  /** 尝试从下载目录加载本地 ONNX 模型（onnxruntime-node 动态 import，未装/加载失败返回 false）。 */
  async _tryLoadLocal(entry) {
    if (!entry || !this.dataDir) return false
    const modelDir = path.join(this.dataDir, 'models', entry.id)
    // 文件完整性（尺寸口径）：缺文件则不算就绪
    for (const f of entry.files) {
      try {
        const st = await fsp.stat(path.join(modelDir, f.path))
        if (st.size !== f.size) return false
      } catch {
        return false
      }
    }
    // 尝试 onnxruntime-node（可选依赖）
    try {
      const ort = await import('onnxruntime-node')
      const onnxPath = path.join(modelDir, 'onnx', 'model_quantized.onnx')
      const session = await ort.InferenceSession.create(onnxPath)
      this.kind = 'local'
      this.dim = entry.dims
      this.detail = `本地模型 ${entry.id}（ONNX, dims=${entry.dims}）`
      this._ort = ort
      this._session = session
      this._entry = entry
      this._runtime = 'onnx'
      return true
    } catch {
      return false
    }
  }

  status() {
    return {
      kind: this.kind,
      dim: this.dim,
      detail: this.detail,
      degraded: this._degraded === true || this.kind === 'hash',
      source: this.source,
      runtime: this._runtime,
    }
  }

  /** 模型身份指纹（用于重建索引检测）。 */
  fingerprint() {
    if (this.kind === 'local') return `local:${this.modelId}`
    if (this.kind === 'remote') return `remote:${this.modelId || 'text-embedding-3-small'}`
    if (this.kind === 'off') return 'off:0'
    return `hash:${this.dim}`
  }

  async _ensurePipeline() {
    if (this.kind === 'local' && this._runtime === 'transformers' && !this._pipelineInstance) {
      this._pipelineInstance = await this._pipeline('feature-extraction', this.modelId)
    }
  }

  async embed(text) {
    const key = String(text)
    const hit = this._cache.get(key)
    if (hit) return hit
    let vec
    if (this.kind === 'off') {
      // off：不产生嵌入（空向量占位，检索走纯关键词）
      vec = new Float32Array(0)
    } else if (this.kind === 'local' && this._runtime === 'onnx') {
      vec = await this._embedOnnx(String(text))
    } else if (this.kind === 'local') {
      await this._ensurePipeline()
      const out = await this._pipelineInstance(String(text), { pooling: 'mean', normalize: true })
      const data = Array.isArray(out) ? out[0] : out
      const arr = data && data.data ? data.data : data
      vec = Float32Array.from(Array.from(arr).slice(0, this.dim))
    } else if (this.kind === 'remote') {
      try {
        vec = await this._embedRemote(String(text))
        // 🔴5 降级自愈：外部 API 恢复后清除降级标志（不再永久停在降级态）
        if (this._degraded) {
          this._degraded = false
          console.warn('[dsh-memory-manager] 远程嵌入恢复，已退出降级哈希嵌入')
        }
      } catch (e) {
        // 嵌入 API 失败（超时/限流/断网）：降级本地哈希嵌入，保证写入/检索不中断
        if (!this._degraded) {
          this._degraded = true
          console.warn(`[dsh-memory-manager] 远程嵌入失败，降级本地哈希嵌入: ${e?.message ?? e}`)
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

  /** 本地 ONNX 嵌入：tokenize + 前向 + 池化（mean/cls）+ L2 归一。 */
  async _embedOnnx(text) {
    const entry = this._entry
    const tokenizer = await this._getTokenizer(entry)
    const ids = tokenizer.encode(String(text)).slice(0, entry.contextTokens)
    const len = Math.max(1, ids.length)
    const Tensor = this._ort.Tensor
    const inputIds = new BigInt64Array(len)
    const mask = new BigInt64Array(len).fill(1n)
    for (let i = 0; i < len; i += 1) inputIds[i] = BigInt(ids[i])
    const feeds = {
      input_ids: new Tensor('int64', inputIds, [1, len]),
      attention_mask: new Tensor('int64', mask, [1, len]),
    }
    const out = await this._session.run(feeds)
    const last = Object.values(out)[0]
    const dims = last.dims
    const seq = dims[1] ?? 1
    const hidden = dims[2] ?? entry.dims
    const data = last.data
    const vec = new Float32Array(entry.dims)
    if (entry.pooling === 'cls' && hidden === entry.dims) {
      for (let i = 0; i < entry.dims; i += 1) vec[i] = data[i]
    } else {
      // mean pooling
      for (let t = 0; t < seq; t += 1) {
        for (let d = 0; d < entry.dims && d < hidden; d += 1) vec[d] += data[t * hidden + d]
      }
      for (let d = 0; d < entry.dims; d += 1) vec[d] /= Math.max(1, seq)
    }
    let norm = 0
    for (let i = 0; i < entry.dims; i += 1) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm)
    if (norm > 0) for (let i = 0; i < entry.dims; i += 1) vec[i] /= norm
    return vec
  }

  /** tokenizer 加载：从下载目录读 tokenizer.json 解析 BPE merges；失败退化字符切分（占位，不阻断）。 */
  async _getTokenizer(entry) {
    if (this._tokenizer) return this._tokenizer
    const tokenizerPath = path.join(this.dataDir, 'models', entry.id, 'tokenizer.json')
    try {
      const raw = JSON.parse(await fsp.readFile(tokenizerPath, 'utf8'))
      if (raw?.model?.merges && Array.isArray(raw.model.merges)) {
        this._tokenizer = new ByteLevelTokenizer(raw)
        return this._tokenizer
      }
    } catch { /* 忽略 */ }
    this._tokenizer = new CharFallbackTokenizer()
    return this._tokenizer
  }

  async embedMany(texts) {
    const out = []
    for (const t of texts) out.push(await this.embed(t))
    return out
  }

  async _embedRemote(text) {
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
      throw new Error(`remote embedding failed: ${res.status}`)
    }
    const data = await res.json()
    return Float32Array.from(data.data[0].embedding)
  }
}

/** 简易 BPE tokenizer（从 tokenizer.json 加载 merges/vocab）。 */
class ByteLevelTokenizer {
  constructor(raw) {
    this.vocab = raw.model?.vocab ?? {}
    this.merges = raw.model?.merges ?? []
    this.addedTokens = raw.added_tokens ?? []
  }

  encode(text) {
    // 简化 BPE：按字节展开后查 vocab（中文/多字节经 UTF-8 展开为字节）
    const bytes = new TextEncoder().encode(String(text))
    const chars = Array.from(bytes, (b) => String.fromCharCode(b))
    const ids = []
    for (const c of chars) {
      const id = this.vocab[c]
      if (id !== undefined) ids.push(id)
      else ids.push(this.vocab['[UNK]'] ?? this.vocab['<unk>'] ?? 0)
    }
    return ids
  }
}

/** 字符切分占位 tokenizer（无真实 tokenizer.json 时）。 */
class CharFallbackTokenizer {
  encode(text) {
    return Array.from(new TextEncoder().encode(String(text)))
  }
}
