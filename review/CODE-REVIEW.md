# dsh-memory-manager 代码审查报告

审查人：The Agency 工程·代码审查工程师（engineering-code-reviewer）+ 主 Agent 复核
日期：2026-08-24（随截图反馈触发的复查）

## 结论
核心架构（模块拆分、node:sqlite、AES-256-GCM、混合检索、事件钩子）清晰、契约文档齐全、集成测试覆盖 7 工具全链路。
高危点集中在「导入加密旁路」「配置运行时不同步导致的数据丢失」「自动摘要并发与失败语义」三处；前端仅一处标题同步遗漏。
**全部修复后回归：集成 25/25 · smoke 23/23 · verify 7/7（avg 125ms）。**

## 已修复（8 项）

| # | 位置 | 严重度 | 问题 | 修复 |
|---|------|--------|------|------|
| 1 | src/core/io.mjs:84 | 高 | 导入备份传 `skipEncrypt:true`，明文落库绕过 AES | 移除 `skipEncrypt`，导入走正常加密 |
| 2 | src/core/index.mjs saveConfig | 高 | 清空主密码→下次启动换随机密钥→历史密文不可读（静默数据丢失） | 有加密数据时拒绝清空主密码/关加密（CONFIG_ERROR） |
| 3 | src/tools/handlers.mjs:66-71 | 中 | memory_summarize content 分支缺 `via`，与 output schema 不符 | 补 `via:'extractive'` |
| 4 | src/core/index.mjs addMemory | 中 | 先写库后嵌入，嵌入失败留孤儿记录 | 先嵌入再入库 |
| 5 | src/dsh/plugin.mjs 钩子 | 中 | 自动摘要并发竞态→重复摘要；失败静默+逐条重试打爆 LLM | per-session 串行链；失败也推进节流+告警 |
| 6 | src/core/short-term.mjs | 中 | 短期文件无限增长 + 每事件全量读文件（O(n²)） | 内存增量计数 + 超窗裁剪 |
| 7 | src/core/store.mjs | 中 | node:sqlite 未开 WAL，2000 次插入 20s（每插一 fsync） | `PRAGMA journal_mode=WAL`，播种 20s→3.7s，检索 avg 541→125ms |
| 8 | gui/js/app.js initNav | 低 | 侧边栏切换不更新页面标题（截图的「设置」面板仍显示「记忆浏览」） | 补 PANEL_TITLES 同步 |

## 待办（需产品决策，未改）

| # | 位置 | 严重度 | 问题 | 建议 |
|---|------|--------|------|------|
| A | src/core/index.mjs:240 | 中 | 加密/嵌入配置保存后运行时**不重生效**，需整机重启，界面无提示 | 运行时重初始化或返回 `needs_restart` 提示 |
| B | src/core/index.mjs:79-90 | 中 | 解密失败静默返回密文乱码，无「密钥不匹配」信号 | decryptContent 返回错误信号，GUI 提示 |
| C | 导入 replace 模式 | 中 | 不清 `_plainCache`，旧明文可能串新记录 | invalidateCache(all) |
| D | lifecycle.expire | 中 | TTL 过期不移除向量 | 补 vector.remove |
| E | src/config.mjs:38 | 低 | auto_summarize_threshold clamp min=2，GUI 设 0 无法关闭 | clamp 下限改 0 |
| F | api/config 响应 | 低 | 返回 master_password / api_key 明文 | 脱敏 |
| G | safeSessionId | 低 | `sess@1`/`sess#1` 折叠到同一文件 | 拒绝含折叠字符 sid 或加哈希 |
| H | HEAD/超限 | 低 | HEAD 对不存在路径返 200；超限未返 413 | 修正状态码 |
| I | signal 透传 | 低 | exec.signal 未消费，取消/超时不中断检索与 LLM | 透传 signal |
| J | Windows | 低 | .key 文件 0o600 在 Windows 无实际 ACL 语义 | 平台化权限或文档说明 |

## 截图疑点核实
- **「设置」面板标题不切换**：属实，已修复（见 #8）。
- **「短期记忆 (滑动窗口)」中「窗」字乱码**：**已核实为截图/字体渲染假象**——源码字节级校验编码正确（UTF-8 正常），非源码 bug。

---

