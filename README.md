# 🧠 dsh-memory-manager

面向 AI Agent 的统一记忆管理插件（DeepSeek Harness 生态）。短程滑动窗口记忆 + 长程向量记忆 + 语义/混合检索 + 智能摘要 + 生命周期管理（TTL / 重要性 / 存储上限 / 清理）+ 多会话隔离 + 全局记忆共享 + JSON/JSONL 导入导出，并附带可视化 Web 管理界面。分层能力：**L0 原始对话 / L1 原子记忆 / L2 场景 / L3 画像 / 会话记忆档位 / 三态嵌入源 + 模型下载 / 日志 / LLM 分层蒸馏**——可独立全功能运行，也可与 dsh-layered-memory 共存（浏览其真实分层数据）。

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
| 📜 日志 | `memory.log` 镜像（info/warn/error + 2MB 轮转 + Windows 容错），GUI「日志」Tab 只读分页 |
| 🎚️ 会话记忆档位 | 每会话 `auto/chat/work/off`（`session-modes.json` 原子写），全链路 gating（捕获隐身 / 蒸馏暂停 / 召回过滤） |
| 🎯 三态嵌入源 | `off/remote/local`（`embedding-source.json`）：本地 ONNX 推理（onnxruntime-node 可选）、远程 API、纯关键词；白名单 3 款模型（bge-small-zh-v1.5 / embeddinggemma-300m / bge-m3）断点续传下载 + 逐文件 sha256 校验 |
| 🧬 分层蒸馏 | LLM（宿主 `ctx.llm`）管线：L0 对话持久化 → L1 原子记忆抽取 → L2 场景 → L3 画像；与 `mm_summarize` 摘要并存 |
| 🌐 Web GUI | 记忆浏览 / 语义搜索 / 导入导出 / 设置，深浅双主题（纯跟随系统）；记忆浏览与搜索结果均支持**真分页**（每页 20/50/100/200，搜索页大小=Top-K）；**DSH 设置侧边栏「记忆管理」入口**（客户端插件注入 `settings.section`，iframe 内嵌 GUI）；记忆浏览内嵌**层级 Tab**（概览/L0 对话/L1 原子记忆/L2 场景/L3 画像/日志）：layered 在场只读其真实分层数据，缺席则读**本插件自持蒸馏数据**（仅装本插件也全功能可跑） |

---

## 目录结构

```
dsh-memory-manager/
├── src/
│   ├── core/            # 核心引擎（类型/分词/短期/嵌入/向量/加密/存储/检索/摘要/生命周期/导入导出/统计/门面）
│   │                     #   + modes.mjs 档位 / model-catalog.mjs 模型白名单 / downloader.mjs 下载队列
│   │                     #   + embedding-source.mjs 三态源 / distill.mjs 分层蒸馏 / self-layered.mjs 自持分层读
│   ├── tools/           # 8 个 Agent 工具（handlers.mjs + 定义：mm_add/search/get_recent/summarize/distill/delete/update_importance/stats）
│   ├── triggers/        # 触发词规则
│   ├── client/          # 浏览器 half（bundle.js：注入设置侧边栏「记忆管理」，iframe 内嵌 GUI）
│   ├── dsh/plugin.mjs   # DSH 插件适配层（name/inject/apply）
│   ├── util/            # filelog.mjs（memory.log 镜像 + 轮转）
│   └── server/          # 共享 REST 路由 + 独立服务器入口
├── gui/                 # Web 界面（index.html 真实模式 / preview.html 独立预览 / css / js）
├── contracts/           # 工具契约（tools.md）与 Web API 契约（web-api.md）
├── scripts/             # seed-2000 / verify / smoke / client（客户端契约探针，含 md 报告）+ 各阶段聚焦测试
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
├── conversations/           # L0 原始对话镜像（YYYY-MM-DD.jsonl，只增不删）
├── scenes/{chat,work}/*.md  # L2 场景块（META 前块，与 layered 布局一致）
├── persona-chat.md / persona-work.md  # L3 画像
├── session-modes.json       # 会话记忆档位（auto/chat/work/off）
├── embedding-source.json    # 嵌入源（off/remote/local + activeModel）
├── models/{id}/             # 下载的本地嵌入模型（onnx 文件 + sha256 校验）
├── memory.log               # 日志镜像（2MB 轮转）
├── long_term/
│   ├── memories.db          # SQLite 元数据（内容默认加密；source='distill' 为蒸馏 L1）
│   ├── vector.index         # 向量索引（原子写，崩溃不留半写）
│   └── embeddings/          # 嵌入模型缓存
├── .salt / .key             # 加密盐与随机密钥
├── .lock                    # 单写者锁（防止插件/独立服务双写）
└── migration.json           # 目录迁移审计记录
```

