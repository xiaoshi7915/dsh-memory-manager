#!/usr/bin/env node
/**
 * 批量种入 2000 条长期记忆（验收 3 用）。可重复运行（先清空长期库）。
 * 用法：DSH_MEMORY_DIR=<dir> node scripts/seed-2000.mjs [count]
 * @module scripts/seed-2000
 */

import { MemoryEngine } from '../src/core/index.mjs'
import { makeContent, decompose, TOTAL } from './lib/seedlib.mjs'

const N = Number(process.argv[2]) || TOTAL

async function main() {
  const engine = await MemoryEngine.create({})
  const dir = engine.baseDir
  engine.store.clear()
  engine.vector.clear()
  engine._plainCache.clear()
  const sessions = ['sess-data', 'sess-code', 'sess-manage', 'sess-life', 'sess-travel', 'sess-english',
    'sess-finance', 'sess-read', 'sess-music', 'sess-sport']
  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    const content = makeContent(i)
    const { topic } = decompose(i)
    engine.store.insert({
      id: `seed-${i}`,
      content: engine.crypto.encrypt(content),
      tags: [topic],
      importance: 1 + (i % 10),
      is_global: i % 13 === 0,
      session_id: sessions[i % sessions.length],
      created_at: Date.now() - (N - i) * 1000,
      last_accessed_at: Date.now(),
      ttl: null,
      source: 'seed',
      tokens: 0,
      summary_of: null,
    })
  }
  for (let i = 0; i < N; i++) {
    const vec = await engine.embedding.embed(makeContent(i))
    engine.vector.upsert(`seed-${i}`, vec)
  }
  await engine.persistVectors()
  await engine.lifecycle.expire()
  await engine.lifecycle.enforceStorageLimit()
  const ms = Date.now() - t0
  console.log(`[seed] 已种入 ${engine.store.count()} 条记忆 -> ${dir}`)
  console.log(`[seed] 耗时 ${ms}ms（${(ms / N).toFixed(2)}ms/条），嵌入模型: ${engine.embedding.status().kind}`)
  await engine.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
