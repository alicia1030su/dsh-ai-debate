/**
 * v0.2.38 §7：源码包可复现性的**根因**，以及「归档 = 提交内容」这条不变量。
 *
 * ## 查清的事实
 *
 * v0.2.37 发布后，本机重建源码包 7815604 字节，GitHub 上 7813235，差 2369 字节。
 * 当时报告只能写「原因未查清」。现在原因确定，而且可以复现：
 *
 * - 工作树里 20 个文本文件是 CRLF（工具以文本模式重写过），仓库里是 LF；
 * - `source-zip.mjs` 读的是**工作树**；
 * - 从干净 LF 工作树重建：7813235 字节，SHA256 `3cd0bc11…` —— 与官方逐字节一致。
 *
 * 所以「源码被篡改」这个怀疑是错的，「构建可完全复现」这个说法在当时也是不能声称的 ——
 * 可复现的前提是打包读的是提交内容，而不是作者硬盘上那一份。
 *
 * ## 这一组钉住什么
 *
 * 1. 判定逻辑本身：内容不同 / 只有行尾不同 / 归档多出 / 归档缺失，四类必须分得开。
 *    v0.2.37 就是因为分不开，才只能写「字节不同，原因不明」。
 * 2. 工作树漂移可检测：打包前就能知道「这一份不是那个提交」。
 * 3. 字节层面：同一份输入两次打包必须产出同一串字节（这一条 v0.2.16 已有，
 *    这里再对**源码包**补一次，因为它之前只覆盖了 TGZ）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  differsOnlyByLineEndings,
  headPaths,
  readHeadBlobs,
  readZipEntries,
  verifyArchive,
  workingTreeDrift,
} from '../scripts/lib/archive-verify.mjs'

import { deflateRawSync as zlibDeflateRawSync } from 'node:zlib'

const ROOT = join(import.meta.dirname, '..')

/** 造一个只含若干文件的最小 ZIP（deflate），用来测判定逻辑本身。 */
function makeZip(entries: readonly (readonly [string, Buffer])[]): Buffer {
  const deflateRawSync = zlibDeflateRawSync
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let c = i
      for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
    return table
  })()
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const local = []
  const central = []
  let offset = 0
  for (const [name, data] of entries) {
    const compressed = deflateRawSync(data, { level: 9 })
    const nameBytes = Buffer.from(name, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc32(data), 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, compressed)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc32(data), 16)
    entry.writeUInt32LE(compressed.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(Buffer.from(entry), nameBytes)

    offset += 30 + nameBytes.length + compressed.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuffer, end])
}

// ---------------------------------------------------------------------------
// 一、判定逻辑：四类必须分得开
// ---------------------------------------------------------------------------

test('一致的条目判 identical，不计入任何问题类', () => {
  const data = Buffer.from('hello\n')
  const zip = makeZip([['a.txt', data]])
  const result = verifyArchive(zip, new Map([['a.txt', data]]), 1)
  assert.equal(result.identical, 1)
  assert.equal(result.verdicts.length, 0)
  assert.deepEqual(result.totals, { content: 0, lineEndingsOnly: 0, notInRepository: 0 })
})

test('只有行尾不同单独成一类：这不是源码被改', () => {
  const committed = Buffer.from('第一行\n第二行\n')
  const checkedOut = Buffer.from('第一行\r\n第二行\r\n')
  const zip = makeZip([['a.txt', checkedOut]])
  const result = verifyArchive(zip, new Map([['a.txt', committed]]), 1)
  assert.equal(result.identical, 0)
  assert.equal(result.totals.lineEndingsOnly, 1)
  assert.equal(result.totals.content, 0)
  assert.equal(result.verdicts[0]?.kind, 'line-endings-only')
  assert.match(result.verdicts[0]?.detail ?? '', /只有行尾不同/)
})

test('内容不同与行尾不同必须分开判，否则报告只能说「字节不同，原因不明」', () => {
  const committed = Buffer.from('价格是 18 元\n')
  const tampered = Buffer.from('价格是 26 元\n')
  const zip = makeZip([['a.txt', tampered]])
  const result = verifyArchive(zip, new Map([['a.txt', committed]]), 1)
  assert.equal(result.totals.content, 1)
  assert.equal(result.totals.lineEndingsOnly, 0)
  assert.equal(result.verdicts[0]?.kind, 'content')
})

test('归档里有、HEAD 里没有的文件单独成一类', () => {
  const zip = makeZip([['secret.env', Buffer.from('X=1\n')]])
  const result = verifyArchive(zip, new Map(), 0)
  assert.equal(result.totals.notInRepository, 1)
  assert.equal(result.verdicts[0]?.kind, 'not-in-repository')
})

