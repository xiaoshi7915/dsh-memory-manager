/**
 * Web GUI 主逻辑（四面板：记忆浏览 / 语义搜索 / 导入导出 / 设置）。
 * 依赖 ./api.js 的 MemoryApi。
 * @module gui/js/app
 */

import { api } from './api.js'

const $ = (sel, el = document) => el.querySelector(sel)
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)]

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (ts) => {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtBytes = (mb) => (mb < 1 ? `${Math.round(mb * 1024)} KB` : `${mb.toFixed(1)} MB`)

function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(el._t)
  el._t = setTimeout(() => el.classList.remove('show'), 2400)
}

function setStatus(on, label) {
  $('#status-dot').className = 'status-dot ' + (on ? 'on' : 'off')
  $('#status-label').textContent = label
}

function spinner(html) {
  return `<div class="empty"><div class="spinner"></div><div>${html}</div></div>`
}

const state = {
  memories: [],
  filters: { session: '', global: '', tag: '' },
  config: null,
}

/* ---------------- 工具函数 ---------------- */
function memCard(m, { score } = {}) {
  const tags = (m.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join(' ')
  const pct = score != null ? Math.round(score * 100) : null
  return `
  <div class="mem" data-id="${esc(m.id)}" data-imp="${Number(m.importance)}">
    <div class="mem-top">
      <div class="mem-content clamped">${esc(m.content)}</div>
    </div>
    <div class="mem-meta">
      <span class="badge imp">重要度 ${m.importance}</span>
      ${m.is_global ? '<span class="badge global">全局</span>' : `<span class="badge session">${esc(m.session_id)}</span>`}
      <span>${fmtTime(m.created_at)}</span>
      <span class="spacer" style="flex:1"></span>
      ${pct != null ? `<span class="score-bar" style="width:90px"><div class="score-track"><div class="score-fill" style="width:${pct}%"></div></div></span><span>${(score * 100).toFixed(1)}%</span>` : ''}
    </div>
    <div class="mem-detail">
      <div class="d-row"><span>ID</span><code>${esc(m.id)}</code></div>
      <div class="d-row"><span>标签</span>${tags || '<span class="hint">无</span>'}</div>
      <div class="d-row"><span>来源</span><span>${esc(m.source || '-')}</span><span>Tokens</span><span>${m.tokens ?? '-'}</span></div>
      <div class="d-row" style="margin-top:6px">
        <button class="btn ghost sm act-imp" data-id="${esc(m.id)}" data-d="1">重要性+1</button>
        <button class="btn ghost sm act-imp" data-id="${esc(m.id)}" data-d="-1">重要性-1</button>
        <button class="btn danger sm act-del" data-id="${esc(m.id)}">删除</button>
      </div>
    </div>
  </div>`
}

function emptyBox(title, sub) {
  return `<div class="empty"><div class="big">🧠</div><div style="font-weight:600">${title}</div><div class="hint">${sub || ''}</div></div>`
}

/* ---------------- 记忆浏览面板 ---------------- */
async function loadStats() {
  try {
    const s = await api.stats()
    $('#st-total').textContent = s.total_memories
    $('#st-st').textContent = `${s.short_term_tokens} tokens`
    $('#st-lt').textContent = s.long_term_count
    $('#st-size').textContent = fmtBytes(s.storage_size_mb)
    $('#st-emb').textContent = s.embedding_status === 'degraded' ? '降级(哈希)' : s.embedding_model
  } catch { /* 忽略 */ }
}

async function renderBrowser() {
  const box = $('#browser-list')
  box.innerHTML = spinner('正在加载记忆…')
  try {
    const f = state.filters
    const params = {}
    if (f.session) params.session = f.session
    if (f.global) params.global = f.global
    if (f.tag) params.tag = f.tag
    const data = await api.memories({ ...params, limit: 200 })
    state.memories = data.items || []
    await loadStats()
    if (state.memories.length === 0) {
      box.innerHTML = emptyBox('暂无记忆', '添加记忆后，它们会按时间线展示在这里')
      return
    }
    box.innerHTML = `<div class="mem-list">${state.memories.map((m) => memCard(m)).join('')}</div>`
    $$('#browser-list .mem').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return
        el.classList.toggle('open')
        el.querySelector('.mem-content').classList.toggle('clamped')
      })
    })
  } catch (e) {
    box.innerHTML = `<div class="alert err">加载失败：${esc(e.message)}</div>`
  }
}

