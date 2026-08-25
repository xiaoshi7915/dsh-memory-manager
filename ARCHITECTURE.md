# dsh-memory-manager — 总体架构设计（ARCHITECTURE.md）

> 依据：`TASK-spec.md`（需求）、`dsh-research.md`（DSH 机制调研）。本文档是本插件实现的唯一设计依据，所有模块接口以本文档为准。

## 1. 定位与总览
为 AI Agent 提供统一记忆管理层：短期记忆滑动窗口、长期记忆向量库、语义/混合检索、智能摘要、生命周期、会话隔离与全局共享、导入导出。数据全部落本地 `~/.dsh/memory/`。

## 2. 架构图（ASCII）

```
                    ┌──────────────────────────────────────────────┐
                    │  DSH 集成层（可选，需 DSH workspace 运行）      │
                    │  src/dsh/plugin.mjs                          │
                    │   name/inject/apply(ctx, config)             │
                    │   ├─ ctx.tools.register(defineTool(...)) ×7  │
                    │   ├─ ctx.webServer.register(/api/memory/*)    │
                    │   └─ ctx.on('session/event') 钩子             │
                    └──────────────┬───────────────────────────────┘
                                   │ 调用 handlers
                    ┌──────────────▼───────────────────────────────┐
                    │  工具处理层  src/tools/handlers.mjs（7 工具）  │
                    │  触发词检测  src/triggers/index.mjs           │
                    └──────────────┬───────────────────────────────┘
                                   │
   ┌───────────────────────────────▼───────────────────────────────┐
   │  MemoryEngine（门面） src/core/index.mjs                       │
   │   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌───────┐  │
   │   │short-term│ │ store   │ │ vector  │ │embedding │ │crypto │  │
   │   │(JSONL)   │ │(SQLite) │ │(纯JS)   │ │(local/降级)│ │(AES)  │  │
   │   └────┬─────┘ └────┬────┘ └────┬────┘ └────┬─────┘ └───┬───┘  │
   │   search / summarize / lifecycle / io / stats（组合层）       │
   └──────────────┬───────────────────────────────────────────────┘
                  │
   ~/.dsh/memory/ │  short_term/{session_id}.jsonl
                  │  long_term/memories.db（SQLite）
                  │  long_term/vector.index（向量索引 JSON）
                  │  long_term/embeddings/（向量缓存分片，可空）
                  │  .salt / .key（加密密钥材料）
                  │  config.json（配置）

   独立运行层（无需 DSH，供演示/验收/自测）：
   server/index.mjs —— 同构 REST API + 静态托管 gui/
   scripts/*.mjs    —— seed / verify / smoke
   gui/preview.html —— 独立静态预览（mock 数据）
```

## 3. 技术选型（含理由）
| 项 | 选择 | 理由 |
|---|---|---|
| 语言/模块 | 纯 ESM JavaScript + JSDoc 类型（`"type":"module"`） | 零构建、零依赖即可 `node xxx.mjs` 运行，规避 npm/网络受限；DSH 集成层用动态 import 适配 TS 约定 |
| 持久化 | 内置 `node:sqlite`（v24 自带 `DatabaseSync`） | 无需原生编译；满足 SPEC 的 memories.db 要求 |
| 短期记忆 | JSONL 按行追加 + 内存滑动窗口 | 追加日志天然适合会话流水；读写 O(1) |
| 向量索引 | 纯 JS 暴力余弦，持久化为 `vector.index`（JSON） | 2000 条规模暴力检索 <10ms，远低于 300ms 验收；零依赖；预留 HNSW 扩展位 |
| 嵌入 | `local`：优先动态加载 `@huggingface/transformers`（安装则用），否则**确定性哈希 n-gram 嵌入**（CJK 字符 + 拉丁词 + 二元组，归一化 512 维）；`openai`：配置 API Key 走 fetch | 离线可用；同义查询共享大量字符，余弦可分；验收 2 的 >0.85 可达成 |
| 摘要 | 本地抽取式（句频+位置加权）为默认；探测到 `ctx.llm` 时启用生成式为可选增强 | 离线零依赖；生成式留 DSH 集成位 |
| 加密 | AES-256-GCM（`node:crypto`）+ scrypt 派生（主密码）或随机密钥文件 | 符合 SPEC 默认启用；`node:crypto` 零依赖 |
| token 计数 | CJK 按 1 字符≈1 token，ASCII 按 4 字符≈1 token，混合估算 | 无需分词库 |

