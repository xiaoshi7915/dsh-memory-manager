// P3 GUI↔后端实时契约验证：对运行中的服务器（PORT 46124）调用 GUI 渲染函数消费的端点，
// 断言响应字段与 gui/js/app.js 分层渲染函数使用的字段一致。
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:46124/api/memory'

const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

const j = async (p) => { const r = await fetch(BASE + p); const d = await r.json().catch(() => null); return { status: r.status, d } }

// layeredStats → loadLayeredOverview 消费字段
{
  const { status, d } = await j('/layered/stats')
  check('layered/stats 200', status === 200)
  check('stats 字段: present/l1/scenes/persona/l0/modes', d && 'present' in d && 'l1' in d && 'scenes' in d && 'persona' in d && 'l0' in d && 'modes' in d)
  check('stats.l1.total/l1.types/l1.families', d && typeof d.l1.total === 'number' && typeof d.l1.types === 'object' && typeof d.l1.families === 'object')
  check('stats.l0.bySession 数组', d && Array.isArray(d.l0.bySession))
  check('stats.modes.default', d && typeof d.modes.default === 'string')
}
// layered/l1 → renderL1View/l1Card 消费字段
{
  const { status, d } = await j('/layered/l1?limit=2')
  check('layered/l1 200', status === 200)
  const it = d?.items?.[0]
  check('l1 条目字段: id/content/type/family/priority/scene_name/version/updated_at', it && ['id', 'content', 'type', 'family', 'priority', 'scene_name', 'version', 'updated_at'].every((k) => k in it), it && JSON.stringify(Object.keys(it)))
  check('l1 分页字段: total/offset/limit', d && 'total' in d && 'offset' in d && 'limit' in d)
}
// layered/scenes → renderL2View/sceneCard
{
  const { status, d } = await j('/layered/scenes')
  check('layered/scenes 200', status === 200)
  const it = d?.items?.[0]
  check('scene 条目字段: path/family/name/summary/heat/updated', it && ['path', 'family', 'name', 'summary', 'heat', 'updated'].every((k) => k in it))
}
// layered/scenes/{fam}/{name} → bindSceneCards
{
  const sc = (await j('/layered/scenes')).d?.items?.[0]
  if (sc) {
    const { status, d } = await j(`/layered/scenes/${sc.family}/${encodeURIComponent(sc.name)}`)
    check('layered/scene 200 + content', status === 200 && d && typeof d.content === 'string' && d.content.length > 0)
  } else { console.log('⚠ 无场景可测，跳过 scene 详情') }
}
// layered/persona → renderL3View
{
  for (const fam of ['chat', 'work']) {
    const { status, d } = await j(`/layered/persona?family=${fam}`)
    check(`layered/persona ${fam} 200 + content`, status === 200 && d && typeof d.content === 'string')
  }
}
// layered/sessions + layered/l0 → renderL0View/convLine
{
  const { status, d } = await j('/layered/sessions')
  check('layered/sessions 200 + items', status === 200 && d && Array.isArray(d.items) && d.items.every((x) => 'id' in x && 'count' in x && 'mode' in x))
  const sid = d?.items?.[0]?.id
  if (sid) {
    const { status: s2, d: d2 } = await j(`/layered/l0?session=${encodeURIComponent(sid)}&limit=2`)
    check('layered/l0 200 + 条目字段', s2 === 200 && d2?.items?.[0] && ['id', 'session_id', 'role', 'content', 'recorded_at'].every((k) => k in d2.items[0]))
  }
}
// layered/mode GET
{
  const { status, d } = await j('/layered/mode')
  check('layered/mode 200 + session/mode', status === 200 && 'session' in d && 'mode' in d)
}

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ P3 GUI↔后端实时契约验证：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
