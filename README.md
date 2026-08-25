# 🧠 dsh-memory-manager

面向 AI Agent 的统一记忆管理插件（DeepSeek Harness 生态）。短程滑动窗口记忆 + 长程向量记忆 + 语义/混合检索 + 智能摘要 + 生命周期管理（TTL / 重要性 / 存储上限 / 清理）+ 多会话隔离 + 全局记忆共享 + JSON/JSONL 导入导出，并附带可视化 Web 管理界面。

> 完整需求与验收口径见 [`TASK-spec.md`](TASK-spec.md)。本插件**本地优先、零云依赖**，默认开箱即用（哈希+关键词降级），可配置真实嵌入模型提升语义精度。

---

## 功能总览

| 能力 | 说明 |
|---|---|
| 🧠 短期记忆 | 每会话滑动窗口（消息条数 + Token 上限），超出自动截断/摘要 |
| 📚 长期记忆 | SQLite 元数据 + 自定义向量索引（`node:sqlite` 原生，零原生依赖） |
| 🔍 混合检索 | 向量（余弦）与关键词（词项重叠）加权融合，降级模式自动适配阈值 |
| ✂️ 智能摘要 | 本地抽取式摘要（可选 LLM 增强），生成 `【对话摘要】` 长期记忆 |
| ♻️ 生命周期 | TTL 过期、重要性评分、存储超限清理（LRU + 低重要性优先） |
| 🔒 会话隔离 | 默认仅本会话可见；`is_global` 记忆跨会话共享，可整体开关 |
| 🔐 安全 | 默认 AES-256-GCM 加密存储（主密码 scrypt 派生密钥） |
| ⇅ 导入导出 | JSON / JSONL 备份，合并 / 替换两种恢复模式 |
| 🌐 Web GUI | 记忆浏览 / 语义搜索 / 导入导出 / 设置 四面板，深浅双主题 |

---

## 目录结构

```
dsh-memory-manager/
├── src/
│   ├── core/            # 核心引擎（类型/分词/短期/嵌入/向量/加密/存储/检索/摘要/生命周期/导入导出/统计/门面）
│   ├── tools/           # 7 个 Agent 工具（handlers.mjs + 定义）
│   ├── triggers/        # 触发词规则
│   ├── dsh/plugin.mjs   # DSH 插件适配层（name/inject/apply）
│   └── server/          # 共享 REST 路由 + 独立服务器入口
├── gui/                 # Web 界面（index.html 真实模式 / preview.html 独立预览 / css / js）
├── contracts/           # 工具契约（tools.md）与 Web API 契约（web-api.md）
├── scripts/             # seed-2000 / verify / smoke（含 md 报告）
├── review/              # UI 视觉验收
├── TASK-spec.md         # 需求规格
├── ARCHITECTURE.md      # 架构设计
└── PLAN.md              # 实施计划与分工
```

---

## 快速开始

环境要求：Node.js ≥ 22.5（使用内置 `node:sqlite` 与 `crypto`）。

```bash
# 1) 安装依赖（无运行时依赖，仅包元数据）
npm install

# 2) 独立演示/验收服务器（无需 DSH workspace）
npm run serve          # 默认 http://127.0.0.1:4599，PORT 可覆盖

# 打开浏览器访问 http://127.0.0.1:4599/ 即可使用 Web GUI
```

数据目录默认 `~/.dsh/memory-manager/`（P0 起与 dsh-layered-memory 解耦的专属目录；首次启动自动把旧 `~/.dsh/memory` 中本插件白名单文件迁移过来，源文件保留为 `*.migrated-<ts>` 墓碑）。可用环境变量 `DSH_MEMORY_DIR` 覆盖：