## 4. 模块接口（实现必须精确遵守）
> 全部模块位于 `src/core/*.mjs`，导出见下。数据目录常量：`baseDir` 默认 `~/.dsh/memory`（环境变量 `DSH_MEMORY_DIR` 可覆盖）。

### 4.1 tokenizer.mjs
- `countTokens(text: string): number`
- `truncateToTokens(text: string, maxTokens: number): string`（按 token 预算截断，保留前缀）

### 4.2 types.mjs
- `newId(): string`（`crypto.randomUUID()`）；`nowMs(): number`
- `clampImportance(n): number`（钳到 1..10 整数）
- `DEFAULT_CONFIG`：SPEC §5 全部默认值
- 记忆记录 `MemoryRecord`：`{id, content, tags: string[], importance, is_global, session_id, created_at, last_accessed_at, ttl: number|null, source: 'manual'|'auto'|'summary'|'import', tokens, summary_of: string|null}`

### 4.3 short-term.mjs
- `class ShortTermStore { constructor(baseDir); append(sessionId, role, content); getRecent(sessionId, {maxMessages, maxTokens}) -> Promise<{messages:[{role,content}], token_count, window_size, truncated}>; clear(sessionId); count(sessionId); }`
- 文件：`{baseDir}/short_term/{sessionId}.jsonl`，每行 `{"role","content","time"}`。

### 4.4 embedding.mjs
- `class EmbeddingProvider { constructor({model, apiKey, dataDir}); async init(); status() -> {kind:'local'|'hash'|'openai'|'unavailable', dim, detail}; async embed(text) -> Promise<Float32Array>; async embedMany(texts); fingerprint() -> string; }`
- `kind==='local'` 表示真实本地模型（embedding_status 'completed'），`'hash'` 表示降级（embedding_status 'degraded'），`'unavailable'` 时搜索退化为纯关键词。

### 4.5 vector.mjs
- `class VectorStore { constructor(indexFile); load(); upsert(id, vec); remove(id); size(); search(vec, topK) -> [{id, score}]; save(); fingerprint(); }`
- `vector.index` 格式：`{"version":1,"model":{"kind","dim","fingerprint"},"entries":{"<id>":[...浮点数组...]}}`。
- `embeddings/` 目录用于可选分片缓存（实现可留空，需在 README 说明）。

### 4.6 crypto.mjs
- `class MemoryCrypto { constructor({enabled, masterPassword, saltFile, keyFile}); async init(); enabled(); encrypt(plain) -> string; decrypt(cipher) -> string; fingerprint(); }`
- `enabled`：主密码 → scrypt 派生（盐存 saltFile）；无主密码 → 随机密钥存 keyFile（权限 600），并记录告警。向量索引不加密（需加载检索），memories.content 加密存储。

### 4.7 store.mjs（SQLite 元数据）
- `class MemoryStore { constructor(dbFile); migrate(); insert(rec); get(id) -> rec|null; update(id, patch); deleteByIds(ids) -> number; list() -> rec[]; count(); touch(id); close(); }`
- 表 `memories`（字段=MemoryRecord，tags 以 JSON 文本存，is_global 用 0/1）。`node:sqlite` `DatabaseSync`。

### 4.8 search.mjs
- `async search(engine, query, {topK, threshold, hybridWeight, sessionId, includeGlobal}) -> {results:[{id,content,score,session_id,timestamp,is_global}], total, latency_ms}`
- 混合：向量分（默认 w=0.7）+ 关键词分（词项重叠，词频加权归一），`score = w*vec + (1-w)*kw`；降级时纯关键词；按 threshold 过滤、Top-K 截断；隔离：结果仅含 `session_id===sessionId` 或 `is_global`（`global_memory.enabled` 关闭时全局也排除）。

