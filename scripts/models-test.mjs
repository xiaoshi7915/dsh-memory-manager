// P7 模型下载 / 嵌入源聚焦测试（dry-run：注入假 fetch 合成小模型，不真下载大文件）：
//  1. 模型目录完整性（3 款白名单，每文件 sha256+size，dims 合法）
//  2. 下载器状态机（注入 fetch）：断点续传(Range) / sha256 失配删重下 / 数量不齐 / 串行拒绝 / 取消 / listStatus / 删除
//  3. EmbeddingSourceStore：无文件=remote / set+persist+reload / 损坏容错
//  4. EmbeddingProvider 三态：off(空向量) / local 无模型降级 hash / remote 无 key 降级
//  5. 引擎 switchEmbeddingSource：off/remote/local 持久化 + 校验
//  6. REST：models 列表 / switch 非法 400 / local 无模型 400
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-model-'))
process.env.DSH_MEMORY_DIR = base
const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

// ---- 1. 模型目录完整性 ----
{
  const { MODEL_CATALOG } = await import('../src/core/model-catalog.mjs')
  check('1 白名单 3 款', MODEL_CATALOG.length === 3)
  const ids = MODEL_CATALOG.map((m) => m.id)
  check('1 含 bge-small-zh-v1.5 / embeddinggemma-300m / bge-m3',
    ids.includes('bge-small-zh-v1.5') && ids.includes('embeddinggemma-300m') && ids.includes('bge-m3'))
  for (const m of MODEL_CATALOG) {
    check(`1 ${m.id} 每文件有 sha256+size`,
      m.files.length > 0 && m.files.every((f) => typeof f.sha256 === 'string' && f.sha256.length === 64 && typeof f.size === 'number' && f.size > 0))
    check(`1 ${m.id} dims 合法`, [512, 768, 1024].includes(m.dims))
    check(`1 ${m.id} revision 锁定`, typeof m.revision === 'string' && m.revision.length >= 40)
  }
  const { catalogById, catalogTotalBytes } = await import('../src/core/model-catalog.mjs')
  check('1 catalogById 命中', catalogById('bge-m3')?.dims === 1024)
  check('1 catalogTotalBytes 求和', catalogTotalBytes(MODEL_CATALOG[0]) === MODEL_CATALOG[0].files.reduce((s, f) => s + f.size, 0))
}

// ---- 2. 下载器状态机（注入 fetch） ----
{
  const { ModelDownloadQueue } = await import('../src/core/downloader.mjs')
  const fsp = await import('node:fs/promises')
  // 合成一个单文件模型：内容固定，可注入网络行为
  const payload = Buffer.from('fake-model-bytes-'.repeat(100)) // 1600 bytes
  const payloadSha = createHash('sha256').update(payload).digest('hex')
  const synthEntry = {
    id: 'synth-test', repo: 'fake/repo', revision: 'a'.repeat(40), dims: 4, contextTokens: 8, pooling: 'mean',
    files: [{ path: 'model.bin', size: payload.length, sha256: payloadSha }],
  }
  const modelsDir = join(base, 'models', 'synth-test')
  const clean = async () => { try { await fsp.rm(modelsDir, { recursive: true, force: true }) } catch { /* 忽略 */ } }
  // fetch 注入：支持 Range；可触发 sha 失配 / 数量不齐
  let mode = 'ok'
  let lastRange = null
  const makeFetch = () => async (url, init) => {
    const range = init?.headers?.range || null
    lastRange = range
    const body = new ReadableStream({
      start(controller) {
        if (mode === 'bad-sha') {
          // 同尺寸但内容不同 → 触发 sha256 失配
          controller.enqueue(Buffer.alloc(payload.length, 7))
        } else if (mode === 'short') {
          controller.enqueue(payload.subarray(0, payload.length - 5))
        } else if (range) {
          const start = parseInt(range.replace('bytes=', '').split('-')[0], 10)
          controller.enqueue(payload.subarray(start))
        } else {
          controller.enqueue(payload)
        }
        controller.close()
      },
    })
    const start = range ? parseInt(range.replace('bytes=', '').split('-')[0], 10) : 0
    return {
      ok: true, status: range ? 206 : 200,
      headers: { get: (k) => (k === 'content-length' ? String(payload.length - start) : null) },
      body,
    }
  }
  // 2a. 正常下载
  await clean()
  let q = new ModelDownloadQueue(base, { fetchImpl: makeFetch() })
  const r1 = await q.startEntry(synthEntry)
  check('2a 正常下载完成', r1.phase === 'done', JSON.stringify(r1))
  check('2a 文件落盘且尺寸正确', (await fsp.stat(join(modelsDir, 'model.bin'))).size === payload.length)
  check('2a 无残留 .part', !(await fsp.stat(join(modelsDir, 'model.bin.part')).then(() => true).catch(() => false)))
  // 2b. 断点续传：删最终文件，留 .part 半截 → 应从断点续传
  await clean()
  await fsp.mkdir(modelsDir, { recursive: true })
  await fsp.writeFile(join(modelsDir, 'model.bin.part'), payload.subarray(0, 100))
  q = new ModelDownloadQueue(base, { fetchImpl: makeFetch() })
  const r2 = await q.startEntry(synthEntry)
  check('2b 断点续传完成', r2.phase === 'done')
  check('2b 请求带 Range', lastRange === 'bytes=100-', String(lastRange))
  check('2b 续传后文件完整', (await fsp.stat(join(modelsDir, 'model.bin'))).size === payload.length)
  // 2c. sha256 失配 → 删重下并报错
  await clean()
  mode = 'bad-sha'
  q = new ModelDownloadQueue(base, { fetchImpl: makeFetch() })
  const r3 = await q.startEntry(synthEntry)
  check('2c sha256 失配报错', r3.phase === 'error' && /sha256/.test(r3.error || ''), JSON.stringify(r3))
  mode = 'ok'
  // 2d. 串行队列：busy 时拒绝
  q = new ModelDownloadQueue(base, { fetchImpl: makeFetch() })
  q.busy = true
  let threw = false
  try { await q.startEntry(synthEntry) } catch { threw = true }
  check('2d 串行拒绝', threw)
  // 2e. 取消（需 busy=true 模拟在途下载；cancel 仅置位，startEntry 的 finally 会复位 busy）
  q.busy = true
  q.progress = { modelId: 'synth-test', phase: 'downloading', fileIndex: 1, fileCount: 1 }
  q.abort = new AbortController()
  check('2e cancel 置 cancelled', (() => { q.cancel(); return q.progress.phase === 'cancelled' })())
  q.busy = false // 模拟 startEntry finally 复位
  // 2f. 删除模型（含非白名单目录清理）
  await clean()
  await fsp.mkdir(join(modelsDir, 'onnx'), { recursive: true })
  await fsp.writeFile(join(modelsDir, 'stale.bin'), 'x')
  check('2f deleteModel 成功', (await q.deleteModel('synth-test')).ok === true)
  check('2f 删除后目录移除', !existsSync(modelsDir))
  check('2f 非法 id 拒绝（穿越）', (await q.deleteModel('../../evil')).ok === false)
}

