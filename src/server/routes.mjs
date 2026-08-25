/**
 * REST 路由实现（contracts/web-api.md）。DSH 适配层与独立服务器共用。
 * attachRoutes(getEngine) 返回一个 (req, res) => Promise<void> 处理器。
 * @module src/server/routes
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GUI_ROOT = path.resolve(__dirname, '..', '..', 'gui')
const VERSION = '1.0.0'

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(body)
}

function sendError(res, code, message, status = 400) {
  sendJson(res, status, { error: { code, message } })
}

async function readBody(req, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonBody(req) {
  const text = await readBody(req)
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('invalid json body')
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
}

/** 静态资源处理（gui/ 目录）。 */
function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  // /gui/* 前缀对应 gui/ 根目录
  rel = rel.replace(/^gui\//, '')
  // 防目录穿越
  const file = path.normalize(path.join(GUI_ROOT, rel))
  if (!file.startsWith(GUI_ROOT)) {
    sendError(res, 'NOT_FOUND', 'Not found', 404)
    return
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    sendError(res, 'NOT_FOUND', 'Not found', 404)
    return
  }
  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}

/**
 * DSH 托管 GUI 的静态处理器：把 GUI 静态文件挂到 DSH webServer 的某前缀下
 * （默认 /memory-manager）。REST 仍在 /api/memory（同源绝对路径，GUI 直接可用）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} prefix 挂载前缀
 */
export function serveGuiHandler(req, res, prefix = '/memory-manager') {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }))
    return
  }
  const url = new URL(req.url, 'http://localhost')
  let rel = url.pathname
  if (rel === prefix || rel === `${prefix}/`) rel = '/'
  else if (rel.startsWith(`${prefix}/`)) rel = rel.slice(prefix.length)
  else {
    sendError(res, 'NOT_FOUND', 'Not found', 404)
    return
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end()
    return
  }
  serveStatic(res, rel)
}

/**
 * @param {() => import('../core/index.mjs').MemoryEngine} getEngine
 */
export function attachRoutes(getEngine) {
  return async (req, res) => {
    try {
      await handle(req, res, getEngine)
    } catch (e) {
      const code = e?.code ?? 'INTERNAL'
      sendError(res, code, e?.message || '内部错误', code === 'VALIDATION_ERROR' ? 400 : (code === 'NOT_FOUND' ? 404 : 500))
    }
  }
}

