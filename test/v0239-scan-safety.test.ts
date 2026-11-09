/**
 * 发布安全收口：扫描器不得输出凭据原文，且不得跳过不可扫描的条目（v0.2.39 §1/§2）。
 *
 * ## 这一组测试要钉的两件事
 *
 * ### 一、发现泄露之后不要再泄露一次
 *
 * 两个扫描器原来把命中的整行放进 findings 的 `sample` 字段，并原样打印：
 * 终端、抛出异常的 message、`--json` 的产物。CI 日志是公开的，JSON 会被贴进 issue，
 * 异常栈会被上传到收集器 —— 于是一条真的 Cookie 被抓到后，最不该发生的事发生了：
 * 它被写进了日志。
 *
 * 这里的断言是**逐字节的**：注入一条凭据，运行扫描器，把 stdout、stderr、JSON 三段
 * 分别拼起来，要求里面**不出现**那条凭据。同时要求它**仍然指出位置** —— 只说「有问题」
 * 而不说哪里，等于把可修复的问题变成一个需要人工再扫一遍的问题。
 *
 * ### 二、读不出来的文件必须让整轮失败
 *
 * 原来的 ZIP 读取器按签名在整份字节里扫描，遇到解压失败就把 `data` 设成 `undefined`，
 * 然后 `continue`。于是**损坏的 deflate 流、不支持的压缩方式、被截断的数据**全都被
 * 静默跳过 —— 而「读不出来的那一个文件」正是没有人能担保的那一个。
 *
 * 现在按条目分类：目录合法、跳过的只有「没有内容」这一种；非普通条目（符号链接、
 * 硬链接、设备、PAX 头）作为发现报出来；需要扫描而读不出来的，整轮失败。
 *
 * ## 为什么凭据字面量要拆开写
 *
 * 本文件自己也在仓库里、也会进源码包、也会被同一个扫描器读。写整串会让它命中自己，
 * 于是只能再给自己开一条豁免 —— 那正是收口要消灭的东西。拆成两段再 `join`，
 * 文件字节里就不存在连续的模式，运行时拼出来的仍然是精确的那一串。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync, gzipSync } from 'node:zlib'

const REPO = join(import.meta.dirname, '..')
const SCANNER = join(REPO, 'scripts', 'scan-archive.mjs')
const PACKER = join(REPO, 'scripts', 'source-zip.mjs')

/** 一条**没有登记**的 AWS 形状凭据。拼出来，避免本文件自己命中扫描器。 */
function testCredential(): string {
  return ['AKIA', 'QWERTYUIOPASDFGH'].join('')
}

/** 运行一个脚本，分别拿到退出码与两路输出。 */
function run(script: string, args: readonly string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

// --- 最小 ZIP 写入器（只为构造测试用的畸形归档） -------------------------

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

interface ZipEntry {
  readonly name: string
  /** 未压缩内容；`undefined` 表示这个条目不该有内容（目录、符号链接）。 */
  readonly data?: Buffer
  /** 0 = stored，8 = deflate，其它 = 用来测「不支持的压缩方式」。 */
  readonly method?: number
  /** 写入的实际负载；用来构造「声明长度与内容不符」。 */
  readonly payload?: Buffer
  /** `external` 的高 16 位是 Unix mode，低字节含 MS-DOS 属性位。 */
  readonly external?: number
  /** `madeBy` 决定高字节：3 = Unix。 */
  readonly madeBy?: number
  /** 声明一个与真实数据不同的解压后长度。 */
  readonly declaredSize?: number
  /** 声明一个错误的 CRC。 */
  readonly declaredCrc?: number
  /** 声明一个与真实 payload 不同的压缩长度。 */
  readonly declaredCompressedSize?: number
}

/** 构造一个 ZIP；只实现扫描器需要读的那几个字段。 */
function buildZip(entries: readonly ZipEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? 0
    const payload = entry.payload ?? (method === 0 ? raw : deflateRawSync(raw))
    const declaredCompressed = entry.declaredCompressedSize ?? payload.length
    const declaredSize = entry.declaredSize ?? raw.length
    const declaredCrc = entry.declaredCrc ?? crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt32LE(declaredCrc, 14)
    header.writeUInt32LE(declaredCompressed, 18)
    header.writeUInt32LE(declaredSize, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, nameBytes, payload)

    const entryHeader = Buffer.alloc(46)
    entryHeader.writeUInt32LE(0x02014b50, 0)
    entryHeader.writeUInt16LE(entry.madeBy ?? 0x0300, 4)
    entryHeader.writeUInt16LE(20, 6)
    entryHeader.writeUInt16LE(0, 8)
    entryHeader.writeUInt16LE(method, 10)
    entryHeader.writeUInt16LE(0, 12)
    entryHeader.writeUInt16LE(0, 14)
    entryHeader.writeUInt32LE(declaredCrc, 16)
    entryHeader.writeUInt32LE(declaredCompressed, 20)
    entryHeader.writeUInt32LE(declaredSize, 24)
    entryHeader.writeUInt16LE(nameBytes.length, 28)
    entryHeader.writeUInt16LE(0, 30)
    entryHeader.writeUInt16LE(0, 32)
    entryHeader.writeUInt16LE(0, 34)
    entryHeader.writeUInt16LE(0, 36)
    entryHeader.writeUInt32LE((entry.external ?? 0) >>> 0, 38)
    entryHeader.writeUInt32LE(offset, 42)
    central.push(entryHeader, nameBytes)

    offset += header.length + nameBytes.length + payload.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...local, centralBuffer, end])
}

