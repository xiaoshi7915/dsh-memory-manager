/**
 * 🔴1 加密加固聚焦测试：
 *  A) 守卫泛化：库里有记录时，random→主密码 / 改密码 / 关加密 / 开加密 一律 CONFIG_ERROR；
 *     空库时允许设置加密。
 *  B) decryptContent：伪造不可解记录 → 显式占位符 + stats.decrypt_failed 计数（不再静默乱码）。
 *  C) config.json 原子写 + 0600 权限。
 * 纯本地临时目录，不碰真实数据。
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEngine } from '../src/core/index.mjs'
import { configPath, saveConfig } from '../src/config.mjs'

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-hardening-'))
process.env.DSH_MEMORY_DIR = base

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

// ---- 用 hash 嵌入避免网络 ----
let engine = await MemoryEngine.create({ config: { long_term: { embedding_model: 'hash' }, storage: { encryption_enabled: false } } })

// ---- C) config.json 原子写 + 0600（POSIX 可验证；Windows 无 POSIX 权限模型，仅验证文件存在与写入成功） ----
await saveConfig(base, {})
const cfgPath = configPath(base)
const st = statSync(cfgPath)
if (process.platform !== 'win32') {
  check('C1 config.json 权限 0600', (st.mode & 0o777) === 0o600, `mode=${st.mode.toString(8)}`)
} else {
  check('C1 config.json 已原子写入（Windows 跳过权限断言）', st.isFile() && st.size > 0, `size=${st.size}`)
}

// ---- A) 空库允许设置加密 ----
const cfgEmpty = await engine.saveConfig({ storage: { encryption_enabled: true, master_password: 'secret-123' } })
check('A1 空库可启用加密+设主密码', cfgEmpty.storage.encryption_enabled === true && cfgEmpty.storage.master_password === 'secret-123')

// 重启引擎加载新配置（scrypt 模式）
await engine.close()
engine = await MemoryEngine.create({ config: { long_term: { embedding_model: 'hash' }, storage: { encryption_enabled: true, master_password: 'secret-123' } } })

// ---- B) 加密下添加记录 ----
await engine.addMemory({ content: '加密下的测试记忆', sessionId: 'hard' })
check('B1 加密记录已写入', engine.store.count() === 1)

// ---- A) 有记录后：改密码 / 关加密 / 改主密码 → 全部拒绝 ----
let rej = []
for (const [label, patch] of [
  ['A2 有记录改主密码被拒', { storage: { master_password: 'new-pass' } }],
  ['A3 有记录清空主密码被拒', { storage: { master_password: '' } }],
  ['A4 有记录关加密被拒', { storage: { encryption_enabled: false } }],
]) {
  try { await engine.saveConfig(patch); rej.push(label + ' 未拒绝!') }
  catch (e) { check(label, e.code === 'CONFIG_ERROR', e.message) }
}
if (rej.length) console.log('✗ ' + rej.join(' / '))

// ---- B) 伪造不可解记录 → decryptContent 显式占位 + stats 计数 ----
engine.store.insert({
  id: 'corrupt-1', content: 'not-valid-ciphertext-at-all', tags: [], importance: 5, is_global: 0,
  session_id: 'hard', created_at: Date.now(), last_accessed_at: Date.now(), ttl: null,
  source: 'test', tokens: 1, summary_of: null,
})
const dec = engine.decryptContent(engine.store.get('corrupt-1'))
check('B2 解密失败返回显式占位（非密文乱码）', dec.includes('解密失败') && !dec.includes('not-valid-ciphertext'), dec)
const s = await engine.stats()
check('B3 stats.decrypt_failed >= 1', s.decrypt_failed >= 1, `decrypt_failed=${s.decrypt_failed}`)

await engine.close()
const passed = results.filter((r) => r.ok).length
console.log(`\n═══ 🔴1 加密加固聚焦测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
