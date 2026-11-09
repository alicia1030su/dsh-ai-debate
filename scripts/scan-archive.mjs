#!/usr/bin/env node
/**
 * Scan a release archive for sensitive content — independently of the packer.
 *
 * ## Why this is separate from `source-zip.mjs`
 *
 * §五 asks for "an independent sensitive-file scan for the release source ZIP". The reason is
 * that a packer which both *decides* what to include and *certifies* what it included can be
 * wrong in the same way twice: a bug in the allowlist is a bug in its own self-check.
 *
 * This script takes a finished archive and asks only "is anything in here dangerous?", using its
 * own name rules and its own content patterns. It never imports the packer.
 *
 * ## Exit codes
 *
 * `0` clean, `1` findings, `2` usage, `3` the archive itself cannot be read (corrupt, truncated,
 * unsupported compression, bad offsets). CI treats every non-zero as failure. The task book is
 * explicit that a finding must **fail the build**, not print a warning — a warning in a
 * 3000-line log is a warning nobody reads.
 *
 * ## What this file must never print (v0.2.39 发布安全收口 §1)
 *
 * A scan that prints the matching line turns "we found a leak" into "we leaked it again": CI
 * logs are public, `--json` output gets pasted into issues, stack traces get uploaded. So a
 * finding is reported as **path + rule + line/column** only. No matched text, no prefix, no
 * whole line. The shape is enforced by `scripts/lib/scan-finding.mjs`, whose constructors do
 * not accept content at all.
 *
 * ## What must not be skipped (v0.2.39 发布安全收口 §2)
 *
 * The previous reader treated every entry it could not decode as `data: undefined` and then
 * `continue`d. A deflate stream that failed to inflate — or a compression method the reader did
 * not implement — was therefore **silently skipped**, which is the one failure mode a security
 * scan cannot have: the file that could not be read is exactly the file nobody can vouch for.
 *
 * The readers below classify every entry and fail the whole scan when a file that should be
 * scanned cannot be scanned:
 *
 * - directory entries → legal, counted, not scanned (there is no content);
 * - non-regular entries (symlink, hardlink, device, PAX header, …) → reported as a finding,
 *   because a release source archive has no legitimate reason to carry one;
 * - regular files → scanned;
 * - corrupt compressed data / unsupported compression / length or offset anomaly / truncated
 *   archive → `ArchiveError`, exit 3, nothing skipped.
 *
 * ## What must not be mis-declared (v0.2.39 复审 §3)
 *
 * Two more ways to make the reader skip bytes without it noticing:
 *
 * - **An index that under-reports itself.** The walk is bounded by the entry count in the
 *   end record, so `count = 1` over an archive that physically holds two entries reads the
 *   first and returns "clean". The count on this disk, the total count, the declared
 *   directory length and the position the walk actually stopped at must all agree, and the
 *   directory must end exactly at the end record — otherwise there is an index nobody read.
 * - **A directory entry with content.** A name ending in `/` (or the DOS directory bit)
 *   used to end the entry's validation before the encryption, compression-method and
 *   length checks. A "directory" with a payload is a file wearing a directory's name, and
 *   skipping it is the same failure as skipping an unreadable file.
 *
 * Usage:
 *   node scripts/scan-archive.mjs <archive.zip|archive.tgz> [--json]
 */

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'

import { isRegisteredFakeLiteral } from './lib/fixture-allowlist.mjs'
import { contentFinding, formatFinding, pathFinding } from './lib/scan-finding.mjs'

const path = process.argv[2]
const asJson = process.argv.includes('--json')

if (!path) {
  console.error('用法: node scripts/scan-archive.mjs <archive.zip|archive.tgz> [--json]')
  process.exit(2)
}

// --- name rules ------------------------------------------------------------

/**
 * File names that must never ship, wherever they sit.
 *
 * `.env.example` is deliberately allowed: it documents which variables exist and carries no
 * values. Everything else starting with `.env.` is a real environment file.
 */
const FORBIDDEN_NAMES = [
  { re: /^\.env$/i, label: '环境变量文件' },
  { re: /^\.env\.(?!example$)/i, label: '环境变量文件' },
  { re: /^\.credentials/i, label: '凭据文件' },
  { re: /^credentials\.(json|ya?ml|txt)$/i, label: '凭据文件' },
  { re: /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i, label: 'SSH 私钥' },
  { re: /\.(pem|key|pfx|p12|keystore|jks)$/i, label: '私钥/证书文件' },
  { re: /^\.netrc$/i, label: '网络凭据文件' },
  { re: /^\.npmrc$/i, label: 'npm 凭据文件' },
  { re: /^\.git-credentials$/i, label: 'Git 凭据文件' },
  { re: /^\.(bash_history|zsh_history|python_history)$/i, label: '命令历史' },
]