/** Unix 目录的 mode。 */
const MODE_DIR = 0o040755
/** Unix 符号链接的 mode。 */
const MODE_SYMLINK = 0o120777

// --- 最小 tar 写入器 ------------------------------------------------------

function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, Math.min(Buffer.byteLength(name), 99), 'utf8')
  block.write('0000644\0', 100, 'ascii')
  block.write('0000000\0', 108, 'ascii')
  block.write('0000000\0', 116, 'ascii')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  block.write('00000000000\0', 136, 'ascii')
  block.fill(0x20, 148, 156)
  block.write(typeflag, 156, 'ascii')
  block.write('ustar', 257, 'ascii')
  block.write('00', 263, 'ascii')

  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

function buildTgz(
  entries: readonly { name: string, data?: Buffer, typeflag?: string }[],
  options: { readonly terminate?: boolean } = {},
): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0)
    chunks.push(tarHeader(entry.name, data.length, entry.typeflag ?? '0'))
    chunks.push(data)
    const remainder = data.length % 512
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder, 0))
  }
  if (options.terminate !== false) chunks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}

/** 写出一个归档并返回路径与它的目录。 */
function writeArchive(name: string, bytes: Buffer): { path: string, dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scan-'))
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return { path, dir }
}

// --- 一、不得输出凭据原文 -------------------------------------------------

