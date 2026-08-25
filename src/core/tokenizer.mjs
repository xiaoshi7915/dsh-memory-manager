/**
 * token 估算、句子切分与检索词项提取。
 * @module src/core/tokenizer
 */

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/

/** 混合估算 token 数：CJK 1 字符≈1 token，ASCII 4 字符≈1 token。 */
export function countTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 按 token 预算截断（保留前缀，尽量在句/词边界，追加省略号）。 */
export function truncateToTokens(text, maxTokens) {
  if (maxTokens <= 0) return ''
  if (countTokens(text) <= maxTokens) return text
  let kept = ''
  for (const ch of text) {
    if (countTokens(kept + ch) > maxTokens) break
    kept += ch
  }
  return kept + '…'
}

/** 按中文/英文句读切句，保留句尾标点。 */
export function segmentSentences(text) {
  if (!text) return []
  const parts = text.split(/(?<=[。！？!?；;\n])/)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** 提取检索词项：CJK 连续段切单字+二元组；拉丁/数字段切成小写词。 */
export function tokenizeTerms(text) {
  if (!text) return []
  const terms = new Set()
  const push = (t) => { if (t && t.length > 0) terms.add(t) }
  let cjkRun = ''
  let latRun = ''
  const flushCjk = () => {
    if (cjkRun.length === 0) return
    if (cjkRun.length === 1) { push(cjkRun); cjkRun = ''; return }
    for (let i = 0; i < cjkRun.length; i += 1) push(cjkRun[i])
    for (let i = 0; i < cjkRun.length - 1; i += 1) push(cjkRun.slice(i, i + 2))
    cjkRun = ''
  }
  const flushLat = () => {
    if (latRun.length > 0) { push(latRun.toLowerCase()); latRun = '' }
  }
  for (const ch of text) {
    if (CJK_RE.test(ch)) { flushLat(); cjkRun += ch }
    else if (/[A-Za-z0-9]/.test(ch)) { flushCjk(); latRun += ch }
    else { flushCjk(); flushLat() }
  }
  flushCjk()
  flushLat()
  return [...terms]
}