async function refreshFilters() {
  try {
    const data = await api.memories({ limit: 500 })
    const sessions = new Set(data.items.map((m) => m.session_id))
    const tags = new Set(data.items.flatMap((m) => m.tags || []))
    $('#f-session').innerHTML = '<option value="">全部会话</option>' + [...sessions].map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')
    $('#f-tags').innerHTML = '<span class="chip gray clickable active" data-tag="">全部</span>' + [...tags].map((t) => `<span class="chip clickable" data-tag="${esc(t)}">${esc(t)}</span>`).join('')
    $$('#f-tags .chip').forEach((c) => {
      c.addEventListener('click', () => {
        $$('#f-tags .chip').forEach((x) => x.classList.remove('active'))
        c.classList.add('active')
        state.filters.tag = c.dataset.tag
        renderBrowser()
      })
    })
  } catch { /* 忽略 */ }
}

/* ---------------- 语义搜索面板 ---------------- */
async function doSearch() {
  const query = $('#sq-input').value.trim()
  const box = $('#search-results')
  if (!query) { box.innerHTML = emptyBox('输入检索内容', '例如：我喜欢用什么语言做数据分析'); return }
  box.innerHTML = spinner('正在检索…')
  const t0 = performance.now()
  try {
    // Number.isFinite 保留合法 0（阈值 0 = 接受全部结果），避免被 `|| 默认` 吞掉
    const n = (el, d) => { const v = Number($(el).value); return Number.isFinite(v) ? v : d }
    const topK = n('#sq-topk', 5)
    const thr = n('#sq-thr', 0.4)
    // GUI 是管理视图：默认搜全部会话（后端 session_id='*'），DSH agent 侧仍按真实会话隔离
    const sess = $('#sq-session').value.trim() || '*'
    const res = await api.search(query, { top_k: topK, threshold: thr, session_id: sess, include_global: $('#sq-global').checked })
    const ms = Math.round(performance.now() - t0)
    if (res.results.length === 0) {
      box.innerHTML = `<div class="empty"><div class="big">🔍</div><div style="font-weight:600">未找到相关记忆</div><div class="hint">试试降低相似度阈值或换一种问法</div></div>`
      return
    }
    box.innerHTML = `
      <div class="result-head"><span>共 ${res.total} 条</span><span>耗时 ${ms}ms</span></div>
      <div class="mem-list">${res.results.map((m) => memCard(m, { score: m.score })).join('')}</div>`
    $$('#search-results .mem').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return
        el.classList.toggle('open')
        el.querySelector('.mem-content').classList.toggle('clamped')
      })
    })
  } catch (e) {
    box.innerHTML = `<div class="alert err">检索失败：${esc(e.message)}</div>`
  }
}

/* ---------------- 导入导出面板 ---------------- */
async function doExport() {
  try {
    const fmt = $('#ex-format').value
    const resp = await api.exportBackup(fmt)
    const blob = await resp.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `memory-backup-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.${fmt}`
    a.click()
    URL.revokeObjectURL(a.href)
    toast('备份已导出')
  } catch (e) {
    toast('导出失败：' + e.message)
  }
}

function setupImport() {
  const dz = $('#dz')
  const fileInput = $('#dz-file')
  dz.addEventListener('click', () => fileInput.click())
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.style.borderColor = 'var(--accent)' })
  dz.addEventListener('dragleave', () => { dz.style.borderColor = '' })
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.style.borderColor = ''
    const f = e.dataTransfer.files?.[0]
    if (f) importFile(f)
  })
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) importFile(f) })
}

