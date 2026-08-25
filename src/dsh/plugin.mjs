/**
 * DSH 适配层：把本插件注册为 DSH 插件（name/inject/apply）。
 * 基于真实 DSH API（@deepseek-ai/dsh-tools 的 defineTool / ctx.tools.register，
 * @deepseek-ai/dsh-llm 的 ctx.llm.stream + BlockAssembler）注册 7 个 Agent 工具、
 * 挂载 Web 路由、监听会话事件，并接入真实 LLM 生成式摘要。
 * 仅当在 DSH workspace 内运行时才可加载（依赖 @deepseek-ai/dsh-tools）。
 * @module src/dsh/plugin
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryEngine } from '../core/index.mjs'
import { HANDLERS } from '../tools/handlers.mjs'
import { MM_NAMES, LEGACY_NAMES } from '../tools/names.mjs'
import { countTokens } from '../core/tokenizer.mjs'
import { attachRoutes, serveGuiHandler } from '../server/routes.mjs'

export const name = 'dsh-memory-manager'
export const inject = ['tools', 'webServer', 'sessions']

/** 便捷构造 output 对象 schema。 */
const obj = (properties) => ({ type: 'object', properties, additionalProperties: false })
const str = (description) => ({ type: 'string', description })
const int = (description) => ({ type: 'integer', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const nullable = (schema) => ({ oneOf: [schema, { type: 'null' }] })

/** 渲染文本块。 */
const text = (s) => [{ type: 'text', text: s }]

/** 7 个工具定义（parameters + output.schema + output.render，与 contracts/tools.md 一致）。
 * 对外名统一 mm_*（P1 与 dsh-layered-memory 共存）；key 供 bareSearch 旧名别名映射。 */
const TOOL_DEFS = [
  {
    key: 'add',
    name: MM_NAMES.add,
    description: '向长期记忆库添加一条结构化记忆（内容 + 可选标签 + 重要性 1-10 + 可选 is_global）。用户说"帮我记住…/记住这个…/记一下…"时调用。',
    parameters: {
      content: { type: 'string', required: true, description: '记忆内容' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      importance: { type: 'integer', description: '重要性 1-10，默认 5' },
      is_global: { type: 'boolean', description: '是否全局记忆（跨会话可见），默认 false' },
      session_id: str('会话 ID，缺省为当前会话'),
    },
    output: obj({
      success: bool('是否成功'),
      memory_id: str('记忆 ID'),
      embedding_status: { type: 'string', enum: ['completed', 'degraded'], description: '嵌入状态' },
      token_cost: int('内容 token 数'),
    }),
    render(args, v) {
      return text(`已保存记忆（id=${v.memory_id}，嵌入=${v.embedding_status}，token=${v.token_cost}）\n内容：${args.content}`)
    },
  },
  {
    key: 'search',
    name: MM_NAMES.search,
    description: '基于查询文本检索最相关的 K 条记忆（语义相似度，含关键词+向量混合）。用户说"我之前说过…/关于…你还记得吗"时调用。',
    parameters: {
      query: { type: 'string', required: true, description: '检索查询文本' },
      top_k: int('返回条数，默认按配置（搜索分页时即每页条数）'),
      threshold: num('相似度阈值，默认按配置'),
      session_id: str('会话 ID，缺省为当前会话'),
      include_global: bool('是否包含全局记忆，默认 true'),
      offset: int('分页偏移（P3），默认 0'),
    },
    output: obj({
      results: {
        type: 'array',
        items: obj({
          id: str('记忆 ID'),
          content: str('记忆内容'),
          score: num('相关度 0-1'),
          session_id: str('所属会话'),
          timestamp: str('创建时间 ISO'),
          is_global: bool('是否全局记忆'),
          source: str('来源（memory-manager 本库）'),
          layer: str('层级（long_term 长期 / summary 摘要）'),
        }),
      },
      total: int('命中条数'),
      latency_ms: int('耗时毫秒'),
      page: obj({
        offset: int('本页偏移'),
        limit: int('每页条数'),
        total: int('命中总数'),
      }),
    }),
    render(args, v) {
      const lines = v.results.length
        ? v.results.map((r, i) => `${i + 1}. [${(r.score * 100).toFixed(1)}%] ${r.content}`).join('\n')
        : '（无命中）'
      return text(`检索「${args.query}」共 ${v.total} 条，耗时 ${v.latency_ms}ms：\n${lines}`)
    },
  },
  {
    key: 'get_recent',
    name: MM_NAMES.get_recent,
    description: '获取当前会话最近 N 轮的短期记忆上下文（滑动窗口）。用户问"这次对话的上下文/我们刚才聊到哪了"时调用。',
    parameters: {
      n: int('最近消息条数，默认按配置'),
      session_id: str('会话 ID，缺省为当前会话'),
    },
    output: obj({
      messages: {
        type: 'array',
        items: obj({ role: str('user 或 assistant'), content: str('消息内容') }),
      },
      token_count: int('窗口内 token 数'),
      window_size: int('窗口消息条数'),
      truncated: bool('是否被截断'),
    }),
    render(_args, v) {
      const body = v.messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n')
      return text(`最近对话（${v.messages.length} 条 / ${v.token_count} tokens${v.truncated ? '，已截断' : ''}）：\n${body || '（空）'}`)
    },
  },
  {
    key: 'summarize',
    name: MM_NAMES.summarize,
    description: '对指定对话区间生成摘要并存储为长期记忆，压缩上下文窗口。用户说"总结一下我们的对话"时调用。',
    parameters: {
      session_id: str('会话 ID，缺省为当前会话'),
      count: int('取最近 count 条消息'),
      content: str('显式提供文本则直接摘要该文本'),
    },
    output: obj({
      summary: str('摘要正文'),
      memory_id: nullable(str('摘要记忆 ID')),
      compressed_from: int('压缩的原始消息条数'),
      saved_tokens: int('节省的 token 数'),
      via: { type: 'string', enum: ['llm', 'extractive'], description: '生成方式：LLM 或抽取式' },
    }),
    render(_args, v) {
      return text(`对话摘要：${v.summary}\n（已存为长期记忆 id=${v.memory_id ?? '无'}，压缩 ${v.compressed_from} 条，节省 ${v.saved_tokens} tokens）`)
    },
  },
  {
    key: 'delete',
    name: MM_NAMES.delete,
    description: '按 ID 删除单条记忆，或按条件（会话/标签/全局/时间/重要性）批量删除。用户说"删除关于…的记忆/忘掉…/清空记忆"时调用。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: '要删除的记忆 ID 列表' },
      conditions: {
        type: 'object', additionalProperties: false,
        properties: {
          session_id: str('会话 ID'),
          tag: str('标签'),
          is_global: bool('是否全局'),
          older_than: int('早于该时间戳'),
          importance_le: int('重要性小于等于'),
        },
        description: '批量删除条件',
      },
      all_sessions: bool('跨会话删除权限，默认 false'),
    },
    output: obj({
      deleted_count: int('删除条数'),
      affected_sessions: { type: 'array', items: { type: 'string' }, description: '受影响的会话' },
      freed_tokens: int('释放的 token 数'),
    }),
    render(_args, v) {
      return text(`已删除 ${v.deleted_count} 条记忆（会话：${v.affected_sessions.join('、') || '无'}，释放 ${v.freed_tokens} tokens）`)
    },
  },
  {
    key: 'update_importance',
    name: MM_NAMES.update_importance,
    description: '修改指定记忆的重要性评分（1-10）。',
    parameters: {
      memory_id: { type: 'string', required: true, description: '记忆 ID' },
      score: { type: 'integer', required: true, description: '新重要性 1-10' },
    },
    output: obj({
      memory_id: str('记忆 ID'),
      old_score: int('旧重要性'),
      new_score: int('新重要性'),
    }),
    render(_args, v) {
      return text(`已更新记忆 ${v.memory_id} 的重要性：${v.old_score} → ${v.new_score}`)
    },
  },
  {
    key: 'stats',
    name: MM_NAMES.stats,
    description: '获取当前记忆库的整体统计信息（数量、存储、嵌入状态等）。',
    parameters: {},
    output: obj({
      total_memories: int('记忆总数'),
      short_term_tokens: int('短期 token 数'),
      long_term_count: int('长期记忆条数'),
      storage_size_mb: num('存储占用 MB'),
      last_compacted: nullable(str('上次清理时间 ISO')),
      embedding_model: str('嵌入模型配置'),
      embedding_status: str('completed 或 degraded'),
      needs_reindex: bool('是否需要重建索引'),
      decrypt_failed: int('解密失败条数（密钥可能已变更，历史记忆不可读）'),
      layered_present: bool('dsh-layered-memory 是否在场（在场时 Agent 分层记忆应调 layered 工具）'),
    }),
    render(_args, v) {
      return text(`记忆库统计：总数 ${v.total_memories}（长期 ${v.long_term_count} / 短期 ${v.short_term_tokens} tokens），占用 ${v.storage_size_mb}MB，嵌入 ${v.embedding_status}${v.needs_reindex ? '（需重建索引）' : ''}${v.layered_present ? '；dsh-layered-memory 在场（分层记忆请调其 memory_search/memory_read_scene）' : ''}`)
    },
  },
]

/** 解析可用 LLM 路由（provider + model），无则返回 null。 */
async function resolveLlmRoute(llm) {
  try {
    const providers = llm.listProviders()
    if (!Array.isArray(providers) || providers.length === 0) return null
    const p = providers[0]
    let model = p?.model
    if (!model && typeof llm.listModels === 'function') {
      const models = await llm.listModels(p?.name).catch(() => [])
      model = models?.[0]?.id
    }
    if (!p?.name || !model) return null
    return { provider: p.name, model }
  } catch {
    return null
  }
}

/**
 * 构造真实 LLM 生成式摘要回调（无 LLM 服务或失败时返回 null，由抽取式回退）。
 *
 * 内置 LLM 成本护栏（读 config.long_term.llm_guardrails，缺省如下）：
 * - max_concurrency（默认 1）：全局并发上限；忙则直接回退抽取式，不排队阻塞会话链；
 * - fail_threshold（默认 3）/ cooldown_ms（默认 600000）：连续失败熔断，冷却期内不再调 LLM；
 * - max_calls_per_hour（默认 30）：小时调用上限；
 * - max_tokens_per_day（默认 50000）：日 token 预算（近似 = 输入 + 输出 token 数）。
 * "没有 LLM / 没有可用路由"是永久性降级，不计入失败熔断；流式超时/出错/中断才算失败。
 */
function makeLlmSummarize(ctx, getConfig) {
  const g = { busy: 0, failStreak: 0, lastFailAt: 0, hourCalls: 0, hourAt: 0, dayTokens: 0, dayAt: 0 }
  return async (text) => {
    const gr = (typeof getConfig === 'function' && getConfig())?.long_term?.llm_guardrails ?? {}
    const maxConcurrency = gr.max_concurrency ?? 1
    const failThreshold = gr.fail_threshold ?? 3
    const cooldownMs = gr.cooldown_ms ?? 600_000
    const maxCallsPerHour = gr.max_calls_per_hour ?? 30
    const maxTokensPerDay = gr.max_tokens_per_day ?? 50_000
    const now = Date.now()
    // 滚动窗口复位
    if (now - g.hourAt >= 3_600_000) { g.hourAt = now; g.hourCalls = 0 }
    if (now - g.dayAt >= 86_400_000) { g.dayAt = now; g.dayTokens = 0 }
    if (g.failStreak >= failThreshold && now - g.lastFailAt < cooldownMs) {
      console.warn(`[dsh-memory-manager] LLM 摘要熔断冷却中（连续失败 ${g.failStreak} 次），回退抽取式`)
      return null
    }
    if (g.hourCalls >= maxCallsPerHour) {
      console.warn(`[dsh-memory-manager] LLM 摘要达小时调用上限（${maxCallsPerHour}），回退抽取式`)
      return null
    }
    if (maxTokensPerDay > 0 && g.dayTokens >= maxTokensPerDay) {
      console.warn(`[dsh-memory-manager] LLM 摘要达日 token 预算（${maxTokensPerDay}），回退抽取式`)
      return null
    }
    if (g.busy >= maxConcurrency) {
      console.warn(`[dsh-memory-manager] LLM 摘要并发达上限（${maxConcurrency}），回退抽取式（不排队阻塞）`)
      return null
    }
    g.busy += 1
    try {
      const out = await generateSummarize(ctx, text)
      g.failStreak = 0
      g.hourCalls += 1
      if (out) g.dayTokens += countTokens(text) + countTokens(out)
      return out
    } catch (e) {
      g.failStreak += 1
      g.lastFailAt = Date.now()
      g.hourCalls += 1
      console.warn(`[dsh-memory-manager] LLM 摘要失败（${g.failStreak}/${failThreshold}），回退抽取式: ${e?.message ?? e}`)
      return null
    } finally {
      g.busy -= 1
    }
  }
}

/** 真实 LLM 生成式摘要核心（无 LLM/无路由返回 null；流式错误向上抛给护栏计数）。 */
async function generateSummarize(ctx, text) {
  let llm = null
  try {
    llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
  } catch { /* 服务不可用 */ }
  if (!llm || typeof llm.stream !== 'function') return null
  const route = await resolveLlmRoute(llm)
  if (!route) return null
  const { createUserMessage, BlockAssembler } = await import('@deepseek-ai/dsh-llm')
  const system = '你是一名记忆整理助手。请用不超过 120 字的中文，把下面的对话浓缩为要点式摘要：保留关键事实、决定、偏好与待办，丢弃寒暄。只输出摘要正文，不要前缀。'
  const user = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-memory-manager' },
  })
  const signal = AbortSignal.any([ctx._dshMemSignal ? ctx._dshMemSignal() : new AbortController().signal, AbortSignal.timeout(20000)])
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [user],
    system,
    maxTokens: 256,
    signal,
  })) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  const out = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim()
  return out || null
}

