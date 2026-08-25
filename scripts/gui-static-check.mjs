// GUI 静态自检（无视觉）：(1) JS 引用的 #id 都在 HTML；(2) 模态标记用到的 class 都有 CSS 规则。
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const html = readFileSync(new URL('gui/index.html', root), 'utf8')
const js = readFileSync(new URL('gui/js/app.js', root), 'utf8')
const css = readFileSync(new URL('gui/css/main.css', root), 'utf8')

const problems = []

// 动态 ID 白名单：分层视图（P3）在 innerHTML 模板里创建并在同次渲染内绑定（onchange/onclick），
// 不存在于静态 HTML。若静态存在反而会与 JS 的 box.innerHTML=... 整体替换冲突。
const DYNAMIC_IDS = new Set([
  'l1-type', 'l1-family', 'l1-refresh', 'l1-list', 'l1-pager',
  'l2-family', 'l2-refresh',
  'l3-chat', 'l3-work',
  'l0-session', 'l0-refresh', 'l0-list', 'l0-pager',
])

// ---- (1) ID 一致性：收集 JS 里所有 $('#' + 简单 id) 与 $$('#f-tags .chip') 这类复合选择器的首 id ----
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
const used = new Set()
for (const m of js.matchAll(/\$\('#([^']+)'\)/g)) used.add(m[1])
for (const m of js.matchAll(/\$\("#([^"]+)"\)/g)) used.add(m[1])
for (const m of js.matchAll(/\$\$\('#([^']+)'\)/g)) used.add(m[1])
for (const m of js.matchAll(/\$\$\("#([^"]+)"\)/g)) used.add(m[1])
// 复合选择器取第一个 #id 段（如 '#f-tags .chip' -> 'f-tags'）
const normalized = [...used].map((s) => s.split(' ')[0].split('.')[0])
for (const id of normalized) if (id && !ids.has(id) && !DYNAMIC_IDS.has(id)) problems.push(`JS 引用但 HTML 缺失: #${id}`)

// ---- (2) 模态/覆盖层标记用到的 class 是否都有 CSS 规则 ----
const modalHtml = html.slice(html.indexOf('id="transfer-modal"'))
const classNames = new Set([...modalHtml.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))
for (const c of classNames) {
  if (!c) continue
  // 检查 CSS 是否含 `.c` 或 `.c:hover` 或 `label.c` 等定义（放宽：只要出现 `.c` 或 `#c` 选择器片段）
  const hasRule = new RegExp(`(?:\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*(?::[a-z-]+)?\\s*[,{]`).test(css)
  if (!hasRule) problems.push(`模态 class 无 CSS 规则: .${c}`)
}

console.log(`html ids=${ids.size} | js 引用 #id=${normalized.length} | 模态 class=${classNames.size}`)
if (problems.length) { console.log('❌ 问题：\n' + problems.join('\n')); process.exit(1) }
console.log('✅ 静态自检通过（ID 一致 + 模态 class 均有样式）')
