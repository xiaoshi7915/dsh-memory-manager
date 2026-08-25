# dsh-memory-manager 冒烟测试报告

- 数据目录：`C:\Users\50251\Desktop\UAP\模型能力调研\dsh-memory-manager\test-data\smoke-1787685233992`
- 生成时间：2026-08-25T19:13:54.478Z
- 结论：**30/30 项通过**

| 检查项 | 结果 | 说明 |
|--------|------|------|
| mm_add | ✅ | {"success":true,"memory_id":"a645caea-a279-44d9-a371-c8f03e80fadf","embedding_status":"degraded","token_cost":8} |
| mm_add(global) | ✅ | {"success":true,"memory_id":"8d265fba-3cca-4a6e-8705-6a49e97daff1","embedding_status":"degraded","token_cost":11} |
| mm_search | ✅ | results=1 top=我的宠物猫叫咪咪 score=0.4227 latency=5ms |
| mm_get_recent | ✅ | {"messages":[{"role":"user","content":"我们讨论一下周末去哪玩"}],"token_count":11,"window_size":1,"truncated":false} |
| mm_summarize | ✅ | {"summary":"用户：我们讨论一下周末去哪玩","memory_id":"e35f0c29-6b5c-44e1-be82-49af9c594f1e","compressed_from":1,"saved_tokens":0,"via":"extractive"} |
| mm_update_importance | ✅ | {"memory_id":"a645caea-a279-44d9-a371-c8f03e80fadf","old_score":8,"new_score":10} |
| mm_delete | ✅ | {"deleted_count":1,"affected_sessions":["smoke-sess"],"freed_tokens":8} |
| 倒排-删除后关键词不再命中 | ✅ | total=0 |
| 倒排-索引与存储一致 | ✅ | inverted=2 store=2 |
| mm_stats | ✅ | {"total_memories":3,"short_term_tokens":11,"long_term_count":2,"storage_size_mb":0.17,"last_compacted":null,"embedding_model":"local","embedding_status":"degraded","needs_reindex":false} |
| 触发词-记住 | ✅ | {"tool":"mm_add","args":{"content":"我的生日是 5 月 20 号"},"matched":"帮我记住我的生日是 5 月 20 号"} |
| 触发词-检索 | ✅ | {"tool":"mm_search","args":{"query":"我喜欢喝茶"},"matched":"我之前说过我喜欢喝茶"} |
| 触发词-总结 | ✅ | {"tool":"mm_summarize","args":{},"matched":"总结一下我们的对话"} |
| 触发词-打开面板 | ✅ | {"tool":"__open_panel__","args":{},"matched":"查看我的记忆"} |
| 触发词-删除 | ✅ | {"tool":"mm_delete","args":{"conditions":{"tag":"工作"}},"matched":"删除关于"} |
| 触发词-上下文 | ✅ | {"tool":"mm_get_recent","args":{},"matched":"这次对话的上下文"} |
| REST healthz | ✅ | {"ok":true,"version":"1.0.0","embedding_status":"hash"} |
| REST stats | ✅ | {"total_memories":3,"short_term_tokens":11,"long_term_count":2,"storage_size_mb":0.17,"last_compacted":null,"embedding_model":"local","embedding_status":"degraded","needs_reindex":false} |
| REST list | ✅ | total=2 |
| REST meta 会话/标签去重 | ✅ | sessions=1 tags=2 total=2 |
| REST 分页 offset 生效 | ✅ | pg0=e35f0c29-6b5c-44e1-be82-49af9c594f1e pg1=8d265fba-3cca-4a6e-8705-6a49e97daff1 total=2 |
| REST 分页 tag 过滤(SQL) | ✅ | tag=摘要 total=1 expect=1 |
| REST search offset 分页 | ✅ | total=1 top=8d265fba-3cca-4a6e-8705-6a49e97daff1 vs (空) |
| REST search(cross-session global) | ✅ | top=我喜欢用 Python 做数据分析 score=0.8908 |
| REST recent | ✅ | messages=1 |
| REST config | ✅ | {"max_messages":20} |
| REST export | ✅ | bytes=889 |
| REST import | ✅ | {"imported":0,"skipped":2,"failed":0} |
| REST cleanup | ✅ | {"expired":0,"evicted":0,"last_compacted":null} |
| REST reindex | ✅ | {"processed":2,"model":"hash:512","needs_reindex":false,"latency_ms":5} |