## 第二轮：5 专家深度审查（2026-08-24）
专家：高级开发者 / 软件架构师 / 自动化优化架构师 / UX 走查 / UI 设计。回归全绿：集成 26/26 · smoke 23/23 · verify 7/7（avg 125ms）。

### 本轮修复（P0/P1）
| 严重度 | 问题 | 修复 |
|---|---|---|
| 🔴 P0 | **存储超限清理会删光全库**（SQLite 不缩文件，磁盘判断死循环；已 node 实测） | 熔断最多删 50% + 不再逐条 dirSizeMb + checkpoint + 告警 |
| 🔴 P0 | **删除空目标=清库**（REST 空 body / memory_delete 空参 / 触发器"忘掉"无目标词 all_sessions） | deleteMemory 强制 ids/conditions；deleteByConditions 有效过滤守卫（含 `{ids:[]}`、`ids:['不存在']` 穿透）；触发器改空目标 |
| 🔴 P0 | **条件删除静默失效**（schema 下划线键 vs 引擎驼峰键，session_id/is_global/older_than/importance_le 全不匹配） | deleteMemory 键归一化映射 |
| 🔴 P0 | **会话事件链被一次异常永久毒化**（链尾存未捕获 rejection） | map 存 caught 版本 |
| 🔴 P0 | **TTL 过期删行不删向量**（孤儿向量累积） | expire() 补 vector.remove |
| 🔴 P0 | **主密码"改新值/关加密"漏守**（运行时旧 key 写入→重启新 key 读→历史密文全毁） | 守卫扩展到 masterChanged/!nextEnabled |
| 🟡 P1 | openai 嵌入无超时/失败即整链崩；换模型维度不一致→点积 NaN 污染排序 | 15s 超时 + 失败降级 hash（degraded 传播到 search/status/addMemory）+ vector.search 维度守卫 |
| 🟡 P1 | GET config 回传主密码/OpenAI Key 明文 | 脱敏 + has_password + 后端 `'***'` 归一化 + GUI 密码留空占位 |
| 🟡 P1 | auto_summarize_threshold clamp min=2 无法设 0 关闭 | clamp 下限改 0（钩子已有 threshold>0 判断） |
| 🟡 P1 | GUI 搜索默认会话 `'default'` 永远搜不到真实 UUID 会话的记忆 | search 支持 `session_id='*'`=全部会话；GUI 默认 `'*'` |
| 🟡 P1 | GUI 刷新按钮死按钮（dispatchEvent 无监听）；阈值 0 被 `\|\|` 吞；搜索内改重要性静默失效；replace 导入无确认；「轮次」标签错 | 加 id+监听；Number.isFinite；卡片 data-imp 从 DOM 读；confirm；改「消息条数,0=关闭」 |

### 待办（需产品决策/更大改造，未改）
| 优先级 | 问题 | 方向 |
|---|---|---|
| P0 | 真 reindex 无实现（NaN 已由维度守卫兜住，但历史向量仍是旧模型） | 遍历重嵌入+重写索引；needs_reindex 期间降级关键词 |
| P0 | LLM 自动摘要无全局并发上限/熔断/日预算 | llm_max_concurrency=1、fail_threshold=3/cooldown、calls_per_hour/tokens_per_day、摘要后台化去首行阻塞 |
| P1 | persistVectors 全量 JSON 覆写 + 并发写可覆盖（O(N²) 悬崖） | 串行队列+原子写( tmp+rename )，或向量并入 SQLite BLOB 同事务 |
| P1 | 检索全表扫描+逐条解密+tokenize | 内存倒排索引（Map<term,Set<id>> 增量维护）→ 2000 条 125ms→预估 5-15ms |
| P1 | 插件与 `npm run serve` 独立服务器共用数据目录双写 | 目录文件锁 .lock 拒绝双写；README 声明 |
| P1 | GUI 记忆列表无分页（固定 limit 200，老记忆不可达）；会话下拉仅前 500 条 | offset 翻页 + distinct 会话接口 |
| P1 | 隐式注入（turn/start 注入 buildInjection）未接线 | 确认 DSH 注入接口后实现，或降级验收承诺 |
| P2 | GUI 视觉系统（UI 设计师 P0/P1：主题默认跟随宿主、danger 对比度、loading/禁用态、原生 confirm、focus 环） | 按设计评审清单实施 |
| P2 | triggers 死代码未接线；_plainCache 无上限；prepared statement 未复用 | 接线或删除；LRU 上限；open() 预编译 |

