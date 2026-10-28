/**
 * Restore `test/*.test.ts` from a source zip built before the botched rewrite.
 *
 * ## Why this exists
 *
 * `tmp-rewrite-approvals.mjs` ran a blanket `replace` that stripped every
 * `humanApproved: true,` line in nine files, but its insert step understood only a
 * fraction of the call shapes, so 25 authorisation flags disappeared without a
 * replacement landing. Hand-restoring them from memory would be guesswork; the
 * v0.2.4 source zip is the exact bytes that were green, so restore from that and
 * redo the migration deliberately.
 *
 * Reads the archive directly: Node has no zip reader on the stdlib, and pulling a
 * dependency in just to recover nine text files is not worth the supply-chain
 * surface. Only stored (method 0) and deflate entries are handled — the archiver
 * this project uses emits deflate, hence `zlib.inflateRawSync`.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const zipPath = process.argv[2]
const destRoot = process.argv[3]
const wanted = new Set(process.argv.slice(4))

const buf = fs.readFileSync(zipPath)

let eocd = -1
for (let i = buf.length - 22; i >= 0; i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i
    break
  }
}
if (eocd < 0) throw new Error('不是 zip：找不到中央目录结尾')

const count = buf.readUInt16LE(eocd + 10)
let cursor = buf.readUInt32LE(eocd + 16)

const restored = []
const missing = new Set(wanted)

for (let index = 0; index < count; index += 1) {
  if (buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error('中央目录条目损坏')
  const method = buf.readUInt16LE(cursor + 10)
  const csize = buf.readUInt32LE(cursor + 20)
  const nlen = buf.readUInt16LE(cursor + 28)
  const elen = buf.readUInt16LE(cursor + 30)
  const clen = buf.readUInt16LE(cursor + 32)
  const lho = buf.readUInt32LE(cursor + 42)
  const name = buf.toString('utf8', cursor + 46, cursor + 46 + nlen)
  cursor += 46 + nlen + elen + clen

  // Archive members are root-relative (`test/x.test.ts`), with no leading folder.
  const parts = name.split('/')
  if (parts.length !== 2 || parts[0] !== 'test') continue
  const base = parts[1]
  if (!wanted.has(base)) continue

  const lnlen = buf.readUInt16LE(lho + 26)
  const lelen = buf.readUInt16LE(lho + 28)
  const start = lho + 30 + lnlen + lelen
  const raw = buf.subarray(start, start + csize)
  const data = method === 0 ? raw : zlib.inflateRawSync(raw)

  fs.writeFileSync(path.join(destRoot, base), data)
  restored.push(`${base} (${data.length} 字节)`)
  missing.delete(base)
}

console.log('已恢复:', restored.length)
for (const line of restored) console.log('  ' + line)
if (missing.size > 0) {
  console.log('未在归档中找到:', [...missing].join(', '))
}
