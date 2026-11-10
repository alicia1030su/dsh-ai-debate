/**
 * 归档核验器的索引完整性（v0.3.0，issue #29）。
 *
 * ## 这条测试来自一个真实的「绿得没有意义」
 *
 * `archive-verify.mjs` 原来按 EOCD 声明的条目数遍历中央目录。一个**少报自己**的索引
 * （声称 1 条、磁盘上 2 条）只会被读到一个前缀，第二条从未被打开；而核验器只比对
 * 读到的条目，于是它对一个不完整的归档给出「归档内容与已提交内容完全一致」。
 *
 * 更糟的是它和扫描器不同步：v0.2.39 的收口只在 `scan-archive.mjs` 里补了索引一致性
 * 检查，核验器没有。两个工具对同一个归档给出相反结论时，可信的是那个说「有问题」的，
 * 但发布流程读的是两个都绿才算过 —— 所以核验器的漏判会直接变成发布闸门的漏判。
 *
 * ## 断言口径
 *
 * 所有负向用例都要求 `readZipEntries` **抛错**，而不是返回一个较短的列表。理由：
 * 返回较短的列表无法与「归档本来就小」区分，调用方只能靠自觉去比长度，而自觉不是判据。
 *
 * 正向用例只有两条：合法归档能读、目录条目被识别且不参与逐文件比对。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'

import { readZipEntries, verifyArchive } from '../scripts/lib/archive-verify.mjs'
import { isUnsafePath, judgeZipBudget, judgeZipIndex } from '../scripts/lib/zip-index.mjs'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Entry {
  readonly name: string
  readonly data?: Buffer
  readonly method?: number
  readonly external?: number
  readonly madeBy?: number
  readonly declaredSize?: number
  readonly declaredCompressedSize?: number
}

interface Options {
  /** EOCD 里写的「本盘条目数」；默认等于实际条目数。 */
  readonly entriesOnDisk?: number
  /** EOCD 里写的「总条目数」；默认等于实际条目数。 */
  readonly totalEntries?: number
  /** 中央目录声明长度的增量；负数表示少报，留下空隙。 */
  readonly centralSizeDelta?: number
}

/** 构造一个 ZIP；所有畸形都是显式参数，不在函数内部猜。 */
function buildZip(entries: readonly Entry[], options: Options = {}): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? 0
    const payload = method === 8 ? deflateRawSync(raw) : raw
    const compressedSize = entry.declaredCompressedSize ?? payload.length
    const uncompressedSize = entry.declaredSize ?? raw.length
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressedSize, 18)
    header.writeUInt32LE(uncompressedSize, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(entry.madeBy ?? 0x0300, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressedSize, 20)
    centralHeader.writeUInt32LE(uncompressedSize, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt32LE((entry.external ?? 0) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, nameBytes)

    offset += header.length + nameBytes.length + payload.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(options.entriesOnDisk ?? entries.length, 8)
  end.writeUInt16LE(options.totalEntries ?? entries.length, 10)
  end.writeUInt32LE(centralBuffer.length + (options.centralSizeDelta ?? 0), 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...local, centralBuffer, end])
}

/** 一条普通文件条目。 */
function file(name: string, body = 'x\n'): Entry {
  return { name, data: Buffer.from(body, 'utf8'), method: 0 }
}

test('索引规则：路径穿越按分段判定，不误伤普通名字', () => {
  assert.equal(isUnsafePath('../etc/passwd'), true)
  assert.equal(isUnsafePath('a/../../b'), true)
  assert.equal(isUnsafePath('/etc/passwd'), true)
  assert.equal(isUnsafePath('C:/Windows/win.ini'), true)
  assert.equal(isUnsafePath('..\\windows'), true)
  assert.equal(isUnsafePath('src/x.ts'), false)
  assert.equal(isUnsafePath('..%2fname'), false, '编码后的点号只是一个普通文件名')
  assert.equal(isUnsafePath('a/../b'), false, '归一化后仍在根目录内')
})

