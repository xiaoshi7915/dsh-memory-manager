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

/** 按钮忙碌/禁用态（异步操作期间防重复点击）。 */
function busy(btn, on) {
  if (!btn) return
  btn.disabled = on
  btn.classList.toggle('loading', on)
}

/** 内联确认：在容器里渲染 确认/取消 按钮，返回 Promise<boolean>（替代原生 confirm，统一视觉与可访问性）。 */
function inlineConfirm(container, message, { danger = true } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div')
    wrap.className = 'inline-confirm'
    wrap.innerHTML = `<span class="ic-msg">${esc(message)}</span>
      <span class="ic-actions">
        <button class="btn ${danger ? 'danger' : ''} sm ic-yes">确认</button>
        <button class="btn ghost sm ic-no">取消</button>
      </span>`
    wrap.querySelector('.ic-yes').onclick = () => { wrap.remove(); resolve(true) }
    wrap.querySelector('.ic-no').onclick = () => { wrap.remove(); resolve(false) }
    container.appendChild(wrap)
    wrap.querySelector('.ic-no').focus()
  })
}

function spinner(html) {
  return `<div class="empty"><div class="spinner"></div><div>${html}</div></div>`
}

const state = {
  memories: [],
  filters: { session: '', global: '', tag: '' },
  config: null,
  mode: 'browse', // 'browse'（记忆列表） | 'search'（语义检索结果，内嵌于同一面板）
  tab: 'overview', // 层级 Tab：overview | l1 | l2 | l3 | l0（P1 骨架；L1-L0 真实数据后续接入）
  browser: { page: 0, pageSize: 50, total: 0 }, // 记忆浏览分页（0-based）
  search: { page: 0, pageSize: 5, total: 0 }, // 语义搜索分页（页大小 = Top-K）
}

/* ---------------- 浏览/搜索 视图切换（同面板内嵌） ---------------- */

/** 进入搜索模式：隐藏浏览列表，显示检索结果。 */
function enterSearchMode() {
  state.mode = 'search'
  $('#browser-list').hidden = true
  $('#browser-pager').hidden = true
  $('#search-results').hidden = false
  $('#search-pager').hidden = false
  $('#sq-clear').hidden = false
}

/** 退出搜索模式回到浏览列表（清空检索结果）。 */
function clearSearch() {
  state.mode = 'browse'
  $('#search-results').hidden = true
  $('#search-results').innerHTML = ''
  $('#search-pager').hidden = true
  $('#browser-list').hidden = false
  $('#browser-pager').hidden = false
  $('#sq-clear').hidden = true
  state.search = { page: 0, pageSize: 5, total: 0 }
  renderBrowser()
}

/* ---------------- 工具函数 ---------------- */

/** 总页数（至少 1）。 */
function pageCount(total, size) {
  const s = Math.max(1, Math.floor(size))
  return Math.max(1, Math.ceil(total / s))
}

/**
 * 渲染分页栏（P3）。page 0-based；窗口=当前页±2（含首尾 + 省略号）。
 * @param {HTMLElement} container
 * @param {{page:number, pageSize:number, total:number, sizes:number[], onGo:(p:number)=>void, onSize:(s:number)=>void}} cfg
 */
