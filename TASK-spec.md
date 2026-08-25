# dsh-memory-manager 插件 — 完整需求规格（SPEC）

> 本文件是 5 人专家协作流水线的唯一需求来源。所有专家任务均引用本文件，不得偏离。

## 0. 环境与约束
- 主机：Windows（路径反斜杠）。文件写入仅限会话工作区 `C:\Users\50251\Desktop\UAP\模型能力调研`。
- 插件项目根目录：`C:\Users\50251\Desktop\UAP\模型能力调研\dsh-memory-manager`（本文件所在目录）。
- DSH 参考检出（只读调研用）：`C:\Users\50251\deepseek-harness\`。
- Node.js 可用（先 `node -v` 确认版本）；npm/网络可能受限，优先零原生依赖、可降级方案。
- 用户可见文案一律中文；代码标识符英文。

## 1. 定位
为 AI Agent 提供短期记忆缓存、长期知识沉淀、语义检索与持久化存储的统一记忆管理层，让 Agent 在多轮对话中保持上下文连贯，并能跨会话积累用户偏好与领域知识。

## 2. 核心功能
1. **短期记忆管理**：维护当前会话最近 N 轮对话，支持按 token 数或消息数自动滑动窗口裁剪。
2. **长期记忆存储**：将用户明确标记"记住"的信息、自动提取的关键事实、对话摘要持久化到本地向量库。
3. **语义记忆检索**：基于查询文本的语义相似度检索相关历史记忆，支持纯向量检索与"关键词 + 向量"混合检索。
4. **智能记忆总结**：对超长对话自动提取摘要，压缩为长期记忆以节省上下文窗口。
5. **记忆生命周期管理**：支持按时间衰减（TTL）、重要性评分、手动删除、批量清理等方式遗忘旧记忆。
6. **多会话隔离与共享**：默认会话间记忆隔离；支持将特定记忆标记为"全局记忆"（is_global），供所有会话检索。
7. **记忆导入导出**：支持将记忆库备份为 JSON/JSONL，或从备份文件恢复，便于迁移与审计。

## 3. Agent 工具（7 个，须向 Agent 暴露）
| 工具名 | 功能 | 期望返回 |
|---|---|---|
| memory_add | 向长期记忆库添加一条结构化记忆（内容 + 可选标签 + 重要性 1-10 + 可选 is_global） | `{"success": true, "memory_id": "uuid", "embedding_status": "completed", "token_cost": 12}` |
| memory_search | 基于查询文本检索最相关的 K 条记忆 | `{"results": [{"id": "uuid", "content": "...", "score": 0.92, "session_id": "...", "timestamp": "...", "is_global": false}], "total": 5, "latency_ms": 45}` |
| memory_get_recent | 获取当前会话最近 N 轮的短期记忆上下文 | `{"messages": [{"role": "user", "content": "..."}], "token_count": 2048, "window_size": 10, "truncated": false}` |
| memory_summarize | 对指定对话区间生成摘要并存储为长期记忆 | `{"summary": "用户偏好使用Python进行数据分析...", "memory_id": "uuid", "compressed_from": 24, "saved_tokens": 1800}` |
| memory_delete | 按 ID 删除单条记忆，或按条件批量删除 | `{"deleted_count": 3, "affected_sessions": ["sess_1"], "freed_tokens": 450}` |
| memory_update_importance | 修改指定记忆的重要性评分（1-10） | `{"memory_id": "uuid", "old_score": 5, "new_score": 9}` |
| memory_stats | 获取当前记忆库的整体统计信息 | `{"total_memories": 150, "short_term_tokens": 2048, "long_term_count": 142, "storage_size_mb": 12.5, "last_compacted": "..."}` |

## 4. Web 界面（GUI 侧边栏）
- **侧边栏入口**：图标 "🧠"，标题"记忆管理"。
- **记忆浏览器面板**：时间线视图展示所有记忆（支持按会话/全局/标签筛选）；每条记忆显示摘要、相似度评分、创建时间、所属会话；支持点击展开查看完整内容。
- **记忆检索面板**：顶部搜索框，输入后实时语义检索；结果列表展示相关记忆及相似度分数。
- **配置页**：短期记忆窗口大小（消息数 / token 数）、自动总结触发阈值（超过 N 轮自动摘要）、检索返回数量 Top-K 与相似度阈值、存储上限与自动清理策略、嵌入模型选择。
- **导入导出工具**：上传 JSON/JSONL 恢复记忆；下载当前记忆库备份。

## 5. 数据与配置
数据存储位置：默认 `~/.dsh/memory/` 目录：
- `short_term/{session_id}.jsonl` — 各会话的近期对话（按行存储）
- `long_term/memories.db` — SQLite 数据库存储记忆元数据
- `long_term/vector.index` — 本地向量索引（FAISS 或 HNSW）
- `long_term/embeddings/` — 向量缓存分片
- `config.json` — 配置，默认值：
  - `short_term.max_messages`: 20
  - `short_term.max_tokens`: 4000
  - `long_term.auto_summarize_threshold`: 10
  - `long_term.retrieval_top_k`: 5
  - `long_term.similarity_threshold`: 0.75
  - `long_term.embedding_model`: "local"（轻量本地模型，可选 "openai" 等）
  - `storage.max_storage_mb`: 500
  - `storage.encryption_enabled`: true（AES-256 本地加密，密钥派生自用户主密码）
  - `global_memory.enabled`: true

## 6. 触发场景
| 用户话语 | 触发动作 |
|---|---|
| "帮我记住..." / "记住这个..." / "记一下..." | 调用 memory_add |
| "我之前说过..." / "关于...你还记得吗" / "我以前提过" | 调用 memory_search |
| "总结一下我们的对话" / "把刚才的内容存起来" | 调用 memory_summarize |
| "查看我的记忆" / "打开记忆管理" / "记忆面板" | 打开 Web 界面侧边栏 |
| "删除关于...的记忆" / "忘掉..." / "清空记忆" | 调用 memory_delete |
| "这次对话的上下文" / "我们刚才聊到哪了" | 调用 memory_get_recent |
| 隐式触发：每次 Agent 生成回复前 | 自动调用 memory_get_recent + memory_search 注入相关记忆 |

## 7. 权限与限制
- **仅本机使用**：所有记忆数据默认存储在本地磁盘，不上传任何云端服务。
- **需先配置嵌入模型**：首次安装后需下载本地嵌入模型（约 50-100MB）或配置外部 API Key，否则语义检索不可用（应降级为关键词检索并明确提示）。
- **涉及敏感数据**：长期记忆可能包含用户隐私信息，默认启用 AES-256 本地加密，密钥派生自用户主密码。
- **存储限制**：默认上限 500MB，超出后按 LRU + 低重要性优先策略自动清理。
- **多会话隔离**：默认记忆不跨会话共享，需显式 is_global: true 才可在其他会话检索到。
- **兼容性**：嵌入模型变更后需重建向量索引，插件应自动检测并提示重建。

## 8. 验收标准
1. **短期记忆保持**：连续进行 20 轮对话后，Agent 能准确引用第 3 轮对话中的关键信息（如用户提到的具体项目名称），且上下文注入延迟 < 100ms。
2. **长期记忆持久化**：用户说"记住我喜欢用 Python 做数据分析"，关闭会话并等待 1 小时后重新打开新会话，用户问"我喜欢用什么语言做数据分析"，Agent 能正确回答"Python"，且检索该记忆的相似度评分 > 0.85。
3. **检索性能**：在本地存储 2000 条记忆的场景下，执行任意语义检索返回 Top-5 结果的平均响应时间 < 300ms，且首条结果与用户查询的语义相关性经人工判断为"直接相关"的比例 ≥ 90%。