test('索引规则：预算按声明值判定，不先分配内存', () => {
  const entry = {
    name: 'a.bin',
    flags: 0,
    method: 0,
    compressedSize: 10,
    uncompressedSize: 999_999_999,
    crc: 0,
    localOffset: 0,
    mode: 0,
    hostUnix: false,
    kind: 'file' as const,
  }
  const problems = judgeZipBudget([entry], { maxEntryBytes: 1024, maxTotalBytes: 2048, maxEntries: 10 })
  assert.ok(problems.some((problem) => problem.includes('超过单条上限')), problems.join('；'))
})

test('索引规则：少报条目数会被判定为不可信', () => {
  const verdict = judgeZipIndex({
    entriesOnDisk: 1,
    totalEntries: 1,
    centralSize: 100,
    centralOffset: 0,
    eocdOffset: 100,
    walked: 2,
    walkedEnd: 160,
    entries: [],
  })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some((problem) => problem.includes('实际遍历到 2 条')), verdict.problems.join('；'))
})

test('核验：EOCD 少报条目数时必须抛错，不能只读一个前缀', () => {
  const bytes = buildZip([file('package/a.ts'), file('package/b.ts')], { entriesOnDisk: 1, totalEntries: 1 })
  assert.throws(() => readZipEntries(bytes), /索引不可信/)
})

test('核验：本盘条数与总条数不一致时必须抛错', () => {
  const bytes = buildZip([file('package/a.ts'), file('package/b.ts')], {
    entriesOnDisk: 1,
    totalEntries: 2,
  })
  assert.throws(() => readZipEntries(bytes), /索引不可信/)
})

test('核验：中央目录声明的长度少报时必须抛错', () => {
  const bytes = buildZip([file('package/a.ts'), file('package/b.ts')], { centralSizeDelta: -8 })
  assert.throws(() => readZipEntries(bytes), /索引不可信|中央目录/)
})

test('核验：重复文件名必须抛错', () => {
  const bytes = buildZip([file('package/a.ts'), file('package/a.ts', 'y\n')])
  assert.throws(() => readZipEntries(bytes), /重复的条目名/)
})

test('核验：路径穿越必须抛错', () => {
  const bytes = buildZip([file('../../etc/passwd')])
  assert.throws(() => readZipEntries(bytes), /路径穿越/)
})

test('核验：符号链接条目必须抛错', () => {
  const bytes = buildZip([
    { name: 'package/link', external: (0o120777 << 16) >>> 0, madeBy: 0x0300 },
  ])
  assert.throws(() => readZipEntries(bytes), /非普通文件条目/)
})

test('核验：不支持的压缩方式必须抛错', () => {
  const bytes = buildZip([{ name: 'package/a.ts', data: Buffer.from('x'), method: 12 }])
  assert.throws(() => readZipEntries(bytes), /不支持的压缩方式/)
})

test('核验：截断归档必须抛错', () => {
  const bytes = buildZip([file('package/a.ts')])
  assert.throws(() => readZipEntries(bytes.subarray(0, bytes.length - 30)), /找不到中央目录结束记录|截断/)
})

test('核验：声明尺寸超过单条上限时必须抛错（不解压）', () => {
  const bytes = buildZip([{ name: 'package/big.bin', data: Buffer.from('x'), declaredSize: 999_999_999 }])
  assert.throws(() => readZipEntries(bytes), /超过单条上限/)
})

test('核验：合法归档可读，目录条目被识别且不进入逐文件比对', () => {
  const bytes = buildZip([
    { name: 'package/', external: (0o040755 << 16) >>> 0, madeBy: 0x0300 },
    file('package/a.ts', 'export const a = 1\n'),
  ])
  const entries = readZipEntries(bytes)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.kind, 'directory')
  assert.equal(entries[1]!.kind, 'file')

  const blob = Buffer.from('export const a = 1\n', 'utf8')
  const result = verifyArchive(bytes, new Map([['package/a.ts', blob]]), 1)
  assert.equal(result.verdicts.length, 0, '目录条目不应被报成「归档里有、HEAD 里没有」')
  assert.equal(result.identical, 1)
  assert.equal(result.missing.length, 0)
})