function renderPager(container, { page, pageSize, total, sizes, onGo, onSize }) {
  if (!container) return
  const pages = pageCount(total, pageSize)
  const cur = Math.min(Math.max(0, page), pages - 1)
  const nums = []
  const lo = Math.max(0, cur - 2)
  const hi = Math.min(pages - 1, cur + 2)
  if (lo > 0) nums.push(0)
  if (lo > 1) nums.push('…')
  for (let i = lo; i <= hi; i++) nums.push(i)
  if (hi < pages - 2) nums.push('…')
  if (hi < pages - 1) nums.push(pages - 1)

  container.hidden = pages <= 1
  container.innerHTML = `
    <span class="pg-info">共 ${total} 条 · 第 ${cur + 1}/${pages} 页</span>
    <label class="pg-size">每页
      <select data-role="pg-size">
        ${sizes.map((s) => `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </label>
    <button class="pg-btn" data-go="prev" ${cur === 0 ? 'disabled' : ''}>‹</button>
    ${nums.map((n) => (n === '…'
      ? '<span class="pg-ellipsis">…</span>'
      : `<button class="pg-btn${n === cur ? ' cur' : ''}" data-go="${n}">${n + 1}</button>`)).join('')}
    <button class="pg-btn" data-go="next" ${cur >= pages - 1 ? 'disabled' : ''}>›</button>`
  container.querySelector('[data-role="pg-size"]').onchange = (e) => onSize(Number(e.target.value))
  container.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.go
    const next = v === 'prev' ? cur - 1 : v === 'next' ? cur + 1 : Number(v)
    if (next >= 0 && next < pages && next !== cur) onGo(next)
  }))
}

/** 绑定记忆卡展开/收拢（浏览 + 搜索共用）。 */
function bindMemCards(box) {
  $$('.mem', box).forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return
      el.classList.toggle('open')
      el.querySelector('.mem-content').classList.toggle('clamped')
    })
  })
}
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
    $('#st-reindex-note').textContent = s.needs_reindex ? '⚠️ 需重建（模型已变更）' : (s.long_term_count > 0 ? '✓ 已同步' : '')
  } catch { /* 忽略 */ }
}

async function renderBrowser() {
  const box = $('#browser-list')
  box.innerHTML = spinner('正在加载记忆…')
  try {
    const f = state.filters
    const b = state.browser
    const params = {}
    if (f.session) params.session = f.session
    if (f.global) params.global = f.global
    if (f.tag) params.tag = f.tag
    params.offset = b.page * b.pageSize
    params.limit = b.pageSize
    const data = await api.memories(params)
    state.memories = data.items || []
    b.total = data.total || 0
    // 删除/过滤后当前页可能越界：回退一页再取
    if (state.memories.length === 0 && b.total > 0 && b.page > 0) {
      b.page -= 1
      return renderBrowser()
    }
    await loadStats()
    if (state.memories.length === 0) {
      box.innerHTML = emptyBox('暂无记忆', '添加记忆后，它们会按时间线展示在这里')
    } else {
      box.innerHTML = `<div class="mem-list">${state.memories.map((m) => memCard(m)).join('')}</div>`
      bindMemCards(box)
    }
    renderPager($('#browser-pager'), {
      page: b.page, pageSize: b.pageSize, total: b.total,
      sizes: [20, 50, 100, 200],
      onGo: (p) => { b.page = p; renderBrowser() },
      onSize: (s) => { b.pageSize = s; b.page = 0; renderBrowser() },
    })
  } catch (e) {
    box.innerHTML = `<div class="alert err">加载失败：${esc(e.message)}</div>`
  }
}

async function refreshFilters() {
  try {
    // P3：用 /meta 拿全量去重会话/标签，取代旧 limit:500 抽样（大库下会漏会话/标签）
    const meta = await api.meta()
    const sessions = (meta.sessions || []).map((s) => s.id)
    const tags = (meta.tags || []).map((t) => t.tag)
    $('#f-session').innerHTML = '<option value="">全部会话</option>' + sessions.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')
    $('#f-tags').innerHTML = '<span class="chip gray clickable active" data-tag="">全部</span>' + tags.map((t) => `<span class="chip clickable" data-tag="${esc(t)}">${esc(t)}</span>`).join('')
    $$('#f-tags .chip').forEach((c) => {
      c.addEventListener('click', () => {
        $$('#f-tags .chip').forEach((x) => x.classList.remove('active'))
        c.classList.add('active')
        state.filters.tag = c.dataset.tag
        state.browser.page = 0
        renderBrowser()
      })
    })
  } catch { /* 忽略 */ }
}

/* ---------------- 内嵌语义搜索（记忆浏览内） ---------------- */
async function doSearch(opts = {}) {
  const query = $('#sq-input').value.trim()
  const box = $('#search-results')
  const pager = $('#search-pager')
  if (!query) { return } // 空查询不动作（清空由「清除检索」/筛选变化处理）
  if (!opts.keepPage) state.search.page = 0
  enterSearchMode()
  box.innerHTML = spinner('正在检索…')
  const btn = $('#sq-btn')
  busy(btn, true)
  const t0 = performance.now()
  try {
    // Number.isFinite 保留合法 0（阈值 0 = 接受全部结果），避免被 `|| 默认` 吞掉
    const n = (el, d) => { const v = Number($(el).value); return Number.isFinite(v) ? v : d }
    const topK = n('#sq-topk', 5)
    const thr = n('#sq-thr', 0.4)
    // GUI 是管理视图：默认搜全部会话（后端 session_id='*'），DSH agent 侧仍按真实会话隔离
    const sess = $('#sq-session').value.trim() || '*'
    const s = state.search
    s.pageSize = Math.max(1, Math.floor(topK))
    // P3：offset 分页（Top-K 即每页条数）；后端召回池封顶 100，超出部分需提高 Top-K
    const res = await api.search(query, { top_k: topK, threshold: thr, session_id: sess, include_global: $('#sq-global').checked, offset: s.page * s.pageSize })
    const ms = Math.round(performance.now() - t0)
    s.total = res.total || 0
    if (res.results.length === 0) {
      box.innerHTML = `<div class="empty"><div class="big">🔍</div><div style="font-weight:600">未找到相关记忆</div><div class="hint">试试降低相似度阈值或换一种问法</div></div>`
    } else {
      box.innerHTML = `
      <div class="result-head"><span>共 ${res.total} 条</span><span>耗时 ${ms}ms</span></div>
      <div class="mem-list">${res.results.map((m) => memCard(m, { score: m.score })).join('')}</div>`
      bindMemCards(box)
    }
    renderPager(pager, {
      page: s.page, pageSize: s.pageSize, total: s.total,
      sizes: [5, 10, 20],
      onGo: (p) => { s.page = p; doSearch({ keepPage: true }) },
      onSize: (sz) => { s.pageSize = sz; $('#sq-topk').value = sz; s.page = 0; doSearch({ keepPage: true }) },
    })
  } catch (e) {
    box.innerHTML = `<div class="alert err">检索失败：${esc(e.message)}</div>`
  } finally {
    busy(btn, false)
  }
}

/* ---------------- 导入导出面板 ---------------- */
async function doExport() {
  const btn = $('#ex-btn')
  busy(btn, true)
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
  } finally {
    busy(btn, false)
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
    if (mode === 'replace') {
      // 内联确认替代原生 confirm（统一视觉/可访问性）
      const ok = await inlineConfirm(log, `导入模式「替换」将清空现有 ${state.memories.length || '全部'} 条记忆后写入。确定继续？`)
      if (!ok) { log.textContent = '已取消导入（替换模式需确认）'; return }
      log.textContent += '已确认替换，继续…\n'
    }
    const res = await api.importBackup(text, mode)
    log.textContent = `读取完成：${file.name}（${text.length} 字符）\n导入 ${res.imported} 条，跳过 ${res.skipped} 条，失败 ${res.failed} 条`
    toast(`导入完成：${res.imported} 条`)
    clearSearch()
    refreshFilters()
  } catch (e) {
    log.textContent += `错误：${e.message}`
    toast('导入失败')
  }
}

let cleaning = false // 防重入
async function doCleanup() {
  if (cleaning) return
  const btn = $('#st-cleanup')
  cleaning = true
  busy(btn, true)
  try {
    const r = await api.cleanup()
    toast(`已清理：过期 ${r.expired}，超限清理 ${r.evicted}`)
    clearSearch()
    refreshFilters()
  } catch (e) { toast('清理失败：' + e.message) }
  finally { cleaning = false; busy(btn, false) }
}

let reindexing = false // 防重入
async function doReindex() {
  if (reindexing) return
  const btn = $('#st-reindex-btn')
  reindexing = true
  busy(btn, true)
  btn.textContent = '重建中…'
  try {
    const r = await api.reindex()
    $('#st-reindex-note').textContent = ''
    toast(`索引已重建：${r.processed} 条 · ${r.model} · ${r.latency_ms}ms`)
  } catch (e) { toast('重建失败：' + e.message) }
  finally {
    reindexing = false
    busy(btn, false)
    btn.textContent = '重建索引'
    loadStats()
  }
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
function initNav() {
  $$('.breadcrumb .crumb[data-panel]').forEach((nav) => {
    const activate = () => {
      $$('.breadcrumb .crumb[data-panel]').forEach((n) => n.classList.remove('active'))
      nav.classList.add('active')
      const target = nav.dataset.panel
      $$('.panel').forEach((p) => p.classList.remove('active'))
      $(`#panel-${target}`).classList.add('active')
      if (target === 'browser') { if (state.mode === 'browse') renderBrowser() }
      if (target === 'settings') loadConfig()
    }
    nav.addEventListener('click', activate)
    // 键盘可达（导航项带 role=button + tabindex=0）
    nav.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
    })
  })
}