async function handle(req, res, getEngine) {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  const method = req.method

  // 静态 GUI
  if (method === 'GET' && (p === '/' || p.startsWith('/gui/') || p === '/index.html')) {
    serveStatic(res, p)
    return
  }

  if (!p.startsWith('/api/memory')) {
    sendError(res, 'NOT_FOUND', 'Not found', 404)
    return
  }
  const rel = p.replace(/^\/api\/memory\/?/, '')
  const engine = getEngine()

  // 认证（可选 token）
  if (engine.config?.storage?.api_token) {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${engine.config.storage.api_token}`) {
      sendError(res, 'UNAUTHORIZED', '未授权：需要 Bearer token', 401)
      return
    }
  }

  // 健康检查
  if (method === 'GET' && rel === 'healthz') {
    sendJson(res, 200, { ok: true, version: VERSION, embedding_status: engine.embedding.status().kind })
    return
  }
  // 统计
  if (method === 'GET' && rel === 'stats') {
    sendJson(res, 200, await engine.stats())
    return
  }
  // 记忆列表（时间线）
  if (method === 'GET' && rel === 'memories') {
    const session = url.searchParams.get('session') ?? undefined
    const g = url.searchParams.get('global')
    const tag = url.searchParams.get('tag') ?? undefined
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    let items = engine.store.list()
    if (session) items = items.filter((r) => r.session_id === session)
    if (g === '1') items = items.filter((r) => r.is_global)
    if (g === '0') items = items.filter((r) => !r.is_global)
    if (tag) items = items.filter((r) => r.tags.includes(tag))
    const total = items.length
    items = items.slice(offset, offset + limit).map((r) => ({ ...r, content: engine.decryptContent(r) }))
    sendJson(res, 200, { items, total })
    return
  }
  // 单条
  const idMatch = rel.match(/^memories\/([^/]+)$/)
  if (method === 'GET' && idMatch) {
    const rec = engine.store.get(idMatch[1])
    if (!rec) { sendError(res, 'NOT_FOUND', '记忆不存在', 404); return }
    sendJson(res, 200, { ...rec, content: engine.decryptContent(rec) })
    return
  }
  if (method === 'DELETE' && idMatch) {
    const r = await engine.deleteMemory('default', { ids: [idMatch[1]], allSessions: true })
    sendJson(res, 200, r)
    return
  }
  // 批量删除
  if (method === 'POST' && rel === 'memories/delete') {
    const body = await readJsonBody(req)
    const ids = Array.isArray(body.ids) ? body.ids : []
    const conds = body.conditions && typeof body.conditions === 'object' ? body.conditions : {}
    if (ids.length === 0 && Object.keys(conds).length === 0) {
      sendError(res, 'VALIDATION_ERROR', '缺少删除目标：请提供 ids 或 conditions', 400)
      return
    }
    const r = await engine.deleteMemory(body.session_id ?? 'default', { ids, conditions: conds, allSessions: true })
    sendJson(res, 200, r)
    return
  }
  // 检索
  if (method === 'POST' && rel === 'search') {
    const body = await readJsonBody(req)
    if (!body.query) { sendError(res, 'VALIDATION_ERROR', '缺少 query', 400); return }
    sendJson(res, 200, await engine.search(body.query, {
      topK: body.top_k, threshold: body.threshold, sessionId: body.session_id ?? 'default', includeGlobal: body.include_global,
    }))
    return
  }
  // 短期上下文
  if (method === 'GET' && rel === 'recent') {
    const sessionId = url.searchParams.get('session') ?? 'default'
    const n = url.searchParams.get('n') ? Number(url.searchParams.get('n')) : undefined
    sendJson(res, 200, await engine.getRecent(sessionId, n ? { maxMessages: n } : {}))
    return
  }
  // 摘要
  if (method === 'POST' && rel === 'summarize') {
    const body = await readJsonBody(req)
    sendJson(res, 200, await engine.summarize(body.session_id ?? 'default', { count: body.count }))
    return
  }
  // 重要性
  const impMatch = rel.match(/^memories\/([^/]+)\/importance$/)
  if (method === 'PATCH' && impMatch) {
    const body = await readJsonBody(req)
    sendJson(res, 200, await engine.updateImportance(impMatch[1], body.score))
    return
  }
  // 配置
  if (method === 'GET' && rel === 'config') {
    // 脱敏：主密码/OpenAI Key 不回传明文（GUI 只需知道是否已设置 + 回填星号）。
    // api_token 是本地 REST 鉴权令牌且 GUI 需回传保持会话，原样返回（防护面=本地端口）。
    const cfg = JSON.parse(JSON.stringify(engine.config))
    const mask = (v) => (v ? '***' : '')
    if (cfg.storage) { cfg.storage.has_password = !!cfg.storage.master_password; cfg.storage.master_password = mask(cfg.storage.master_password) }
    if (cfg.long_term) cfg.long_term.openai_api_key = mask(cfg.long_term.openai_api_key)
    sendJson(res, 200, cfg)
    return
  }
  if (method === 'POST' && rel === 'config') {
    const body = await readJsonBody(req)
    const saved = await engine.saveConfig(body)
    sendJson(res, 200, { saved: true, config: saved })
    return
  }
  // 导出
  if (method === 'GET' && rel === 'export') {
    const format = url.searchParams.get('format') === 'jsonl' ? 'jsonl' : 'json'
    const text = await engine.exportBackup({ format })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="memory-backup-${ts}.${format}"`,
    })
    res.end(text)
    return
  }
  // 导入
  if (method === 'POST' && rel === 'import') {
    const body = await readJsonBody(req)
    const r = await engine.importBackup(body.text ?? '', { mode: body.mode ?? 'merge' })
    sendJson(res, 200, r)
    return
  }
  // 清理
  if (method === 'POST' && rel === 'cleanup') {
    sendJson(res, 200, await engine.runLifecycle())
    return
  }
  // 重建向量索引（更换嵌入模型后调用；期间检索自动降级关键词）
  if (method === 'POST' && rel === 'reindex') {
    sendJson(res, 200, await engine.reindex())
    return
  }

  sendError(res, 'NOT_FOUND', 'Not found', 404)
}
