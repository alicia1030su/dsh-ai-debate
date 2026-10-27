/**
 * Pack the whole repository into a source ZIP for GitHub.
 *
 * A separate script from `pack.mjs` on purpose: `pack.mjs` builds the *installable*
 * bundle (only what a plugin needs at runtime), while this builds the *repository*
 * (everything a contributor or auditor needs, including tests, fixtures and CI).
 * Mixing them is how a release ends up shipping `.env` or, worse, omitting tests.
 *
 * Excludes: node_modules, the built .tgz files, and anything the .gitignore already
 * keeps out — the ZIP is meant to be extracted as a working copy, not a dump of the
 * developer's machine.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const root = process.cwd()
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const outFile = join(root, '..', `dsh-ai-debate-source-${version}.zip`)

/** Top-level names never included. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.plugin-manager', 'probe-out', 'dsh-src'])

/**
 * Directories excluded on purpose:
 * - `probe-out` holds verification screenshots.
 * - `dsh-src` holds DSH reference files extracted from app.asar for research;
 *   they are not this project's source and must not be redistributed.
 */

/** Path prefixes (relative, posix) never included. */
const SKIP_PREFIXES = ['debate-stage', 'tmp-']

/** Extensions that are build output we do not want to ship as source. */
const SKIP_FILE = /\.(tgz|zip|log)$/

/** Walk the tree, returning posix-style relative file paths. */
async function walk(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(root, full).split(sep).join(posix.sep)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (SKIP_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
      await walk(full, acc)
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
    if (SKIP_FILE.test(entry.name)) continue
    acc.push(rel)
  }
  return acc
}

const files = (await walk(root)).sort()

// --- minimal ZIP writer (deflate, no zip64) ---------------------------------
// The project has no npm dependencies to lean on at pack time (the environment has
// no npm at all), and the standard library has no ZIP writer, so this writes the
// container directly. Entries are deflated; anything already compressed stays fine.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Convert a JS date to the DOS date/time pair ZIP uses. */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

const LOCAL_HEADER = Buffer.alloc(30)
const CENTRAL_HEADER = Buffer.alloc(46)

const chunks = []
const central = []
let offset = 0

for (const rel of files) {
  const full = join(root, rel.split(posix.sep).join(sep))
  const info = await stat(full)
  const raw = await readFile(full)
  const compressed = deflateRawSync(raw, { level: 9 })
  const nameBytes = Buffer.from(rel, 'utf8')
  const crc = crc32(raw)
  const { time, day } = dosDateTime(info.mtime)

  LOCAL_HEADER.writeUInt32LE(0x04034b50, 0)
  LOCAL_HEADER.writeUInt16LE(20, 4) // version needed
  LOCAL_HEADER.writeUInt16LE(0x0800, 6) // UTF-8 names
  LOCAL_HEADER.writeUInt16LE(8, 8) // deflate
  LOCAL_HEADER.writeUInt16LE(time, 10)
  LOCAL_HEADER.writeUInt16LE(day, 12)
  LOCAL_HEADER.writeUInt32LE(crc, 14)
  LOCAL_HEADER.writeUInt32LE(compressed.length, 18)
  LOCAL_HEADER.writeUInt32LE(raw.length, 22)
  LOCAL_HEADER.writeUInt16LE(nameBytes.length, 26)
  LOCAL_HEADER.writeUInt16LE(0, 28)

  chunks.push(Buffer.from(LOCAL_HEADER), nameBytes, compressed)

  const centralEntry = Buffer.from(CENTRAL_HEADER)
  centralEntry.writeUInt32LE(0x02014b50, 0)
  centralEntry.writeUInt16LE(20, 4) // version made by
  centralEntry.writeUInt16LE(20, 6) // version needed
  centralEntry.writeUInt16LE(0x0800, 8)
  centralEntry.writeUInt16LE(8, 10)
  centralEntry.writeUInt16LE(time, 12)
  centralEntry.writeUInt16LE(day, 14)
  centralEntry.writeUInt32LE(crc, 16)
  centralEntry.writeUInt32LE(compressed.length, 20)
  centralEntry.writeUInt32LE(raw.length, 24)
  centralEntry.writeUInt16LE(nameBytes.length, 28)
  centralEntry.writeUInt16LE(0, 30) // extra
  centralEntry.writeUInt16LE(0, 32) // comment
  centralEntry.writeUInt16LE(0, 34) // disk
  centralEntry.writeUInt16LE(0, 36) // internal attrs
  // `<< 16` overflows into a negative int32 for mode 0o100644, so force unsigned.
  centralEntry.writeUInt32LE((0o100644 << 16) >>> 0, 38) // regular file mode
  centralEntry.writeUInt32LE(offset, 42)
  central.push(Buffer.from(centralEntry), nameBytes)

  offset += LOCAL_HEADER.length + nameBytes.length + compressed.length
}

const centralBuffer = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(0, 4)
end.writeUInt16LE(0, 6)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralBuffer.length, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)

const zip = Buffer.concat([...chunks, centralBuffer, end])
await writeFile(outFile, zip)

console.log(`已写入 ${outFile}`)
console.log(`  文件数：${files.length}`)
console.log(`  大小：${zip.length} 字节`)
for (const rel of files) console.log(`  ${rel}`)