> 说明：本轮视觉工具预算耗尽，UI 设计师/UX 走查为**源码级评审**（未看图），对比度为 WCAG 公式估算。

---

## 第三轮：功能补全（2026-08-24，接第二轮待办）
围绕用户点名的三项补齐，回归全绿：集成 26/26 · smoke 26/26（+3 新覆盖）· verify 7/7。

### 本轮完成
| 项 | 内容 |
|---|---|
| 🔴 P0 真 reindex | `engine.reindex()` 按当前提供者对全库重嵌入并覆写向量索引；saveConfig 对嵌入冷键（model/id/api_key）**运行时重建提供者**；`needs_reindex` 期间检索**自动降级关键词**（不报错、不返回旧模型乱序）；`POST /api/memory/reindex` 端点 + GUI「重建索引」按钮 + 状态提示（✓已同步 / ⚠️需重建） |
| 🟡 P1 倒排索引 | 新增 `src/core/inverted.mjs`（`Map<term, Map<id,freq>>` + docTerms 回撤）；启动构建一次、addMemory/删除/TTL/超限/导入实时维护；**失步自愈**（`docCount()!==store.count()` 时就地重建，覆盖旁路直插/恢复场景）；关键词检索从全表扫描 O(N) 降到命中集 |
| 🟡 P2 GUI 视觉整改 | 按 UI 设计师清单：主题默认**跟随系统/宿主**（prefers-color-scheme + 监听变化，显式切换才记忆）；danger 对比度 WCAG AA（浅色 #c62828/白字 5.94:1，深色浅红底+深字 7:1 级）；`:focus-visible` 高对比焦点环（含表单控件）；loading/禁用态（`busy()` 助手 + 清理/导出/检索防重入）；**内联确认**替代原生 confirm（删除两步确认 3.5s、替换导入内联确认条）；导航键盘可达（role=button + Enter/Space）；离线状态点改红；`prefers-reduced-motion` 尊重 |

### 新增回归覆盖（已固化进 smoke）
- 倒排-删除后关键词不再命中、倒排-索引与存储一致
- REST reindex（processed / needs_reindex=false / latency_ms）

### 仍待办
| 优先级 | 问题 | 方向 |
|---|---|---|
| ~~P1~~ ✅ | persistVectors 全量 JSON 覆写 + 并发写可覆盖（O(N²) 悬崖） | **P0 已实现**：`src/core/atomic.mjs` writeFileAtomic（tmp+fsync+rename）；VectorStore.save() 串行合并队列折叠并发写；启动 recoverTmp 清孤儿；persistVectors 吞错+保留 dirty 自愈（scripts/p0-test.mjs A 组 4/4） |
| ~~P1~~ ✅ | 插件与 `npm run serve` 独立服务器共用数据目录双写 | **P0 已实现**：`src/core/lock.mjs` DirLock 单写者锁（wx 原子创建 + pid 判活陈旧接管 + 仅创建者可删）；serve/plugin 双实例 LOCKED 快速失败（p0-test B/D 组） |
| P1 | ~~GUI 记忆列表无分页~~ → 并存后 P3：GUI 真分页（服务端 LIMIT/OFFSET + `GET /api/memory/meta` 去 limit:500 缺陷） | offset 翻页 + distinct 会话接口（并入共存设计 P3） |
| P1 | 隐式注入（turn/start 注入 buildInjection）未接线 | 确认 DSH 注入接口后实现，或降级验收承诺 |
| P2 | triggers 死代码未接线；_plainCache 无上限；prepared statement 未复用 | 接线或删除；LRU 上限；open() 预编译 |

