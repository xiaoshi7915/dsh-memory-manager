#!/usr/bin/env node
/**
 * P0 全流程验证：目录迁移 + 单写者锁 + 原子写。
 * 所有数据只落在 os.tmpdir() 下的临时目录，绝不触碰真实 ~/.dsh/memory。
 * 用法：node scripts/p0-test.mjs
 * @module scripts/p0-test
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { MemoryEngine } from '../src/core/index.mjs'
import { VectorStore } from '../src/core/vector.mjs'
import { MemoryStore } from '../src/core/store.mjs'
import { DirLock, ownerAlive } from '../src/core/lock.mjs'
import { migrateLegacyData, maybeMigrateLegacy, legacyHasManagerData, newDirHasData } from '../src/core/migrate.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mm-p0-'))

let pass = 0
let fail = 0
const failed = []
function check(name, ok, detail = '') {
  if (ok) { pass += 1 } else { fail += 1; failed.push(name) }
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`)
}
const exists = (p) => fs.existsSync(p)
const tombstoned = (p) => fs.readdirSync(path.dirname(p)).some((n) => n.startsWith(`${path.basename(p)}.migrated-`))

async function main() {
  // ================= A. 原子写 =================
  console.log('\n== A. 原子写 ==')
  {
    const dir = path.join(TMP, 'atomic')
    fs.mkdirSync(dir, { recursive: true })
    const idx = path.join(dir, 'vector.index')

    const vs = new VectorStore(idx)
    vs.setModel({ kind: 'hash', dim: 512, fingerprint: 'hash:512' })
    vs.upsert('a', new Float32Array(512).fill(0.1))
    vs.upsert('b', new Float32Array(512).fill(0.2))
    await vs.save()
    check('A1 基础保存生成文件', exists(idx))
    const vs2 = new VectorStore(idx)
    vs2.load()
    const aVal = vs2.entries.get('a')?.[0] ?? NaN
    check('A2 回读一致', vs2.size() === 2 && Math.abs(aVal - 0.1) < 1e-6 && vs2.fingerprint() === 'hash:512', `a[0]=${aVal}`)

    // 并发 save 折叠：20 个 upsert+save 交错，最后文件须包含全部
    const vs3 = new VectorStore(idx)
    vs3.load()
    const jobs = []
    for (let i = 0; i < 20; i += 1) {
      vs3.upsert(`c${i}`, new Float32Array(512).fill(i / 100))
      jobs.push(vs3.save())
    }
    await Promise.all(jobs)
    const vs4 = new VectorStore(idx)
    vs4.load()
    const allPresent = Array.from({ length: 20 }).every((_, i) => vs4.entries.has(`c${i}`))
    check('A3 并发 save 折叠无丢失', allPresent && vs4.size() === 22, `size=${vs4.size()}`)

    // 孤儿 tmp 清理
    fs.writeFileSync(path.join(dir, 'vector.index.tmp-999'), 'junk')
    const recovered = await new VectorStore(idx).recoverTmp()
    check('A4 孤儿 tmp 清理', recovered === 1 && !exists(path.join(dir, 'vector.index.tmp-999')))
  }

  // ================= B. 单写者锁 =================
  console.log('\n== B. 单写者锁 ==')
  {
    const dir = path.join(TMP, 'lock')
    fs.mkdirSync(dir, { recursive: true })

    const l1 = new DirLock(dir, { mode: 'serve' })
    l1.acquire()
    const l2 = new DirLock(dir, { mode: 'plugin' })
    let threw = false
    try { l2.acquire() } catch (e) { threw = e.code === 'LOCKED' }
    check('B1 第二持有者 LOCKED 快速失败', threw)
    check('B2 锁文件携带 pid/mode', JSON.parse(fs.readFileSync(path.join(dir, '.lock'), 'utf8')).pid === process.pid)
    l1.release()
    const l3 = new DirLock(dir)
    l3.acquire()
    check('B3 释放后可重取', l3.isOwned())
    l3.release()
    check('B4 释放后锁文件删除', !exists(path.join(dir, '.lock')))

    // 陈旧锁接管（持有者 pid 已死）
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: 999_999_999, hostname: 'dead', mode: 'plugin', startedAt: Date.now() - 99_999, heartbeat: Date.now() - 99_999 }))
    const l4 = new DirLock(dir)
    l4.acquire()
    check('B5 陈旧锁自动接管', l4.isOwned())
    l4.release()

    // 非创建者不删他人锁（内容身份匹配）
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: 123, hostname: 'other', startedAt: 111, heartbeat: 111 }))
    const l5 = new DirLock(dir)
    l5.owned = true
    l5.meta = { pid: 999, startedAt: 111 } // 身份不匹配
    l5.release()
    check('B6 非创建者不误删他人锁', exists(path.join(dir, '.lock')))
    fs.unlinkSync(path.join(dir, '.lock'))

    check('B7 ownerAlive 判活', ownerAlive(process.pid) === true && ownerAlive(999_999_999) === false)
  }

  // ================= C. 目录迁移 =================
  console.log('\n== C. 目录迁移 ==')
  {
    const legacy = path.join(TMP, 'legacy')
    const newDir = path.join(TMP, 'memory-manager')
    fs.mkdirSync(path.join(legacy, 'long_term'), { recursive: true })

    // layered 哨兵文件（绝不触碰）
    fs.mkdirSync(path.join(legacy, 'conversations'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'conversations', 'c1.jsonl'), 'layered')
    fs.mkdirSync(path.join(legacy, 'records'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'records', 'r1.jsonl'), 'layered')
    fs.mkdirSync(path.join(legacy, 'scenes'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'scenes', 's1.md'), 'layered')
    fs.writeFileSync(path.join(legacy, 'memory.db'), 'LAYERED-DB')
    fs.writeFileSync(path.join(legacy, 'session-modes.json'), '{}')
    fs.writeFileSync(path.join(legacy, 'embedding-source.json'), '{}')
    fs.writeFileSync(path.join(legacy, 'memory.log'), 'log')

    // manager 白名单文件
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ storage: { encryption_enabled: false }, long_term: { embedding_model: 'hash' } }, null, 2))
    fs.writeFileSync(path.join(legacy, '.key'), Buffer.alloc(32, 7))
    fs.writeFileSync(path.join(legacy, '.salt'), Buffer.alloc(16, 3))
    const st = new MemoryStore(path.join(legacy, 'long_term', 'memories.db'))
    st.open()
    st.insert({ id: 'legacy-1', content: '迁移前的历史记忆：使用 Python 做数据分析', tags: ['迁移', '历史'], importance: 7, is_global: false, session_id: 'sess-legacy', created_at: Date.now(), last_accessed_at: Date.now(), ttl: null, source: 'manual', tokens: 12, summary_of: null })
    st.checkpoint()
    st.close()
    const vst = new VectorStore(path.join(legacy, 'long_term', 'vector.index'))
    vst.setModel({ kind: 'hash', dim: 512, fingerprint: 'hash:512' })
    vst.upsert('legacy-1', new Float32Array(512).fill(0.25))
    await vst.save()
    fs.mkdirSync(path.join(legacy, 'short_term'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'short_term', 's1.jsonl'), JSON.stringify({ role: 'user', content: 'hi' }) + '\n')

    check('C0 前置-检测到旧数据', legacyHasManagerData(legacy) === true)

    const res = await migrateLegacyData({ from: legacy, to: newDir })
    check('C1 迁移执行成功', res.migrated === true)
    check('C2 新目录含全部白名单', ['config.json', '.key', '.salt', 'long_term', 'short_term', 'migration.json'].every((n) => exists(path.join(newDir, n))))
    check('C3 源 manager 文件已墓碑', !exists(path.join(legacy, 'config.json')) && tombstoned(path.join(legacy, 'config.json')) && tombstoned(path.join(legacy, '.key')))
    const layeredIntact = ['conversations', 'records', 'scenes', 'memory.db', 'session-modes.json', 'embedding-source.json', 'memory.log']
      .every((n) => exists(path.join(legacy, n)))
    const layeredUntouched = !['memory.db', 'session-modes.json', 'embedding-source.json'].some((n) => tombstoned(path.join(legacy, n)))
    check('C4 layered 文件原样未动', layeredIntact && layeredUntouched)
    const db = new DatabaseSync(path.join(newDir, 'long_term', 'memories.db'))
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get('legacy-1')
    db.close()
    check('C5 迁移后数据库记录完整', row && row.content === '迁移前的历史记忆：使用 Python 做数据分析')
    check('C6 migration.json 审计', JSON.parse(fs.readFileSync(path.join(newDir, 'migration.json'), 'utf8')).status === 'done')

    // 幂等：源已墓碑 → no-legacy
    const again = await maybeMigrateLegacy(newDir, { allow: true, from: legacy })
    check('C7 迁移幂等（源墓碑→跳过）', again.migrated === false && again.reason === 'no-legacy')

    // dryRun 零副作用
    const legacy2 = path.join(TMP, 'legacy2')
    fs.mkdirSync(path.join(legacy2, 'long_term'), { recursive: true })
    fs.writeFileSync(path.join(legacy2, 'config.json'), '{}')
    const dry = await migrateLegacyData({ from: legacy2, to: path.join(TMP, 'newdir2'), dryRun: true })
    check('C8 dryRun 零写盘', dry.dryRun === true && !exists(path.join(TMP, 'newdir2')) && exists(path.join(legacy2, 'config.json')) && !tombstoned(path.join(legacy2, 'config.json')))

    // fail-closed：坏库中止迁移
    const legacy3 = path.join(TMP, 'legacy3')
    fs.mkdirSync(path.join(legacy3, 'long_term'), { recursive: true })
    fs.writeFileSync(path.join(legacy3, 'long_term', 'memories.db'), 'NOT A DATABASE')
    fs.writeFileSync(path.join(legacy3, 'config.json'), '{}')
    let busy = false
    try { await migrateLegacyData({ from: legacy3, to: path.join(TMP, 'newdir3') }) } catch (e) { busy = e.code === 'MIGRATION_BUSY' }
    check('C9 坏库 fail-closed 中止', busy && !exists(path.join(TMP, 'newdir3', 'config.json')))

    // maybe 条件分支
    const m1 = await maybeMigrateLegacy(path.join(TMP, 'x1'), { allow: false, from: legacy })
    check('C10 显式目录不迁移', m1.reason === 'explicit-data-dir')
    const m2 = await maybeMigrateLegacy(path.join(TMP, 'x2'), { allow: true, from: path.join(TMP, 'nonexistent-legacy') })
    check('C11 无旧数据跳过', m2.reason === 'no-legacy')
    fs.mkdirSync(path.join(TMP, 'hasdata'), { recursive: true })
    fs.writeFileSync(path.join(TMP, 'hasdata', 'config.json'), '{}')
    const m3 = await maybeMigrateLegacy(path.join(TMP, 'hasdata'), { allow: true, from: legacy2 })
    check('C12 新目录已有数据跳过', m3.reason === 'new-dir-has-data')
  }

  // ================= D. 引擎端到端（锁 + 迁移后数据） =================
  console.log('\n== D. 引擎端到端 ==')
  {
    const engDir = path.join(TMP, 'engine')
    const engine = await MemoryEngine.create({ baseDir: engDir })
    check('D1 引擎创建成功（临时目录）', !!engine)
    check('D2 引擎持有 .lock', exists(path.join(engDir, '.lock')))
    let locked = false
    try { await MemoryEngine.create({ baseDir: engDir }) } catch (e) { locked = e.code === 'LOCKED' }
    check('D3 双实例 LOCKED 快速失败', locked)
    const r = await engine.addMemory({ content: 'P0 端到端验证记忆', tags: ['p0'], sessionId: 'sess-x' })
    const s = await engine.search('P0 端到端', { sessionId: 'sess-x' })
    check('D4 写入+检索正常', s.results.length > 0 && s.results[0].id === r.memory_id)
    await engine.close()
    check('D5 close 释放锁', !exists(path.join(engDir, '.lock')))

    // 迁移后的新目录数据可被引擎读取
    const engine2 = await MemoryEngine.create({ baseDir: path.join(TMP, 'memory-manager') })
    const list = engine2.store.list()
    check('D6 迁移后数据可被引擎读取', list.some((x) => x.id === 'legacy-1'))
    await engine2.close()
  }

  console.log(`\nP0 测试完成：${pass} 通过，${fail} 失败`)
  if (fail > 0) {
    console.log('失败项：', failed.join(', '))
    process.exit(1)
  }
  console.log(`临时目录：${TMP}`)
}

main().catch((e) => {
  console.error('P0 测试崩溃:', e)
  process.exit(1)
})
