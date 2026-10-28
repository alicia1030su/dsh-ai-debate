/** Confirm the shipped source zip contains the files as they are on disk now. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = 'C:/Users/23866/Documents/deepseek-harness/default-workspace'
const zipPath = path.join(ROOT, 'dsh-ai-debate-source-0.2.5.zip')

// Rebuild the zip so it cannot lag behind the source, then compare.
execFileSync(process.execPath, [path.join(ROOT, 'dsh-ai-debate/scripts/source-zip.mjs'), '0.2.5'], {
  stdio: 'ignore',
})

const buf = fs.readFileSync(zipPath)
let eocd = -1
for (let i = buf.length - 22; i >= 0; i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i
    break
  }
}
const count = buf.readUInt16LE(eocd + 10)
let off = buf.readUInt32LE(eocd + 16)

/** Pull one member out of the archive. */
function member(name) {
  const saved = off
  off = saved
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nlen = buf.readUInt16LE(off + 28)
    const elen = buf.readUInt16LE(off + 30)
    const clen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    const entry = buf.toString('utf8', off + 46, off + 46 + nlen)
    off += 46 + nlen + elen + clen
    if (entry !== name) continue
    const lnlen = buf.readUInt16LE(lho + 26)
    const lelen = buf.readUInt16LE(lho + 28)
    const start = lho + 30 + lnlen + lelen
    const raw = buf.subarray(start, start + csize)
    return method === 0 ? raw : zlib.inflateRawSync(raw)
  }
  return undefined
}

const checks = ['src/publisher.ts', 'src/index.ts', 'src/store.ts', 'client/client.cjs', 'package.json']
let failures = 0
for (const file of checks) {
  const inside = member(file)
  if (inside === undefined) {
    console.log(`MISSING in zip: ${file}`)
    failures += 1
    continue
  }
  const onDisk = fs.readFileSync(path.join(ROOT, 'dsh-ai-debate', file))
  const same = createHash('sha256').update(inside).digest('hex') === createHash('sha256').update(onDisk).digest('hex')
  console.log(`${same ? 'same  ' : 'DIFFER'} ${file}  (zip ${inside.length} / disk ${onDisk.length})`)
  if (!same) failures += 1
}

const pkg = JSON.parse(member('package.json').toString('utf8'))
console.log('zip package.json version:', pkg.version)
console.log(failures === 0 ? '源码 ZIP 与磁盘一致' : `${failures} 处不一致`)
process.exit(failures === 0 ? 0 : 1)
