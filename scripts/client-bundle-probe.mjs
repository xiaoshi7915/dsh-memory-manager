// 探针：模拟 web shell 的 window.__ModuleLoader__.load handoff，校验 bundle 契约。
// 零副作用：只 require bundle + 桩 slots，验证 apply/inject 形态。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const bundleSrc = readFileSync(new URL('../src/client/bundle.js', import.meta.url), 'utf8')

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, factory }
    },
  },
}

// 桩 require：只提供 react（bundle 里唯一 require）
const stubRequire = (spec) => {
  if (spec === 'react') {
    return {
      createElement: (type, props, ...children) => ({ __type: type, props, children }),
    }
  }
  throw new Error(`unexpected require(${spec})`)
}

// 在 CommonJS 包裹中执行 bundle（bundle 内部用 factory(require)，需模拟 module/exports）
const code = `
(function (module, exports, require, window) {
  ${bundleSrc}
})(module, exports, stubRequire, window)
`
const module_ = { exports: {} }
const fn = new Function('module', 'exports', 'stubRequire', 'window', code)
fn(module_, module_.exports, stubRequire, globalThis.window)

const results = []
const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail })

check('ModuleLoader.load 收到 {id, factory}', loaded !== null && loaded.id === 'dsh-memory-manager' && typeof loaded.factory === 'function', JSON.stringify(loaded?.id))

// factory 由 shell 在装载时执行：这里手动调用拿到模块（bundle 内部 factory 会执行 module.exports = ...）
const mod = loaded.factory(stubRequire)
check('factory 返回 {apply, inject}', typeof mod.apply === 'function' && Array.isArray(mod.inject), `inject=${JSON.stringify(mod.inject)}`)
check('inject = ["slots"]', Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'slots', JSON.stringify(mod.inject))

// 桩 slots：捕获 settings.section 注册
let registered = null
const fakeCtx = {
  slots: {
    inject(name, fn) {
      if (name !== 'settings.section') throw new Error(`unexpected inject(${name})`)
      registered = fn()
    },
    register(opts, view) {
      return { opts, view }
    },
  },
}
mod.apply(fakeCtx)
check('apply 注入 settings.section', registered !== null && registered.opts.name === 'settings.section', JSON.stringify(registered?.opts))
check('入口 id/label/order', registered?.opts?.id === 'memory-manager' && registered?.opts?.label === '记忆管理' && registered?.opts?.order === 180,
  `id=${registered?.opts?.id} label=${registered?.opts?.label} order=${registered?.opts?.order}`)
check('视图组件返回 iframe → /memory-manager/', typeof registered?.view === 'function' && (() => {
  const el = registered.view()
  return el.__type === 'iframe' && el.props.src === '/memory-manager/'
})(), '')

let pass = results.filter((r) => r.pass).length
console.log(`客户端 bundle 契约探针：${pass}/${results.length} 通过`)
for (const r of results) console.log(`  ${r.pass ? '✅' : '✗'} ${r.name}${r.pass ? '' : ' — ' + r.detail}`)
if (pass !== results.length) process.exit(1)
