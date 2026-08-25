// 构建自包含 GUI fixture：vision_html_screenshot 断网，需内联 CSS + fetch stub（返回真实 layered 响应）+ 本地模块路径。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.env.FIXTURE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp-gui-fixture')
const readNoBom = (p) => readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const html = readNoBom(join(dir, 'index.html'))
const css = readNoBom(join(dir, 'main.css'))
const fi = (n) => JSON.parse(readNoBom(join(dir, `f-${n}.json`)))

const FIXTURES = {
  '/api/memory/layered/stats': fi('stats'),
  '/api/memory/layered/l1': fi('l1'),
  '/api/memory/layered/scenes': fi('scenes'),
  '/api/memory/layered/l0': fi('l0'),
  '/api/memory/layered/sessions': fi('sessions'),
  '/api/memory/layered/persona': fi('persona'),
}

// fetch stub：按 URL 子串匹配，返回对应 fixture；未知 → 空对象（调用方 try/catch 兜底）
const stub = `
<script>
window.__FIXTURES__ = ${JSON.stringify(FIXTURES)};
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const key = Object.keys(window.__FIXTURES__).find((k) => url.includes(k));
  let body = key ? window.__FIXTURES__[key] : {};
  const opts = init || {};
  if ((opts.method || 'GET') === 'PUT' && url.includes('/layered/mode')) body = { ok: true, session: opts.body ? JSON.parse(opts.body).session : null };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
</script>
`

// 内联 CSS：把 <link rel="stylesheet" href="./css/main.css" /> 替换为 <style>
let out = html.replace('<link rel="stylesheet" href="./css/main.css" />', `<style>${css}</style>`)
// 模块路径相对（与 shot.html 同目录，file:// 下可解析）
out = out.replace('src="./js/app.js"', 'src="./app.js"')
// 在模块脚本前注入 fetch stub
out = out.replace('<script type="module" src="./app.js"></script>', `${stub}<script type="module" src="./app.js"></script>`)
// 其余相对资源路径保持相对
out = out.replace('href="./css/main.css"', '')

writeFileSync(join(dir, 'shot.html'), out, 'utf8')
console.log(`fixture written: ${join(dir, 'shot.html')} (${out.length}B)`)
