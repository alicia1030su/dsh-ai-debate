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

import { DEFAULT_ZIP_LIMITS, judgeZipBudget, judgeZipIndex } from './zip-index.mjs'

/**
 * 读 ZIP 中央目录并解压每个条目（v0.3.0 issue #29）。
 *
 * 旧实现按 EOCD 里声明的条数遍历，**不检查索引是否描述了自己**：一个少报条目的归档
 * 只会被读到一个前缀，而「没读到的条目」根本不进入后面的逐文件比对 —— 核验器于是
 * 对一个不完整的归档给出「全部一致」。这正是 issue #29。
 *
 * 现在的顺序是：先完整读出索引 → `judgeZipIndex` 判定索引自洽 → `judgeZipBudget`
 * 判定资源预算 → 再解压内容。索引不可信时不进入解压阶段，错误信息里只出现路径与
 * 数字，不出现文件内容。
 *
 * @param {Buffer} buffer 归档字节
 * @param {typeof DEFAULT_ZIP_LIMITS} [limits] 资源上限
 * @returns {Array<{ name: string, data?: Buffer, kind: 'file' | 'directory' | 'nonregular' }>}
 */
export function readZipEntries(buffer, limits = DEFAULT_ZIP_LIMITS) {
  if (buffer.length < 22) throw new Error('不是合法的 ZIP：文件小于一个结尾记录')

  let eocd = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65558); index -= 1) {
    if (buffer.readUInt32LE(index) !== 0x06054b50) continue
    // 注释长度必须恰好吃掉文件剩余部分，否则压缩数据里的巧合签名会被当成索引。
    if (index + 22 + buffer.readUInt16LE(index + 20) !== buffer.length) continue
    eocd = index
    break
  }
  if (eocd === -1) {
    throw new Error('不是合法的 ZIP：找不到中央目录结束记录（归档可能被截断）')
  }

  const entriesOnDisk = buffer.readUInt16LE(eocd + 8)
  const totalEntries = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (
    totalEntries === 0xffff ||
    entriesOnDisk === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('不支持 ZIP64 的归档')
  }
  if (centralOffset + centralSize > eocd) {
    throw new Error('中央目录的偏移与长度越过了结尾记录')
  }

  /** @type {Array<import('./zip-index.mjs').ZipIndexEntry>} */
  const index = []
  let cursor = centralOffset
  for (let position = 0; position < totalEntries; position += 1) {
    if (cursor + 46 > eocd) throw new Error(`中央目录第 ${position + 1} 条不完整`)
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`中央目录第 ${position + 1} 条的签名不对`)
    }

    const madeBy = buffer.readUInt16LE(cursor + 4)
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const external = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)

    if (cursor + 46 + nameLength + extraLength + commentLength > eocd) {
      throw new Error(`中央目录第 ${position + 1} 条的名称或扩展字段超出目录`)
    }
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    const hostUnix = madeBy >> 8 === 3
    const mode = (external >>> 16) & 0xffff
    const kind = name.endsWith('/') || (external & 0x10) !== 0
      ? 'directory'
      : hostUnix && mode !== 0 && (mode & 0o170000) !== 0o100000 && (mode & 0o170000) !== 0o040000
        ? 'nonregular'
        : 'file'

    index.push({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      crc,
      localOffset,
      mode,
      hostUnix,
      kind,
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  const verdict = judgeZipIndex({
    entriesOnDisk,
    totalEntries,
    centralSize,
    centralOffset,
    eocdOffset: eocd,
    walked: index.length,
    walkedEnd: cursor,
    entries: index,
  })
  if (!verdict.ok) {
    throw new Error(`ZIP 索引不可信：${verdict.problems.join('；')}`)
  }

  const budget = judgeZipBudget(index, limits)
  if (budget.length > 0) {
    throw new Error(`ZIP 超出资源上限：${budget.join('；')}`)
  }

  const entries = []
  for (const entry of index) {
    if (entry.kind !== 'file') {
      entries.push({ name: entry.name, kind: entry.kind })
      continue
    }

    if (entry.localOffset + 30 > centralOffset) {
      throw new Error(`条目 ${entry.name} 的本地头偏移越过中央目录`)
    }
    if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw new Error(`条目 ${entry.name} 的本地头签名不对`)
    }
    const localNameLength = buffer.readUInt16LE(entry.localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28)
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength
    if (dataStart > centralOffset || dataStart + entry.compressedSize > centralOffset) {
      throw new Error(`条目 ${entry.name} 的数据越过中央目录（归档被截断）`)
    }

    const payload = buffer.subarray(dataStart, dataStart + entry.compressedSize)
    /** @type {Buffer} */
    let data
    if (entry.method === 0) {
      data = Buffer.from(payload)
    } else {
      try {
        data = inflateRawSync(payload, { maxOutputLength: limits.maxEntryBytes })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`条目 ${entry.name} 解压失败（数据损坏或超过资源上限）：${message}`)
      }
    }
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`条目 ${entry.name} 解压后长度与声明不符`)
    }
    if (crc32(data) !== entry.crc) {
      throw new Error(`条目 ${entry.name} 的 CRC 与内容不符`)
    }
    entries.push({ name: entry.name, data, kind: 'file' })
  }

  return entries
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** @param {Buffer} buffer */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
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
  let nonRegular = 0

  for (const entry of entries) {
    // 目录没有内容，不参与「字节等于提交」的比对；非普通条目则是一条明确的问题 ——
    // 它的语义不是文件，无法用 sha256 证明它是什么。
    if (entry.kind === 'directory') continue
    if (entry.kind === 'nonregular') {
      nonRegular += 1
      verdicts.push({
        path: entry.name,
        kind: 'non-regular',
        detail: '归档里有非普通文件条目（符号链接/设备/FIFO）',
      })
      continue
    }
    const data = entry.data
    if (data === undefined) {
      verdicts.push({ path: entry.name, kind: 'content', detail: '条目没有可读内容' })
      continue
    }
    const hash = sha256(data)
    manifest.push({ path: entry.name, bytes: data.length, sha256: hash })
    const blob = blobs.get(entry.name)
    if (blob === undefined) {
      notInRepository += 1
      verdicts.push({
        path: entry.name,
        kind: 'not-in-repository',
        detail: '归档里有这个文件，但 HEAD 里没有',
        archiveSha256: hash,
        archiveBytes: data.length,
      })
      continue
    }
    if (blob.equals(data)) {
      identical += 1
      continue
    }
    if (differsOnlyByLineEndings(blob, data)) {
      lineEndingsOnly += 1
      verdicts.push({
        path: entry.name,
        kind: 'line-endings-only',
        detail: `只有行尾不同：归档 ${data.length} 字节，HEAD ${blob.length} 字节`,
        archiveSha256: hash,
        archiveBytes: data.length,
      })
      continue
    }
    content += 1
    verdicts.push({
      path: entry.name,
      kind: 'content',
      detail: `内容不同：归档 sha256 ${hash.slice(0, 16)}…，HEAD sha256 ${sha256(blob).slice(0, 16)}…`,
      archiveSha256: hash,
      archiveBytes: data.length,
    })
  }

  const archived = new Set(entries.map((entry) => entry.name))
  /**
   * 仓库里有、归档里没有的文件，分成两类。
   *
   * ## 为什么不能一律算失败
   *
   * 归档不是「仓库的完整拷贝」：打包器有白名单，`.eval/`（评测记录）、根目录的
   * 历史报告、`test/fixtures/<pkg>/node_modules`（刻意入库的假包）都在白名单之外，
   * 而且**是故意的**。把「不在归档里」一律判红，这条检查就会永远红 ——
   * 一条永远红的检查等于没有检查。
   *
   * 判据：**本该整目录发布的位置**（源码、测试、脚本、文档、客户端）缺文件才算失败；
   * 其余只列出来，并说明「可能是设计如此」。
   *
   * 这个划分不 import 打包器的白名单（那会让两处规则互相掩护），它是核验方自己的
   * 判断，写在这里供人质疑。
   */
  const PUBLISHED_ROOTS = ['src/', 'test/', 'scripts/', 'docs/', 'client/', 'templates/', '.github/']
  const allMissing = [...blobs.keys()].filter((path) => !archived.has(path))
  const missing = allMissing.filter((path) => PUBLISHED_ROOTS.some((root) => path.startsWith(root)))
  const notPublished = allMissing.filter((path) => !missing.includes(path))

  return {
    entries: entries.length,
    identical,
    verdicts,
    missing,
    notPublished,
    manifest,
    totals: { content, lineEndingsOnly, notInRepository, nonRegular },
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
