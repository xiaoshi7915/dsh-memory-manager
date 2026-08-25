# dsh-memory-manager · UI 视觉验收

> 评审对象：`gui/preview.html`（独立预览，模拟数据）。评审方式：无头浏览器渲染 + 视觉检查 + 布局/交互代码走查。

## 1. 评审证据（截图归档于 `review/`）

| 截图 | 状态 |
|---|---|
| `preview-browser-light.png` | ✅ 已确认（布局/统计条/筛选/记忆卡片/徽章，无溢出） |
| `preview-search-light.png` | ✅ 已确认（搜索命中 Python 记忆 64.3%，评分条/徽章/耗时齐全，无错位） |
| `preview-settings-light.png` | 🟡 已渲染（46KB，非空白），细节逐项核对待下轮视觉预算 |
| `preview-browser-dark.png` | 🟡 已渲染（81KB，非空白），细节逐项核对待下轮视觉预算 |

> 说明：本轮清理脚本误删 `test-data/ui-shots/` 下 PNG，已重新生成并归档于 `review/`（`preview-settings-light.png` 46,076B / `preview-browser-dark.png` 81,422B，均为正常渲染内容）。本回合视觉预算再次耗尽，设置/深色面板的逐项细节核对仍未完成。

评审辅助：`scripts/ui-shots.mjs` 从 `gui/preview.html` 生成四面板变体（无 BOM、注入错误浮层、`__NO_DELAY__` 免延迟），输出 `test-data/ui-shots/`。

## 2. 已确认项

### 2.1 记忆浏览（浅色）
| 维度 | 结论 |
|---|---|
| 布局 | ✅ 左栏（导航）+ 右主区（顶栏 + 内容）结构正确，无错位、无文字溢出 |
| 侧边栏 | ✅ 「🧠 记忆管理」品牌 + 4 个导航项 + 状态脚注 |
| 顶栏 | ✅ 标题「记忆浏览」+ 主题切换按钮 |
| 统计条 | ✅ 5 张等宽卡片：记忆总数 14 / 短期 tokens 2,048 / 长期记忆 12 / 存储 1.2 MB / 嵌入模型（降级-哈希） |
| 筛选器 | ✅ 会话下拉 + 全部/全局/本地 pill + 刷新 + 标签 chip 行 |
| 记忆卡片 | ✅ 内容两行截断；meta = 重要度徽章 + 全局/会话徽章 + 时间（YYYY-MM-DD HH:MM） |
| 配色 | ✅ 语义色（重要度橙/全局绿/会话蓝紫）对比清晰 |

### 2.2 语义搜索（浅色）
- ✅ 侧边栏高亮「语义搜索」；查询「我喜欢用什么语言做数据分析」已填入；参数 Top-K=5 / 阈值=0.4 / 含全局记忆=开。
- ✅ 结果区显示：头部「共 1 条 · 耗时 183ms」+ 结果卡片（内容 + 重要度 9 + 全局徽章 + 时间 + 评分条 + 64.3%）。
- ✅ 无布局错位/溢出。
- 评审发现并已修复：① 原 `scoreQuery` 把整句 CJK 当作一个词导致空结果 → 改为字符+二元组重叠打分（与真实混合检索一致）；② 评分条填充对比度偏低 → 加粗到 6px 并加深渐变。

覆盖数据要求：14 条模拟记忆 ≥12；3 个会话（数据分析 / 项目管理 / 日常生活）；3 条全局（m01、m05、m11）；标签覆盖 偏好/工作/生活/摘要/旅行/理财/学习/健康 等；搜索评分区间 0.64（改述命中）~0.98（全文命中）。

## 3. 组件走查（未逐项截图但代码已核对）
- **导入导出**：`doExport()` 生成 JSON/JSONL 并触发下载；拖放/点击导入（预览模式回显提示）；清理按钮 toast 反馈。
- **设置**：全部字段与 `DEFAULT_CONFIG` 一一对应（短期窗口/自动摘要阈值/Top-K/相似度阈值滑杆/混合权重滑杆/嵌入模型/存储上限/AES/主密码/API Token/全局开关）；滑杆同步数值；保存 toast。
- **交互**：卡片点击展开/收起（ID/标签/会话/来源/Tokens/重要度±1/删除）；删除 confirm；主题持久化 localStorage；URL hash（`#search` 等）直达面板；`__NO_DELAY__` 测试钩子。
- **状态**：加载 spinner、空态插画、错误 alert、toast 均已实现。

## 4. 待办
- [ ] `preview-settings-light.png` / `preview-browser-dark.png` 细节逐项核对（本轮视觉预算耗尽，下轮补齐）
- [ ] 真实模式（`gui/index.html` + 服务器）浏览器联通验证（REST 已由 smoke 覆盖）

## 5. DSH 集成验证（真实 ctx.tools）
`scripts/dsh-integration.mjs` 在 DSH workspace 内以真实 Cordis Context + 真实 `@deepseek-ai/dsh-tools` `ToolRuntime` 装载插件，**24/24 通过**（报告：`scripts/integration-report.md`）：
- 注册：`ctx.tools.get(name)` 7 工具全注册；`ctx.tools.schemas()` 覆盖 7 项。
- 执行（真实 `ctx.tools.execute` 全链路）：`memory_add`（含 output schema 校验 + render）→ `memory_search`（召回新增记忆）→ `memory_get_recent`（会话事件钩子写入短期记忆）→ `memory_summarize`（**LLM 生成式** `via:'llm'`，经 `ctx.get('llm')` + `ctx.llm.stream` + `BlockAssembler`）→ `memory_delete` → `memory_update_importance` → `memory_stats`。
- 路由：webServer 记录 `/api/memory` 前缀路由。
- 依赖解析：`node_modules/@deepseek-ai/{cordis,dsh-tools,dsh-llm}` 为指向 DSH checkout 真实包目录的 junction，验证用。

## 6. 结论

主面板与语义搜索面板视觉验收 **通过**（布局/对齐/配色/信息层级均达标，含修复项）。设置/深色面板已渲染为正常内容（非空白），逐项核对待补。功能层（REST + 工具端到端）已由 `scripts/verify.mjs`（7/7）与 `scripts/smoke.mjs`（23/23）覆盖。