```
~/.dsh/memory-manager/
├── config.json              # 配置（自动生成默认值）
├── short_term/{session}.jsonl  # 短期滑动窗口
├── long_term/
│   ├── memories.db          # SQLite 元数据（内容默认加密）
│   ├── vector.index         # 向量索引（原子写，崩溃不留半写）
│   └── embeddings/          # 嵌入模型缓存
├── .salt / .key             # 加密盐与随机密钥
├── .lock                    # 单写者锁（防止插件/独立服务双写）
└── migration.json           # 目录迁移审计记录
```

### 作为 DSH 插件运行

插件入口 `src/dsh/plugin.mjs`（`export const name / inject / apply`），基于真实 DSH API 实现：
- 通过 `@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register` 注册 7 个 Agent 工具（含完整 `parameters` 参数 schema 与 `output` 输出 schema/渲染）
- 通过 `ctx.webServer.register` 挂载 `/api/memory/*` REST 路由
- 通过 `ctx.on('session/event')` 监听会话事件：写入短期记忆、超阈值自动摘要
- 通过 `ctx.get('llm')` 接入真实 LLM 生成式摘要（`ctx.llm.stream` + `BlockAssembler`），失败自动回退本地抽取式

**装载与验证**（在 DSH workspace 内）：本项目 `node_modules/@deepseek-ai/{cordis,dsh-tools,dsh-llm}` 为指向 DSH checkout 真实包目录的 junction，使插件可用 DSH 的包树裸导入加载。

```bash
npm run integration   # scripts/dsh-integration.mjs：真实 Cordis + ToolRuntime 装载插件，26/26 通过
```

**从 GitHub 一键安装（推荐，发布后可用）**：仓库声明了 `dsh.bundle` 清单（`package.json` → `cordis.patch.yml`），因此可直接用 DSH 的插件命令安装：

```bash
dsh plugin add xiaoshi7915/dsh-memory-manager
```

安装后验证：`http://127.0.0.1:3080/api/memory/healthz` 返回 200；GUI 面板在 `http://127.0.0.1:3080/memory-manager/`。

**接入运行中的 DSH**（本机开发验证，首次装载经 HMR 自动生效）：
1. 在 DSH profile（`~/.dsh/profiles/web/`）下建 junction 指向本项目：
   `plugins\dsh-memory-manager` → 本项目根目录（保证插件内部 `@deepseek-ai/*` 经本项目 junction 包树解析）。
2. 在 `cordis.patch.yml` 补丁层追加一条 insert（DSH 的 HMR 监听该文件，**首次新增条目**即事务性重载生效）：

```yaml
- insert:
    - id: dsh-memory-manager
      name: ./plugins/dsh-memory-manager/src/dsh/plugin.mjs
```

3. 验证：`http://127.0.0.1:3080/api/memory/healthz` 返回 200 即已生效；GUI 面板在
   `http://127.0.0.1:3080/memory-manager/`（与 REST 同源 `/api/memory/*`，GUI 内四面板直接读写真实记忆）。

> ⚠️ 更新插件代码后需**重启 DSH** 才加载：DSH 的 Cordis HMR 以 `root: []` 运行（不监听用户插件代码文件），
> 补丁配置重载不会清除 ESM 模块缓存（相对路径同名条目重导仍返回旧模块）。这是 DSH 运行时限制，非插件问题。

---

## 验收结果（已实测通过）

| 标准 | 要求 | 实测 |
|---|---|---|
| 1. 20 轮后引用第 3 轮信息 | 注入延迟 <100ms | ✅ 命中 + 25–36ms |
| 2. 跨会话偏好检索 | 相似度 >0.85 | ✅ 0.8908 |
| 3. 2000 条记忆 | Top-5 平均 <300ms；Top-1 直接相关 ≥90% | ✅ 平均 220ms / Top-1 90% / Top-5 100% |

复现：

```bash
npm run verify     # 完整验收，输出 scripts/verify-report.md
npm run smoke      # 端到端冒烟（工具 + REST），输出 scripts/smoke-report.md
npm run seed       # 批量种入 2000 条演示记忆（默认 ~/.dsh/memory-manager）
```

