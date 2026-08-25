# contracts/web-api.md — GUI REST API

> Base：`/api/memory`。请求/响应均为 JSON（`Content-Type: application/json`；导入导出端点接受 text/plain 文本体）。
> 统一错误：`{"error": {"code": string, "message": string}}` + HTTP 状态码（见 contracts/tools.md 错误码表）。
> 本契约同时被 DSH 集成层（`ctx.webServer.register({kind:'prefix', path:'/api/memory', handler})`）与独立服务器（`server/index.mjs`，默认端口 `4599`，可用 `PORT` 环境变量覆盖）实现。静态 GUI 由 `gui/` 托管。

## 端点表
| 方法 | 路径 | 说明 | 请求体 | 成功响应 |
|---|---|---|---|---|
| GET | `/api/memory/healthz` | 健康检查 | — | `{"ok":true,"version":"1.0.0","embedding_status":"..."}` |
| GET | `/api/memory/stats` | 统计 | — | `{"total_memories":150,"short_term_tokens":2048,"long_term_count":142,"storage_size_mb":12.5,"last_compacted":"...","embedding_model":"local","embedding_status":"completed","needs_reindex":false}` |
| GET | `/api/memory/memories` | 记忆列表（时间线） | query：`session`、`global`(`1`/`0`)、`tag`、`limit`(默认100)、`offset` | `{"items":[{id,content,tags,importance,is_global,session_id,created_at,score?}],"total":N}` |
| GET | `/api/memory/memories/:id` | 单条详情（完整内容） | — | 单条 MemoryRecord（content 解密后完整文本） |
| DELETE | `/api/memory/memories/:id` | 删除单条 | — | `{"deleted_count":1,"affected_sessions":[...],"freed_tokens":N}` |
| POST | `/api/memory/memories/delete` | 条件批量删除 | `{"ids":[...]? ,"conditions":{session_id?,tag?,is_global?,older_than?,importance_le?}}` | `{"deleted_count":N,"affected_sessions":[...],"freed_tokens":N}` |
| POST | `/api/memory/search` | 语义检索 | `{"query":"...","top_k":5,"threshold":0.75,"session_id":"...","include_global":true}` | `{"results":[{id,content,score,session_id,timestamp,is_global}],"total":N,"latency_ms":45}` |
| GET | `/api/memory/recent` | 短期记忆上下文 | query：`session`、`n` | `{"messages":[{"role","content"}],"token_count":2048,"window_size":10,"truncated":false}` |
| POST | `/api/memory/summarize` | 生成摘要并入库 | `{"session_id":"...","count":24}` | `{"summary":"...","memory_id":"<uuid>","compressed_from":24,"saved_tokens":1800}` |
| PATCH | `/api/memory/memories/:id/importance` | 修改重要性 | `{"score":9}` | `{"memory_id":"<uuid>","old_score":5,"new_score":9}` |
| GET | `/api/memory/config` | 读取配置 | — | 完整 config 对象（含默认值） |
| POST | `/api/memory/config` | 保存配置 | 部分或全部配置对象 | `{"saved":true,"config":{...}}` |
| GET | `/api/memory/export?format=json|jsonl` | 下载备份 | — | 文本：备份 JSON 或 JSONL（`Content-Disposition: attachment`） |
| POST | `/api/memory/import` | 上传恢复 | `{"text":"...","mode":"merge|replace"}` | `{"imported":N,"skipped":N,"failed":N}` |
| POST | `/api/memory/cleanup` | 手动执行清理（TTL+超限） | — | `{"expired":N,"evicted":N,"last_compacted":"..."}` |

## 认证
- 本机工具，默认无认证（仅绑定 `127.0.0.1`）。若 `storage.api_token` 配置了 token，则要求 `Authorization: Bearer <token>`（其余请求返回 401 UNAUTHORIZED）。DSH 集成层复用 DSH 本机 Web 服务约定。

## 静态资源
- `GET /` 与 `GET /gui/*`：托管 `gui/` 目录（`preview.html`、面板 JS/CSS、api.js）。独立服务器与 DSH 集成层均可启用。
