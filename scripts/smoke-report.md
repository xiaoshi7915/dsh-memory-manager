# dsh-memory-manager 冒烟测试报告

- 数据目录：`C:\Users\50251\Desktop\UAP\模型能力调研\dsh-memory-manager\test-data\smoke-1787641386789`
- 生成时间：2026-08-25T07:03:07.103Z
- 结论：**26/26 项通过**

| 检查项 | 结果 | 说明 |
|--------|------|------|
| memory_add | ✅ | {"success":true,"memory_id":"f8ebd727-bac0-413e-bee4-2d8be52c93f8","embedding_status":"degraded","token_cost":8} |
| memory_add(global) | ✅ | {"success":true,"memory_id":"bc75880e-6965-4e52-ae01-3b1502ed3e15","embedding_status":"degraded","token_cost":11} |
| memory_search | ✅ | results=1 top=我的宠物猫叫咪咪 score=0.4227 latency=9ms |
| memory_get_recent | ✅ | {"messages":[{"role":"user","content":"我们讨论一下周末去哪玩"}],"token_count":11,"window_size":1,"truncated":false} |
| memory_summarize | ✅ | {"summary":"用户：我们讨论一下周末去哪玩","memory_id":"89acc751-c9ab-481e-9b54-6fc63f19885e","compressed_from":1,"saved_tokens":0,"via":"extractive"} |
| memory_update_importance | ✅ | {"memory_id":"f8ebd727-bac0-413e-bee4-2d8be52c93f8","old_score":8,"new_score":10} |
| memory_delete | ✅ | {"deleted_count":1,"affected_sessions":["smoke-sess"],"freed_tokens":8} |
| 倒排-删除后关键词不再命中 | ✅ | total=0 |
| 倒排-索引与存储一致 | ✅ | inverted=2 store=2 |
| memory_stats | ✅ | {"total_memories":3,"short_term_tokens":11,"long_term_count":2,"storage_size_mb":0.17,"last_compacted":null,"embedding_model":"local","embedding_status":"degraded","needs_reindex":false} |
| 触发词-记住 | ✅ | {"tool":"memory_add","args":{"content":"我的生日是 5 月 20 号"},"matched":"帮我记住我的生日是 5 月 20 号"} |
| 触发词-检索 | ✅ | {"tool":"memory_search","args":{"query":"我喜欢喝茶"},"matched":"我之前说过我喜欢喝茶"} |
| 触发词-总结 | ✅ | {"tool":"memory_summarize","args":{},"matched":"总结一下我们的对话"} |
| 触发词-打开面板 | ✅ | {"tool":"__open_panel__","args":{},"matched":"查看我的记忆"} |
| 触发词-删除 | ✅ | {"tool":"memory_delete","args":{"conditions":{"tag":"工作"}},"matched":"删除关于"} |
| 触发词-上下文 | ✅ | {"tool":"memory_get_recent","args":{},"matched":"这次对话的上下文"} |
| REST healthz | ✅ | {"ok":true,"version":"1.0.0","embedding_status":"hash"} |
| REST stats | ✅ | {"total_memories":3,"short_term_tokens":11,"long_term_count":2,"storage_size_mb":0.17,"last_compacted":null,"embedding_model":"local","embedding_status":"degraded","needs_reindex":false} |
| REST list | ✅ | total=2 |
| REST search(cross-session global) | ✅ | top=我喜欢用 Python 做数据分析 score=0.8908 |
| REST recent | ✅ | messages=1 |
| REST config | ✅ | {"max_messages":20} |
| REST export | ✅ | bytes=889 |
| REST import | ✅ | {"imported":0,"skipped":2,"failed":0} |
| REST cleanup | ✅ | {"expired":0,"evicted":0,"last_compacted":null} |
| REST reindex | ✅ | {"processed":2,"model":"hash:512","needs_reindex":false,"latency_ms":9} |