/** Directory segments that must never appear in a published archive. */
const FORBIDDEN_DIRS = ['.ssh', '.dsh', '.git', '.aws', '.gnupg', '.kube', '.docker']

// --- content rules ---------------------------------------------------------

/**
 * Credential shapes.
 *
 * The task book says a regex must not be the only protection — it is not: the allowlist is the
 * primary control, and this is the second line. It catches exactly the mistakes that happen (a
 * pasted key, a committed cookie) rather than trying to prove absence.
 */
const SECRET_PATTERNS = [
  { re: /\bBDUSS=[A-Za-z0-9+/=]{20,}/, label: '贴吧 BDUSS Cookie' },
  { re: /\bSTOKEN=[A-Za-z0-9+/=]{20,}/, label: '贴吧 STOKEN Cookie' },
  { re: /\bBAIDUID=[A-Za-z0-9+/=:]{20,}/, label: '百度 BAIDUID Cookie' },
  { re: /\b(?:sk|pk)-[A-Za-z0-9]{20,}/, label: 'API key（sk-/pk- 前缀）' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{30,}/, label: 'Bearer 令牌' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, label: '私钥内容' },
  { re: /\bm0sk_[A-Za-z0-9]{16,}/, label: 'mem0 API key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, label: 'GitHub 令牌' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key id' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack 令牌' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API key' },
  { re: /\bsk_live_[A-Za-z0-9]{20,}/, label: 'Stripe live key' },
]

/**
 * 精确的假数据例外（v0.2.39 复审 §2）。
 *
 * 这里原来也有一条 `test/`、`docs/` 整目录跳过，外加一份按文件名的豁免表和一串
 * 「行里出现 fixture 关键字」的正则。三者都不可验证：把一把真钥匙放进任何一个测试文件，
 * 独立扫描器会安静地放行 —— 而它存在的意义正是「不信任打包器」。
 *
 * 现在只认「这个路径里的这一串确切字符」。登记表与打包器共用
 * `scripts/lib/fixture-allowlist.mjs`：共用的是「哪些字节被认定为假数据」这个事实，
 * 两边的模式表与判定流程仍然各写各的，所以一个扫描器漏掉的形状，另一个仍有机会拦到。
 */

// --- readers ---------------------------------------------------------------

/**
 * An archive that cannot be read in full.
 *
 * `code` exists so tests and logs can tell the classes apart without any of them carrying
 * archive content: `truncated` (fewer bytes than the format declares), `corrupt` (bytes are
 * there but do not decode), `unsupported` (a legal format feature this reader does not
 * implement), `bounds` (a length or offset points outside the archive).
 */