### 作为 DSH 插件运行

插件入口 `src/dsh/plugin.mjs`（`export const name / inject / apply`），基于真实 DSH API 实现：
- 通过 `@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register` 注册 **8 个 Agent 工具**（对外名 `mm_*`：add / search / get_recent / summarize / **distill** / delete / update_importance / stats；`compat.bareSearch=true` 时 best-effort 额外注册旧名 `memory_*` 别名，被他人占用则跳过）
- 通过 `ctx.webServer.register` 挂载 `/api/memory/*` REST 路由（记忆列表 SQL 级分页；`/api/memory/meta` 返回去重会话/标签；搜索支持 `offset` 分页；**档位 mode / 模型 models / 蒸馏 distill / 日志 logs**）
- 通过 `ctx.on('session/event')` 监听会话事件：写入短期记忆、超阈值自动摘要（按会话档位 gating：off 隐身、auto 跟随共存协调）
- 通过 `ctx.get('llm')` 接入真实 LLM 生成式摘要（`ctx.llm.stream` + `BlockAssembler`）与**分层蒸馏**（`mm_distill`：L0→L1→L2→L3），失败自动回退本地抽取式 / 降级
- **P2 事件协调**（与 dsh-layered-memory 共存）：`config.hooks.sessionEventSummarize = auto|on|off`，默认 `auto` —— 启动探测 layered（cordis 注册表含 `dsh-memory`/layered，或裸工具 `memory_search` 已被注册且本插件未开 bareSearch），在场即让位（不短期捕获、不自动摘要），避免双写/重复摘要；`on` 强制接管，`off` 只关自动摘要（保留短期捕获）
- **浏览器 half**（`dsh.client`）：手写 plain-JS bundle 注入 `settings.section` 槽位，设置侧边栏出现「记忆管理」入口，iframe 内嵌 `src/client/bundle.js`（无打包器、无 RPC，纯 HTTP 走 `/api/memory/*`）

**装载与验证**（在 DSH workspace 内）：本项目 `node_modules/@deepseek-ai/{cordis,dsh-tools,dsh-llm}` 为指向 DSH checkout 真实包目录的 junction，使插件可用 DSH 的包树裸导入加载。