test('扫描器：命中凭据时退出非零，但 stdout / stderr / JSON 都不含凭据原文', () => {
  const credential = testCredential()
  const body = Buffer.from(`line one is harmless\nconst key = ${credential}\nline three\n`, 'utf8')
  const archive = writeArchive('leaky.zip', buildZip([{ name: 'package/src/config.ts', data: body, method: 8 }]))
  try {
    for (const extraArgs of [[], ['--json']] as const) {
      const result = run(SCANNER, [archive.path, ...extraArgs], REPO)
      assert.notEqual(result.code, 0, `命中必须有非零退出（参数 ${extraArgs.join(' ') || '无'}）`)

      const everything = `${result.stdout}\n${result.stderr}`
      assert.equal(
        everything.includes(credential),
        false,
        `扫描输出里出现了凭据原文（参数 ${extraArgs.join(' ') || '无'}）：\n${everything.slice(0, 800)}`,
      )
      // 连片段也不行：前 8 位就足够缩小猜测范围。
      assert.equal(
        everything.includes(credential.slice(0, 8)),
        false,
        '扫描输出里出现了凭据的前缀片段',
      )

      // 但仍然要指出位置与规则：只说「有问题」而不说哪里，等于没发现问题。
      const combined = `${result.stdout}${result.stderr}`
      assert.match(combined, /config\.ts/, '必须给出文件路径')
      assert.match(combined, /AWS/, '必须给出命中的规则名')
      // 文本模式是 `path:line:column`，JSON 模式是 `"line": 2`；两种都必须给出行号。
      assert.match(
        combined,
        /:2:|"line":\s*2\b/,
        '必须给出行号（凭据在第 2 行）',
      )
    }
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('扫描器：JSON 结构里没有 sample / 命中内容字段', () => {
  const credential = testCredential()
  const archive = writeArchive('leaky-json.zip', buildZip([
    { name: 'package/src/leak.ts', data: Buffer.from(`x = ${credential}\n`, 'utf8'), method: 0 },
  ]))
  try {
    const result = run(SCANNER, [archive.path, '--json'], REPO)
    assert.notEqual(result.code, 0)
    const report = JSON.parse(result.stdout) as { findings: Record<string, unknown>[], clean: boolean }
    assert.equal(report.clean, false)
    assert.ok(report.findings.length > 0, 'JSON 里必须有 findings')
    for (const finding of report.findings) {
      assert.equal('sample' in finding, false, `findings 不得带 sample 字段：${JSON.stringify(finding)}`)
      assert.equal('match' in finding, false, 'findings 不得带命中子串')
      assert.equal('line' in finding || 'offset' in finding, true, '必须给出可定位的行号或偏移')
      for (const value of Object.values(finding)) {
        assert.equal(
          typeof value === 'string' ? value.includes(credential) : false,
          false,
          'findings 的任何字段都不得包含凭据原文',
        )
      }
    }
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('扫描器：二进制文件里的凭据同样被发现，且输出不含原文', () => {
  const credential = testCredential()
  // 一张「PNG」：头部是二进制，中间夹一个凭据。原来的实现在 `includes(0)` 处直接跳过。
  const data = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0x00]),
    Buffer.from(credential, 'utf8'),
    Buffer.from([0x00, 0x01, 0x02]),
  ])
  const archive = writeArchive('binary.zip', buildZip([{ name: 'package/docs/image.png', data, method: 0 }]))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.notEqual(result.code, 0, '二进制不是免检区：PNG 元数据里同样可能藏着令牌')
    assert.equal(`${result.stdout}${result.stderr}`.includes(credential), false)
    assert.match(result.stdout + result.stderr, /image\.png/, '必须指出是哪个文件')
    assert.match(result.stdout + result.stderr, /@\d+/, '二进制命中用字节偏移定位')
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('打包器：命中凭据时异常信息里没有原文，但有文件与行号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pack-leak-'))
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-pack-out-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'leak-fixture', version: '9.9.9' }), 'utf8')
    writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1\n', 'utf8')
    copyFileSync(PACKER, join(dir, 'scripts', 'source-zip.mjs'))
    copyFileSync(join(REPO, 'scripts', 'lib', 'git-objects.mjs'), join(dir, 'scripts', 'lib', 'git-objects.mjs'))
    copyFileSync(
      join(REPO, 'scripts', 'lib', 'fixture-allowlist.mjs'),
      join(dir, 'scripts', 'lib', 'fixture-allowlist.mjs'),
    )
    copyFileSync(join(REPO, 'scripts', 'lib', 'scan-finding.mjs'), join(dir, 'scripts', 'lib', 'scan-finding.mjs'))

    const credential = testCredential()
    // 白名单目录里的第 2 行 —— 文件名过滤救不了它，只有字节扫描能拦。
    writeFileSync(join(dir, 'src', 'leaked.ts'), `// harmless\nconst key = "${credential}"\n`, 'utf8')

    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: dir })
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir })

    const result = run(join(dir, 'scripts', 'source-zip.mjs'), ['--out', outDir], dir)
    assert.notEqual(result.code, 0, '白名单目录里的真凭据必须让打包失败')
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(credential),
      false,
      '打包失败的输出里不得出现凭据原文',
    )
    assert.match(result.stderr, /src\/leaked\.ts/, '异常信息要指出文件')
    assert.match(result.stderr, /:2/, '异常信息要指出行号')
    assert.match(result.stderr, /AWS/, '异常信息要指出规则名')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

// --- 二、不可扫描的条目必须让整轮失败 -------------------------------------

