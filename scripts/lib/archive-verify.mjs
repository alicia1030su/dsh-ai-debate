/**
 * 归档核验的判定逻辑：归档里的每个文件，是否等于仓库里**已提交**的那一份。
 *
 * ## 为什么把它单独拆出来
 *
 * 同一套判据有三个使用者：命令行核验脚本、发布流水线、测试。写成一份，
 * 三处结论就不可能互相矛盾 —— 而「核验工具说没问题、发布产物却对不上」正是
 * 这一类工作最容易出现的自欺。
 *
 * ## 为什么比较的是 blob 而不是工作树
 *
 * v0.2.37 的真实故障：工作树里 20 个文本文件是 CRLF（工具以文本模式重写过），
 * 仓库里是 LF（`.gitattributes` 写死 `eol=lf`）。`source-zip.mjs` 读工作树，
 * 于是同一台机器重建的包比 GitHub 上的大 2369 字节。
 *
 * 所以「正确」的定义只能是**提交内容**：归档是那个提交的公开副本，不是某个人
 * 硬盘上那一份的样子。用工作树做基准，等于让归档的正确性取决于谁的编辑器。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

/** 读 ZIP 中央目录并解压每个条目。只支持本仓库会产出的格式。 */
export function readZipEntries(buffer) {
  let eocd = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65558); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd === -1) throw new Error('不是合法的 ZIP：找不到中央目录结束记录')

  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`中央目录第 ${index} 条的签名不对`)
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    // 数据起点以本地头为准：中央目录与本地头的扩展字段长度可以不同。
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const payload = buffer.subarray(dataStart, dataStart + compressedSize)
    entries.push({ name, data: method === 0 ? Buffer.from(payload) : inflateRawSync(payload) })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 一次性取出 HEAD 里所有文件的字节。用 `cat-file --batch` 避免 N 次进程启动。 */
export function readHeadBlobs(root, paths) {
  const out = new Map()
  if (paths.length === 0) return out

  const listing = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString('utf8')

  const wanted = new Set(paths)
  const objectByPath = new Map()
  for (const record of listing.split('\0')) {
    if (record === '') continue
    // `<mode> <type> <sha>\t<path>`
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const meta = record.slice(0, tab).split(' ')
    const path = record.slice(tab + 1)
    if (!wanted.has(path)) continue
    objectByPath.set(path, meta[2])
  }
  if (objectByPath.size === 0) return out

  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: [...new Set(objectByPath.values())].join('\n'),
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  })

  const byObject = new Map()
  let cursor = 0
  while (cursor < batch.length) {
    const newline = batch.indexOf(0x0a, cursor)
    if (newline === -1) break
    const header = batch.subarray(cursor, newline).toString('utf8')
    // `<sha> blob <size>`
    const parts = header.split(' ')
    if (parts.length < 3 || parts[1] !== 'blob') break
    const size = Number(parts[2])
    const start = newline + 1
    byObject.set(parts[0], batch.subarray(start, start + size))
    cursor = start + size + 1
  }

  for (const [path, object] of objectByPath) {
    const data = byObject.get(object)
    if (data !== undefined) out.set(path, data)
  }
  return out
}

/** 只在行尾上不同？ */
export function differsOnlyByLineEndings(a, b) {
  const strip = (buffer) => buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return strip(a) === strip(b)
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * 核验一个源码包。
 *
 * @param zipBytes 归档字节
 * @param blobs HEAD 里的文件内容（由 `readHeadBlobs` 取得）
 */
export function verifyArchive(zipBytes, blobs, trackedCount) {
  const entries = readZipEntries(zipBytes)
  const verdicts = []
  const manifest = []
  let identical = 0
  let content = 0
  let lineEndingsOnly = 0
  let notInRepository = 0

  for (const entry of entries) {
    const hash = sha256(entry.data)
    manifest.push({ path: entry.name, bytes: entry.data.length, sha256: hash })
    const blob = blobs.get(entry.name)
    if (blob === undefined) {
      notInRepository += 1
      verdicts.push({
        path: entry.name,
        kind: 'not-in-repository',
        detail: '归档里有这个文件，但 HEAD 里没有',
        archiveSha256: hash,
        archiveBytes: entry.data.length,
      })
      continue
    }
    if (blob.equals(entry.data)) {
      identical += 1
      continue
    }
    if (differsOnlyByLineEndings(blob, entry.data)) {
      lineEndingsOnly += 1
      verdicts.push({
        path: entry.name,
        kind: 'line-endings-only',
        detail: `只有行尾不同：归档 ${entry.data.length} 字节，HEAD ${blob.length} 字节`,
        archiveSha256: hash,
        archiveBytes: entry.data.length,
      })
      continue
    }
    content += 1
    verdicts.push({
      path: entry.name,
      kind: 'content',
      detail: `内容不同：归档 sha256 ${hash.slice(0, 16)}…，HEAD sha256 ${sha256(blob).slice(0, 16)}…`,
      archiveSha256: hash,
      archiveBytes: entry.data.length,
    })
  }

  const archived = new Set(entries.map((entry) => entry.name))
  const missing = [...blobs.keys()].filter((path) => !archived.has(path))

  return {
    entries: entries.length,
    identical,
    verdicts,
    missing,
    manifest,
    totals: { content, lineEndingsOnly, notInRepository },
  }
}

/**
 * 工作树里哪些跟踪文件与 HEAD 不一致。
 *
 * 这是**打包之前**该问的问题。v0.2.37 的错位是在打包之后才被发现的，而那时已经
 * 发布了 —— 把检查提前到打包前，错位就只是一次本地失败，不是一次公开的错包。
 *
 * @returns 每个不一致路径的说明；空数组表示工作树与提交一致。
 */
export function workingTreeDrift(root, paths) {
  const blobs = readHeadBlobs(root, paths)
  const drift = []
  for (const [path, blob] of blobs) {
    let actual
    try {
      actual = execFileSync('cat', [path], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    } catch {
      drift.push(`${path}：读不到工作树里的这一份`)
      continue
    }
    if (blob.equals(actual)) continue
    drift.push(
      differsOnlyByLineEndings(blob, actual)
        ? `${path}：只有行尾不同（工作树 ${actual.length} 字节 / 仓库 ${blob.length} 字节）`
        : `${path}：内容与 HEAD 不同`,
    )
  }
  return drift
}

/** `git ls-tree -r HEAD` 的全部路径。 */
export function headPaths(root) {
  const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString('utf8')
  return listing.split('\0').filter((entry) => entry !== '')
}
