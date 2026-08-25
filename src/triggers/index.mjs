/**
 * 触发词检测：把用户话语映射为对应工具调用建议。
 * 规则覆盖 TASK-spec.md §6 的六类触发场景。
 * @module src/triggers
 */

/** 正则规则表：每条含匹配正则、目标工具、参数提取。 */
const RULES = [
  // 1. 记住 → memory_add
  {
    tool: 'memory_add',
    test: /(?:帮我|请|麻烦)?(记住|记一下|记下来|记得)(?:[:：\s,，。]*)(.+)/,
    extract: (m) => ({ content: m[2].trim() }),
  },
  // 5. 删除/忘掉/清空 → memory_delete（放在检索前，避免"关于"被检索规则抢占）
  {
    tool: 'memory_delete',
    test: /删除关于|删除.+的记忆|忘掉|忘记|清空记忆|删掉/,
    extract: (_m, text) => {
      let target = null
      let m2 = text.match(/删除关于[:：\s]*([^\s，。；、]+)/)
      if (m2) target = m2[1]
      if (!target) { m2 = text.match(/删除[:：\s]*([^\s，。；、]+)的记忆/); if (m2) target = m2[1] }
      if (!target) { m2 = text.match(/忘掉[:：\s]*([^\s，。；、]+)/); if (m2) target = m2[1] }
      if (!target) { m2 = text.match(/忘记[:：\s]*([^\s，。；、]+)/); if (m2) target = m2[1] }
      if (!target) { m2 = text.match(/删掉[:：\s]*([^\s，。；、]+)/); if (m2) target = m2[1] }
      if (!target) return {} // 无目标词：返回空参数，走 VALIDATION_ERROR（安全兜底，绝不 all_sessions 全库清空）
      return { conditions: { tag: target } }
    },
  },
  // 2. 之前说过 / 你还记得吗 → memory_search
  {
    tool: 'memory_search',
    test: /(?:我之前说过|我以前提过|关于|你还记得吗|你还记得|记得吗)(?:[:：\s,，。]*)(.*)/,
    extract: (m) => ({ query: m[1].trim() || '' }),
  },
  // 3. 总结 / 存起来 → memory_summarize
  {
    tool: 'memory_summarize',
    test: /(?:总结一下|总结|把刚才的内容存起来|把对话存起来|做个总结)(.*)/,
    extract: () => ({}),
  },
  // 4. 打开面板 → 打开 Web 侧边栏（动作信号）
  {
    tool: '__open_panel__',
    test: /(?:查看我的记忆|打开记忆管理|打开记忆面板|记忆面板|查看记忆)/,
    extract: () => ({}),
  },
  // 6. 这次对话上下文 / 聊到哪 → memory_get_recent
  {
    tool: 'memory_get_recent',
    test: /(?:这次对话的上下文|我们刚才聊到哪|刚才聊到|上下文是什么)/,
    extract: () => ({}),
  },
]

/**
 * 检测文本是否命中某类触发。
 * @param {string} text
 * @returns {{tool: string, args: object, matched: string}|null}
 */
export function detectTrigger(text) {
  if (!text) return null
  for (const rule of RULES) {
    const m = text.match(rule.test)
    if (m) {
      const args = rule.extract ? rule.extract(m, text) : {}
      return { tool: rule.tool, args, matched: m[0] }
    }
  }
  return null
}

/** 判断是否为"打开记忆面板"类话语。 */
export function isOpenPanel(text) {
  const hit = detectTrigger(text)
  return hit !== null && hit.tool === '__open_panel__'
}
