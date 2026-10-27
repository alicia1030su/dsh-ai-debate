/**
 * Read files back out of the produced .tgz for verification.
 *
 * `listTar` only reports names and sizes, which is enough for the packer's
 * integrity check but not for proving what the archive actually *says*. This
 * helper walks the same ustar blocks and returns the bytes too.
 *
 *   node scripts/inspect-tgz.mjs [路径 ...]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const root = join(import.meta.dirname, '..')

/** Walk ustar blocks and return path -> Buffer for the requested paths. */
function readEntries(tar, wanted) {
  const out = new Map()
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const name = block.subarray(0, 100).toString('utf8').replace(/\u0000.*$/s, '')
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\u0000.*$/s, '')
    const size = Number.parseInt(
      block.subarray(124, 136).toString('ascii').replace(/\u0000.*$/s, ''),
      8,
    )
    const logical = prefix ? `${prefix}/${name}` : name
    const bytes = Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512
    if (wanted.includes(logical)) {
      out.set(logical, tar.subarray(offset + 512, offset + 512 + size))
    }
    offset += 512 + bytes
  }
  return out
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tgzPath = join(root, `${manifest.name}-${manifest.version}.tgz`)
const tar = gunzipSync(readFileSync(tgzPath))

const wanted = process.argv.slice(2)
const entries = readEntries(tar, wanted)
for (const path of wanted) {
  const data = entries.get(path)
  if (data === undefined) {
    process.stdout.write(`✖ ${path} 不在归档里\n`)
    process.exitCode = 1
    continue
  }
  const text = data.toString('utf8')
  process.stdout.write(`\n===== ${path} (${data.length} bytes) =====\n`)
  process.stdout.write(`${text.slice(0, 4000)}\n`)
}