test('归档：合法目录条目被接受并计入，不当作「跳过」', () => {
  const archive = writeArchive('dirs.zip', buildZip([
    { name: 'package/', external: (MODE_DIR << 16) >>> 0 },
    { name: 'package/src/', external: (MODE_DIR << 16) >>> 0 },
    { name: 'package/src/index.ts', data: Buffer.from('export const a = 1\n', 'utf8'), method: 8 },
  ]))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 0, `目录条目应当放行，实际：${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /目录 2/, '目录必须被计数：它们是被「识别为目录」，不是被跳过')
    assert.match(result.stdout, /文件 1/)
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：目录条目里的禁止路径仍然命中（目录不是免检区）', () => {
  const archive = writeArchive('dir-env.zip', buildZip([
    { name: 'package/.env/', external: (MODE_DIR << 16) >>> 0 },
  ]))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    // `.env/` 的名字以斜杠结尾，`FORBIDDEN_NAMES` 匹配的是末段名（空串之外的那一段）。
    // 目录本身不该被当成「环境变量文件」，但它是目录这一点要被承认。
    assert.match(result.stdout, /目录 1/, '带禁止前缀的目录仍要被识别为目录而不是文件')
    assert.equal(
      /环境变量文件/.test(result.stdout),
      false,
      '目录名不带文件语义，不应误判成环境变量文件',
    )
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：Unix 符号链接条目作为发现报出，不静默跳过', () => {
  const archive = writeArchive('symlink.zip', buildZip([
    { name: 'package/src/link', external: (MODE_SYMLINK << 16) >>> 0, madeBy: 0x0300 },
  ]))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.notEqual(result.code, 0, '符号链接条目必须让扫描失败，不能当成「没有内容」跳过')
    assert.match(result.stdout + result.stderr, /非普通文件条目/, '必须说明它是什么类型')
    assert.match(result.stdout + result.stderr, /src\/link/, '必须指出是哪个条目')
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：TGZ 里的符号链接（typeflag 2）同样作为发现报出', () => {
  const bytes = buildTgz([
    { name: 'package/src/link', data: Buffer.from('target\n', 'utf8'), typeflag: '2' },
  ])
  const archive = writeArchive('symlink.tgz', bytes)
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.notEqual(result.code, 0, 'tgz 里的符号链接必须让扫描失败')
    assert.match(result.stdout + result.stderr, /非普通文件条目/)
    assert.match(result.stdout + result.stderr, /typeflag 2/)
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：不支持的压缩方式必须整轮失败（exit 3），不是跳过', () => {
  const archive = writeArchive('method.zip', buildZip([
    { name: 'package/src/index.ts', data: Buffer.from('hello\n', 'utf8'), method: 12 }, // bzip2
  ]))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 3, `必须是「无法读取」的退出码，实际 ${result.code}：${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /不支持的压缩方式 12/, '必须说明是压缩方式的问题')
    assert.match(result.stderr, /src\/index\.ts/, '必须指出是哪一条')
    assert.equal(/未发现敏感文件或凭据/.test(result.stdout + result.stderr), false, '不能声称干净')
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：损坏的 deflate 数据必须整轮失败', () => {
  const archive = writeArchive('corrupt-deflate.zip', buildZip([
    { name: 'package/src/index.ts', data: Buffer.from('hello\n', 'utf8'), method: 8, payload: Buffer.from([0xff, 0xff, 0xff, 0xff]) , declaredCompressedSize: 4 },
  ]))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 3, `损坏数据必须让整轮失败，实际 ${result.code}`)
    assert.match(result.stderr, /deflate 数据损坏/, '必须说明是数据损坏')
    assert.match(result.stderr, /\[corrupt\]/, '退出原因要带分类')
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：CRC 与内容不符必须整轮失败', () => {
  const archive = writeArchive('bad-crc.zip', buildZip([
    { name: 'package/src/index.ts', data: Buffer.from('hello\n', 'utf8'), method: 0, declaredCrc: 0xdeadbeef },
  ]))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 3, 'CRC 不符说明内容被改过，必须失败')
    assert.match(result.stderr, /CRC 与内容不符/)
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：声明的解压后长度与内容不符必须整轮失败', () => {
  const archive = writeArchive('bad-length.zip', buildZip([
    { name: 'package/src/index.ts', data: Buffer.from('hello\n', 'utf8'), method: 0, declaredSize: 999 },
  ]))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 3, '长度不符属于「偏移/长度异常」，必须失败')
    assert.match(result.stderr, /长度与声明不符/)
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：被截断的 ZIP 必须整轮失败，不能只扫到一半', () => {
  const full = buildZip([
    { name: 'package/src/index.ts', data: Buffer.from('export const a = 1\n', 'utf8'), method: 8 },
    { name: 'package/src/b.ts', data: Buffer.from('export const b = 2\n', 'utf8'), method: 8 },
  ])
  const archive = writeArchive('truncated.zip', full.subarray(0, Math.floor(full.length / 2)))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 3, `截断归档必须失败，实际 ${result.code}：${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /截断/, '必须说明是截断')
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：中央目录偏移异常必须整轮失败', () => {
  const full = buildZip([{ name: 'package/a.ts', data: Buffer.from('x\n', 'utf8'), method: 0 }])
  // 把 EOCD 里的中央目录偏移改到文件之外。
  const patched = Buffer.from(full)
  patched.writeUInt32LE(patched.length + 4096, patched.length - 22 + 16)
  const archive = writeArchive('bad-offset.zip', patched)
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 3, '偏移越界必须失败，不能猜一个位置继续读')
    assert.match(result.stderr, /\[bounds\]/)
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：损坏的 gzip 必须整轮失败', () => {
  const good = buildTgz([{ name: 'package/src/index.ts', data: Buffer.from('hello\n', 'utf8') }])
  const bad = Buffer.from(good)
  bad[bad.length - 5] ^= 0xff
  bad[bad.length - 4] ^= 0xff
  const archive = writeArchive('corrupt.tgz', bad)
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 3, 'gzip 校验失败必须让整轮扫描失败')
    assert.match(result.stderr, /gzip 解压失败|truncated|corrupt/, '必须说明是哪一类问题')
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：缺少 tar 结束标记的 tgz 必须整轮失败', () => {
  const archive = writeArchive(
    'no-terminator.tgz',
    buildTgz([{ name: 'package/src/index.ts', data: Buffer.from('hello\n', 'utf8') }], { terminate: false }),
  )
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 3, `缺少结束标记说明归档不完整，实际 ${result.code}`)
    assert.match(result.stderr, /缺少 tar 结束标记/)
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

test('归档：声明大小超出归档末尾的条目必须整轮失败', () => {
  const bytes = buildTgz([{ name: 'package/src/index.ts', data: Buffer.from('hello\n', 'utf8') }])
  // 重新构造：头里声明 100000 字节，但只写了 6 字节。
  const header = tarHeader('package/src/index.ts', 100000, '0')
  const raw = Buffer.concat([header, Buffer.from('hello\n', 'utf8'), Buffer.alloc(1024, 0)])
  void bytes
  const archive = writeArchive('oversize.tgz', gzipSync(raw, { level: 9 }))
  try {
    const result = run(SCANNER, [archive.path], REPO)
    assert.equal(result.code, 3, '声明大小超出归档末尾必须失败')
    assert.match(result.stderr, /数据被截断|truncated/)
  } finally {
    rmSync(archive.dir, { recursive: true, force: true })
  }
})

// --- 三、不得靠扩大豁免来「解决」 -----------------------------------------

test('扫描器：没有整目录跳过、没有行级关键字豁免', () => {
  const source = readFileSync(SCANNER, 'utf8')
  assert.equal(
    /startsWith\('test\/'\)|startsWith\('docs\/'\)/.test(source),
    false,
    '脚本里又出现了按目录跳过：这正是收口要消灭的东西',
  )
  assert.equal(/FIXTURE_MARKER/.test(source), false, '行级关键字豁免不得回来')
  assert.equal(/SCAN_EXEMPT/.test(source), false, '文件级豁免表不得回来')
})

test('扫描器：无参数时以用法错误退出（不是 0）', () => {
  const result = run(SCANNER, [], REPO)
  assert.equal(result.code, 2, '没有参数必须是用法错误')
  assert.match(result.stderr, /用法/)
})