class ArchiveError extends Error {
  /**
   * @param {'truncated' | 'corrupt' | 'unsupported' | 'bounds'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

const ZIP_EOCD = 0x06054b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_LOCAL = 0x04034b50

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

/**
 * Read a ZIP through its **central directory**.
 *
 * Scanning for the central-directory signature at arbitrary offsets — what this file used to
 * do — finds entries that a truncated or malformed archive never declared, and misses the ones
 * it did. The end-of-central-directory record is the archive's own index; when it is absent or
 * inconsistent, the archive is not readable and the scan must say so.
 *
 * @param {Buffer} buffer
 * @returns {Array<{ name: string, kind: 'file' | 'directory' | 'nonregular', typeflag?: string, data?: Buffer }>}
 */
function readZip(buffer) {
  if (buffer.length < 22) throw new ArchiveError('truncated', '归档小于一个 ZIP 结尾记录（22 字节）')

  let eocd = -1
  const lowest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD) continue
    // The comment length must consume exactly the rest of the file. Without this check a
    // signature inside a compressed payload can be mistaken for the index.
    if (offset + 22 + buffer.readUInt16LE(offset + 20) !== buffer.length) continue
    eocd = offset
    break
  }
  if (eocd === -1) {
    throw new ArchiveError('truncated', '找不到中央目录结束记录：归档被截断，或不是 ZIP')
  }

  const disk = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  if (disk !== 0 || centralDisk !== 0) {
    throw new ArchiveError('unsupported', '不支持分卷 ZIP')
  }

  const count = buffer.readUInt16LE(eocd + 10)
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (
    count === 0xffff ||
    entriesOnDisk === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new ArchiveError('unsupported', '不支持 ZIP64')
  }
  // Two counts that disagree mean the index does not describe itself. A reader that
  // trusts the smaller one walks a prefix of the archive and reports it as the whole.
  if (entriesOnDisk !== count) {
    throw new ArchiveError(
      'corrupt',
      `中央目录声称本盘 ${entriesOnDisk} 条、共 ${count} 条，两者不一致`,
    )
  }
  const centralEnd = centralOffset + centralSize
  if (centralEnd > eocd) {
    throw new ArchiveError('bounds', '中央目录的偏移与长度越过了结尾记录')
  }
  // The central directory is the last thing before the end record. Anything between
  // them is an index the record did not declare — which is exactly how a hidden
  // entry survives a reader that only walks the declared length.
  if (centralEnd !== eocd) {
    throw new ArchiveError(
      'corrupt',
      '中央目录与结尾记录之间有未说明的数据：条目数或目录长度被少报',
    )
  }

  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd) throw new ArchiveError('truncated', `中央目录第 ${index + 1} 条不完整`)
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL) {
      throw new ArchiveError('corrupt', `中央目录第 ${index + 1} 条的签名不对`)
    }

    const madeBy = buffer.readUInt16LE(cursor + 4)
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const expectedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const external = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)

    if (cursor + 46 + nameLength + extraLength + commentLength > eocd) {
      throw new ArchiveError('truncated', `中央目录第 ${index + 1} 条的名称/扩展字段超出目录`)
    }
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    if (name === '') throw new ArchiveError('corrupt', `中央目录第 ${index + 1} 条没有名称`)

    cursor += 46 + nameLength + extraLength + commentLength

    // Type from the external attributes. Unix host = 3; the high 16 bits are st_mode.
    const host = madeBy >> 8
    const mode = (external >>> 16) & 0xffff
    const isDirectory = name.endsWith('/') || (external & 0x10) !== 0
    const isUnixNonRegular = host === 3 && mode !== 0 && (mode & 0xf000) !== 0x8000 && (mode & 0xf000) !== 0x4000
    // Non-regular is decided **before** the directory branch, and by the mode rather
    // than by the name: an entry can be named `x/` and still carry a symlink's mode,
    // and a name is not a type. Checking the name first let exactly that through.
    if (isUnixNonRegular) {
      entries.push({
        name,
        kind: 'nonregular',
        typeflag: `mode ${(mode & 0xf000).toString(8)}`,
      })
      continue
    }
    if (isDirectory) {
      // A directory has no content, so it must declare none. A "directory" carrying a
      // payload, an encryption bit, or a compression method this reader does not
      // implement is a file wearing a directory's name — and skipping it is the one
      // failure mode a security scan cannot have: the bytes nobody read are the bytes
      // nobody can vouch for.
      if (compressedSize !== 0 || uncompressedSize !== 0) {
        throw new ArchiveError(
          'corrupt',
          `目录条目 ${name} 声明了 ${compressedSize}/${uncompressedSize} 字节的内容，目录不应有负载`,
        )
      }
      if ((flags & 0x1) !== 0) {
        throw new ArchiveError('unsupported', `目录条目 ${name} 已加密，无法扫描`)
      }
      if (method !== 0 && method !== 8) {
        throw new ArchiveError('unsupported', `目录条目 ${name} 使用不支持的压缩方式 ${method}`)
      }
      entries.push({ name, kind: 'directory' })
      continue
    }

    if ((flags & 0x1) !== 0) {
      throw new ArchiveError('unsupported', `条目 ${name} 已加密，无法扫描`)
    }
    if (method !== 0 && method !== 8) {
      throw new ArchiveError('unsupported', `条目 ${name} 使用不支持的压缩方式 ${method}`)
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ArchiveError('unsupported', `条目 ${name} 需要 ZIP64`)
    }

    if (localOffset + 30 > centralOffset) {
      throw new ArchiveError('bounds', `条目 ${name} 的本地头偏移越过中央目录`)
    }
    if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL) {
      throw new ArchiveError('corrupt', `条目 ${name} 的本地头签名不对`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart > centralOffset) {
      throw new ArchiveError('bounds', `条目 ${name} 的数据起点越过中央目录`)
    }
    if (dataStart + compressedSize > centralOffset) {
      throw new ArchiveError('truncated', `条目 ${name} 的数据被截断`)
    }

    const payload = buffer.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) {
      data = Buffer.from(payload)
    } else {
      try {
        data = inflateRawSync(payload)
      } catch {
        throw new ArchiveError('corrupt', `条目 ${name} 的 deflate 数据损坏`)
      }
    }
    if (data.length !== uncompressedSize) {
      throw new ArchiveError('bounds', `条目 ${name} 解压后长度与声明不符`)
    }
    if (crc32(data) !== expectedCrc) {
      throw new ArchiveError('corrupt', `条目 ${name} 的 CRC 与内容不符`)
    }
    entries.push({ name, kind: 'file', data })
  }

  // The walk must consume exactly the declared central directory.
  //
  // The loop bound is `count`, so an under-reported count walks a *prefix* and
  // returns it as the whole archive — with every entry past the prefix never opened.
  // The opposite direction already fails on its own (the walk runs off the end of the
  // directory and the next signature check rejects it), which is why this check is the
  // one that was missing: it is only reachable when the record lies downwards.
  if (cursor !== centralEnd) {
    throw new ArchiveError(
      'corrupt',
      `中央目录长度与条目数不符：声称 ${count} 条 / ${centralSize} 字节，` +
        `实际遍历到 ${cursor - centralOffset} 字节`,
    )
  }

  return entries
}