// ---- 2g. 镜像 failover（主镜像失败自动切备用）+ 默认镜像 = hf-mirror.com ----
{
  const { ModelDownloadQueue } = await import('../src/core/downloader.mjs')
  const fsp = await import('node:fs/promises')
  const payload = Buffer.from('mirror-failover-'.repeat(50))
  const payloadSha = createHash('sha256').update(payload).digest('hex')
  const synthEntry = {
    id: 'synth-mirror', repo: 'fake/repo', revision: 'b'.repeat(40), dims: 4, contextTokens: 8, pooling: 'mean',
    files: [{ path: 'model.bin', size: payload.length, sha256: payloadSha }],
  }
  const modelsDir = join(base, 'models', 'synth-mirror')
  try { await fsp.rm(modelsDir, { recursive: true, force: true }) } catch {}
  // 主镜像 500，备用镜像 ok → 应 failover 成功
  const seenMirrors = []
  const failoverFetch = async (url) => {
    seenMirrors.push(url)
    if (url.startsWith('https://hf-mirror.com/')) {
      return { ok: false, status: 500, headers: { get: () => null }, body: null }
    }
    const body = new ReadableStream({ start(c) { c.enqueue(payload); c.close() } })
    return { ok: true, status: 200, headers: { get: (k) => (k === 'content-length' ? String(payload.length) : null) }, body }
  }
  const q = new ModelDownloadQueue(base, { fetchImpl: failoverFetch })
  const r = await q.startEntry(synthEntry)
  check('2g 默认镜像列表首位 hf-mirror.com', q.listMirrors()[0] === 'https://hf-mirror.com', JSON.stringify(q.listMirrors()))
  check('2g 镜像列表含官方兜底', q.listMirrors().includes('https://huggingface.co'))
  check('2g 主镜像失败自动切备用完成', r.phase === 'done', JSON.stringify(r))
  check('2g 确实访问过两个镜像', seenMirrors.some((u) => u.startsWith('https://hf-mirror.com/')) && seenMirrors.some((u) => u.startsWith('https://huggingface.co/')), JSON.stringify(seenMirrors[0]))
  // 显式 mirror 覆盖
  const q2 = new ModelDownloadQueue(base, { mirror: 'https://custom.example.com', fetchImpl: failoverFetch })
  check('2g 显式 mirror 生效', q2.listMirrors()[0] === 'https://custom.example.com', JSON.stringify(q2.listMirrors()))
}