```bash
npm run integration   # scripts/dsh-integration.mjs：真实 Cordis + ToolRuntime 装载插件，40/40 通过
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
| `compat` | `bareSearch` | false | true=额外 best-effort 注册旧名 `memory_*` 别名（与 layered 共存；被他人占用则跳过） |
| `hooks` | `sessionEventSummarize` | `auto` | 会话事件协调：`auto`（默认，探测 layered，在场即让位）/ `on`（强制接管）/ `off`（关自动摘要，保留短期捕获） |

> `compat` / `hooks` 段的**生效值读插件配置**（cordis.patch.yml 的 `config.compat.*` / `config.hooks.*`），本表仅作 schema 与文档记录。

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

`healthz` / `stats` / `meta` / `memories`(GET, 列表, SQL 分页) / `memories/:id`(GET/DELETE) / `memories/delete`(批量) / `search`(支持 offset 分页) / `recent` / `summarize` / `memories/:id/importance`(PATCH) / `config`(GET/POST) / `export?format=json|jsonl` / `import` / `cleanup` / **`mode`(GET/PUT 档位) / `models`(GET 列表 + POST download/cancel/switch + DELETE) / `distill`(POST 分层蒸馏) / `logs`(GET)** / `layered/*`（分层浏览：layered 在场读其真实数据，缺席降级读自持蒸馏数据，`stats.source` 区分 layered|self）。详见 [`contracts/web-api.md`](contracts/web-api.md)。

---

## 设计决策

- **零运行时依赖**：核心用纯 ESM + Node 内置模块（`node:sqlite`、`crypto`、`http`），离线可用。
- **降级嵌入**：本地哈希 n-gram 向量（FNV-1a，512 维）作为兜底；配置 `@huggingface/transformers` 或 OpenAI 后自动升级。
- **混合检索**：候选集 = 向量召回（P3 起封顶 100）∪ 关键词命中，融合打分后按阈值过滤、Top-K 截断（支持 offset 分页），并按会话隔离。
- **倒排索引**：内存 `term → {id, freq}` 增量索引（启动构建一次，增删/导入实时维护；与存储失步时自愈重建），关键词检索从全表扫描降到命中集——2000 条下检索平均 ~104ms、峰值 <170ms。
- **重建索引**：更换嵌入模型后点「重建索引」按新模型对全库重嵌入并覆写向量索引；重建完成前检索自动降级为关键词匹配（不报错、不返回旧模型乱序结果）。
- **明文缓存**：搜索高频解密场景以 `id → 明文` 内存缓存加速。
- **加密存储**：默认加密；`master_password` 提供则 scrypt 派生，否则自动生成随机密钥（`.key`，0600）。**加密守卫**：库里有记录时禁止修改主密码/加密开关（避免密钥变更静默损坏存量），解密失败显式标记并计入 `stats.decrypt_failed`；`config.json` 原子写 + 0600。
- **分层浏览（自持 / 共存双源）**：Web GUI「记忆浏览」内嵌层级 Tab（概览/L0 对话/L1 原子记忆/L2 场景/L3 画像/日志）。数据源策略：layered 在场 → 只读直连其真实数据（`~/.dsh/memory`：readOnly SQLite + JSONL/MD 解析，fail-closed 绝不返回猜测数据）；layered 缺席 → 读**本插件自持蒸馏数据**（`conversations/` + `memories.db source='distill'` + `scenes/` + `persona-*.md`），`stats.source` 区分 `layered|self`。分层浏览不做导入/清理/重建索引。
- **分层蒸馏（P8）**：`mm_distill` 走宿主 `ctx.llm`（护栏包裹，零额外依赖）：L0 会话轮次镜像为日期 JSONL → L1 抽取原子记忆（family/type/priority，入库 `source='distill'`，family/type 编码进 tags 保持 schema 稳定）→ L2 场景 `.md`（META 前块 + 安全文件名防穿越）→ L3 画像（纯正文，同 layered 布局）。与 `mm_summarize`（短期→L1 摘要）并存互补。
- **三态嵌入源（P7）**：`off/remote/local`。本地 ONNX 推理**可选依赖**（`onnxruntime-node` 动态加载，未装明确降级哈希并提示，同 dsh-layered-memory 的处理——它也是 worker 内动态加载，非硬依赖）；模型下载白名单 3 款（bge-small-zh-v1.5 / embeddinggemma-300m / bge-m3），逐文件 size+sha256+revision 锁定，Range 断点续传 + 流式校验（失配删重下）+ 磁盘门禁 + 取消保留断点。
- **会话记忆档位（P6）**：每会话 `auto/chat/work/off`，全链路 gating（捕获隐身 / 蒸馏暂停 / 召回过滤），`session-modes.json` 原子写 + 串行队列 + 90 天剪枝 + 500 会话上限。
- **记忆仅显式工具召回**：DSH 无 `ctx.injection`；真实注入面（`agent.inject`/`agent/pre-step`）归 dsh-layered-memory 的 recall 注入所有。本插件不做隐式注入（避免双份上下文 + token 浪费），Agent 通过 `mm_*` 显式调用；`mm_search` 结果带 `source: 'memory-manager'` 与 `layer`（long_term/summary），`mm_stats` 带 `layered_present`（在场时分层记忆请调 layered 的 `memory_search`/`memory_read_scene`）。