async function importFile(file) {
  const log = $('#import-log')
  log.textContent = `正在读取 ${file.name}…\n`
  try {
    const text = await file.text()
    const mode = $('#im-mode').value
    if (mode === 'replace' && !confirm(`导入模式为「替换」：将清空现有 ${state.memories.length || '全部'} 条记忆后写入。确定继续？`)) {
      log.textContent = '已取消导入（替换模式需确认）'
      return
    }
    const res = await api.importBackup(text, mode)
    log.textContent = `读取完成：${file.name}（${text.length} 字符）\n导入 ${res.imported} 条，跳过 ${res.skipped} 条，失败 ${res.failed} 条`
    toast(`导入完成：${res.imported} 条`)
    renderBrowser()
    refreshFilters()
  } catch (e) {
    log.textContent += `错误：${e.message}`
    toast('导入失败')
  }
}

async function doCleanup() {
  try {
    const r = await api.cleanup()
    toast(`已清理：过期 ${r.expired}，超限清理 ${r.evicted}`)
    renderBrowser()
    refreshFilters()
  } catch (e) { toast('清理失败：' + e.message) }
}

/* ---------------- 设置面板 ---------------- */
function configToForm(c) {
  $('#st-max-msgs').value = c.short_term.max_messages
  $('#st-max-tokens').value = c.short_term.max_tokens
  $('#st-auto-sum').value = c.long_term.auto_summarize_threshold
  $('#st-topk').value = c.long_term.retrieval_top_k
  $('#st-thr').value = c.long_term.similarity_threshold
  $('#st-thr-val').textContent = Number(c.long_term.similarity_threshold).toFixed(2)
  $('#st-hybrid').value = c.long_term.hybrid_weight
  $('#st-hybrid-val').textContent = Number(c.long_term.hybrid_weight).toFixed(2)
  $('#st-emb').value = c.long_term.embedding_model
  $('#st-emb-id').value = c.long_term.embedding_model_id || ''
  $('#st-emb-key').value = c.long_term.openai_api_key || ''
  $('#st-max-mb').value = c.storage.max_storage_mb
  $('#st-enc').checked = c.storage.encryption_enabled !== false
  $('#st-global').checked = c.global_memory.enabled !== false
  // 主密码不回显明文：已设置则留空 + 占位提示，用户输入新值才提交修改
  const passEl = $('#st-pass')
  passEl.value = ''
  passEl.placeholder = c.storage.has_password ? '已设置（留空保持，输入新值即修改）' : '设置主密码（可选，AES-256 密钥派生）'
  $('#st-token').value = c.storage.api_token || ''
  api.setToken(c.storage.api_token || '')
}

function formToConfig() {
  const storage = {
    max_storage_mb: Math.max(1, Number($('#st-max-mb').value) || 500),
    encryption_enabled: $('#st-enc').checked,
    api_token: $('#st-token').value,
  }
  // 密码框留空 = 不修改（不回传，避免空串触发"清空主密码"守卫/脱敏回显误判变更）
  const mp = $('#st-pass').value
  if (mp) storage.master_password = mp
  return {
    short_term: {
      max_messages: Math.max(1, Number($('#st-max-msgs').value) || 20),
      max_tokens: Math.max(100, Number($('#st-max-tokens').value) || 4000),
    },
    long_term: {
      auto_summarize_threshold: Math.max(0, Number($('#st-auto-sum').value) || 10),
      retrieval_top_k: Math.max(1, Number($('#st-topk').value) || 5),
      similarity_threshold: Math.max(0, Math.min(1, Number($('#st-thr').value) || 0.75)),
      hybrid_weight: Math.max(0, Math.min(1, Number($('#st-hybrid').value) || 0.7)),
      embedding_model: $('#st-emb').value,
      embedding_model_id: $('#st-emb-id').value,
      openai_api_key: $('#st-emb-key').value,
    },
    storage,
    global_memory: { enabled: $('#st-global').checked },
  }
}

async function loadConfig() {
  try {
    const c = await api.getConfig()
    state.config = c
    configToForm(c)
  } catch (e) {
    $('#settings-msg').innerHTML = `<div class="alert err">加载配置失败：${esc(e.message)}</div>`
  }
}

