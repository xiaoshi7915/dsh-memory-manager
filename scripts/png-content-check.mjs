// 用内置 zlib 解 PNG IDAT，粗判图像是否"有内容"（非纯色空白）。
// 不做完整滤波还原，只统计解压字节的方差/唯一值——空白页 → 极低方差，渲染 UI → 高方差。
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const png = process.argv[2]
const buf = readFileSync(png)
// 解析 PNG chunks
let off = 8
const chunks = []
while (off < buf.length) {
  const len = buf.readUInt32BE(off)
  const type = buf.toString('ascii', off + 4, off + 8)
  chunks.push({ type, len, data: buf.subarray(off + 8, off + 8 + len) })
  off += 12 + len
}
const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
const raw = inflateSync(idat)
// raw 是逐行滤波字节流。统计字节分布（不还原滤波也能反映内容复杂度）
let sum = 0, sumSq = 0, n = raw.length, uniq = new Set()
for (let i = 0; i < n; i += 3) { // 每 3 字节采样一次，够粗
  const b = raw[i]
  sum += b; sumSq += b * b; uniq.add(b)
  if (uniq.size > 4000) break // 足够判断"丰富"
}
const mean = sum / n
const variance = sumSq / n - mean * mean
const distinctRatio = uniq.size / Math.min(4000, n)
const ihdr = chunks.find((c) => c.type === 'IHDR').data
const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4)
console.log(`尺寸 ${w}x${h} · IDAT 解压 ${n}B · 字节方差 ${variance.toFixed(1)} · 不同字节 ${uniq.size}`)
// 纯空白/纯色 → 不同字节值 ≈1-2，方差≈0；渲染 UI → 不同字节值显著多（字体/边框/主题色）
const hasContent = uniq.size > 100
console.log(hasContent ? '✅ PNG 含实际内容（非空白）' : '⚠️ PNG 接近空白或极简')
process.exit(hasContent ? 0 : 1)