### 第四轮：共存加固 P0（2026-08-25，接第三轮仍待办 + 4 专家共存方案）
| 项 | 落地 |
|---|---|
| ✅ 目录迁移 | `src/core/migrate.mjs` 白名单（config.json/.key/.salt/long_term/short_term）复制→SHA-256→源墓碑 `*.migrated-<ts>`→migration.json；SQLite checkpoint fail-closed（MIGRATION_BUSY）；dryRun/幂等/显式目录守卫；`defaultBaseDir()`→`~/.dsh/memory-manager`（config.mjs legacyBaseDir + 共享目录告警）；启动自动迁移在 `MemoryEngine.create()` 锁内 |
| ✅ 单写者锁 | `src/core/lock.mjs`（.lock wx 创建、pid 判活接管、仅创建者删除、心跳刷新）；create() 先锁后迁移/加载，close()/异常路径统一释放；server LOCKED 快速失败提示 |
| ✅ 原子写 | 见上表 persistVectors 行 |
| ✅ 验证 | `scripts/p0-test.mjs` 30/30（纯临时目录，含 layered 文件不可碰断言 C4、坏库 fail-closed C9、双实例 LOCKED D3） |
| 📄 设计存档 | `docs/coexistence-design.md`（**不提交 git**，供 P1 工具改名 mm_* / P2 事件协调 / P3 GUI 分页对照） |

### 第五轮：共存 P1 工具改名 mm_*（2026-08-25，接共存方案 ①）
| 项 | 落地 |
|---|---|
| ✅ 单一常量源 | `src/tools/names.mjs`：MM_NAMES / LEGACY_NAMES / LEGACY_TO_MM / ALL_MM / ALL_LEGACY |
| ✅ 改名 | `TOOL_DEFS` 7 个工具 `memory_*`→`mm_*`（加 key）；`HANDLERS` 双键（mm_* + memory_*）指向同一实现；`triggers` 触发词改 `mm_*`；REST/GUI 不变（HTTP 路径与工具面解耦） |
| ✅ bareSearch 别名 | `config.compat.bareSearch=true` 时 best-effort 注册旧名 memory_*（被 layered 占用即 try/catch 跳过，绝不致命）；`DEFAULT_CONFIG` 增加 `compat` 段 |
| ✅ 验证 | 集成 **34/34**（原 26 + 7 别名注册 + 1 别名执行，真实 Cordis 装载）；smoke 26/26 · P0 30/30 · verify 7/7 |
| 📝 文档 | contracts/tools.md、TASK-spec/senior、ARCHITECTURE、gui/DESIGN、dsh-research 同步 mm_* |

### 第六轮：共存 P2 事件协调 + P3 GUI 真分页（2026-08-25，接共存方案 ②③）
| 项 | 落地 |
|---|---|
| ✅ P2 事件协调 | `config.hooks.sessionEventSummarize = auto\|on\|off`（默认 auto）：导出 `detectLayeredMemory(ctx, config)`（cordis 注册表含 `dsh-memory`/layered 为权威信号；工具探测 `memory_search` 仅在本插件 bareSearch 关闭时兜底，避免误判自身别名）+ `resolveEventMode`；auto 在场即让位（不短期捕获、不自动摘要）；on 强制接管；off 只关自动摘要。事件钩子按 captureEnabled/summarizeEnabled 门控 |
| ✅ P3 服务端真分页 | `store.page()` SQL LIMIT/OFFSET + 条件过滤 + COUNT（tag 用 `json_each`，node:sqlite 命名参数按语句分离）；`store.meta()` 去重会话/标签；`GET /api/memory/meta`；search 支持 `offset`，召回池封顶 100 |
| ✅ P3 GUI | 记忆浏览 + 搜索结果分页栏（页大小 20/50/100/200，搜索页大小=Top-K，页码窗口±2+省略号）；`refreshFilters` 改用 `/meta` 去 limit:500 抽样缺陷；过滤/删除后页码越界自动回退 |
| ✅ 验证 | 集成 **40/40**（+6 P2：探测命中/auto 让位/on/off/无 layered 全开/事件未写短期）；smoke **30/30**（+4 P3：meta/分页 offset/tag SQL/search offset）；P0 30/30 · verify 7/7 · GUI JS `node --check` 通过 |
| ⚠️ 修复 | ① `store.page` COUNT 传多余命名参数 → where/分页参数分离；② mm_search 输出 schema 缺 `page` → 补 page 字段；③ FakeLayered 缺 `inject:['tools']` 且裸 schema 缺 additionalProperties → 补；④ Context 封闭不可附加属性 → 可观测性走导出函数 |
