/**
 * 原子文件写入：同目录 tmp + fsync + rename，崩溃时旧文件保持完整。
 * 零运行时依赖，纯 Node 内置 fs（Windows 用 rename 覆盖语义处理）。
 * @module src/core/atomic
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * 原子写：先写同目录临时文件并 fsync，再 rename 覆盖目标。
 * - 目标保持「要么旧完整、要么新完整」，绝无半写状态。
 * - Windows rename 可覆盖已存在文件（MoveFileEx 语义）；目标被占用时
 *   清理 tmp 并抛错（调用方可吞错 + 保留 dirty 自愈）。
 * - 目录 fsync 仅非 win32 尝试（Windows 上目录句柄 sync 无意义且常失败）。
 * @param {string} dest 目标文件绝对路径
 * @param {string|Buffer} data 内容
 * @param {{fsync?: boolean, mode?: number, tmpSuffix?: string}} [opts]
 */
export async function writeFileAtomic(dest, data, { fsync = true, mode, tmpSuffix = `.tmp-${process.pid}` } = {}) {
  const dir = path.dirname(dest)
  const base = path.basename(dest)
  const tmp = path.join(dir, `${base}${tmpSuffix}`)
  await fsp.mkdir(dir, { recursive: true })
  let fh
  try {
    fh = await fsp.open(tmp, 'w', mode)
    await fh.writeFile(data, 'utf8')
    if (fsync) await fh.sync()
  } catch (err) {
    try { await fh?.close() } catch { /* 忽略 */ }
    try { await fsp.unlink(tmp) } catch { /* 忽略 */ }
    throw err
  }
  try {
    await fh.close()
  } catch {
    try { await fsp.unlink(tmp) } catch { /* 忽略 */ }
    throw new Error(`atomic write: fsync 后关闭失败 ${tmp}`)
  }
  try {
    await fsp.rename(tmp, dest)
  } catch (err) {
    try { await fsp.unlink(tmp) } catch { /* 忽略 */ }
    throw err
  }
  // 目录 fsync：尽力而为，Windows 跳过
  if (fsync && process.platform !== 'win32') {
    try {
      const dh = await fsp.open(dir, 'r')
      try { await dh.sync() } finally { await dh.close() }
    } catch { /* 忽略 */ }
  }
}

/**
 * 清理孤儿临时文件（崩溃残留）。启动时调用一次。
 * 单写者锁保证同目录只有本进程在写，启动时残留 tmp 均为前次崩溃产物。
 * @param {string} dir 目录
 * @param {{prefix?: string, maxAgeMs?: number}} [opts] prefix 默认为空（匹配 *.tmp-<pid> 形如 `.*\.tmp-\d+$`）
 * @returns {Promise<number>} 清理数量
 */
export async function recoverOrphanTmp(dir, { pattern = /\.tmp-\d+$/ } = {}) {
  let cleaned = 0
  let names
  try { names = await fsp.readdir(dir) } catch { return 0 }
  for (const name of names) {
    if (!pattern.test(name)) continue
    try { await fsp.unlink(path.join(dir, name)); cleaned += 1 } catch { /* 忽略 */ }
  }
  return cleaned
}

/** 同步探测文件是否可写（供锁/迁移预检）。 */
export function pathExists(p) {
  try { fs.accessSync(p); return true } catch { return false }
}