/** 层级 Tab 切换（概览 | L1 | L2 | L3 | L0）。P1 只做视图显隐骨架；
 *  L1-L0 真实分层数据在 P3 接入对应视图的渲染。 */
function initLvlTabs() {
  $$('.lvl-tab[data-lvl]').forEach((tab) => {
    const activate = () => {
      state.tab = tab.dataset.lvl
      $$('.lvl-tab[data-lvl]').forEach((t) => {
        const on = t === tab
        t.classList.toggle('active', on)
        t.setAttribute('aria-selected', on ? 'true' : 'false')
      })
      $$('.lvl-view').forEach((v) => { v.hidden = v.id !== `lvl-${state.tab}` })
      // 切到概览回到浏览态（搜索结果仅属于概览层）
      if (state.tab === 'overview' && state.mode === 'search') renderBrowser()
    }
    tab.addEventListener('click', activate)
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
    })
  })
}

/* ---------------- 导入导出模态 ---------------- */
function openTransfer() { $('#transfer-modal').hidden = false }
function closeTransfer() { $('#transfer-modal').hidden = true }
function initTransferModal() {
  $('#transfer-btn').addEventListener('click', openTransfer)
  $('#tm-close').addEventListener('click', closeTransfer)
  $('#transfer-modal').addEventListener('click', (e) => { if (e.target === $('#transfer-modal')) closeTransfer() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#transfer-modal').hidden) closeTransfer() })
}

function initEvents() {
  $('#f-session').addEventListener('change', (e) => { state.filters.session = e.target.value; state.browser.page = 0; clearSearch() })
  $$('input[name="f-global"]').forEach((r) => r.addEventListener('change', (e) => { state.filters.global = e.target.value; state.browser.page = 0; clearSearch() }))
  $('#browse-refresh').addEventListener('click', () => { state.browser.page = 0; clearSearch(); refreshFilters(); loadStats(); toast('已刷新') })
  $('#sq-btn').addEventListener('click', () => doSearch())
  $('#sq-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch() })
  $('#sq-clear').addEventListener('click', () => { $('#sq-input').value = ''; clearSearch() })
  $('#st-thr').addEventListener('input', (e) => { $('#st-thr-val').textContent = Number(e.target.value).toFixed(2) })
  $('#st-hybrid').addEventListener('input', (e) => { $('#st-hybrid-val').textContent = Number(e.target.value).toFixed(2) })
  $('#st-save').addEventListener('click', saveConfig)
  $('#st-cleanup').addEventListener('click', doCleanup)
  $('#st-reindex-btn').addEventListener('click', doReindex)
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
      // 两步内联确认：第一次点击进入确认态（3.5s），第二次点击执行
      if (del.dataset.armed !== '1') {
        del.dataset.orig = del.textContent
        del.dataset.armed = '1'
        del.textContent = '确认删除？'
        del.classList.add('confirming')
        setTimeout(() => {
          if (del.dataset.armed === '1') {
            delete del.dataset.armed
            del.textContent = del.dataset.orig
            del.classList.remove('confirming')
          }
        }, 3500)
        return
      }
      delete del.dataset.armed
      del.textContent = del.dataset.orig
      del.classList.remove('confirming')
      try {
        await api.deleteMemory(id)
        toast('已删除')
        if (state.mode === 'search') { doSearch({ keepPage: true }) } else { renderBrowser() }
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
        if (state.mode === 'search') { doSearch({ keepPage: true }) } else { renderBrowser() }
      } catch (err) { toast('更新失败：' + err.message) }
    }
  })
}

async function init() {
  // 主题：默认跟随系统/宿主（prefers-color-scheme），用户显式切换后才记住选择
  const savedTheme = localStorage.getItem('dsh_mem_theme')
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
  const applyTheme = () => {
    const t = localStorage.getItem('dsh_mem_theme') || (mq?.matches ? 'dark' : 'light')
    document.documentElement.setAttribute('data-theme', t)
  }
  applyTheme()
  mq?.addEventListener?.('change', applyTheme)
  initNav()
  initLvlTabs()
  initEvents()
  setupImport()
  initTransferModal()
  // 服务健康检查（离线时 toast 由各 API 调用报错提示）
  try {
    await api.healthz()
  } catch {
    /* 服务离线：操作时 toast 会提示错误 */
  }
  await loadConfig()
  await refreshFilters()
  renderBrowser()
}

init()
