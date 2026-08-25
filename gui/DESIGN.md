# dsh-memory-manager · Web GUI 设计文档

> 面向 AI Agent 的记忆管理插件 Web 界面。本文档描述信息架构、交互与视觉规范。
> 独立预览：`gui/preview.html`（自包含、模拟数据，双击即可打开，无需后端）。
> 真实模式：`gui/index.html`（经 `/api/memory` REST 与引擎对接）。

## 1. 设计目标

- **统一入口**：在 DSH Web 侧边栏提供「🧠 记忆管理」入口（`ctx.slots.inject('sidebar.settings', ...)`），与 Agent 的工具调用（`memory_add` / `memory_search` 等）共用同一记忆库。
- **可读性优先**：记忆是时间线 + 评分，重点呈现「内容 / 重要度 / 会话 / 时间 / 相关度」五个维度，避免信息过载。
- **桌面优先**：16:9 以上的工作台布局；窄屏降级为滚动。
- **深浅双主题**：`data-theme` 切换，所有颜色走 CSS 变量，保证无障碍对比度。

## 2. 信息架构

```
侧边栏
├── 🧠 记忆管理（品牌 + 状态指示：在线/离线/降级）
├── 🕘 记忆浏览          → 统计条 + 筛选 + 时间线卡片
├── 🔍 语义搜索          → 搜索框 + 参数 + 评分结果
├── ⇅ 导入导出          → 导出下载 / 导入拖放 / 存储清理
└── ⚙️ 设置             → 短期窗口 / 检索 / 嵌入模型 / 存储与安全
```

### 2.1 记忆浏览（默认面板）
- **统计条**：记忆总数 / 短期 tokens / 长期记忆数 / 存储占用 / 嵌入模型状态。
- **筛选器**：会话下拉、全局/本地切换（radio chip）、标签 chip 多选（互斥单选）。
- **时间线卡片**：内容两行截断；元信息行 = 重要度徽章 + 全局/会话徽章 + 时间 + （搜索时为评分条）。点击展开详情：ID、标签、会话、来源、Tokens、操作（重要度 ±1、删除）。
- 空态 / 加载态 / 错误态三态齐备。

### 2.2 语义搜索
- 输入框 + Top-K + 阈值 + 会话 + 「含全局记忆」开关。
- 结果按分数降序，评分条按百分比着色，头部显示命中数与耗时。

### 2.3 导入导出
- 导出：JSON（带版本头）/ JSONL（每行一条），浏览器下载。
- 导入：点击/拖放上传，合并 / 替换两种模式，导入日志回显。
- 存储清理：手动触发 TTL 过期 + 超限 LRU 清理。

### 2.4 设置
- 短期窗口：max_messages / max_tokens。
- 长期检索：auto_summarize_threshold / retrieval_top_k / similarity_threshold（滑杆 + 数值） / hybrid_weight（滑杆）。
- 嵌入模型：model（local / openai）、model_id（留空 = 哈希降级）、API Key；更换模型提示重建索引。
- 存储与安全：max_storage_mb、AES-256 开关、主密码（scrypt 派生）、API Token。
- 全局记忆开关。

## 3. 视觉规范

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#f4f6fb` | `#0f1420` | 画布 |
| `--panel` | `#ffffff` | `#171d2c` | 卡片/侧边栏 |
| `--border` | `#e3e8f0` | `#26304a` | 分隔线 |
| `--text` | `#1c2333` | `#e8ecf6` | 主文本 |
| `--accent` | `#4f6ef7` | `#6a85ff` | 主操作/高亮 |
| `--ok / --warn / --danger` | `#2f9e6e / #d97706 / #e5484d` | 同左 | 语义色 |

- 圆角 `12px`、阴影 `0 1px 3px + 0 6px 20px`、主字体栈含 PingFang SC / Microsoft YaHei。
- 重要度徽章橙色系、全局徽章绿色系、会话徽章主色系，深浅色下各自适配。

## 4. 组件清单

| 组件 | 文件 |
|---|---|
| 共享样式 | `gui/css/main.css` |
| 真实 API 客户端 | `gui/js/api.js`（MemoryApi 类，封装 `/api/memory/*`） |
| 真实应用逻辑 | `gui/js/app.js`（四面板 + 主题 + toast） |
| 真实页面 | `gui/index.html` |
| 独立预览 | `gui/preview.html`（内联 CSS/JS + 14 条模拟数据） |

## 5. 验收口径（对应 TASK-spec §7）

- **UI 验收**：以 `preview.html` 截图为评审对象（视觉评审脚本 `scripts/ui-review.mjs` 渲染预览并输出 `review/REVIEW.md`）。
- **功能验收**：真实模式由 `scripts/verify.mjs` + `scripts/smoke.mjs` 覆盖（REST + 工具端到端）。

## 6. 降级说明

- 未配置真实嵌入模型时，引擎以「哈希向量 + 关键词」混合降级；GUI 统计条与设置页会明确标注「降级(哈希)」。
- 更换嵌入模型后 `needs_reindex` 为真，设置页提示重建索引；检索按当前模型向量实时计算，功能不受阻塞。