/**
 * Validate a ustar header checksum.
 *
 * This is the tar format's own integrity check: a truncated or overwritten header fails it.
 * Without it, a garbage block is parsed as a "file" with a nonsense size and the reader walks
 * off into the payload.
 *
 * @param {Buffer} block
 */
function tarChecksumOk(block) {
  const stored = block.subarray(148, 156).toString('ascii').replace(/\0.*$/s, '').trim()
  if (!/^[0-7]+$/.test(stored)) return false
  let sum = 0
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]
  }
  return sum === Number.parseInt(stored, 8)
}

/**
 * Parse the size field. `null` means "a legal encoding this reader does not implement"
 * (GNU base-256), which must be a hard failure rather than a guess.
 *
 * @param {Buffer} block
 * @returns {number | null}
 */
function tarSize(block) {
  const field = block.subarray(124, 136)
  if ((field[0] & 0x80) !== 0) return null
  const text = field.toString('ascii').replace(/\0.*$/s, '').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) return null
  return Number.parseInt(text, 8)
}

/**
 * Read a gzipped tar.
 *
 * Stopping at the first zero block is not enough: a truncated archive can end anywhere, and the
 * previous reader silently returned whatever it had parsed. This one requires the two zero
 * blocks that terminate a tar, rejects trailing non-zero bytes, and refuses to guess a size it
 * cannot parse.
 *
 * @param {Buffer} buffer
 * @returns {Array<{ name: string, kind: 'file' | 'directory' | 'nonregular', typeflag?: string, data?: Buffer }>}
 */
function readTgz(buffer) {
  if (buffer.length < 18 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    throw new ArchiveError('unsupported', '不是 gzip 压缩的 tar（缺少 gzip 头）')
  }

  let tar
  try {
    tar = gunzipSync(buffer)
  } catch {
    throw new ArchiveError('corrupt', 'gzip 解压失败：数据损坏或归档被截断')
  }

  const entries = []
  let offset = 0
  let terminated = false

  while (offset < tar.length) {
    if (offset + 512 > tar.length) {
      throw new ArchiveError('truncated', `偏移 ${offset} 处的 tar 头不完整`)
    }
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      const next = offset + 512
      if (next + 512 <= tar.length && !tar.subarray(next, next + 512).every((byte) => byte === 0)) {
        throw new ArchiveError('corrupt', 'tar 的第一个结束块之后仍有数据')
      }
      for (let index = next + 512; index < tar.length; index += 1) {
        if (tar[index] !== 0) throw new ArchiveError('corrupt', 'tar 结束后仍有非零数据')
      }
      if (next > tar.length) throw new ArchiveError('truncated', 'tar 结束标记不完整')
      terminated = true
      break
    }

    if (!tarChecksumOk(header)) {
      throw new ArchiveError('corrupt', `偏移 ${offset} 处的 tar 头校验失败`)
    }

    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/s, '')
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '')
    const name = prefix ? `${prefix}/${rawName}` : rawName
    if (name === '') throw new ArchiveError('corrupt', `偏移 ${offset} 处的 tar 条目没有名称`)

    const size = tarSize(header)
    if (size === null) {
      throw new ArchiveError('unsupported', `条目 ${name} 的 tar 大小字段不是八进制（不支持 base-256）`)
    }
    const dataStart = offset + 512
    if (dataStart + size > tar.length) {
      throw new ArchiveError('truncated', `条目 ${name} 的数据被截断`)
    }

    const typeflag = header.toString('ascii', 156, 157) || '\0'
    if (typeflag === '5') {
      entries.push({ name, kind: 'directory', typeflag })
    } else if (typeflag === '0' || typeflag === '\0') {
      entries.push({ name, kind: 'file', data: tar.subarray(dataStart, dataStart + size) })
    } else {
      // Symlink, hardlink, device, FIFO, PAX/GNU metadata…: legal tar, but a release source
      // archive has no business carrying one, and its "content" is not a file to scan.
      entries.push({ name, kind: 'nonregular', typeflag })
    }

    offset = dataStart + Math.ceil(size / 512) * 512
  }

  if (!terminated) {
    throw new ArchiveError('truncated', '缺少 tar 结束标记：归档被截断')
  }

  return entries
}