// 记忆注入决策（P4，多智能体架构师合议）：
// DSH 无 ctx.injection 服务；真实注入面是 agent.inject(UserMessage) 与 agent/pre-step 监听，
// 且 dsh-layered-memory 已占有 recall 注入（双通道）。本插件「记忆仅显式工具召回」——
// Agent 通过 mm_* 显式调用，不做隐式注入（避免双份上下文 + token 浪费 + 相关度噪音）。
// 原 buildInjection 死代码（曾返回 {text, token_cost}，与任何注入面都不匹配）已移除。
// 若将来需要接线，走 agent/pre-step 且仅在 layered 缺席时。

/**
 * P2：探测 dsh-layered-memory 是否已在本进程注册（事件协调用）。
 * 信号：① cordis 注册表里有名含 layered / 名为 dsh-memory 的插件（权威）；
 *       ② 兜底——裸工具 memory_search 已被注册。仅当本插件未开 bareSearch 时可用
 *         （否则 memory_search 可能是我们自己的 bare 别名，无法区分 layered）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 插件配置（读 compat.bareSearch 判断工具探测是否可信）
 * @returns {boolean}
 */
export function detectLayeredMemory(ctx, config = {}) {
  try {
    const reg = ctx?.registry
    if (reg && typeof reg === 'object') {
      for (const entry of Object.values(reg)) {
        const name = entry?.name ?? entry?.id ?? ''
        if (typeof name === 'string' && (/layered/i.test(name) || name === 'dsh-memory')) return true
      }
    }
  } catch { /* 注册表不可读 → 走工具探测 */ }
  if (config?.compat?.bareSearch !== true) {
    try {
      if (ctx?.tools?.get?.('memory_search')) return true
    } catch { /* 忽略 */ }
  }
  return false
}

