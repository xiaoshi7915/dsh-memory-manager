/**
 * 蒸馏管线（P8）：L0 持久化 → L1 抽取 → L2 场景 → L3 画像。
 * 复刻 dsh-layered-memory 的分层蒸馏思路（独立实现，复用宿主 ctx.llm，零额外依赖）：
 *  - L0：会话原始轮次镜像为日期 JSONL（conversations/YYYY-MM-DD.jsonl），只增不删；
 *  - L1：LLM 从轮次抽取结构化原子记忆（JSON 数组，family/type/priority），写入长期库
 *        （source='distill'，family/type 编码进 tags 以保持 schema 稳定，与分层语义可互认）；
 *  - L2：LLM 将 L1 记忆整合为场景 .md（含 META 前块），写 scenes/{family}/；
 *  - L3：LLM 生成画像 .md（persona-{family}.md）。
 * 与 mm_summarize 并存：摘要（短期→L1 压缩）与蒸馏（L0→L1→L2→L3 结构化）互为补充。
 * @module src/core/distill
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/** 蒸馏记忆的 L1 类型白名单（family 决定可选词表）。 */
const CHAT_TYPES = ['persona', 'episodic', 'instruction']
const WORK_TYPES = ['work_fact', 'work_task', 'work_method', 'work_artifact']
const FAMILIES = ['chat', 'work']

export function isFamily(f) {
  return FAMILIES.includes(f)
}

/** L1 抽取的系统提示（简化自 layered，保持 JSON 数组输出契约）。 */
function l1SystemPrompt(family) {
  const types = family === 'work' ? WORK_TYPES : CHAT_TYPES
  const typeDesc = family === 'work'
    ? 'work_fact（项目/业务事实）、work_task（待办/跟进）、work_method（SOP/原则/经验）、work_artifact（文档/产物）'
    : 'persona（用户稳定属性/偏好）、episodic（客观事件/安排）、instruction（用户对 AI 的长效行为规则）'
  return `你是一名记忆抽取助手。从对话中抽取核心原子记忆，宁缺毋滥，过滤寒暄/临时指令/一次性操作。
每条记忆必须独立完整（脱离上下文可懂），不依赖"这个/那个/上面说的"。
family 固定为 ${family}；type 只能从：${typeDesc} 中选。
请仅返回一个合法 JSON 数组，每项是：
{"content":"完整独立的记忆陈述","type":"...","priority":0-100,"metadata":{}}
如果无有价值记忆，返回空数组 []。不要输出任何 Markdown 代码块或解释文字。`
}

/** L1 抽取用户提示（含消息原文）。 */
function l1UserPrompt(turns, family) {
  const text = turns
    .map((t, i) => `[${i}] ${t.role === 'user' ? '用户' : 'AI'}：${t.content}`)
    .join('\n')
  return `以下是一段对话（role: 用户/AI）。请抽取其中值得长期记忆的原子记忆（family=${family}）：\n\n${text}\n`
}

/** 从 LLM 响应剥离代码块并解析 JSON 数组。 */
export function parseL1Json(raw) {
  if (!raw) return []
  let text = String(raw).trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 生成当前日期键（YYYY-MM-DD）。 */
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * L0 持久化：把会话轮次镜像追加到 conversations/YYYY-MM-DD.jsonl（只增不删）。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} sessionId
 * @param {{role:string, content:string}[]} turns
 * @returns {Promise<{file:string, appended:number}>}
 */