// --- scan ------------------------------------------------------------------

const archive = readFileSync(path)
const isZip = extname(path).toLowerCase() === '.zip'

let entries
try {
  entries = isZip ? readZip(archive) : readTgz(archive)
} catch (error) {
  const reason = error instanceof ArchiveError ? `[${error.code}] ${error.message}` : `[unknown] ${String(error instanceof Error ? error.message : error)}`
  const report = {
    archive: path,
    error: reason,
    findings: [],
    clean: false,
  }
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.error(`扫描失败：${reason}`)
    console.error('  归档里有无法扫描的内容。这类文件必须让整轮扫描失败，不能跳过。')
  }
  process.exit(3)
}

const findings = []
const stats = { files: 0, directories: 0, nonregular: 0, binary: 0 }

for (const entry of entries) {
  // Archives wrap everything in `package/`; strip it so the exemption list can use repo paths.
  const normalised = entry.name.replace(/^package\//, '').replace(/^\.\//, '')
  const segments = normalised.split('/')
  const name = segments[segments.length - 1]

  for (const segment of segments) {
    if (FORBIDDEN_DIRS.includes(segment)) {
      findings.push(pathFinding({ path: normalised, rule: `禁止目录 ${segment}` }))
      break
    }
  }

  for (const { re, label } of FORBIDDEN_NAMES) {
    if (re.test(name)) {
      findings.push(pathFinding({ path: normalised, rule: label }))
      break
    }
  }

  if (entry.kind === 'directory') {
    stats.directories += 1
    continue
  }
  if (entry.kind === 'nonregular') {
    stats.nonregular += 1
    findings.push(
      pathFinding({
        path: normalised,
        rule: `非普通文件条目（typeflag ${entry.typeflag ?? '?'}）`,
        kind: 'type',
      }),
    )
    continue
  }

  stats.files += 1
  const data = entry.data ?? Buffer.alloc(0)
  const binary = data.includes(0)
  if (binary) stats.binary += 1
  const text = data.toString('utf8')

  for (const { re, label } of SECRET_PATTERNS) {
    if (!re.test(text)) continue
    // 同一行可能命中多次；逐次判定，别让一处登记过的假值替后面的真值开路。
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)

    if (binary) {
      for (const match of text.matchAll(global)) {
        if (isRegisteredFakeLiteral(normalised, match[0], '')) continue
        findings.push(contentFinding({ path: normalised, rule: label, offset: match.index }))
      }
      continue
    }

    text.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(global)) {
        if (isRegisteredFakeLiteral(normalised, match[0], line)) continue
        findings.push(
          contentFinding({
            path: normalised,
            rule: label,
            line: index + 1,
            column: (match.index ?? 0) + 1,
          }),
        )
      }
    })
  }
}

const report = {
  archive: path,
  entries: entries.length,
  scannedFiles: stats.files,
  directories: stats.directories,
  nonregular: stats.nonregular,
  binaryFiles: stats.binary,
  findings,
  clean: findings.length === 0,
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`扫描 ${path}`)
  console.log(`  条目：${entries.length}（文件 ${stats.files}，目录 ${stats.directories}，非普通 ${stats.nonregular}）`)
  if (findings.length === 0) {
    console.log('  结果：未发现敏感文件或凭据')
  } else {
    console.log(`  结果：发现 ${findings.length} 处问题（只显示位置，不显示内容）`)
    for (const finding of findings) {
      console.log(`    ${formatFinding(finding)} — ${finding.rule}`)
    }
  }
}

process.exit(findings.length === 0 ? 0 : 1)
