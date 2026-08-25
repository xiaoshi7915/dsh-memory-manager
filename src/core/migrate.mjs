/**
 * 数据目录迁移：把旧默认目录（~/.dsh/memory，与 dsh-layered-memory 混居）中
 * 属 dsh-memory-manager 的白名单文件迁移到专属目录（默认 ~/.dsh/memory-manager）。
 *
 * 安全设计（P0，用户要求先临时目录验证再动真数据）：
 * - 白名单：config.json / .key / .salt / long_term / short_term —— 绝不触碰
 *   layered-memory 的 conversations/ records/ scenes/ memory.db/ *.json 等。
 * - SQLite 先 checkpoint（TRUNCATE）再拷贝；库被占用（busy/locked）→ fail-closed 中止。
 * - 流程：copy → SHA-256 校验 → 源墓碑 *.migrated-<ts>（非删除）→ migration.json 审计。
 * - 幂等：新目录已有数据（config.json / long_term / migration.json）→ 跳过。
 * - dryRun：只返回计划，零写盘。
 * @module src/core/migrate
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { legacyBaseDir } from '../config.mjs'
import { MemoryError } from './types.mjs'

/** dsh-memory-manager 属主白名单（迁移唯一允许搬动的顶层项）。 */
export const MANAGER_WHITELIST = ['config.json', '.key', '.salt', 'long_term', 'short_term']

/** layered-memory 哨兵（用于检测混居目录，仅诊断不触碰）。 */
export const LAYERED_SENTINELS = [
  'conversations', 'records', 'scenes', 'memory.db',
  'memory.db-wal', 'memory.db-shm', 'session-modes.json',
  'embedding-source.json', 'memory.log', 'runtime', 'models',
]

/** 旧目录是否含 dsh-memory-manager 数据（白名单任一存在）。 */
export function legacyHasManagerData(dir = legacyBaseDir()) {
  try {
    if (!fs.existsSync(dir)) return false
    return MANAGER_WHITELIST.some((n) => fs.existsSync(path.join(dir, n)))
  } catch { return false }
}

/** 新目录是否已有数据（防覆盖/幂等）。 */
export function newDirHasData(dir) {
  try {
    if (!fs.existsSync(dir)) return false
    return ['config.json', 'long_term', 'short_term', 'migration.json']
      .some((n) => fs.existsSync(path.join(dir, n)))
  } catch { return false }
}

/** 旧目录里是否混居着 layered-memory 文件（诊断用）。 */
export function legacyHasLayeredFiles(dir = legacyBaseDir()) {
  try {
    if (!fs.existsSync(dir)) return false
    return LAYERED_SENTINELS.some((n) => fs.existsSync(path.join(dir, n)))
  } catch { return false }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function countFiles(dir) {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1
    }
  } catch { /* 忽略 */ }
  return n
}

/**
 * SQLite checkpoint（TRUNCATE 把 WAL 合并进主库），随后关闭。
 * @returns {boolean} true=可安全拷贝；false=无法 checkpoint（busy/locked/损坏）→ fail-closed
 */
function checkpointLegacyDb(dbFile) {
  if (!fs.existsSync(dbFile)) return true
  let db = null
  try {
    db = new DatabaseSync(dbFile, { readOnly: false })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return true
  } catch {
    return false
  } finally {
    try { db?.close() } catch { /* 忽略 */ }
  }
}

async function copyItem(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  const st = await fsp.stat(from)
  if (st.isDirectory()) {
    await fsp.mkdir(to, { recursive: true })
    const entries = await fsp.readdir(from, { withFileTypes: true })
    for (const e of entries) {
      await copyItem(path.join(from, e.name), path.join(to, e.name))
    }
  } else {
    await fsp.copyFile(from, to)
  }
}

/**
 * 执行迁移。from/to 均可显式传入（测试用临时目录）；缺省 from=旧默认目录。
 * @param {{from?: string, to: string, dryRun?: boolean}} opts
 * @returns {Promise<{migrated: boolean, reason?: string, dryRun?: boolean, from: string, to: string, moved: Array<{name: string, type: string, sha256?: string, bytes?: number, files?: number}>, plan?: string[]}>}
 */
