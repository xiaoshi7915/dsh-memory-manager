/**
 * 独立 HTTP 服务器入口：无需 DSH workspace 即可运行演示/验收。
 * 用法：node server/index.mjs  （PORT 环境变量可覆盖端口，默认 4599）
 * 数据目录：DSH_MEMORY_DIR 环境变量或 ~/.dsh/memory
 * @module src/server/index
 */

import http from 'node:http'
import { MemoryEngine } from '../core/index.mjs'
import { attachRoutes } from './routes.mjs'

const PORT = Number(process.env.PORT) || 4599
const HOST = process.env.HOST || '127.0.0.1'

async function main() {
  const engine = await MemoryEngine.create({})
  const handler = attachRoutes(() => engine)
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: e.message } }))
      } catch { /* 连接已关闭 */ }
    })
  })
  server.listen(PORT, HOST, () => {
    const status = engine.embedding.status()
    console.log(`[dsh-memory-manager] 记忆服务已启动`)
    console.log(`  Web GUI : http://${HOST}:${PORT}/`)
    console.log(`  API     : http://${HOST}:${PORT}/api/memory/healthz`)
    console.log(`  数据目录: ${engine.baseDir}`)
    console.log(`  嵌入模型: ${status.kind} (${status.detail ?? ''})`)
  })
  // 优雅退出
  const shutdown = async () => {
    await engine.close()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error('启动失败:', e.message)
  process.exit(1)
})
