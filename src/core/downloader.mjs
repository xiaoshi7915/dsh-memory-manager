/**
 * 模型下载器（P7）：镜像直连 + Range 断点续传 + sha256 校验 + 串行队列。
 * 复刻 dsh-layered-memory 的 download-queue 思路（独立实现，零依赖用内置 fetch）：
 *  - 进度是用户硬性要求：字节级实时进度（文件 i/N、已收/总量、EMA 速度），进度对象由 RPC 轮询读取；
 *  - 断点续传：写 .part 旁车文件，重试从断点 Range 续传；服务器不支持 Range（回 200）则从头重写；取消保留断点；
 *  - 完整性：每文件下满后流式哈希整文件比对目录 sha256（续传无法增量哈希，落盘后单遍校验最简单且正确）；
 *    失配删文件整体重下；单文件失败自动重试（默认 2 次，重试追加缓存键参数绕开 CDN 污染缓存）；
 *  - 磁盘门禁：下载前检查数据目录所在卷剩余空间 ≥ 模型体积 × 1.2（statfs 不可用时跳过）；
 *  - 同一时刻只跑一个下载任务（串行队列），后续请求直接拒绝并说明。
 * @module src/core/downloader
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { catalogById, catalogTotalBytes, MODEL_CATALOG } from './model-catalog.mjs'

const DISK_HEADROOM = 1.2
// 默认镜像（对齐 dsh-layered-memory：国内可达的 hf-mirror.com），可配回官方；备用官方兜底。
const DEFAULT_MIRROR = 'https://hf-mirror.com'
const FALLBACK_MIRROR = 'https://huggingface.co'

export class ModelDownloadQueue {
  /**
   * @param {string} dataDir 数据目录（models/<id>/ 写在这里）
   * @param {{log?: {info?: Function, warn?: Function}, mirror?: string, mirrors?: string[], fetchImpl?: Function, retryDelaysMs?: number[], freeBytes?: Function}} [opts]
   */
  constructor(dataDir, opts = {}) {
    this.dataDir = dataDir
    this.opts = opts
    // 镜像列表：显式 mirror 优先，否则默认 + 官方兜底；failover 时逐个尝试
    const primary = (opts.mirror || DEFAULT_MIRROR).replace(/\/+$/, '')
    const extra = (opts.mirrors || []).map((m) => m.replace(/\/+$/, '')).filter((m) => m && m !== primary)
    this.mirrors = [primary, ...extra]
    if (!this.mirrors.includes(FALLBACK_MIRROR)) this.mirrors.push(FALLBACK_MIRROR)
    this.mirror = this.mirrors[0]
    this.progress = null
    this.busy = false
    this.abort = null
    this.log = opts.log || null
    this.fetchImpl = opts.fetchImpl || ((...a) => fetch(...a))
  }

  mirrorUrl() {
    return this.mirror
  }

  /** 运行时切换镜像（保存配置后即时生效，无需重启）。 */
  setMirror(mirror) {
    const m = String(mirror || '').replace(/\/+$/, '')
    if (!m) return
    if (!this.mirrors.includes(m)) this.mirrors.unshift(m)
    this.mirror = m
  }

  /** 当前候选镜像列表（GUI 展示 + 测试断言用）。 */
  listMirrors() {
    return [...this.mirrors]
  }

  /** 当前进度快照（无任务时 null）。 */
  getProgress() {
    return this.progress ? { ...this.progress } : null
  }

  /** 是否有任务在跑（含校验阶段）。 */
  isBusy() {
    return this.busy
  }

  modelsDir(id) {
    return path.join(this.dataDir, 'models', id)
  }

  /** 全目录状态扫描（设置页模型卡数据源）。 */
  async listStatus() {
    const out = []
    for (const entry of MODEL_CATALOG) {
      const dir = this.modelsDir(entry.id)
      let bytes = 0
      let complete = true
      let anyFile = false
      for (const f of entry.files) {
        const size = await fileSize(path.join(dir, f.path))
        const partSize = await fileSize(path.join(dir, `${f.path}.part`))
        if (size === f.size) {
          bytes += size
          anyFile = true
        } else if (partSize !== null) {
          bytes += partSize
          complete = false
          anyFile = true
        } else if (size !== null) {
          bytes += size
          complete = false
          anyFile = true
        } else {
          complete = false
        }
      }
      out.push({
        id: entry.id,
        name: entry.name,
        dims: entry.dims,
        tags: entry.tags,
        description: entry.description,
        state: complete && anyFile ? 'downloaded' : anyFile ? 'partial' : 'none',
        bytesOnDisk: bytes,
        totalBytes: catalogTotalBytes(entry),
      })
    }
    return out
  }

  /** 单模型是否已完整下载（尺寸口径，不做哈希复验——下载完成时已验过）。 */
  async isDownloaded(id) {
    return (await this.listStatus()).find((s) => s.id === id)?.state === 'downloaded'
  }

  /** 删除已下载模型（切走后释放磁盘；正在使用/下载中的拒绝）。
   *  id 需为目录安全名（无路径分隔/穿越），允许删除白名单外目录（清理 partial/损坏残留）。 */
  async deleteModel(id) {
    if (typeof id !== 'string' || !id || /[\\/]|\.\./.test(id)) {
      return { ok: false, error: '非法模型 id' }
    }
    if (this.busy && this.progress?.modelId === id) return { ok: false, error: '该模型正在下载' }
    try {
      await fsp.rm(this.modelsDir(id), { recursive: true, force: true })
      this.log?.info?.(`[memory-manager] 已删除模型 ${id}`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 启动下载（串行队列：忙时直接拒绝）。resolve 在任务终态（done/error/cancelled）。 */
  async start(id) {
    const entry = catalogById(id)
    if (!entry) throw new Error(`未知模型: ${id}`)
    return this.startEntry(entry)
  }

  /** 按给定目录项启动（测试缝：合成目录项驱动状态机，不触网）。 */
  async startEntry(entry) {
    if (this.busy) throw new Error('已有下载任务进行中（串行队列，请等待或取消）')
    this.busy = true
    this.abort = new AbortController()
    const totalBytes = catalogTotalBytes(entry)
    this.progress = {
      modelId: entry.id,
      phase: 'downloading',
      fileIndex: 0,
      fileCount: entry.files.length,
      fileReceived: 0,
      fileTotal: 0,
      overallReceived: 0,
      overallTotal: totalBytes,
      speedBps: 0,
      startedAt: Date.now(),
    }
    try {
      await this.run(entry)
      this.progress.phase = 'done'
      this.log?.info?.(`[memory-manager] 模型 ${entry.id} 下载校验完成（${totalBytes} 字节）`)
      return { ...this.progress }
    } catch (err) {
      const cancelled = this.progress.phase === 'cancelled'
      const message = err instanceof Error ? err.message : String(err)
      if (!cancelled) {
        this.progress.phase = 'error'
        this.progress.error = message
        this.log?.warn?.(`[memory-manager] 模型 ${entry.id} 下载失败: ${message}`)
      }
      return { ...this.progress }
    } finally {
      this.busy = false
      this.abort = null
    }
  }

  /** 取消当前任务：中断 fetch，保留 .part 断点。 */
  cancel() {
    if (!this.busy || !this.abort) return false
    if (this.progress) this.progress.phase = 'cancelled'
    this.abort.abort()
    return true
  }

  async run(entry) {
    const prog = this.progress
    // 磁盘门禁：剩余空间 ≥ 体积 × 1.2（statfs 不可用则跳过检查）
    const free = await this.freeBytes()
    if (free !== null) {
      const need = Math.ceil(catalogTotalBytes(entry) * DISK_HEADROOM)
      if (free < need) {
        const fmt = (n) => (n >= 1e6 ? `${Math.round(n / 1e6)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`)
        throw new Error(`磁盘剩余空间不足：需要约 ${fmt(need)}（含 20% 余量），当前 ${fmt(free)}`)
      }
    }
    const dir = this.modelsDir(entry.id)
    await fsp.mkdir(path.join(dir, 'onnx'), { recursive: true })
    let overall = 0
    // 之前已完整就位的文件计入整体进度（重试/断点续传场景分母口径一致）
    for (const f of entry.files) {
      if ((await fileSize(path.join(dir, f.path))) === f.size) overall += f.size
    }
    for (let i = 0; i < entry.files.length; i += 1) {
      if (prog.phase === 'cancelled') throw new Error('已取消')
      const f = entry.files[i]
      prog.fileIndex = i + 1
      prog.fileTotal = f.size
      const alreadyOk = (await fileSize(path.join(dir, f.path))) === f.size
      if (alreadyOk) {
        prog.fileReceived = f.size
        continue
      }
      overall += await this.downloadFile(entry, f, dir, (received) => {
        prog.fileReceived = received
        prog.overallReceived = overall + received
      })
      prog.overallReceived = overall
    }
  }

  /** 下载单文件到最终路径（含续传与校验），返回该文件贡献的字节数。
   *  - 镜像 failover：当前镜像所有重试耗尽后自动切下一个镜像（主镜像 hf-mirror.com 失败
   *    → 官方 huggingface.co 兜底），全部耗尽才抛错；
   *  - sha256 失配：downloadFileOnce 已删除断点 → 从零重下；
   *  - 数量不齐/网络错误：断点保留 → Range 续传重试；
   *  - 取消：立即上抛不重试。 */
  async downloadFile(entry, f, dir, onBytes) {
    const delays = this.opts.retryDelaysMs ?? [1000, 3000]
    let lastErr
    // 每个镜像一轮重试；轮间换镜像（failover）
    for (let mi = 0; mi < this.mirrors.length; mi += 1) {
      this.mirror = this.mirrors[mi]
      for (let attempt = 0; ; attempt += 1) {
        if (this.progress?.phase === 'cancelled') throw new Error('已取消')
        try {
          return await this.downloadFileOnce(entry, f, dir, attempt, onBytes)
        } catch (err) {
          lastErr = err
          if (this.progress?.phase === 'cancelled') throw err
          if (attempt >= delays.length) break
          const msg = err instanceof Error ? err.message : String(err)
          this.log?.warn?.(`[memory-manager] 文件 ${f.path} 镜像 ${this.mirror} 第 ${attempt + 1} 次尝试失败（${msg}），${delays[attempt]}ms 后自动重试（换缓存键）`)
          await new Promise((r) => setTimeout(r, delays[attempt]))
        }
      }
      // 当前镜像所有重试耗尽 → 换下一个镜像（保留断点续传）
      if (mi < this.mirrors.length - 1) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
        this.log?.warn?.(`[memory-manager] 文件 ${f.path} 镜像 ${this.mirror} 重试耗尽，切换 ${this.mirrors[mi + 1]}（${msg}）`)
      }
    }
    throw lastErr ?? new Error('下载失败')
  }

  /** 单次尝试：续传探测 → fetch（attempt>0 追加缓存键参数）→ 落盘 → 尺寸 + sha256 校验 → rename。 */
  async downloadFileOnce(entry, f, dir, attempt, onBytes) {
    const finalPath = path.join(dir, f.path)
    const partPath = `${finalPath}.part`
    const base = this.mirrorUrl()
    const cacheBust = attempt > 0 ? `?dshmem-retry=${attempt}` : ''
    const url = `${base}/${entry.repo}/resolve/${entry.revision}/${f.path}${cacheBust}`
    const prog = this.progress
    let resumeFrom = 0
    const partSize = await fileSize(partPath)
    if (partSize !== null && partSize < f.size) {
      resumeFrom = partSize
    } else if (partSize === f.size) {
      // 断点已写满但尚未 rename（进程在最后一个字节与改名间被杀）：直接校验收编，
      // 避免发 bytes=<size>- 后 416 死循环
      const pre = await sha256File(partPath)
      if (pre === f.sha256) {
        await fsp.rename(partPath, finalPath)
        return f.size
      }
      await fsp.rm(partPath, { force: true })
    } else if (partSize !== null) {
      await fsp.rm(partPath, { force: true })
    }

    const headers = {}
    if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`
    let res = await this.fetchImpl(url, { headers, signal: this.abort?.signal })
    if (res.status === 416 && resumeFrom > 0) {
      // 服务器对已满 Range 回 416：删断点从零重来（一次性）
      await fsp.rm(partPath, { force: true })
      resumeFrom = 0
      delete headers.range
      res = await this.fetchImpl(url, { headers, signal: this.abort?.signal })
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}（${f.path}）`)
    const appending = res.status === 206 && resumeFrom > 0
    if (!appending) resumeFrom = 0
    const declared = Number(res.headers.get('content-length') ?? 0)
    const expectBytes = appending ? resumeFrom + declared : declared || f.size
    const handle = await fsp.open(partPath, appending ? 'a' : 'w')
    let received = resumeFrom
    let lastTick = Date.now()
    let lastBytes = received
    try {
      if (!res.body) throw new Error('响应无 body')
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (prog.phase === 'cancelled') throw new Error('已取消')
        await handle.write(value)
        received += value.byteLength
        const now = Date.now()
        if (now - lastTick > 200) {
          const inst = ((received - lastBytes) / (now - lastTick)) * 1000
          prog.speedBps = prog.speedBps * 0.6 + inst * 0.4
          lastTick = now
          lastBytes = received
        }
        onBytes(Math.min(received, f.size))
        prog.fileTotal = expectBytes || f.size
      }
    } finally {
      await handle.close()
    }
    if (received !== f.size) {
      throw new Error(`下载数量不齐：期望 ${f.size}，收到 ${received}（${f.path}）`)
    }
    // 校验（含续传）：落盘后单遍流式哈希
    prog.phase = 'verifying'
    const sha = await sha256File(partPath)
    if (sha !== f.sha256) {
      await fsp.rm(partPath, { force: true })
      throw new Error(`sha256 校验失败（${f.path}），已删除断点，请重试`)
    }
    // 校验期间取消（cancel 把 phase 置 cancelled）：不得被下面覆写回 downloading
    if (prog.phase === 'cancelled') throw new Error('已取消')
    prog.phase = 'downloading'
    await fsp.rename(partPath, finalPath)
    return f.size
  }

  async freeBytes() {
    if (this.opts.freeBytes) return this.opts.freeBytes()
    try {
      const s = await fsp.statfs(this.dataDir)
      return Number(BigInt(s.bavail) * BigInt(s.bsize))
    } catch {
      return null
    }
  }
}

async function fileSize(p) {
  try {
    const s = await fsp.stat(p)
    return s.isFile() ? s.size : null
  } catch {
    return null
  }
}

async function sha256File(p) {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(p)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}
