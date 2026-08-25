# 任务书：后端架构师（阶段 2-A）

角色：后端架构师。完整需求见 `TASK-spec.md`，设计依据见 `ARCHITECTURE.md`、`contracts/tools.md`、`contracts/web-api.md`、`PLAN.md`、`dsh-research.md`（都在本目录，先全部读完再动手）。

## 你的范围（只写这些文件，其他一律不碰）
- `core/**` — 记忆引擎全部实现
- `server/**` — Web API 路由实现（按 contracts/web-api.md）
- `core/**` 对应的单元测试（Node 内置 node:test）
- `scripts/seed-2000.mjs`、`scripts/verify.mjs`、`scripts/verify-report.md`（由 verify.mjs 生成）

禁止触碰：插件入口 index、tools/**、gui/**、contracts/**、PLAN.md、ARCHITECTURE.md。

## 必须实现（core/**）
1. **短期记忆**：`short_term/{session_id}.jsonl` 按行追加；滑动窗口同时受 max_messages 与 max_tokens 约束（token 估算方法按 ARCHITECTURE.md）；提供 getRecent(sessionId, n) 返回 {messages, token_count, window_size, truncated}。
2. **长期存储**：SQLite（方案按 ARCHITECTURE.md 选型，注意 Node 版本兼容性；若最终用纯 JS 替代需在 README 说明偏差）。memories 表至少含 id/content/tags/importance/is_global/session_id/created_at/last_accessed_at/ttl/source(tokens 占用)。
3. **向量库**：纯 JS 余弦相似度；vector.index 文件格式按 ARCHITECTURE.md 定义；向量缓存分片存 long_term/embeddings/；2000 条 Top-5 必须 <300ms（暴力检索足够，加缓存即可）。
4. **嵌入 provider**：默认 local（按选型）；必须实现离线确定性降级嵌入（无网/未下载模型时自动启用，embedding_status 返回 "degraded"），保证验收 2 的同义查询相似度 >0.85；openai 等外部 provider 接口（API Key 从配置读，缺省时明确报 EMBEDDING_UNAVAILABLE 并允许降级关键词检索）。
5. **混合检索**：纯向量与"关键词+向量"加权融合（权重与归一化按设计文档），支持 Top-K 与 similarity_threshold 过滤；返回 latency_ms。
6. **摘要**：本地抽取式摘要（句频+位置加权）；若 dsh-research.md 发现 DSH 有 LLM API 则提供生成式可选实现。memory_summarize 输出 {summary, memory_id, compressed_from, saved_tokens}。
7. **生命周期**：TTL 过期、按条件批量删除、自动清理（存储超 max_storage_mb 时按 LRU + 低重要性优先）、记录 last_compacted。
8. **加密**：AES-256-GCM + scrypt/PBKDF2 从主密码派生（方案细节按设计文档）；未设主密码的降级行为要可预期并写入 README。
9. **导入导出**：JSON/JSONL 备份（含元数据与嵌入状态说明）与恢复（校验、冲突策略：按 id 去重/合并，返回导入统计）。
10. **统计**：memory_stats 所需全部字段（含 storage_size_mb、last_compacted）。

## 必须实现（server/**）
按 contracts/web-api.md 实现全部 REST 端点（Node 内置 http 即可，零依赖优先），统一错误响应格式 {error: {code, message}}。

## 验收自证（必须跑通并留痕）
- `scripts/seed-2000.mjs`：生成 2000 条真实感中文样例记忆入库。
- `scripts/verify.mjs`：自动跑三条验收场景——
  1. 20 轮对话模拟后 get_recent 注入延迟（多次采样取平均，目标 <100ms）
  2. 跨会话召回："记住我喜欢用 Python 做数据分析" → 新会话查询"我喜欢用什么语言做数据分析"，报告该记忆得分（目标 >0.85）
  3. 2000 条规模 Top-5 检索 20 次取平均延迟（目标 <300ms）
  结果写入 `scripts/verify-report.md`（达标/未达标、实测数字、环境信息）。
- 单元测试覆盖：窗口裁剪、混合检索融合、加密往返、导入导出、清理策略。

## 约束与汇报
- 优先零原生依赖；如必须 npm install，记录命令与结果；离线必须可用。
- 用户可见错误信息用中文；代码标识符英文。
- 最终回复 <25 行摘要：实现清单、依赖情况、verify-report 三条验收的实测数字、遗留问题。
