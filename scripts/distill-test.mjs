// P8 分层蒸馏聚焦测试（LLM mock，不触真实 LLM）：
//  1. persistL0：日期 JSONL 镜像（只增不删）
//  2. parseL1Json：代码块剥离 + JSON 数组解析 + 空数组
//  3. extractL1：LLM mock 返回 JSON → 写入长期库（source=distill，tags 含 family/type）
//  4. distillScenes：L1 → L2 场景 .md（META 前块 + 安全文件名）
//  5. distillPersona：L3 画像 .md
//  6. runDistill 全管线：engine.distill 集成（LLM mock）+ 档位 gating 静态断言
//  7. REST POST /api/memory/distill
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const base = mkdtempSync(join(tmpdir(), 'dsh-mem-distill-'))
process.env.DSH_MEMORY_DIR = base
const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? '✅' : '✗'} ${name}${cond ? '' : ' — ' + detail}`) }

// ---- 1. persistL0 ----
{
  const { persistL0, dateKey } = await import('../src/core/distill.mjs')
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({})
  const r = await persistL0(e, 'sess-a', [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！有什么可以帮你？' },
  ])
  check('1 L0 落盘日期 JSONL', existsSync(r.file), r.file)
  check('1 L0 appended=2', r.appended === 2)
  const r2 = await persistL0(e, 'sess-a', [{ role: 'user', content: '再来一条' }])
  check('1 L0 追加只增', r2.appended === 1 && existsSync(r2.file))
  const raw = readFileSync(r.file, 'utf8').trim().split('\n')
  check('1 L0 文件含 3 行', raw.length === 3)
  const first = JSON.parse(raw[0])
  check('1 L0 行含 session_id/role/content', first.session_id === 'sess-a' && first.role === 'user' && first.content === '你好')
  check('1 dateKey 格式', /^\d{4}-\d{2}-\d{2}$/.test(dateKey()))
  await e.close()
}

// ---- 2. parseL1Json ----
{
  const { parseL1Json } = await import('../src/core/distill.mjs')
  check('2 纯 JSON 数组', parseL1Json('[{"content":"a","type":"persona","priority":80}]').length === 1)
  check('2 代码块包裹', parseL1Json('```json\n[{"content":"a","type":"persona"}]\n```').length === 1)
  check('2 夹杂解释文本', parseL1Json('下面是结果：\n[{"content":"a"}]\n完').length === 1)
  check('2 空数组', parseL1Json('[]').length === 0)
  check('2 无数组返回空', parseL1Json('没有结果') .length === 0)
  check('2 非法 JSON 返回空', parseL1Json('[{bad json}').length === 0)
}

// ---- 3. extractL1 ----
{
  const { extractL1 } = await import('../src/core/distill.mjs')
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({})
  const llm = async () => JSON.stringify([
    { content: '用户偏好用中文交流', type: 'persona', priority: 70 },
    { content: '用户计划周五发布新版本', type: 'episodic', priority: 85 },
    { type: 'persona', priority: 90 }, // 无 content → 应丢弃
  ])
  const r = await extractL1(e, 'sess-b', [
    { role: 'user', content: '我喜欢用中文交流' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '计划周五发布新版本' },
  ], { llm, family: 'chat' })
  check('3 L1 抽取 2 条（无效丢弃）', r.extracted === 2, `extracted=${r.extracted}`)
  check('3 family 回传', r.family === 'chat')
  // 校验入库（source=distill + tags）
  const recs = e.store.list()
  const distilled = recs.filter((x) => x.source === 'distill')
  check('3 入库 source=distill', distilled.length === 2, `distilled=${distilled.length}`)
  check('3 tags 含 family:chat', distilled.every((x) => x.tags.includes('family:chat')))
  check('3 tags 含 type 标记', distilled.some((x) => x.tags.includes('type:persona')) && distilled.some((x) => x.tags.includes('type:episodic')))
  check('3 无 LLM 时返回 0', (await extractL1(e, 'sess-b', [{ role: 'user', content: 'x' }], { llm: null, family: 'work' })).extracted === 0)
  // work family types
  const rw = await extractL1(e, 'sess-b', [{ role: 'user', content: '我们决定用 pnpm 管理依赖' }], { llm: async () => JSON.stringify([{ content: '团队决定用 pnpm 管理依赖', type: 'work_fact', priority: 80 }]), family: 'work' })
  check('3 work family 抽取', rw.family === 'work' && rw.extracted === 1)
  const wRec = e.store.list().filter((x) => x.source === 'distill' && x.tags.includes('family:work'))
  check('3 work tags 含 family:work', wRec.length === 1)
  await e.close()
}

// ---- 4. distillScenes ----
{
  const { distillScenes, sceneFileContent } = await import('../src/core/distill.mjs')
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({})
  const llm = async () => JSON.stringify([
    { scene_name: '用户沟通偏好', summary: '用户偏好中文、简洁', content: '## 沟通\n- 偏好中文\n- 要求简洁' },
    { scene_name: '../escape/危险', summary: 'x', content: 'y' },
  ])
  const r = await distillScenes(e, 'chat', [{ content: 'a', type: 'persona', priority: 70 }], { llm })
  check('4 L2 场景 2 个', r.scenes === 2, `scenes=${r.scenes}`)
  check('4 场景文件含 META 前块', existsSync(r.paths[0]) && /-----META-START-----/.test(readFileSync(r.paths[0], 'utf8')))
  // 文件名安全：basename 不含路径分隔符（穿越被消毒），且完整路径在 scenes/chat 内、无 .. 路径段
  const bn = r.paths[1].split(/[\\/]/).pop()
  check('4 文件名安全（穿越被消毒）',
    !/[\\/]/.test(bn) && !bn.split(/[\\/]/).some((seg) => seg === '..') && r.paths[1].startsWith(join(base, 'scenes', 'chat')), r.paths[1])
  check('4 完整路径无 .. 段', !r.paths[1].split(/[\\/]/).some((seg) => seg === '..'), r.paths[1])
  check('4 sceneFileContent 含 updated', /updated:/.test(sceneFileContent()))
  // 无 LLM 返回 0
  check('4 无 LLM 返回 0', (await distillScenes(e, 'chat', [{ content: 'a', type: 'persona', priority: 70 }], { llm: null })).scenes === 0)
  await e.close()
}

// ---- 5. distillPersona ----
{
  const { distillPersona } = await import('../src/core/distill.mjs')
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({})
  const llm = async () => '## 用户画像\n- 偏好中文\n- 工作严谨'
  const r = await distillPersona(e, 'chat', [{ name: '沟通偏好', summary: 'x' }], { llm })
  check('5 L3 画像写入', r.written === true && existsSync(r.path))
  const content = readFileSync(r.path, 'utf8')
  check('5 画像含导航头', content.includes('## 🗺️ Scene Navigation'))
  check('5 画像含正文', content.includes('工作严谨'))
  await e.close()
}

// ---- 6. runDistill 全管线 ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const e = await MemoryEngine.create({})
  // 先灌短期
  for (const t of [{ r: 'user', c: '请记住：我们团队约定用 pnpm' }, { r: 'assistant', c: '好的，已记录' }]) {
    await e.shortTerm.append('sess-c', t.r, t.c, { maxLines: 50 })
  }
  const llm = async () => JSON.stringify([
    { content: '团队约定用 pnpm 管理依赖', type: 'work_fact', priority: 80 },
    { content: '用户要求回答简洁', type: 'instruction', priority: 60 },
  ])
  const r = await e.distill('sess-c', { llm, family: 'work' })
  check('6 全管线 L0 持久化', r.l0.appended === 2, `l0=${r.l0.appended}`)
  check('6 全管线 L1 抽取', r.l1.extracted === 2, `l1=${r.l1.extracted}`)
  check('6 全管线 L2 场景', r.l2.scenes >= 1, `l2=${r.l2.scenes}`)
  check('6 全管线 L3 画像', r.l3.written === true)
  check('6 L3 画像文件为 work', r.l3.path.endsWith('persona-work.md'), r.l3.path)
  // conversations 目录有日期 JSONL
  const convDir = join(base, 'conversations')
  check('6 conversations 目录存在', existsSync(convDir))
  // 无 LLM 全管线：L0 仍持久化，L1/L2/L3 空
  const rNoLlm = await e.distill('sess-c', { llm: null, family: 'chat' })
  check('6 无 LLM 时 L0 仍持久化', rNoLlm.l0.appended >= 0 && rNoLlm.l1.extracted === 0 && rNoLlm.l2.scenes === 0 && rNoLlm.l3.written === false)
  await e.close()
}

// ---- 7. REST POST /api/memory/distill ----
{
  const { MemoryEngine } = await import('../src/core/index.mjs')
  const { attachRoutes } = await import('../src/server/routes.mjs')
  const e = await MemoryEngine.create({})
  const handler = attachRoutes(() => e)
  const call = (method, path, body) => new Promise((resolve) => {
    const req = new Readable({ read() {} })
    req.method = method; req.url = path
    req.headers = { host: '127.0.0.1:4599', 'content-type': 'application/json' }
    if (body) req.push(JSON.stringify(body))
    req.push(null)
    const res = { writeHead: (s) => { res.status = s }, end: (b) => resolve({ status: res.status, body: b ? JSON.parse(b.toString()) : null }) }
    handler(req, res)
  })
  const r = await call('POST', '/api/memory/distill', { session: 'rest-dist', family: 'chat' })
  check('7 POST distill 200', r.status === 200, `status=${r.status}`)
  check('7 返回结构含 l0/l1/l2/l3', !!(r.body?.l0 && r.body?.l1 && r.body?.l2 && r.body?.l3))
  check('7 family 回传', r.body.family === 'chat')
  // 无 LLM 时 L1=0 但仍成功
  check('7 无 LLM 时 L1=0', r.body.l1.extracted === 0, JSON.stringify(r.body.l1))
  await e.close()
}

// ---- 8. plugin gating 静态断言 ----
{
  const src = readFileSync(new URL('../src/dsh/plugin.mjs', import.meta.url), 'utf8')
  check('8 mm_distill 工具注册', src.includes("name: MM_NAMES.distill"))
  check('8 档位 gating 保留', src.includes("mode !== 'off'"))
}

const passed = results.filter((r) => r.ok).length
console.log(`\n═══ P8 分层蒸馏聚焦测试：${passed}/${results.length} 通过 ═══`)
process.exit(passed === results.length ? 0 : 1)