/**
 * P2：解析会话事件协调模式。
 * mode（config.hooks.sessionEventSummarize）：auto|on|off
 * - auto（默认）：启动探测 layered，在场 → 让位（capture/summarize 全关）；缺席 → 全开
 * - on：强制接管（无视 layered，capture + summarize 全开）
 * - off：关闭自动摘要（capture 保留，mm_get_recent 仍需短期记忆）
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function resolveEventMode(ctx, config = {}) {
  const mode = config?.hooks?.sessionEventSummarize ?? 'auto'
  const layered = detectLayeredMemory(ctx, config)
  if (mode === 'on') return { mode, layered, captureEnabled: true, summarizeEnabled: true, reason: 'force' }
  if (mode === 'off') return { mode, layered, captureEnabled: true, summarizeEnabled: false, reason: 'disabled' }
  return {
    mode, layered,
    captureEnabled: !layered,
    summarizeEnabled: !layered,
    reason: layered ? 'yield-to-layered' : 'standalone',
  }
}

export function apply(ctx, config = {}) {
  const enginePromise = MemoryEngine.create({}).catch((e) => {
    throw new Error(`dsh-memory-manager: 初始化记忆引擎失败: ${e.message}`)
  })
  const engineHolder = { engine: null }
  enginePromise.then((e) => { engineHolder.engine = e })
  // LLM 摘要护栏读取运行中引擎的配置（llm_guardrails），引擎就绪前用缺省值
  const llmSummarize = makeLlmSummarize(ctx, () => engineHolder.engine?.config ?? null)

  // P2 事件协调：启动探测 dsh-layered-memory，决定短期捕获/自动摘要是否让位（避免双写/重复摘要）
  // mode 读插件配置 config.hooks.sessionEventSummarize（auto|on|off），缺省 auto。
  // （可观测性走导出函数 resolveEventMode/detectLayeredMemory；Context 为封闭对象不可附加属性。）
  const eventMode = resolveEventMode(ctx, config)
  if (eventMode.layered) {
    console.warn(`[dsh-memory-manager] 检测到 dsh-layered-memory 在场，事件协调=${eventMode.mode}（${eventMode.reason}）：${eventMode.captureEnabled ? '短期捕获开' : '短期捕获让位'} / ${eventMode.summarizeEnabled ? '自动摘要开' : '自动摘要让位'}`)
  }
  // P4 可观测：把 layered 在场标志挂到引擎，stats（工具/REST）上报 layered_present
  enginePromise.then((e) => { e.layered_present = eventMode.layered })

  // 1) 通过真实 defineTool + ctx.tools.register 注册 7 个工具（mm_* 前缀，P1 共存）
  for (const spec of TOOL_DEFS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: spec.output,
        render: spec.render,
      },
      async execute(args, exec) {
        const engine = engineHolder.engine ?? (await enginePromise)
        const sessionId = exec?.agent?.session?.id || config.default_session_id || 'default'
        return HANDLERS[spec.name](args ?? {}, { engine, sessionId, llmSummarize, signal: exec?.signal })
      },
    }))
  }

  // 1b) 旧名 memory_* 别名（compat.bareSearch=true 时 best-effort）：
  // 与 dsh-layered-memory 共存场景下旧名可能已被其占用 → 注册抛错即跳过，绝不致命。
  if (config?.compat?.bareSearch === true) {
    for (const spec of TOOL_DEFS) {
      const legacy = LEGACY_NAMES[spec.key]
      try {
        ctx.tools.register(defineTool({
          name: legacy,
          description: spec.description,
          parameters: spec.parameters,
          output: { schema: spec.output, render: spec.render },
          async execute(args, exec) {
            const engine = engineHolder.engine ?? (await enginePromise)
            const sessionId = exec?.agent?.session?.id || config.default_session_id || 'default'
            return HANDLERS[legacy](args ?? {}, { engine, sessionId, llmSummarize, signal: exec?.signal })
          },
        }))
      } catch (e) {
        // 名字已被占用（如 layered 的 memory_search）→ 静默跳过别名，工具面仍以 mm_* 为准
        console.warn(`[dsh-memory-manager] bare 别名 ${legacy} 注册失败（可能已被其他插件占用），跳过: ${e?.message ?? e}`)
      }
    }
  }

  // 2) Web 路由：把 contracts/web-api.md 的 REST 端点挂到 /api/memory
  ctx.webServer.register({
    kind: 'prefix',
    path: '/api/memory',
    handler: attachRoutes(() => engineHolder.engine),
  })
  // 2b) 托管 GUI（四面板管理界面）到 /memory-manager，让用户在 DSH 内直接看到记忆管理界面
  ctx.webServer.register({
    kind: 'prefix',
    path: '/memory-manager',
    handler: serveGuiHandler,
  })

  // 3) 会话事件钩子：短期记忆写入 + 自动摘要（LLM 优先，失败回退抽取式）
  // 真实 DSH 事件形状：user/message 的 data 为 UserMessage（content 为 ContentBlock[]），
  // assistant/message 的 data = { turn, step, message: AssistantMessage, ... }（正文在 message.content）。
  // 摘要按阈值边界节流（每 auto_summarize_threshold 条消息摘要一次），且同一会话的事件经 per-session
  // 串行链处理，避免并发投递（ctx.parallel）下检查-摘要-更新出现竞态导致重复摘要。
  const lastSummarizedCount = new Map() // sessionId -> 上次摘要时的消息条数
  const sessionChains = new Map() // sessionId -> Promise（串行化链尾）
  ctx.on('session/event', (session, event) => {
    const sid = session?.id || 'default'
    const prevChain = sessionChains.get(sid) ?? Promise.resolve()
    const nextChain = prevChain.then(() => handleSessionEvent(sid, event))
    // map 存已捕获版本：避免某次处理 reject 后链尾变 rejected，永久毒化该会话后续事件
    sessionChains.set(sid, nextChain.catch(() => {}))
    // 返回链尾（带 catch）：既保持 per-session 串行，又让 ctx.parallel 等到本次处理完成
    return nextChain.catch((e) => {
      console.warn(`[dsh-memory-manager] session/event 处理失败: ${e?.message ?? e}`)
    })
  })

  async function handleSessionEvent(sid, event) {
    const engine = engineHolder.engine ?? (await enginePromise)
    let role = null
    let content = ''
    if (event.type === 'user/message') {
      role = 'user'
      content = messageText(event.data?.content)
    } else if (event.type === 'assistant/message') {
      role = 'assistant'
      content = messageText(event.data?.message?.content)
    }
    // P2 让位：layered 在场（auto）时短期捕获关闭，避免同一对话被双方各存一份
    if (role && content && eventMode.captureEnabled) {
      await engine.shortTerm.append(sid, role, content, { maxLines: engine.config.short_term.max_messages })
    }
    // P2 让位：layered 在场（auto）或 off 时自动摘要关闭（后者仍保留短期捕获）
    if (event.type === 'user/message' && eventMode.summarizeEnabled) {
      const count = await engine.shortTerm.count(sid)
      const threshold = engine.config.long_term.auto_summarize_threshold
      const prev = lastSummarizedCount.get(sid) ?? 0
      if (threshold > 0 && count >= threshold && count - prev >= threshold) {
        try {
          await engine.summarize(sid, { count, llm: llmSummarize })
          lastSummarizedCount.set(sid, count)
        } catch (e) {
          // 失败也推进节流，避免后续每条消息都重试打爆 LLM
          lastSummarizedCount.set(sid, count)
          console.warn(`[dsh-memory-manager] 自动摘要失败（已暂停至下个阈值）: ${e?.message ?? e}`)
        }
      }
    }
  }
}

/** 从 ContentBlock[]（或纯字符串）提取可见文本。 */
function messageText(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}
