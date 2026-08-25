# dsh-memory-manager · DSH ctx.tools 集成验证报告

- 生成时间：2026-08-25T02:21:04.973Z
- 数据目录：`C:\Users\50251\AppData\Local\Temp\dsh-mem-verify-xVMYCI`
- 结论：**26/26 项通过**

| 检查项 | 结果 | 说明 |
|--------|------|------|
| register memory_add | ✅ | def={"name":"memory_add"} |
| register memory_search | ✅ | def={"name":"memory_search"} |
| register memory_get_recent | ✅ | def={"name":"memory_get_recent"} |
| register memory_summarize | ✅ | def={"name":"memory_summarize"} |
| register memory_delete | ✅ | def={"name":"memory_delete"} |
| register memory_update_importance | ✅ | def={"name":"memory_update_importance"} |
| register memory_stats | ✅ | def={"name":"memory_stats"} |
| schemas 覆盖 7 工具 | ✅ | schemas=["memory_add","memory_search","memory_get_recent","memory_summarize","memory_delete","memory_update_importance","memory_stats"] |
| execute memory_add 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"已保存记忆（id=b4ec0104-da8c-4d15-83ce-eecfb5792150，嵌入=degraded，token=20）\n内容：我喜欢用 Python 做数据分析 |
| memory_add value 有 memory_id | ✅ |  |
| memory_add 渲染含中文 | ✅ |  |
| execute memory_search 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"检索「我平时用什么语言做数据分析」共 1 条，耗时 2ms：\n1. [47.4%] 我喜欢用 Python 做数据分析，常用 pandas 和 matplotlib。"}]," |
| memory_search 召回新增记忆 | ✅ | hit={"id":"b4ec0104-da8c-4d15-83ce-eecfb5792150","content":"我喜欢用 Python 做数据分析，常用 pandas 和 matplotlib。","score":0.4743,"session_id":"sess-A", |
| execute memory_get_recent 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"最近对话（2 条 / 30 tokens）：\n用户：帮我看看这个数据集的缺失值怎么处理\n助手：可以用 dropna 或 fillna 处理缺失值"}],"value":{"m |
| 会话事件钩子写入短期记忆 | ✅ |  |
| execute memory_summarize 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"对话摘要：用户偏好使用 Python 做数据分析，工具链为 pandas 与 matplotlib。\n（已存为长期记忆 id=3ac7551d-e09c-4a15-8552-e |
| memory_summarize 经 LLM 生成 | ✅ | summary="用户偏好使用 Python 做数据分析，工具链为 pandas 与 matplotlib。" |
| memory_delete 空目标被守卫拦截 | ✅ | {"isError":true,"error":{"message":"缺少删除目标：请提供 ids 或 conditions"},"content":[{"type":"text","text":"Error: 缺少删除目标：请提供 ids 或 conditions"}]} |
| execute memory_delete 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"已删除 2 条记忆（会话：sess-A，释放 48 tokens）"}],"value":{"deleted_count":2,"affected_sessions":["ses |
| memory_delete 清理指定记忆 | ✅ | deleted={"deleted_count":2,"affected_sessions":["sess-A"],"freed_tokens":48} |
| execute memory_stats 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"记忆库统计：总数 2（长期 0 / 短期 30 tokens），占用 0.16MB，嵌入 degraded"}],"value":{"total_memories":2,"sho |
| memory_stats 字段完整 | ✅ |  |
| execute memory_update_importance 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"已更新记忆 00c5a035-0cc4-486f-99e8-c6a479f3482c 的重要性：5 → 9"}],"value":{"memory_id":"00c5a035-0 |
| memory_update_importance 更新生效 | ✅ |  |
| webServer 注册 /api/memory 前缀路由 | ✅ |  |
| webServer 注册 /memory-manager GUI 托管路由 | ✅ |  |

> 验证方式：真实 Cordis Context + 真实 @deepseek-ai/dsh-tools ToolRuntime 装载插件；桩仅用于非目标服务缝（systemPrompt/webServer/sessions/llm）。