### 4.9 summarize.mjs
- `extractiveSummary(text, {maxChars}) -> string`
- `async summarizeSession(engine, sessionId, {count}) -> {summary, memory_id, compressed_from, saved_tokens}`

### 4.10 lifecycle.mjs
- `class Lifecycle { async expire(engine) -> number; async enforceStorageLimit(engine) -> number; async deleteByConditions(engine, {sessionId, tag, isGlobal, olderThan, importanceLe, ids}) -> {deleted_count, affected_sessions, freed_tokens}; }`
- TTL：`created_at + ttl < now` 或 `last_accessed_at + ttl < now` 即过期删除。
- 超限清理：目录总字节 > `max_storage_mb` 时，按 `(importance asc, last_accessed_at asc)` 删到低于上限，记录 `last_compacted`。

### 4.11 io.mjs
- `async exportBackup(engine, {format:'json'|'jsonl'}) -> string`
- `async importBackup(engine, text, {mode:'merge'|'replace'}) -> {imported, skipped, failed}`
- 备份元数据：`{version, exported_at, counts, memories:[...]}`（json 单对象 / jsonl 每行一条 MemoryRecord）。

### 4.12 stats.mjs
- `async stats(engine) -> {total_memories, short_term_tokens, long_term_count, storage_size_mb, last_compacted, embedding_model, embedding_status, needs_reindex}`

### 4.13 index.mjs（MemoryEngine 门面）
- `class MemoryEngine { constructor({baseDir, config, masterPassword}); static async create(opts) -> MemoryEngine; get recentConfig(); get embeddingStatus(); async addMemory({content, tags, importance, is_global, sessionId, source}); async search(query, opts); async getRecent(sessionId, opts); async summarize(sessionId, opts); async deleteMemory(sessionId, {ids, conditions}); async updateImportance(id, score, sessionId); async stats(); async exportBackup(opts); async importBackup(text, mode); async runLifecycle(); needsReindex(); async close(); }`
- 写入路径：addMemory → 校验 → 重要性钳制 → token 计数 → crypto 加密 content → store.insert → embedding.embed → vector.upsert → save 索引 → 生命周期顺手跑（expire + 超限）。
- 检索路径：query → embed → vector.search 取候选 → 读 store（解密）→ 混合打分 → 过滤/截断 → 返回。
- 摘要路径：短期窗口取文本 → extractiveSummary → 按 addMemory(source='summary', summary_of=sessionId) 落库。
- 清理路径：expire + enforceStorageLimit + deleteByConditions。
- 导入导出路径：解析 → 校验 → 逐条 addMemory(source='import')（merge 按 id 去重；replace 先清空）。

### 4.14 config 模块（src/config.mjs）
- `loadConfig(baseDir) -> config`（读 `config.json` 并合并 DEFAULT_CONFIG，非法值回落默认并写回告警）
- `saveConfig(baseDir, patch)`
- `embeddingFingerprint(config)`：`{model, providerKind}` → 字符串；与 vector.index 的 fingerprint 不一致 ⇒ `needs_reindex=true`。

## 5. 数据流时序（简）
1. **短期写入**：`user/message`/`assistant/message` 事件 → `shortTerm.append(sessionId, role, text)`。
2. **语义检索**：query → embedding → vector.search（暴力余弦）→ store 读元数据/内容 → 混合打分 → 返回 Top-K + threshold。
3. **自动摘要**：`turn/start` 时若 `count(sessionId) > auto_summarize_threshold` → 取窗口文本 → 摘要 → 存长期记忆（source='summary'）。
4. **清理**：addMemory 后顺带 `expire()`+`enforceStorageLimit()`；手动删除走 `deleteByConditions`。
5. **导入导出**：export 序列化全量 → import 校验/去重/逐条入库。

## 6. 会话隔离模型
- 检索默认只命中 `session_id === 当前会话` 或 `is_global=1`（且 `global_memory.enabled`）。is_global 仅 `mm_add` 显式传 `is_global:true` 才置位。
- `mm_delete` 无 sessionId 上下文时只允许删本会话记忆；带全局权限时才可删全局。

