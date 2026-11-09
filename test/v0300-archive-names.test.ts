/**
 * 归档名字层面的威胁（v0.3.0 阶段 F.3）。
 *
 * ## 为什么这两条要单独测
 *
 * `scan-archive.mjs` 原来的判定全部建立在「条目名是一个普通路径」这个假设上。两个反例
 * 都不需要篡改压缩数据，只要改中央目录里的名字就能做到：
 *
 * 1. **重复名**：同一个路径出现两次时，人会以为「那是一个文件」。两条内容不同的记录
 *    在解压时后写覆盖前写，扫描器如果按路径判重（比如按登记表豁免），第二条就借第一条
 *    的豁免通过。
 * 2. **路径穿越**：`../../etc/passwd` 在解压时落到归档目录之外；对扫描器而言它只是
 *    「一个名字里带点号的文件」，读过就算过 —— 但它根本不是这个归档的内容。
 *
 * 两条都属于「名字本身就有问题」，所以判定在读取内容之前。
 *
 * ## 断言口径
 *
 * 只看两件事：退出码非零、输出里点名了那个路径。不要求特定的措辞 —— 措辞会改，
 * 「有没有被拦住」不会。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'

const REPO = join(import.meta.dirname, '..')
const SCANNER = join(REPO, 'scripts', 'scan-archive.mjs')

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
}

function buildZip(entries: readonly Entry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? 0
    const payload = method === 8 ? deflateRawSync(raw) : raw

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(crc32(raw), 14)
    header.writeUInt32LE(payload.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(entry.madeBy ?? 0x0300, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt32LE(crc32(raw), 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(raw.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt32LE((entry.external ?? 0) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, nameBytes)

    offset += header.length + nameBytes.length + payload.length
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

function run(args: readonly string[]): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCANNER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

test('扫描器：重复条目名必须报出，不能给第二条借用第一条的判定', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dup-'))
  try {
    const path = join(dir, 'dup.zip')
    writeFileSync(
      path,
      buildZip([
        { name: 'package/src/a.ts', data: Buffer.from('export const a = 1\n', 'utf8'), method: 8 },
        { name: 'package/src/a.ts', data: Buffer.from('export const a = 2\n', 'utf8'), method: 8 },
      ]),
    )
    const result = run([path])
    assert.notEqual(result.code, 0, '重复名必须让扫描失败')
    assert.match(result.output, /重复的条目名/, '必须说明问题类别')
    assert.match(result.output, /src\/a\.ts/, '必须指出是哪个名字')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('扫描器：路径穿越必须报出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-traverse-'))
  try {
    const path = join(dir, 'traverse.zip')
    writeFileSync(
      path,
      buildZip([
        { name: 'package/src/ok.ts', data: Buffer.from('x\n', 'utf8'), method: 0 },
        { name: '../../etc/passwd', data: Buffer.from('root:x:0:0\n', 'utf8'), method: 0 },
      ]),
    )
    const result = run([path])
    assert.notEqual(result.code, 0, '路径穿越必须让扫描失败')
    assert.match(result.output, /路径穿越或绝对路径/, '必须说明问题类别')
    assert.match(result.output, /etc\/passwd/, '必须指出是哪个路径')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('扫描器：双向检查 —— 合法名字不被误判', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-legit-'))
  try {
    const path = join(dir, 'legit.zip')
    writeFileSync(
      path,
      buildZip([
        { name: 'package/src/a.ts', data: Buffer.from('export const a = 1\n', 'utf8'), method: 8 },
        { name: 'package/docs/guide.md', data: Buffer.from('# guide\n', 'utf8'), method: 8 },
      ]),
    )
    const result = run([path])
    assert.equal(result.code, 0, `合法归档应当放行，实际：${result.output}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
