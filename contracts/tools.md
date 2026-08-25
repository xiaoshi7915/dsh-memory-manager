# contracts/tools.md — 7 个 Agent 工具契约

> 所有工具返回值为 JSON 对象；出错时返回 `{"error": {"code": string, "message": string}}`。
> `ctx`（引擎上下文）携带 `sessionId`（当前会话 ID）与 `engine`（MemoryEngine）。DSH 适配层经 `exec.agent.session.id` 注入 sessionId。

## 错误码表
| code | HTTP 场景 | 含义 |
|---|---|---|
| VALIDATION_ERROR | 400 | 入参非法（缺必填/类型错/越界） |
| NOT_FOUND | 404 | 指定记忆不存在 |
| EMBEDDING_UNAVAILABLE | 503 | 嵌入不可用且无关键词降级路径（罕见） |
| STORAGE_LIMIT | 507 | 存储超限且清理后仍不足 |
| DECRYPTION_FAILED | 500 | 密钥缺失或内容解密失败（需重配主密码） |
| INTERNAL | 500 | 其他内部错误 |

---

## 1. memory_add
向长期记忆库添加一条结构化记忆。
- 参数（object）：
  - `content`（string, required）：记忆内容
  - `tags`（array<string>, optional）：标签
  - `importance`（number, optional, 1..10，默认 5）：重要性
  - `is_global`（boolean, optional，默认 false）：是否全局记忆（跨会话可见）
- 返回（object）：
  ```json
  {"success": true, "memory_id": "<uuid>", "embedding_status": "completed|degraded", "token_cost": 12}
  ```
- 备注：`embedding_status` = 'completed'（真实模型）或 'degraded'（离线哈希嵌入）。

## 2. memory_search
基于查询文本检索最相关的 K 条记忆。
- 参数：`query`（string, required）；`top_k`（number, optional，默认 config.long_term.retrieval_top_k=5）；`threshold`（number, optional，默认 config.long_term.similarity_threshold=0.75）；`session_id`（string, optional，缺省用当前会话）；`include_global`（boolean, optional，默认 true）
- 返回：
  ```json
  {"results": [{"id": "<uuid>", "content": "...", "score": 0.92, "session_id": "...", "timestamp": "<ISO>", "is_global": false}], "total": 5, "latency_ms": 45}
  ```

## 3. memory_get_recent
获取当前会话最近 N 轮的短期记忆上下文。
- 参数：`n`（number, optional，默认窗口消息数上限）；`session_id`（string, optional，缺省当前会话）
- 返回：
  ```json
  {"messages": [{"role": "user", "content": "..."}], "token_count": 2048, "window_size": 10, "truncated": false}
  ```
- `truncated=true` 表示因 token 预算被裁剪。

## 4. memory_summarize
对指定对话区间生成摘要并存储为长期记忆。
- 参数：`session_id`（string, optional，缺省当前会话）；`count`（number, optional，取最近 count 条消息，缺省取整个窗口）；`content`（string, optional，显式提供文本则跳过窗口读取，直接摘要该文本）
- 返回：
  ```json
  {"summary": "用户偏好使用Python进行数据分析...", "memory_id": "<uuid>", "compressed_from": 24, "saved_tokens": 1800}
  ```

## 5. memory_delete
按 ID 删除单条记忆，或按条件批量删除。
- 参数（满足其一）：`ids`（array<string>, optional）；或 `conditions`（object, optional）：`{session_id?, tag?, is_global?, older_than?, importance_le?}`
- 返回：
  ```json
  {"deleted_count": 3, "affected_sessions": ["sess_1"], "freed_tokens": 450}
  ```
- 隔离：未指定 conditions 时只删当前会话（`session_id` 缺省=当前会话，`ids` 模式下仅允许删属于当前会话的记忆，除非传 `all_sessions: true`）。

## 6. memory_update_importance
修改指定记忆的重要性评分（1-10）。
- 参数：`memory_id`（string, required）；`score`（number, required, 1..10）
- 返回：
  ```json
  {"memory_id": "<uuid>", "old_score": 5, "new_score": 9}
  ```

## 7. memory_stats
获取当前记忆库的整体统计。
- 参数：无
- 返回：
  ```json
  {"total_memories": 150, "short_term_tokens": 2048, "long_term_count": 142, "storage_size_mb": 12.5, "last_compacted": "<ISO|null>", "embedding_model": "local", "embedding_status": "completed|degraded", "needs_reindex": false}
  ```