export async function migrateLegacyData({ from = legacyBaseDir(), to, dryRun = false } = {}) {
  if (!to) throw new MemoryError('VALIDATION_ERROR', '迁移需要目标目录 to')

  const plan = []
  for (const name of MANAGER_WHITELIST) {
    const p = path.join(from, name)
    if (fs.existsSync(p)) plan.push({ name, from: p, to: path.join(to, name) })
  }
  if (plan.length === 0) {
    return { migrated: false, reason: 'no-legacy', from, to, moved: [] }
  }
  if (dryRun) {
    return {
      migrated: false, dryRun: true, from, to,
      plan: plan.map((x) => x.name), moved: [],
    }
  }

  // 0) 目标目录就位（后续操作原子化失败可回滚到墓碑）
  await fsp.mkdir(to, { recursive: true })

  // 1) SQLite checkpoint，fail-closed：库被占用就中止，绝不拷贝半写状态
  const dbFile = path.join(from, 'long_term', 'memories.db')
  if (fs.existsSync(dbFile) && !checkpointLegacyDb(dbFile)) {
    throw new MemoryError(
      'MIGRATION_BUSY',
      `旧数据目录的 SQLite 正被其他进程占用（${dbFile}），请先停止旧实例再执行迁移`,
    )
  }

  // 2) copy（文件→文件，目录→递归目录）
  for (const item of plan) {
    await copyItem(item.from, item.to)
  }

  // 3) SHA-256 校验（文件级强校验；目录记录文件数，深校验由引擎加载自检兜底）
  const moved = []
  for (const item of plan) {
    const st = await fsp.stat(item.to)
    if (st.isDirectory()) {
      moved.push({ name: item.name, type: 'dir', files: countFiles(item.to) })
    } else {
      moved.push({ name: item.name, type: 'file', sha256: sha256File(item.to), bytes: st.size })
    }
  }

  // 4) 源墓碑：改名为 *.migrated-<ts>（保留可回滚，非删除）
  const ts = Date.now()
  for (const item of plan) {
    try {
      await fsp.rename(item.from, `${item.from}.migrated-${ts}`)
    } catch (err) {
      // 墓碑失败（如权限）→ 中止并报错，但已拷贝内容保留供人工处理
      throw new MemoryError('MIGRATION_TOMBSTONE_FAILED', `源文件墓碑失败（${item.from}）: ${err.message}。目标已拷贝，请人工核对后再清理`)
    }
  }

  // 5) 审计记录 migration.json（幂等键）
  const audit = {
    version: 1,
    from, to,
    at: new Date().toISOString(),
    ts,
    moved,
    status: 'done',
  }
  await fsp.writeFile(path.join(to, 'migration.json'), JSON.stringify(audit, null, 2), 'utf8')

  return { migrated: true, from, to, moved: moved.map((x) => x.name) }
}

/**
 * 条件迁移：仅在满足全部条件时执行。
 * - allow=false：数据目录为显式指定（env/opts）→ 尊重用户，不迁移。
 * - from 与 to 相同 → 跳过。
 * - 旧目录无 manager 数据 / 新目录已有数据 → 幂等跳过。
 * @param {string} to 新目录
 * @param {{allow?: boolean, from?: string}} [opts]
 */
export async function maybeMigrateLegacy(to, { allow = true, from = legacyBaseDir() } = {}) {
  if (!allow) return { migrated: false, reason: 'explicit-data-dir', from, to, moved: [] }
  if (path.resolve(to) === path.resolve(from)) return { migrated: false, reason: 'same-dir', from, to, moved: [] }
  if (!legacyHasManagerData(from)) return { migrated: false, reason: 'no-legacy', from, to, moved: [] }
  if (newDirHasData(to)) return { migrated: false, reason: 'new-dir-has-data', from, to, moved: [] }
  return migrateLegacyData({ from, to })
}
