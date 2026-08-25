#!/usr/bin/env node
/**
 * UI 截图辅助：由 gui/preview.html 生成多面板变体（无 BOM UTF-8），供无头浏览器截图。
 * 生成到 test-data/ui-shots/。用法：node scripts/ui-shots.mjs
 * @module scripts/ui-shots
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const src = path.join(ROOT, 'gui', 'preview.html')
const outDir = path.join(ROOT, 'test-data', 'ui-shots')
fs.mkdirSync(outDir, { recursive: true })

const html = fs.readFileSync(src, 'utf8')
const TAIL = 'init();\n</script>'

/**
 * @param {string} panel  'search' | 'settings' | 'browser'
 * @param {string} query  搜索预设（仅 search）
 * @param {boolean} dark  深色主题
 */
function variant(panel, { query = '', dark = false } = {}) {
  const acts = []
  if (dark) acts.push(`document.documentElement.setAttribute('data-theme','dark')`)
  if (panel === 'search') {
    acts.push(`document.querySelector('[data-panel=search]').click()`)
    if (query) acts.push(`document.getElementById('sq-input').value=${JSON.stringify(query)}`)
    acts.push(`window.__NO_DELAY__=true`)
    acts.push(`document.getElementById('sq-btn').click()`)
  } else if (panel === 'settings') {
    acts.push(`document.querySelector('[data-panel=settings]').click()`)
  } else {
    acts.push(`document.querySelector('[data-panel=browser]').click()`)
  }
  const overlay = `window.addEventListener('error',e=>{document.body.insertAdjacentHTML('beforeend','<div style="position:fixed;bottom:0;left:0;background:#c0392b;color:#fff;z-index:99999;padding:6px 10px;font-size:12px">ERR: '+e.message+'</div>')});`
  const injection = `${overlay}\ninit();\nsetTimeout(()=>{try{${acts.join(';')}}catch(e){console.error(e)}},120);`
  return html.replace(TAIL, injection + '\n</script>')
}

const files = {
  'search.html': variant('search', { query: '我喜欢用什么语言做数据分析' }),
  'settings.html': variant('settings'),
  'dark-browser.html': variant('browser', { dark: true }),
  'search-dark.html': variant('search', { query: '常用 SQL 优化技巧', dark: true }),
}

for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(outDir, name), content, 'utf8')
  console.log(`[ui-shots] generated ${name} (${content.length} bytes)`)
}
