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
 * @param {string} dataDir
 * @param {{offset?: number, limit?: number, level?: string}} [q]
 * @returns {{items: Array<{ts, level, message}>, total: number}}
 */
export function readLog(dataDir, { offset = 0, limit = 100, level } = {}) {
  const logPath = join(dataDir, 'memory.log')
  let lines = []
  try {
    if (existsSync(logPath)) {
      lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0)
    }
    // 合并轮转档案（memory.log.1 为更旧）
    const rotPath = `${logPath}.1`
    if (existsSync(rotPath)) {
      const older = readFileSync(rotPath, 'utf8').split('\n').filter((l) => l.length > 0)
      lines = [...older, ...lines]
    }
  } catch {
    lines = []
  }
  const parsed = lines.map(parseLogLine)
  const filtered = level ? parsed.filter((l) => l.level === level) : parsed
  const total = filtered.length
  const off = Math.max(0, Math.floor(offset))
  const lim = Math.max(1, Math.min(500, Math.floor(limit) || 100))
  return { items: filtered.slice(off, off + lim), total, offset: off, limit: lim }
}