// ---- 3. EmbeddingSourceStore ----
{
  const { EmbeddingSourceStore, SOURCES } = await import('../src/core/embedding-source.mjs')
  check('3 SOURCES 三态', JSON.stringify(SOURCES) === JSON.stringify(['off', 'remote', 'local']))
  const s = new EmbeddingSourceStore(base)
  await s.init()
  check('3 无文件默认 remote', s.get().source === 'remote')
  await s.set({ source: 'local', activeModel: 'bge-m3' })
  check('3 set 后持久化', existsSync(join(base, 'embedding-source.json')))
  const s2 = new EmbeddingSourceStore(base)
  await s2.init()
  check('3 reload 保留 local/bge-m3', s2.get().source === 'local' && s2.get().activeModel === 'bge-m3')
  // 损坏容错
  writeFileSync(join(base, 'embedding-source.json'), '{bad json')
  const s3 = new EmbeddingSourceStore(base)
  await s3.init()
  check('3 损坏回退 remote', s3.get().source === 'remote')
}

// ---- 4. EmbeddingProvider 三态 ----
{
  const { EmbeddingProvider } = await import('../src/core/embedding.mjs')
  const off = new EmbeddingProvider({ source: 'off', dataDir: base })
  await off.init()
  check('4 off 空向量', off.status().kind === 'off' && (await off.embed('x')).length === 0)
  const localNoModel = new EmbeddingProvider({ source: 'local', modelId: 'bge-m3', dataDir: base })
  await localNoModel.init()
  check('4 local 未下载降级 hash', localNoModel.status().kind === 'hash', localNoModel.status().detail)
  const remoteNoKey = new EmbeddingProvider({ source: 'remote', dataDir: base })
  await remoteNoKey.init()
  check('4 remote 无 key 降级 hash', remoteNoKey.status().kind === 'hash')
  const remoteWithKey = new EmbeddingProvider({ source: 'remote', apiKey: 'sk-test', dataDir: base })
  await remoteWithKey.init()
  check('4 remote 有 key = remote', remoteWithKey.status().kind === 'remote')
  const fp = new EmbeddingProvider({ source: 'local', modelId: 'bge-m3', dataDir: base })
  await fp.init()
  check('4 local 未下载 fingerprint=hash', fp.fingerprint() === 'hash:512', fp.fingerprint())
  const offFp = new EmbeddingProvider({ source: 'off', dataDir: base })
  await offFp.init()
  check('4 off fingerprint=off:0', offFp.fingerprint() === 'off:0')
}

// ---- 5. 引擎 switchEmbeddingSource ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({})
  const r1 = await e.switchEmbeddingSource('off')
  check('5 切 off 成功', r1.source === 'off' && r1.kind === 'off')
  await e.close()
  const e2 = await MemoryEngine.create({})
  check('5 off 持久化（重启仍 off）', e2.embeddingSource.get().source === 'off')
  // remote 无 key → 校验错误
  let threw = false
  try { await e2.switchEmbeddingSource('remote') } catch (err) { threw = true }
  check('5 remote 无 key 拒绝', threw)
  // local 无模型 id → 校验错误
  threw = false
  try { await e2.switchEmbeddingSource('local', null) } catch (err) { threw = true }
  check('5 local 无模型 id 拒绝', threw)
  await e2.close()
}

// ---- 6. REST ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const { attachRoutes } = await import('../src/server/routes.mjs')
  const e = await MemoryEngine.create({})
  const handler = attachRoutes(() => e)
  const call = (method, path, body) => new Promise((resolve) => {
    const req = new Readable({ read() {} })
    req.method = method; req.url = path
    req.headers = { host: '127.0.0.1:4599', 'content-type': 'application/json' }
    if (body) req.push(JSON.stringify(body))
    req.push(null)
    const res = { writeHead: (s) => { res.status = s }, end: (b) => resolve({ status: res.status, body: b ? JSON.parse(b.toString()) : null }) }
    handler(req, res)
  })
  const g = await call('GET', '/api/memory/models')
  check('6 GET models 200 且含 3 款', g.status === 200 && g.body.models.length === 3, JSON.stringify(g.body?.models?.length))
  check('6 GET models 含 source', g.body.source && g.body.embedding)
  const bad = await call('POST', '/api/memory/models/switch', { source: 'nope' })
  check('6 switch 非法 source 400', bad.status === 400)
  const badLocal = await call('POST', '/api/memory/models/switch', { source: 'local' })
  check('6 switch local 无模型 400', badLocal.status === 400)
  const delNoId = await call('DELETE', '/api/memory/models')
  check('6 DELETE 无 id 400', delNoId.status === 400)
  await e.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ P7 模型下载/嵌入源聚焦测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
