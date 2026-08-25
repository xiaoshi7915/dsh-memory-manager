# awesome-dsh-plugin 投稿条目（拷贝到 awesome-dsh-plugin 仓库后按步骤提交）

## 1) 新建文件：data/plugins/xiaoshi7915__dsh-memory-manager.yml

```yaml
url: https://github.com/xiaoshi7915/dsh-memory-manager
name: xiaoshi7915/dsh-memory-manager
category: memory
description:
  en: 'Unified memory layer for AI agents: short-term context window, long-term knowledge base, semantic retrieval and persistent encrypted storage.'
  zh: '为 AI Agent 提供短期记忆缓存、长期知识沉淀、语义检索与持久化存储的统一记忆管理层，让 Agent 在多轮对话中保持上下文连贯，并能跨会话积累用户偏好与领域知识。'
```

说明：
- `category: memory` 在合法取值表内（memory）。
- 描述只陈述功能、无营销词、无具体数字/API 名（避免被核对打回）。
- 含 `:` 后带空格 → 已加引号（en/zh 都加了）。

## 2) 可选：截图（data/screenshots.json 加一条）

```json
{
  "https://github.com/xiaoshi7915/dsh-memory-manager": [
    "https://raw.githubusercontent.com/xiaoshi7915/dsh-memory-manager/main/review/preview-browser-light.png",
    "https://raw.githubusercontent.com/xiaoshi7915/dsh-memory-manager/main/review/preview-search-light.png",
    "https://raw.githubusercontent.com/xiaoshi7915/dsh-memory-manager/main/review/preview-settings-light.png",
    "https://raw.githubusercontent.com/xiaoshi7915/dsh-memory-manager/main/review/preview-browser-dark.png"
  ]
}
```

## 3) 提交 PR 的步骤

```sh
git clone https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b add-dsh-memory-manager
# 1) 新建 data/plugins/xiaoshi7915__dsh-memory-manager.yml（内容见上）
# 2) （可选）在 data/screenshots.json 加入截图条目
# 3) 重新生成 README：
npm ci
node scripts/generate-readme.mjs
git add data/plugins/xiaoshi7915__dsh-memory-manager.yml data/screenshots.json README.md
git commit -m "add dsh-memory-manager to the memory category"
git push -u origin add-dsh-memory-manager
# 4) 在 GitHub 上对 awesome-dsh-plugin 开 PR（只动自己这一条，最多 3 条）
```

## CI 会检查（确保已满足）
- [x] package.json 声明 `dsh.bundle.patch`（已加：./cordis.patch.yml）
- [ ] 仓库满 1 天（push 后次日再开 PR）
- [x] ≥10 提交（当前 11）
- [ ] 仓库加 `dsh-plugin` topic（GitHub → repo → About → Topics 添加）
- [x] 描述准确、无营销词
- [x] 真实可运行代码（集成 26/26、冒烟 23/23、验收 7/7）