## 7. 错误处理约定
- 工具返回统一 `{error: {code, message}}`（code 见 contracts/tools.md 错误码表）。内部抛 `MemoryError{code,message}`，由 handlers 层捕获映射。
- Web API 统一 `{error:{code,message}}` + 恰当 HTTP 状态码。

## 8. 验收映射
- 验收 1（20 轮后引用第 3 轮信息，注入 <100ms）：get_recent 返回窗口消息；verify 脚本采样延迟。
- 验收 2（跨会话持久化，相似度 >0.85）：manual 记忆 is_global 可选；跨会话 query 走混合检索，哈希嵌入下同义文本余弦高分。
- 验收 3（2000 条 Top-5 <300ms，直接相关 ≥90%）：暴力余弦 + 阈值过滤，verify 脚本 20 次采样平均。

## 9. 假设与偏差（实现者须知）
- 数据目录可用环境变量 `DSH_MEMORY_DIR` 覆盖（便于测试隔离）。
- `long_term/embeddings/` 分片在本实现中允许为空（向量统一存 vector.index），README 说明。
- 生成式摘要（ctx.llm）为可选增强，默认抽取式。
- **实现备注（最终落地）**：
  - 降级（哈希嵌入）模式：融合分 = `0.25×向量 + 0.75×关键词`；关键词分 = `0.5×recall + 0.5×覆盖率 + 短语命中0.3`；配置阈值（默认 0.75）自适应映射到哈希尺度 `max(0.38, thr×0.5)`，避免真实命中被误杀。
  - 搜索热路径以 `id→明文` 内存缓存加速解密（2000 条下平均检索约 220–245ms）。
  - `openai_api_key` 落在 `config.long_term.openai_api_key`；嵌入模型指纹比对检测 `needs_reindex`。
  - 会话事件钩子采用 `ctx.on('session/event', (session, event)=>{})`，`user/message` 写短期、超阈值自动摘要。

## 10. DSH 集成（真实 API 落地 + 验证）
- **插件形态**：`src/dsh/plugin.mjs` 为 Cordis Object 插件（`export const name/inject/apply`），`inject=['tools','webServer','sessions']`。
- **工具注册**：用 `@deepseek-ai/dsh-tools` 的 `defineTool({name, description, parameters, output:{schema, render}, execute})` 定义 7 个工具，再 `ctx.tools.register(def)`。`output.schema` 为对象 schema（`additionalProperties:false`，可空字段用 `oneOf:[…,{type:'null'}]`），`render(args,value)` 返回 `ContentBlock[]`（`{type:'text',text}`）。execute 内 `sessionId = exec?.agent?.session?.id || config.default_session_id || 'default'`。
- **LLM 生成式摘要**：`makeLlmSummarize(ctx)` 用 `ctx.get('llm')`（机会式，不注入依赖，无 LLM 时插件照常加载）→ `llm.listProviders()`/`listModels()` 解析路由 → `createUserMessage({content, source:{kind:'plugin', plugin:'dsh-memory-manager'}})` + `llm.stream({provider, model, messages, system, maxTokens:256, signal})` + `BlockAssembler` 拼装；失败返回 null 由 `summarizeSession` 回退抽取式。摘要记忆 `source='summary-llm'`，返回体新增 `via:'llm'|'extractive'`。
- **验证**：`scripts/dsh-integration.mjs` 在 DSH workspace 内以真实 `Context` + 真实 `ToolRuntime`（`ctx.plugin(ToolRuntime)`）装载插件，桩提供非目标服务缝（systemPrompt/webServer/sessions/llm）；断言 `ctx.tools.get(name)` 7 个全注册、`ctx.tools.schemas()` 覆盖、经真实 `ctx.tools.execute` 全链路执行 7 工具、`ctx.parallel('session/event',…)` 驱动事件钩子、webServer 路由记录。**实测 24/24 通过**。
- **依赖解析**：项目 `node_modules/@deepseek-ai/{cordis,dsh-tools,dsh-llm}` 为指向 DSH checkout 真实包目录（`vendor/cordis`、`packages/core/tools`、`packages/llm/llm`）的 junction，使裸导入在该环境下可解析；DSH 宿主内则直接用包树解析。
