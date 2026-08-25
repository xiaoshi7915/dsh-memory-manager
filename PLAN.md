# PLAN.md — 文件树与分工地图

> 分工原则：每个角色只写自己名下的文件，禁止触碰他人边界（避免并行写冲突）。所有实现先读 `ARCHITECTURE.md` 与对应 `contracts/*.md`。

## 文件树（目标）
```
dsh-memory-manager/
├─ TASK-spec.md            # 需求（已存在）
├─ dsh-research.md         # DSH 机制调研（已完成）
├─ ARCHITECTURE.md         # 架构与模块接口（已完成）
├─ contracts/
│  ├─ tools.md             # 工具契约（已完成）
│  └─ web-api.md           # Web API 契约（已完成）
├─ package.json            # ★高级开发者 或 负责人补齐
├─ .gitignore
├─ README.md               # ★高级开发者 最终补全
├─ src/
│  ├─ config.mjs           # 配置加载/校验/指纹（后端）
│  ├─ core/                # 记忆引擎（★后端架构师）
│  │  ├─ types.mjs  tokenizer.mjs  short-term.mjs  embedding.mjs
│  │  ├─ vector.mjs  crypto.mjs  store.mjs  search.mjs
│  │  ├─ summarize.mjs  lifecycle.mjs  io.mjs  stats.mjs
│  │  └─ index.mjs        # MemoryEngine 门面
│  ├─ tools/
│  │  ├─ handlers.mjs     # 7 工具纯函数处理器（★高级开发者）
│  │  └─ definitions.mjs  # defineTool 定义（DSH 适配用，★高级开发者）
│  ├─ triggers/index.mjs  # 触发词检测（★高级开发者）
│  └─ dsh/plugin.mjs      # DSH 适配层 name/inject/apply（★高级开发者）
├─ server/
│  └─ index.mjs           # 独立 REST 服务器（★后端架构师）
├─ scripts/
│  ├─ seed-2000.mjs       # 生成 2000 条样例记忆（★后端架构师）
│  ├─ verify.mjs          # 三条验收自证 → verify-report.md（★后端架构师）
│  └─ smoke.mjs           # 7 工具冒烟 → smoke-report.md（★高级开发者）
├─ gui/                   # 前端（★前端开发者）
│  ├─ DESIGN.md           # 设计契约（第一步）
│  ├─ preview.html        # 独立静态预览（mock 数据）
│  ├─ api.js              # Web API 封装（可回退 mock）
│  └─ panels/             # 4 面板实现（browser/search/config/io）
└─ review/                # UI 验收产物（★UI 验收设计师，只读不改码）
   └─ *.png / REVIEW.md
```

## 分工边界
| 角色 | 负责 | 禁止触碰 |
|---|---|---|
| 后端架构师 | `src/config.mjs`、`src/core/**`、`server/index.mjs`、`scripts/seed-2000.mjs`、`scripts/verify.mjs` | tools/、triggers/、dsh/、gui/、contracts/、ARCHITECTURE.md |
| 高级开发者 | `package.json`、`src/tools/**`、`src/triggers/**`、`src/dsh/**`、`README.md`、`scripts/smoke.mjs` | src/core/** 内部实现（只 import 公开 API）、server/、gui/ |
| 前端开发者 | `gui/**`（先 DESIGN.md，再 preview.html，再 panels） | core/、server/、tools/、dsh/、contracts/ |
| UI 验收设计师 | `review/REVIEW.md` 与截图 | 全部代码文件（只读） |
| 负责人（编排） | TASK-*.md、契约、版本控制与合并 | — |

## 依赖顺序
1. 后端架构师：core A（types/tokenizer/short-term/embedding/vector/crypto）→ core B（store/search/summarize/lifecycle/io/stats/index/config）→ server → scripts。
2. 高级开发者：依赖 core 门面（src/core/index.mjs 公开 API）后实现 tools/triggers/dsh，最后补 package.json/README/smoke。
3. 前端开发者：与 core 并行；只依赖 contracts/web-api.md。
4. UI 验收设计师：依赖 gui/preview.html 完成。