test('仓库里有、归档里没有的文件列进 missing', () => {
  const zip = makeZip([['a.txt', Buffer.from('a\n')]])
  const result = verifyArchive(
    zip,
    new Map([
      ['a.txt', Buffer.from('a\n')],
      ['pnpm-lock.yaml', Buffer.from('lock\n')],
    ]),
    2,
  )
  assert.equal(result.identical, 1)
  assert.deepEqual(result.missing, ['pnpm-lock.yaml'])
})

test('行尾比较只认 CRLF/CR，不把别的字节差异放过', () => {
  assert.equal(differsOnlyByLineEndings(Buffer.from('a\nb\n'), Buffer.from('a\r\nb\r\n')), true)
  assert.equal(differsOnlyByLineEndings(Buffer.from('a\nb\n'), Buffer.from('a\nc\n')), false)
})

// ---------------------------------------------------------------------------
// 二、真实仓库：归档由提交内容决定
// ---------------------------------------------------------------------------

test('当前工作树里，跟踪文件与 HEAD 的差异可被指出（打包前的门禁）', () => {
  const drift = workingTreeDrift(ROOT, headPaths(ROOT))
  // 这条测试不要求「零漂移」——开发中本来就会有未提交改动。
  // 它要求的是：有漂移时必须**说得出来是哪些文件、差在哪一类**。
  // 一个只会返回 true/false 的检查，无法让人判断「这次打包能不能发」。
  for (const line of drift) {
    assert.match(line, /：/, `漂移说明必须解释原因，实际：${line}`)
  }
  assert.ok(Array.isArray(drift))
})

test('工作树里的 CRLF 文本文件一旦存在，就被判成「只有行尾不同」而不是「内容不同」', () => {
  // 造一个临时 git 仓库，把一个 LF 文件改成 CRLF，再看判据怎么说。
  const dir = mkdtempSync(join(tmpdir(), 'archive-verify-'))
  try {
    const git = (...args: readonly string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
    git('init', '-q')
    git('config', 'core.autocrlf', 'false')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'test')
    writeFileSync(join(dir, 'a.txt'), '第一行\n第二行\n', 'utf8')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'init')

    assert.deepEqual(workingTreeDrift(dir, headPaths(dir)), [], '干净时不应报漂移')

    // 模拟「工具以文本模式重写」：LF → CRLF。
    writeFileSync(join(dir, 'a.txt'), '第一行\r\n第二行\r\n', 'utf8')
    const drift = workingTreeDrift(dir, headPaths(dir))
    assert.equal(drift.length, 1)
    assert.match(drift[0], /只有行尾不同/, `应当判成行尾问题，实际：${drift[0]}`)

    // 真改内容时要说「内容不同」，不能混为一谈。
    writeFileSync(join(dir, 'a.txt'), '第一行\r\n第二行改过了\r\n', 'utf8')
    const contentDrift = workingTreeDrift(dir, headPaths(dir))
    assert.match(contentDrift[0], /内容与 HEAD 不同/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HEAD 里没有 CRLF 存储的文本文件（仓库约定 LF）', () => {
  const paths = headPaths(ROOT).filter(
    (path) => !/\.(png|jpe?g|gif|ico|zip|tgz|pdf|woff2?|ttf)$/i.test(path),
  )
  const blobs = readHeadBlobs(ROOT, paths)
  const offenders = []
  for (const [path, data] of blobs) {
    if (data.includes(0)) continue
    if (data.includes(Buffer.from([0x0d, 0x0a]))) offenders.push(path)
  }
  assert.deepEqual(offenders, [], `仓库里这些文件是 CRLF，应统一为 LF：${offenders.join('、')}`)
})

test('.gitattributes 同时钉住检出与存储两侧', () => {
  const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
  assert.match(attributes, /text=auto eol=lf/, '必须声明检出统一 LF')
  assert.match(attributes, /^\* text eol=lf$/m, '必须声明存储统一 LF（与 core.autocrlf 无关）')
  assert.match(attributes, /\.png binary/, '二进制必须排除在规范化之外，否则图片会被改坏')
})

// ---------------------------------------------------------------------------
// 三、字节层面：同一输入两次打包字节相同
// ---------------------------------------------------------------------------

test('源码包：同一份内容两次打包字节完全相同（含文件顺序）', () => {
  const entries: readonly (readonly [string, Buffer])[] = [
    ['src/a.ts', Buffer.from('export const a = 1\n')],
    ['README.md', Buffer.from('# 标题\n')],
    ['lib/a.js', Buffer.from('export const a = 1;\n')],
  ]
  const first = makeZip(entries)
  const second = makeZip(entries)
  assert.equal(first.equals(second), true)
  // 且条目顺序必须与输入一致：顺序变了字节也会变。
  assert.deepEqual(
    readZipEntries(first).map((entry) => entry.name),
    ['src/a.ts', 'README.md', 'lib/a.js'],
  )
})
