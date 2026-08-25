/**
 * P2 分层端点聚焦测试：
 *  A) 对真实 ~/.dsh/memory（只读直连）断言 stats/l1/l0/scenes/persona/sessions/mode 结构。
 *  B) fail-closed：指向不存在目录 → isPresent=false、stats.present=false、l1 抛 LAYERED_UNAVAILABLE。
 *  C) modeSet 写临时目录副本（原子写 + mtime 并发守卫），不碰真实 session-modes.json。
 */
import { mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import os from 'node:os'
import { LayeredReader } from '../src/core/layered.mjs'

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

const realRoot = join(os.homedir(), '.dsh', 'memory')

// ---- A) 真实数据只读 ----
if (existsSync(join(realRoot, 'memory.db'))) {
  process.env.DSH_LAYERED_DIR = realRoot
  const lr = new LayeredReader()
  check('A1 isPresent（真实库）', lr.isPresent() === true)

  const st = await lr.stats()
  check('A2 stats.present=true', st.present === true)
  check('A3 stats.l1.total 数字', typeof st.l1.total === 'number' && st.l1.total >= 0, `l1.total=${st.l1.total}`)
  check('A4 stats.l0.total 数字', typeof st.l0.total === 'number' && st.l0.total >= 0, `l0.total=${st.l0.total}`)
  check('A5 stats 含 scenes/persona/modes 键', 'scenes' in st && 'persona' in st && 'modes' in st)

  const l1 = lr.l1({ limit: 5 })
  check('A6 l1 返回 items+total+分页字段', Array.isArray(l1.items) && typeof l1.total === 'number' && 'offset' in l1, `l1.items=${l1.items.length}/total=${l1.total}`)
  if (l1.items[0]) {
    const it = l1.items[0]
    check('A7 l1 条目字段完整', ['id', 'content', 'type', 'family', 'priority', 'scene_name'].every((k) => k in it), JSON.stringify(Object.keys(it)))
  }

  const l0 = lr.l0({ limit: 5 })
  check('A8 l0 返回 items', Array.isArray(l0.items) && l0.items.length > 0, `l0.items=${l0.items.length}`)
  if (l0.items[0]) {
    const it = l0.items[0]
    check('A9 l0 条目字段完整', ['id', 'session_id', 'role', 'content', 'recorded_at'].every((k) => k in it), JSON.stringify(Object.keys(it)))
  }

  const scenes = lr.scenes()
  check('A10 scenes 返回 items+total', Array.isArray(scenes.items) && typeof scenes.total === 'number', `scenes.total=${scenes.total}`)
  if (scenes.items[0]) {
    const s = scenes.items[0]
    check('A11 scene 条目字段完整', ['path', 'family', 'name', 'summary', 'heat', 'updated'].every((k) => k in s), JSON.stringify(Object.keys(s)))
    const sc = lr.scene({ family: s.family, name: s.name })
    check('A12 scene 内容可读', sc.content.includes('META'), `content=${sc.content.length}B`)
  }

  for (const fam of ['chat', 'work']) {
    const p = lr.persona({ family: fam })
    check(`A13 persona-${fam} 无导航段`, !p.content.includes('Scene Navigation'), `content=${p.content.length}B`)
  }

  const sess = lr.sessions()
  check('A14 sessions 返回 items', Array.isArray(sess.items) && typeof sess.total === 'number', `sessions=${sess.total}`)

  const m = lr.mode()
  check('A15 mode 返回 {session,mode}', 'session' in m && 'mode' in m, JSON.stringify(m))
  lr.close()
} else {
  console.log('⚠ 真实 ~/.dsh/memory 不存在，跳过 A 组（只读断言）')
}

// ---- B) fail-closed：不存在的目录 ----
{
  process.env.DSH_LAYERED_DIR = join(tmpdir(), 'dsh-no-such-layered-' + Date.now())
  const lr = new LayeredReader()
  check('B1 isPresent=false（不存在目录）', lr.isPresent() === false)
  const st = await lr.stats()
  check('B2 stats.present=false + available=false', st.present === false && st.available === false)
  let threw = null
  try { lr.l1({ limit: 5 }) } catch (e) { threw = e }
  check('B3 l1 抛 LAYERED_UNAVAILABLE', threw?.code === 'LAYERED_UNAVAILABLE', threw?.message)
  lr.close()
}

// ---- C) modeSet 写临时目录副本 ----
{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-layered-mode-'))
  // 复制 session-modes.json（存在则拷，不存在则跳过——用最小副本）
  const realMode = join(realRoot, 'session-modes.json')
  const tmpMode = join(tmp, 'session-modes.json')
  if (existsSync(realMode)) copyFileSync(realMode, tmpMode)
  else writeFileSync(tmpMode, JSON.stringify({ version: 1, sessions: {} }, null, 2))
  process.env.DSH_LAYERED_DIR = tmp
  const lr = new LayeredReader()
  const r = await lr.modeSet({ session: 'test-session', mode: 'work' })
  check('C1 modeSet 返回 {session,mode}', r.session === 'test-session' && r.mode === 'work')
  const back = lr.mode({ session: 'test-session' })
  check('C2 mode 读回 work', back.mode === 'work', JSON.stringify(back))
  // 非法 mode → VALIDATION_ERROR
  let threw = null
  try { await lr.modeSet({ session: 'test-session', mode: 'bogus' }) } catch (e) { threw = e }
  check('C3 非法 mode 抛 VALIDATION_ERROR', threw?.code === 'VALIDATION_ERROR', threw?.message)
  // 无 session → VALIDATION_ERROR
  threw = null
  try { await lr.modeSet({ mode: 'work' }) } catch (e) { threw = e }
  check('C4 缺 session 抛 VALIDATION_ERROR', threw?.code === 'VALIDATION_ERROR', threw?.message)
  lr.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ P2 分层端点聚焦测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