> 降级模式说明：未配置真实嵌入模型时，检索以「哈希向量(0.25) + 关键词(0.75)」融合，并把配置阈值（默认 0.75）自适应映射到哈希尺度（`max(0.38, thr*0.5)`），保证真实命中不被误杀；配置真实模型（local/OpenAI）后即用配置阈值。

---

## 配置项（config.json，均可经 GUI 修改）

| 段 | 键 | 默认 | 说明 |
|---|---|---|---|
| `short_term` | `max_messages` | 20 | 窗口消息条数 |
| | `max_tokens` | 4000 | 窗口 Token 上限 |
| `long_term` | `auto_summarize_threshold` | 10 | 超过该消息条数自动摘要（0 = 关闭） |
| | `retrieval_top_k` | 5 | 检索返回条数 |
| | `similarity_threshold` | 0.75 | 相似度阈值 |
| | `hybrid_weight` | 0.7 | 向量占比（混合检索权重） |
| | `embedding_model` | `local` | `local` / `openai` |
| | `embedding_model_id` | `''` | 留空 = 哈希降级 |
| | `openai_api_key` | `''` | OpenAI Key |
| | `llm_guardrails` | 见下 | LLM 生成式摘要成本护栏 |
| `storage` | `max_storage_mb` | 500 | 存储上限（超限 LRU 清理） |
| | `encryption_enabled` | true | AES-256-GCM |
| | `master_password` | `''` | 主密码（scrypt 派生密钥） |
| | `api_token` | `''` | Web API 可选鉴权 |
| `global_memory` | `enabled` | true | 跨会话全局记忆开关 |

`long_term.llm_guardrails` 子项（生成式摘要的 LLM 成本护栏，超出自动回退本地抽取式摘要）：

| 键 | 默认 | 说明 |
|---|---|---|
| `max_concurrency` | 1 | 全局并发上限；忙则回退抽取式，不排队阻塞会话链 |
| `fail_threshold` | 3 | 连续失败熔断阈值 |
| `cooldown_ms` | 600000 | 熔断冷却时长（毫秒） |
| `max_calls_per_hour` | 30 | 小时调用上限 |
| `max_tokens_per_day` | 50000 | 日 Token 预算（输入+输出近似；0 = 不限） |

---

## Web API（`/api/memory`）

`healthz` / `stats` / `memories`(GET, 列表) / `memories/:id`(GET/DELETE) / `memories/delete`(批量) / `search` / `recent` / `summarize` / `memories/:id/importance`(PATCH) / `config`(GET/POST) / `export?format=json|jsonl` / `import` / `cleanup`。详见 [`contracts/web-api.md`](contracts/web-api.md)。

---

## 设计决策

- **零运行时依赖**：核心用纯 ESM + Node 内置模块（`node:sqlite`、`crypto`、`http`），离线可用。
- **降级嵌入**：本地哈希 n-gram 向量（FNV-1a，512 维）作为兜底；配置 `@huggingface/transformers` 或 OpenAI 后自动升级。
- **混合检索**：候选集 = 向量 Top-K×8 ∪ 关键词命中，融合打分后按阈值过滤、Top-K 截断，并按会话隔离。
- **倒排索引**：内存 `term → {id, freq}` 增量索引（启动构建一次，增删/导入实时维护；与存储失步时自愈重建），关键词检索从全表扫描降到命中集——2000 条下检索平均 ~104ms、峰值 <170ms。
- **重建索引**：更换嵌入模型后点「重建索引」按新模型对全库重嵌入并覆写向量索引；重建完成前检索自动降级为关键词匹配（不报错、不返回旧模型乱序结果）。
- **明文缓存**：搜索高频解密场景以 `id → 明文` 内存缓存加速。
- **加密存储**：默认加密；`master_password` 提供则 scrypt 派生，否则自动生成随机密钥（`.key`，0600）。