async function saveConfig() {
  const btn = $('#st-save')
  btn.disabled = true
  try {
    const saved = await api.saveConfig(formToConfig())
    state.config = saved
    api.setToken(saved.storage.api_token || '')
    $('#settings-msg').innerHTML = `<div class="alert ok">配置已保存${saved.long_term?.embedding_model === 'local' && !saved.long_term?.embedding_model_id ? '（当前为本地哈希降级）' : ''}</div>`
    toast('配置已保存')
  } catch (e) {
    $('#settings-msg').innerHTML = `<div class="alert err">保存失败：${esc(e.message)}</div>`
  } finally {
    btn.disabled = false
  }
}

/* ---------------- 初始化 ---------------- */
const PANEL_TITLES = { browser: '记忆浏览', search: '语义搜索', transfer: '导入导出', settings: '设置' }

function initNav() {
  $$('.sidebar .nav').forEach((nav) => {
    nav.addEventListener('click', () => {
      $$('.sidebar .nav').forEach((n) => n.classList.remove('active'))
      nav.classList.add('active')
      const target = nav.dataset.panel
      $$('.panel').forEach((p) => p.classList.remove('active'))
      $(`#panel-${target}`).classList.add('active')
      if (PANEL_TITLES[target]) $('#page-title').textContent = PANEL_TITLES[target]
      if (target === 'browser') renderBrowser()
      if (target === 'search') $('#sq-input').focus()
      if (target === 'settings') loadConfig()
    })
  })
}

function initEvents() {
  $('#f-session').addEventListener('change', (e) => { state.filters.session = e.target.value; renderBrowser() })
  $$('input[name="f-global"]').forEach((r) => r.addEventListener('change', (e) => { state.filters.global = e.target.value; renderBrowser() }))
  $('#browse-refresh').addEventListener('click', () => { renderBrowser(); refreshFilters(); loadStats(); toast('已刷新') })
  $('#sq-btn').addEventListener('click', doSearch)
  $('#sq-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch() })
  $('#st-thr').addEventListener('input', (e) => { $('#st-thr-val').textContent = Number(e.target.value).toFixed(2) })
  $('#st-hybrid').addEventListener('input', (e) => { $('#st-hybrid-val').textContent = Number(e.target.value).toFixed(2) })
  $('#st-save').addEventListener('click', saveConfig)
  $('#st-cleanup').addEventListener('click', doCleanup)
  $('#ex-btn').addEventListener('click', doExport)
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme')
    const next = cur === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('dsh_mem_theme', next)
  })

  // 记忆卡片内的操作按钮（事件委托）
  document.addEventListener('click', async (e) => {
    const del = e.target.closest('.act-del')
    if (del) {
      e.stopPropagation()
      const id = del.dataset.id
      if (!confirm('确定删除这条记忆？')) return
      try {
        await api.deleteMemory(id)
        toast('已删除')
        renderBrowser()
        refreshFilters()
      } catch (err) { toast('删除失败：' + err.message) }
      return
    }
    const imp = e.target.closest('.act-imp')
    if (imp) {
      e.stopPropagation()
      const id = imp.dataset.id
      // 从卡片 DOM 读当前重要度（搜索结果不在 state.memories，旧逻辑会静默失效）
      const cur = Number(imp.closest('.mem')?.dataset.imp)
      if (!Number.isFinite(cur)) return
      const next = Math.max(1, Math.min(10, cur + Number(imp.dataset.d)))
      try {
        await api.importance(id, next)
        toast(`重要度 ${cur} → ${next}`)
        renderBrowser()
      } catch (err) { toast('更新失败：' + err.message) }
    }
  })
}

async function init() {
  // 主题
  const savedTheme = localStorage.getItem('dsh_mem_theme') || 'light'
  document.documentElement.setAttribute('data-theme', savedTheme)
  initNav()
  initEvents()
  setupImport()
  // 状态
  try {
    await api.healthz()
    setStatus(true, '服务在线')
  } catch {
    setStatus(false, '服务离线')
  }
  await loadConfig()
  await refreshFilters()
  renderBrowser()
}

init()
