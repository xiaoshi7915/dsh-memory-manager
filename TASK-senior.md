# 任务书：高级开发者（阶段 2-B）

角色：高级开发者。完整需求见 `TASK-spec.md`，设计依据见 `ARCHITECTURE.md`、`contracts/tools.md`、`contracts/web-api.md`、`PLAN.md`、`dsh-research.md`（先全部读完再动手）。记忆引擎（core/**）由后端架构师并行实现，你只做接线层——调用 core 的公开 API，不实现业务逻辑。

## 你的范围（只写这些文件，其他一律不碰）
- 插件入口（index/main，按 PLAN.md 中 DSH 约定命名）
- `tools/**` — 7 个 Agent 工具的注册与 handler
- `triggers/**`（或在 tools/ 下）— 触发词检测
- config 引导模块（config.json 默认值/校验/读写）
- Web 服务挂载（启动 server/**，端口与路径按 contracts/web-api.md）
- `scripts/smoke.mjs` + `scripts/smoke-report.md`（冒烟报告由脚本生成）

禁止触碰：core/** 内部实现（只 import 其公开 API）、gui/** 面板、contracts/**、ARCHITECTURE.md、PLAN.md。若发现 core 公开 API 与设计文档不符，在汇报中列出，不要擅自改 core。

## 必须实现
1. **7 个工具注册**：memory_add / memory_search / memory_get_recent / memory_summarize / memory_delete / memory_update_importance / memory_stats。注册方式与参数 schema 严格按 DSH 约定（dsh-research.md 的证据）与 contracts/tools.md。handler 为薄层：入参校验 → 调 core → 映射为契约规定返回结构；错误统一映射为错误码（EMBEDDING_UNAVAILABLE/NOT_FOUND/VALIDATION_ERROR/STORAGE_LIMIT 等），错误信息中文。
2. **触发词检测**：按 TASK-spec.md 第 6 节的 6 组中文话语模式（记住…/我之前说过…/总结一下…/查看我的记忆…/删除关于…或忘掉…/这次对话的上下文…）实现模式匹配（正则列表，覆盖"帮我记住X"、"记一下：X"等变体，能抽出 X 作为参数）；输出结构化的 {tool, args, matched_phrase} 建议；"打开记忆面板"类触发输出打开 GUI 的动作信号。
3. **隐式注入**：若 dsh-research.md 确认 DSH 有"生成回复前"钩子，则按该钩子注册：每次回复前自动 memory_get_recent + memory_search（以当前用户输入为查询），把相关记忆拼成注入块（格式：【相关记忆】…，控制总 token 预算 ≤ 配置值）；若无钩子，提供独立的 `injectContext(sessionId, userInput)` API 并在 README 写清集成方式。
4. **config 引导**：首次运行生成 ~/.dsh/memory/config.json（TASK-spec.md 第 5 节全部默认值）；校验非法值并回落默认；支持读取时合并默认值；**嵌入模型变更检测**：记录当前 embedding_model 指纹（模型名+版本），与向量索引元数据不一致时设置"需重建索引"标志并暴露给 memory_stats 与 Web API。
5. **会话上下文**：工具调用时按 dsh-research.md 确认的方式获取 session_id；get_recent/自动摘要等会话级操作以此为准。
6. **自动摘要触发**：会话轮次超过 long_term.auto_summarize_threshold 时调用 core 摘要（若 DSH 钩子可用则在钩子里判断；否则提供 API）。
7. **Web 服务挂载**：按 web-api.md 启动 HTTP 服务（默认端口按设计文档，可配置），健康检查端点 /healthz。
8. **冒烟测试** `scripts/smoke.mjs`：在临时数据目录依次调用全部 7 个工具 handler（add→search→recent→summarize→update_importance→stats→delete），断言返回结构符合契约，输出 `scripts/smoke-report.md`（每步的入参/出参/通过与否）。跑通它作为你的完成门槛。

## 约束与汇报
- 零原生依赖优先；错误信息中文；代码标识符英文。
- 最终回复 <25 行摘要：实现清单、工具注册方式、触发词规则数、冒烟结果（7/7?）、core API 不符之处、遗留问题。
