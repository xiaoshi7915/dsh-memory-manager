/**
 * 嵌入源状态层（P7）：off / remote / local 三态 + 活切换管理器。
 * 复刻 dsh-layered-memory 的 embedding-source 思路（独立实现）：
 *  - 状态文件 embedding-source.json（写穿持久化，原子写 + 串行写队列）；无文件 = remote（与历史行为一致）；
 *  - 生效 = 部署上限 AND 运行时选择（仓库铁律）；
 *  - 失败语义：异常（下载失败/模型加载失败）→ 状态不持久化，重启回到旧源。
 * 语义（对齐 layered）：
 *  - off：纯关键词检索（不产生嵌入）
 *  - remote：外部嵌入 API（manager 的 openai 分支）
 *  - local：本地 ONNX 模型（白名单目录，需已下载 + onnxruntime-node 可用）
 * @module src/core/embedding-source
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.mjs'

export const SOURCES = ['off', 'remote', 'local']

export class EmbeddingSourceStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.file = path.join(dataDir, 'embedding-source.json')
    this.state = { source: 'remote', activeModel: null }
    this.writeChain = Promise.resolve()
  }

  get() {
    return { ...this.state }
  }

  async init() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (
        SOURCES.includes(parsed.source) &&
        (parsed.activeModel === null || typeof parsed.activeModel === 'string')
      ) {
        this.state = { source: parsed.source, activeModel: parsed.activeModel }
      }
      // 损坏则保持默认 remote
    } catch {
      // 无文件 = 历史行为（remote）
    }
  }

  /** 写穿持久化（串行队列，失败保持内存态生效）。 */
  async set(next) {
    this.state = { source: next.source, activeModel: next.activeModel ?? null }
    this.writeChain = this.writeChain.then(() => this.persist()).catch(() => {})
    await this.writeChain
  }

  async persist() {
    try {
      await writeFileAtomic(this.file, JSON.stringify(this.state, null, 2))
    } catch {
      // 写失败保持内存态，下次写入自愈
    }
  }

  flush() {
    return this.writeChain
  }
}
