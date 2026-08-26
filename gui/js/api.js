/**
 * Web GUI API 客户端：封装 /api/memory 端点。
 * 供 gui/index.html（真实模式）使用；preview.html 使用同款方法签名 + 模拟数据。
 * @module gui/js/api
 */

export class MemoryApi {
  constructor(base = '') {
    this.base = base.replace(/\/+$/, '')
    this.token = localStorage.getItem('dsh_mem_token') || ''
  }

  setToken(t) {
    this.token = t
    localStorage.setItem('dsh_mem_token', t)
  }

  headers(json = false) {
    const h = {}
    if (this.token) h.Authorization = `Bearer ${this.token}`
    if (json) h['Content-Type'] = 'application/json'
    return h
  }

  async _fetch(path, opts = {}) {
    const resp = await fetch(this.base + path, opts)
    let data = null
    try { data = await resp.json() } catch { /* 非 JSON 响应 */ }
    if (!resp.ok) {
      const msg = data?.error?.message || `HTTP ${resp.status}`
      throw new Error(msg)
    }
    return data
  }

  get(path) {
    return this._fetch(path, { headers: this.headers() })
  }

  post(path, body) {
    return this._fetch(path, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body ?? {}),
    })
  }

  patch(path, body) {
    return this._fetch(path, {
      method: 'PATCH',
      headers: this.headers(true),
      body: JSON.stringify(body ?? {}),
    })
  }

  del(path) {
    return this._fetch(path, { method: 'DELETE', headers: this.headers() })
  }

  // ---- 业务方法 ----
  healthz() { return this.get('/api/memory/healthz') }
  stats() { return this.get('/api/memory/stats') }
  meta() { return this.get('/api/memory/meta') }
  memories(params = {}) {
    const q = new URLSearchParams()
    for (const k of Object.keys(params)) if (params[k] !== undefined && params[k] !== '') q.set(k, params[k])
    const s = q.toString()
    return this.get(`/api/memory/memories${s ? `?${s}` : ''}`)
  }
  memory(id) { return this.get(`/api/memory/memories/${id}`) }
  deleteMemory(id) { return this.del(`/api/memory/memories/${id}`) }
  deleteBatch(body) { return this.post('/api/memory/memories/delete', body) }
  search(query, opts = {}) {
    return this.post('/api/memory/search', { query, top_k: opts.top_k, threshold: opts.threshold, session_id: opts.session_id, include_global: opts.include_global, offset: opts.offset })
  }
  recent(session, n) { return this.get(`/api/memory/recent?session=${encodeURIComponent(session || 'default')}${n ? `&n=${n}` : ''}`) }
  summarize(body) { return this.post('/api/memory/summarize', body) }
  importance(id, score) { return this.patch(`/api/memory/memories/${id}/importance`, { score }) }
  getConfig() { return this.get('/api/memory/config') }
  // P6 会话档位（manager 自己的模式）
  modeGet(session) { return this.get(`/api/memory/mode${session ? `?session=${encodeURIComponent(session)}` : ''}`) }
  modeSet(session, mode) { return this.put('/api/memory/mode', { session, mode }) }
  saveConfig(body) { return this.post('/api/memory/config', body) }
  exportBackup(format = 'json') {
    const q = format === 'jsonl' ? '?format=jsonl' : ''
    return fetch(this.base + `/api/memory/export${q}`, { headers: this.headers() })
  }
  importBackup(text, mode = 'merge') { return this.post('/api/memory/import', { text, mode }) }
  cleanup() { return this.post('/api/memory/cleanup', {}) }
  reindex() { return this.post('/api/memory/reindex', {}) }

  // ---- layered 分层记忆（只读直连 dsh-layered-memory 真实数据；P2/P3） ----
  layeredStats() { return this.get('/api/memory/layered/stats') }
  layeredL1(params = {}) {
    const q = new URLSearchParams()
    for (const k of ['type', 'family', 'scene', 'offset', 'limit']) if (params[k] !== undefined && params[k] !== '') q.set(k, params[k])
    const s = q.toString()
    return this.get(`/api/memory/layered/l1${s ? `?${s}` : ''}`)
  }
  layeredScenes(params = {}) {
    const q = new URLSearchParams()
    if (params.family) q.set('family', params.family)
    const s = q.toString()
    return this.get(`/api/memory/layered/scenes${s ? `?${s}` : ''}`)
  }
  layeredScene(family, name) { return this.get(`/api/memory/layered/scenes/${encodeURIComponent(family)}/${encodeURIComponent(name)}`) }
  layeredPersona(family) { return this.get(`/api/memory/layered/persona?family=${encodeURIComponent(family)}`) }
  layeredL0(params = {}) {
    const q = new URLSearchParams()
    for (const k of ['session', 'offset', 'limit']) if (params[k] !== undefined && params[k] !== '') q.set(k, params[k])
    const s = q.toString()
    return this.get(`/api/memory/layered/l0${s ? `?${s}` : ''}`)
  }
  layeredSessions() { return this.get('/api/memory/layered/sessions') }
  layeredModeGet(session) { return this.get(`/api/memory/layered/mode${session ? `?session=${encodeURIComponent(session)}` : ''}`) }
  layeredModeSet(session, mode) { return this.put('/api/memory/layered/mode', { session, mode }) }

  // ---- 日志（P5：memory.log 分页读取，GUI「日志」Tab） ----
  logs(params = {}) {
    const q = new URLSearchParams()
    for (const k of ['offset', 'limit', 'level']) if (params[k] !== undefined && params[k] !== '') q.set(k, params[k])
    const s = q.toString()
    return this.get(`/api/memory/logs${s ? `?${s}` : ''}`)
  }

  put(path, body) {
    return this._fetch(path, {
      method: 'PUT',
      headers: this.headers(true),
      body: JSON.stringify(body ?? {}),
    })
  }
}

export const api = new MemoryApi()
