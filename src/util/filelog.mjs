/**
 * 文件日志：把 warn/info/error 镜像到数据目录 memory.log，供 GUI「日志」Tab 事后查看。
 * 复刻 dsh-layered-memory 的 util/filelog 思路（P5，独立实现）：
 *  - memory.log 2MB 上限，超限 rename 轮转（memory.log.1）；Windows 文件占用
 *    导致 rename 失败时，连续失败达上限则截断重开，保证日志体积有界。
 *  - 体积检查抽样（每 N 条写检查一次），避免每写一次都 stat 系统调用。
 *  - 写失败静默忽略——诊断日志绝不能反过来拖垮主流程。
 * @module src/util/filelog
 */

import { appendFileSync, existsSync, renameSync, statSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 2 * 1024 * 1024
const ROTATE_FAIL_LIMIT = 5
export const SIZE_CHECK_INTERVAL = 32

/** 错误对象转单行描述（诊断日志用，非 Error 直接字符串化）。 */
export function errDetail(err) {
  if (err instanceof Error) {
    return `${err.message} @ ${err.stack?.split('\n')[1]?.trim() ?? err.name}`
  }
  return String(err)
}

/** 惰性解析单行日志：memory.log 行格式 `<ISO> [level] message`。 */
export function parseLogLine(line) {
  const m = /^(\S+)\s+\[(\w+)\]\s+([\s\S]*)$/.exec(line)
  if (!m) return { ts: null, level: 'info', message: line }
  return { ts: m[1], level: m[2], message: m[3] }
}

/**
 * 创建文件日志写入器。
 * @param {string} dataDir 数据目录（memory.log 写在这里）
 * @param {{debug?: Function, info?: Function, warn?: Function, error?: Function}} [consoleLike]
 *   可选宿主 logger；默认退化为 console。
 */
export function withFileLog(dataDir, consoleLike = console) {
  const logPath = join(dataDir, 'memory.log')
  let rotateFailures = 0
  let writesSinceCheck = 0

  const write = (level, msg) => {
    try {
      if (
        writesSinceCheck++ % SIZE_CHECK_INTERVAL === 0 &&
        existsSync(logPath) &&
        statSync(logPath).size > MAX_LOG_BYTES
      ) {
        try {
          renameSync(logPath, `${logPath}.1`)
          rotateFailures = 0
        } catch {
          // rename 可能因文件被占用失败（Windows EBUSY）：连续失败达上限后截断重开
          if (++rotateFailures >= ROTATE_FAIL_LIMIT) {
            writeFileSync(logPath, '')
            rotateFailures = 0
          }
        }
      }
      appendFileSync(logPath, `${new Date().toISOString()} [${level}] ${msg}\n`)
    } catch {
      /* ignore */
    }
  }

  return {
    debug: (m) => consoleLike.debug?.(m),
    info: (m) => {
      consoleLike.info?.(m)
      write('info', m)
    },
    warn: (m) => {
      consoleLike.warn?.(m)
      write('warn', m)
    },
    error: (m) => {
      consoleLike.error?.(m)
      write('error', m)
    },
  }
}

/**
 * 读取 memory.log（GUI 日志 Tab）。分页 + 可选级别过滤。
 * 支持多源合并（融合兼容）：传 { dir, source } 数组读多个 memory.log（如 layered 真实日志
 * 与本插件日志），合并后按时间倒序，每条带 source 标记；同时间戳保持来源分组顺序。
 * @param {string|Array<{dir:string, source?:string}>} dataDir 数据目录，或 [{dir, source}] 数组
 * @param {{offset?: number, limit?: number, level?: string}} [q]
 * @returns {{items: Array<{ts, level, message, source?}>, total: number}}
 */
export function readLog(dataDir, { offset = 0, limit = 100, level } = {}) {
  const sources = Array.isArray(dataDir)
    ? dataDir
    : [{ dir: dataDir, source: 'manager' }]
  let lines = []
  try {
    for (const { dir, source } of sources) {
      const logPath = join(dir, 'memory.log')
      const readOne = (p) => {
        try {
          if (existsSync(p)) {
            return readFileSync(p, 'utf8').split('\n')
              .filter((l) => l.length > 0)
              .map((l) => ({ line: l, source }))
          }
        } catch { /* 单源读取失败静默，其余源不受影响 */ }
        return []
      }
      // memory.log.1 为更旧档案 → 先读再读主文件（同 layered filelog 轮转语义）
      lines = [...lines, ...readOne(`${logPath}.1`), ...readOne(logPath)]
    }
  } catch {
    lines = []
  }
  const parsed = lines.map(({ line, source }) => ({ ...parseLogLine(line), source }))
  // 合并后按时间倒序（新在前）；无时间戳的行排最后
  parsed.sort((a, b) => {
    if (a.ts && b.ts) return b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0
    if (a.ts) return -1
    if (b.ts) return 1
    return 0
  })
  const filtered = level ? parsed.filter((l) => l.level === level) : parsed
  const total = filtered.length
  // 按来源计数（GUI 融合提示用）
  const bySource = {}
  for (const l of filtered) bySource[l.source || 'unknown'] = (bySource[l.source || 'unknown'] || 0) + 1
  const srcList = Object.entries(bySource).map(([source, count]) => ({ source, count }))
  const off = Math.max(0, Math.floor(offset))
  const lim = Math.max(1, Math.min(500, Math.floor(limit) || 100))
  return { items: filtered.slice(off, off + lim), total, offset: off, limit: lim, sources: srcList }
}
