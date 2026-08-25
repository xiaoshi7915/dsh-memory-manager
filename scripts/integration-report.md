# dsh-memory-manager · DSH ctx.tools 集成验证报告

- 生成时间：2026-08-25T20:49:26.267Z
- 数据目录：`C:\Users\50251\AppData\Local\Temp\dsh-mem-verify-ExGJd7`
- 结论：**40/40 项通过**

| 检查项 | 结果 | 说明 |
|--------|------|------|
| register mm_add | ✅ | def={"name":"mm_add"} |
| register mm_search | ✅ | def={"name":"mm_search"} |
| register mm_get_recent | ✅ | def={"name":"mm_get_recent"} |
| register mm_summarize | ✅ | def={"name":"mm_summarize"} |
| register mm_delete | ✅ | def={"name":"mm_delete"} |
| register mm_update_importance | ✅ | def={"name":"mm_update_importance"} |
| register mm_stats | ✅ | def={"name":"mm_stats"} |
| schemas 覆盖 7 工具(mm_*) | ✅ | schemas=["mm_add","mm_search","mm_get_recent","mm_summarize","mm_delete","mm_update_importance","mm_stats","memory_add","memory_search","mem |
| bare 别名 register memory_add | ✅ | def={"name":"memory_add"} |
| bare 别名 register memory_search | ✅ | def={"name":"memory_search"} |
| bare 别名 register memory_get_recent | ✅ | def={"name":"memory_get_recent"} |
| bare 别名 register memory_summarize | ✅ | def={"name":"memory_summarize"} |
| bare 别名 register memory_delete | ✅ | def={"name":"memory_delete"} |
| bare 别名 register memory_update_importance | ✅ | def={"name":"memory_update_importance"} |
| bare 别名 register memory_stats | ✅ | def={"name":"memory_stats"} |
| execute mm_add 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"已保存记忆（id=ae24681a-4b3d-4854-b90f-2e8bcbe79993，嵌入=degraded，token=20）\n内容：我喜欢用 Python 做数据分析 |
| mm_add value 有 memory_id | ✅ |  |
| mm_add 渲染含中文 | ✅ |  |
| execute mm_search 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"检索「我平时用什么语言做数据分析」共 1 条，耗时 2ms：\n1. [47.4%] 我喜欢用 Python 做数据分析，常用 pandas 和 matplotlib。"}]," |
| mm_search 召回新增记忆 | ✅ | hit={"id":"ae24681a-4b3d-4854-b90f-2e8bcbe79993","content":"我喜欢用 Python 做数据分析，常用 pandas 和 matplotlib。","score":0.4743,"session_id":"sess-A", |
| bare 别名 memory_search 可执行 | ✅ | {"isError":false,"content":[{"type":"text","text":"检索「我平时用什么语言做数据分析」共 1 条，耗时 2ms：\n1. [47.4%] 我喜欢用 Python 做数据分析，常用 pandas 和 matplotlib。"}]," |
| execute mm_get_recent 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"最近对话（2 条 / 30 tokens）：\n用户：帮我看看这个数据集的缺失值怎么处理\n助手：可以用 dropna 或 fillna 处理缺失值"}],"value":{"m |
| 会话事件钩子写入短期记忆 | ✅ |  |
| execute mm_summarize 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"对话摘要：用户偏好使用 Python 做数据分析，工具链为 pandas 与 matplotlib。\n（已存为长期记忆 id=54ef5233-bb2f-45e6-ad6c-2 |
| mm_summarize 经 LLM 生成 | ✅ | summary="用户偏好使用 Python 做数据分析，工具链为 pandas 与 matplotlib。" |
| mm_delete 空目标被守卫拦截 | ✅ | {"isError":true,"error":{"message":"缺少删除目标：请提供 ids 或 conditions"},"content":[{"type":"text","text":"Error: 缺少删除目标：请提供 ids 或 conditions"}]} |
| execute mm_delete 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"已删除 2 条记忆（会话：sess-A，释放 48 tokens）"}],"value":{"deleted_count":2,"affected_sessions":["ses |
| mm_delete 清理指定记忆 | ✅ | deleted={"deleted_count":2,"affected_sessions":["sess-A"],"freed_tokens":48} |
| execute mm_stats 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"记忆库统计：总数 2（长期 0 / 短期 30 tokens），占用 0.16MB，嵌入 degraded"}],"value":{"total_memories":2,"sho |
| mm_stats 字段完整 | ✅ |  |
| execute mm_update_importance 成功 | ✅ | {"isError":false,"content":[{"type":"text","text":"已更新记忆 cd9c6f1c-f5ec-4c4f-a18a-27701928cd32 的重要性：5 → 9"}],"value":{"memory_id":"cd9c6f1c-f |
| mm_update_importance 更新生效 | ✅ |  |
| webServer 注册 /api/memory 前缀路由 | ✅ |  |
| webServer 注册 /memory-manager GUI 托管路由 | ✅ |  |
| P2 layered 探测命中 | ✅ | {"mode":"auto","layered":true,"captureEnabled":false,"summarizeEnabled":false,"reason":"yield-to-layered"} |
| P2 auto 让位：短期捕获/自动摘要关闭 | ✅ | {"mode":"auto","layered":true,"captureEnabled":false,"summarizeEnabled":false,"reason":"yield-to-layered"} |
| P2 on 强制接管（无视 layered） | ✅ |  |
| P2 off 仅关自动摘要（保留短期捕获） | ✅ |  |
| P2 无 layered 时 auto 全开（bareSearch=true 不误判自身别名） | ✅ |  |
| P2 让位生效：事件未写短期 | ✅ | messages=[] |

> 验证方式：真实 Cordis Context + 真实 @deepseek-ai/dsh-tools ToolRuntime 装载插件；桩仅用于非目标服务缝（systemPrompt/webServer/sessions/llm）。