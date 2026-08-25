/**
 * dsh-memory-manager — browser half（手写 plain-JS bundle，无打包器，与
 * dsh-layered-memory 的客户端实现同构）。
 *
 * 职责：设置 → 记忆管理。注入 `settings.section` 槽位，在设置左侧边栏新增
 * 「记忆管理」入口，点击后在设置面板内容列内以 iframe 嵌入既有四面板 GUI
 * （/memory-manager/，同源，直接复用 /api/memory/* REST）。
 *
 * 结构对齐官方 client bundle 的 handoff 协议：
 *   window.__ModuleLoader__.load({ id, factory })，
 *   factory(require) 返回 { apply, inject }。
 * - inject = ['slots']：仅需 UI 槽位注册表（由 @deepseek-ai/dsh-client-runtime 提供）。
 * - 不依赖 ctx.connection / RPC：iframe 用普通 HTTP 走 /api/memory/*，零额外通道。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')

    /** 设置侧边栏「记忆管理」入口的视图：同源 iframe 嵌入既有四面板 GUI。 */
    function MemoryManagerPanel() {
      return react.createElement('iframe', {
        src: '/memory-manager/',
        title: '记忆管理',
        style: {
          width: '100%',
          height: '100%',
          minHeight: '560px',
          border: '0',
          display: 'block',
        },
      })
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'memory-manager',
            order: 180,
            label: '记忆管理',
          },
          MemoryManagerPanel,
        )
      })
    }

    var inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