export async function persistL0(engine, sessionId, turns) {
  const dir = path.join(engine.baseDir, 'conversations')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${dateKey()}.jsonl`)
  const lines = turns.map((t) => JSON.stringify({
    session_id: String(sessionId),
    role: t.role === 'user' ? 'user' : 'assistant',
    content: String(t.content),
    time: Date.now(),
  }))
  if (lines.length > 0) await fsp.appendFile(file, lines.join('\n') + '\n', 'utf8')
  return { file, appended: lines.length }
}

/**
 * L1 抽取：LLM 从轮次抽取原子记忆 → 写入长期库（source='distill'，family/type 入 tags）。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} sessionId
 * @param {{role:string, content:string}[]} turns
 * @param {{llm?: Function, family?: string}} opts  llm(text): Promise<string>；缺省返回 []（无 LLM 降级）
 * @returns {Promise<{extracted:number, family:string, memories:object[]}>}
 */
export async function extractL1(engine, sessionId, turns, { llm = null, family = 'chat' } = {}) {
  if (!llm || typeof llm !== 'function' || turns.length === 0) {
    return { extracted: 0, family, memories: [] }
  }
  const raw = await llm(l1SystemPrompt(family) + '\n\n' + l1UserPrompt(turns, family))
  const items = parseL1Json(raw)
  const memories = []
  for (const it of items) {
    const content = typeof it?.content === 'string' && it.content.trim() ? it.content.trim() : null
    if (!content) continue
    const type = typeof it.type === 'string' ? it.type : null
    const priority = Math.max(0, Math.min(100, Number(it.priority) || 5))
    const importance = Math.max(1, Math.min(10, Math.round(priority / 10)))
    try {
      await engine.addMemory({
        sessionId,
        content,
        importance,
        source: 'distill',
        tags: ['distill', `l1`, `family:${family}`, `type:${type || 'unknown'}`].filter(Boolean),
      })
      memories.push({ content, type: type || 'unknown', priority })
    } catch {
      // 单条失败不阻断整批
    }
  }
  engine.log?.info?.(`[memory-manager] 蒸馏 L1 抽取 ${memories.length} 条（family=${family}，会话 ${sessionId}）`)
  return { extracted: memories.length, family, memories }
}

/** 校验场景文件名安全（防穿越）。 */
export function safeSceneName(name) {
  const s = String(name || '').replace(/[\\/:"*?<>|]/g, '-').replace(/\s+/g, '-').trim()
  return s ? s.slice(0, 80) : `scene-${Date.now()}`
}

/** 生成场景文件内容（含 META 前块）。 */
export function sceneFileContent({ summary = '', heat = 1, body = '' } = {}) {
  const now = new Date().toISOString()
  return `-----META-START-----
created: ${now}
updated: ${now}
summary: ${String(summary || '').replace(/\n/g, ' ').slice(0, 200)}
heat: ${Number(heat) || 1}
-----META-END-----

${body}
`
}

/**
 * L2 场景蒸馏：LLM 将 L1 记忆整合为场景 .md 写入 scenes/{family}/。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} family
 * @param {object[]} memories  L1 记忆（{content, type, priority}）
 * @param {{llm?: Function}} opts
 * @returns {Promise<{scenes:number, paths:string[]}>}
 */
export async function distillScenes(engine, family, memories, { llm = null } = {}) {
  if (!llm || memories.length === 0) return { scenes: 0, paths: [] }
  const dir = path.join(engine.baseDir, 'scenes', family)
  await fsp.mkdir(dir, { recursive: true })
  const list = memories.map((m, i) => `${i + 1}. ${m.type}（p${m.priority}）：${m.content}`).join('\n')
  const system = `你是一名记忆整合助手。把下面的 L1 原子记忆整合为 ${family === 'work' ? '工作方法' : '用户画像'} 场景。
请仅返回一个合法 JSON 数组，每项：
{"scene_name":"简短场景名（30-50字，全局唯一，安全文件名）","summary":"30-40字索引摘要","content":"场景正文（Markdown，围绕主题连贯描述，≤500字）"}
最多 3 个场景。无有价值内容返回 []。不要输出代码块或解释。`
  const raw = await llm(`${system}\n\n待整合记忆：\n${list}`)
  const items = parseL1Json(raw)
  const paths = []
  for (const it of items) {
    const name = safeSceneName(it?.scene_name)
    const file = path.join(dir, `${name}.md`)
    const content = sceneFileContent({
      summary: it?.summary,
      body: it?.content || '',
    })
    await fsp.writeFile(file, content, 'utf8')
    paths.push(file)
  }
  engine.log?.info?.(`[memory-manager] 蒸馏 L2 场景 ${paths.length} 个（family=${family}）`)
  return { scenes: paths.length, paths }
}

/**
 * L3 画像蒸馏：LLM 生成画像 .md 写入 persona-{family}.md。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} family
 * @param {object[]} scenes  L2 场景摘要（{name, summary}）
 * @param {{llm?: Function}} opts
 * @returns {Promise<{written:boolean, path:string}>}
 */
export async function distillPersona(engine, family, scenes = [], { llm = null } = {}) {
  const file = path.join(engine.baseDir, family === 'work' ? 'persona-work.md' : 'persona-chat.md')
  if (!llm) return { written: false, path: file }
  const input = scenes.length > 0
    ? scenes.map((s, i) => `${i + 1}. ${s.name}：${s.summary || ''}`).join('\n')
    : '（当前无场景）'
  const system = family === 'work'
    ? '你是团队工作准则整合助手。把下面的工作场景整合为团队工作准则（Operating Doctrine）：核心原则、SOP、决策逻辑、边界与反模式。直接输出 Markdown 正文，不要代码块包裹，控制在 600 字内。'
    : '你是用户画像整合助手。把下面的个人场景整合为用户画像：核心特征、偏好、隐信号、演变。直接输出 Markdown 正文，不要代码块包裹，控制在 600 字内。'
  const body = await llm(`${system}\n\n场景摘要：\n${input}`)
  const content = `## 🗺️ Scene Navigation\n*以下为画像导航（蒸馏生成）*\n\n${body}\n`
  await fsp.writeFile(file, content, 'utf8')
  engine.log?.info?.(`[memory-manager] 蒸馏 L3 画像已写入（family=${family}）`)
  return { written: true, path: file }
}

/**
 * 蒸馏管线入口：L0 持久化 → L1 抽取 → L2 场景 → L3 画像。
 * 档位 gating（与 plugin 捕获一致）：off 跳过；chat/work 强制；auto 由调用方决定让位。
 * @param {import('./index.mjs').MemoryEngine} engine
 * @param {string} sessionId
 * @param {{llm?: Function, family?: string, turns?: {role:string,content:string}[]}} opts
 * @returns {Promise<{l0:{file:string,appended:number}, l1:{extracted:number}, l2:{scenes:number}, l3:{written:boolean}}>}
 */
export async function runDistill(engine, sessionId, { llm = null, family = 'chat', turns = null } = {}) {
  const f = isFamily(family) ? family : 'chat'
  // 轮次来源：调用方显式给，否则读短期窗口
  let srcTurns = turns
  if (!srcTurns) {
    const recent = await engine.shortTerm.getRecent(sessionId, {
      maxMessages: engine.config.short_term.max_messages ?? 20,
      maxTokens: engine.config.short_term.max_tokens ?? 4000,
    })
    srcTurns = recent.messages
  }
  const l0 = await persistL0(engine, sessionId, srcTurns)
  const l1 = await extractL1(engine, sessionId, srcTurns, { llm, family: f })
  const l2 = await distillScenes(engine, f, l1.memories, { llm })
  const l3 = await distillPersona(engine, f, l2.paths.map((p) => ({ name: path.basename(p, '.md'), summary: '' })), { llm })
  engine.log?.info?.(`[memory-manager] 蒸馏管线完成（会话 ${sessionId}，family=${f}，L0=${l0.appended} L1=${l1.extracted} L2=${l2.scenes} L3=${l3.written}）`)
  return { l0, l1, l2, l3 }
}
