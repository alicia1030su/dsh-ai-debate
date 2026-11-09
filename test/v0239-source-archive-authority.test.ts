/**
 * 源码包以提交为权威来源的回归测试（v0.2.39 §5）。
 *
 * ## 这一组测试要钉住的是「字节从哪来」
 *
 * v0.2.38 的诊断是「工作树行尾会污染源码包」，当时的处置是加一个打包前的漂移检查。
 * 检查能发现脏工作树，但不能阻止在一个脏工作树里打包 —— 而发布这件事不应当依赖
 * 「有人记得先跑另一个命令」。
 *
 * 所以这里的断言不看脚本的自述，只看产物：同一个提交，两个内容相同但行尾/未跟踪文件
 * 不同的工作树，必须打出同一串字节。做不到就是根因还在。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const REPO = join(import.meta.dirname, '..')
const PACKER = join(REPO, 'scripts', 'source-zip.mjs')
const GIT_OBJECTS = join(REPO, 'scripts', 'lib', 'git-objects.mjs')

/** 在一个隔离目录里建一个真实的 Git 仓库，内容与断言无关，结构与真实仓库一致。 */
function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-src-${name}-`))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'src-fixture', version: '9.9.9' }), 'utf8')
  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1\nexport const b = 2\n', 'utf8')
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n', 'utf8')
  copyFileSync(PACKER, join(dir, 'scripts', 'source-zip.mjs'))
  copyFileSync(GIT_OBJECTS, join(dir, 'scripts', 'lib', 'git-objects.mjs'))

  git('init', '-q')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'fixture')
  git('config', 'core.autocrlf', 'false')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  return dir
}

function runPacker(dir: string, extraArgs: readonly string[] = []) {
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-src-out-'))
  execFileSync(process.execPath, [join(dir, 'scripts', 'source-zip.mjs'), '--out', outDir, ...extraArgs], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const zip = join(outDir, 'dsh-ai-debate-source-9.9.9.zip')
  const bytes = readFileSync(zip)
  return { outDir, zip, bytes, sha: createHash('sha256').update(bytes).digest('hex') }
}

/** 读 ZIP 里的条目（只用本测试需要的字段）。 */
function readEntries(buffer: Buffer) {
  const entries = []
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const rawSize = buffer.readUInt32LE(offset + 22)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const dataStart = offset + 30 + nameLength + extraLength
    const method = buffer.readUInt16LE(offset + 8)
    const raw = method === 8 ? inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize)) : buffer.subarray(dataStart, dataStart + compressedSize)
    entries.push({ name, data: Buffer.from(raw), declaredSize: rawSize })
    offset = dataStart + compressedSize
  }
  return entries
}

test('源码包：同一提交的 LF 与 CRLF 工作树打出同一串字节', () => {
  const lf = makeRepo('lf')
  const crlf = makeRepo('crlf')
  try {
    // 把 crlf 那份工作树里的所有文本改成 CRLF，**不提交**。这正是 v0.2.37 的现场。
    const target = join(crlf, 'src', 'index.ts')
    writeFileSync(target, readFileSync(target, 'utf8').replace(/\n/g, '\r\n'), 'utf8')
    assert.ok(readFileSync(target).includes('\r\n'), '前提：工作树里确实是 CRLF')

    const a = runPacker(lf)
    const b = runPacker(crlf)
    assert.equal(
      b.sha,
      a.sha,
      '工作树行尾不该影响归档字节：v0.2.39 起打包读的是 Git 对象，不是磁盘',
    )
    rmSync(a.outDir, { recursive: true, force: true })
    rmSync(b.outDir, { recursive: true, force: true })
  } finally {
    rmSync(lf, { recursive: true, force: true })
    rmSync(crlf, { recursive: true, force: true })
  }
})

test('源码包：未跟踪的文件不会进包', () => {
  const dir = makeRepo('untracked')
  try {
    writeFileSync(join(dir, 'src', 'uncommitted.ts'), 'export const secret = "x"\n', 'utf8')
    writeFileSync(join(dir, 'notes.md'), '# local notes\n', 'utf8')
    const { outDir, bytes } = runPacker(dir)
    const names = readEntries(bytes).map((entry) => entry.name)
    assert.equal(names.includes('src/uncommitted.ts'), false, '未提交的源文件不该进源码包')
    assert.equal(names.includes('notes.md'), false, '未跟踪文件不该进源码包')
    rmSync(outDir, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('源码包：已暂存但未提交的改动也不进包（清单与内容都取 HEAD）', () => {
  const dir = makeRepo('staged')
  try {
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 999\n', 'utf8')
    execFileSync('git', ['add', 'src/index.ts'], { cwd: dir })
    const { outDir, bytes } = runPacker(dir)
    const entry = readEntries(bytes).find((row) => row.name === 'src/index.ts')
    assert.ok(entry !== undefined)
    assert.equal(
      entry.data.toString('utf8').includes('999'),
      false,
      '暂存区不是发布内容：归档必须是 HEAD 的那一份',
    )
    assert.equal(entry.data.toString('utf8'), 'export const a = 1\nexport const b = 2\n')
    rmSync(outDir, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('源码包：`--rev` 能打指定提交的包', () => {
  const dir = makeRepo('rev')
  try {
    const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 2\n', 'utf8')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'second'], { cwd: dir })

    const { outDir, bytes } = runPacker(dir, ['--rev', first])
    const entry = readEntries(bytes).find((row) => row.name === 'src/index.ts')
    assert.equal(entry?.data.toString('utf8'), 'export const a = 1\nexport const b = 2\n')
    rmSync(outDir, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('源码包：必需的 fixture 在包里，其余 node_modules 仍然排除', () => {
  // 这一条钉的是 §5.2 的 fixture 冲突：精确例外收进两个刻意入库的假 CLI 文件，
  // 但任何别的 node_modules 路径都还不许进。
  const dir = makeRepo('fixture')
  try {
    const fixture = join(dir, 'test', 'fixtures', 'fake-weibo-pkg', 'node_modules', '@weibo-ai', 'weibo-cli')
    mkdirSync(join(fixture, 'dist'), { recursive: true })
    writeFileSync(join(fixture, 'package.json'), '{"name":"@weibo-ai/weibo-cli","version":"0.0.0"}\n', 'utf8')
    writeFileSync(join(fixture, 'dist', 'index.js'), '#!/usr/bin/env node\n', 'utf8')
    // 同一棵树下再放一个真实的依赖目录，它必须被排除。
    const dependency = join(dir, 'node_modules', 'left-pad')
    mkdirSync(dependency, { recursive: true })
    writeFileSync(join(dependency, 'index.js'), 'module.exports = 1\n', 'utf8')

    execFileSync('git', ['add', '-f', 'test/fixtures/fake-weibo-pkg'], { cwd: dir })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir })

    const { outDir, bytes } = runPacker(dir)
    const names = readEntries(bytes).map((entry) => entry.name)
    assert.ok(
      names.includes('test/fixtures/fake-weibo-pkg/node_modules/@weibo-ai/weibo-cli/package.json'),
      '刻意入库的假 CLI 必须在包里，否则下载者跑不了依赖它的桌面验收',
    )
    assert.equal(
      names.some((name) => name.startsWith('node_modules/')),
      false,
      '真实依赖目录不能被这个例外带进来',
    )
    rmSync(outDir, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('源码包：没有 Git 时回落工作树，并在输出里说明不能复现', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-src-nogit-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'src-fixture', version: '9.9.9' }), 'utf8')
    writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1\n', 'utf8')
    copyFileSync(PACKER, join(dir, 'scripts', 'source-zip.mjs'))
    copyFileSync(GIT_OBJECTS, join(dir, 'scripts', 'lib', 'git-objects.mjs'))

    const outDir = mkdtempSync(join(tmpdir(), 'dsh-src-out-'))
    const stdout = execFileSync(
      process.execPath,
      [join(dir, 'scripts', 'source-zip.mjs'), '--out', outDir],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    assert.match(stdout, /不能.*复现/, '没有 Git 时必须明说这一份不能从提交复现')
    assert.match(stdout, /working-tree/)
    rmSync(outDir, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('源码包：归档里每个文件等于 `git cat-file` 的字节（独立核验工具）', () => {
  // 这一条把打包器与核验器放在一起：核验器不 import 打包规则，所以它能反过来证明
  // 「清单说的」和「字节是的」是同一件事。
  const dir = makeRepo('verify')
  try {
    const { outDir, zip } = runPacker(dir)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
    const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((path) => path !== '')

    for (const entry of readEntries(readFileSync(zip))) {
      assert.ok(paths.includes(entry.name), `归档里出现了不在提交里的文件：${entry.name}`)
      const expected = git('cat-file', 'blob', `HEAD:${entry.name}`)
      assert.deepEqual(entry.data, expected, `${entry.name} 的字节与提交不一致`)
    }
    rmSync(outDir, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git-objects：一次 batch 读多个 blob，内容与逐个 cat-file 相同', () => {
  const dir = makeRepo('batch')
  try {
    const module = join(dir, 'scripts', 'lib', 'git-objects.mjs')
    const script = `
      import { readBlobs } from ${JSON.stringify(pathToFileURL(module).href)}
      const blobs = readBlobs(${JSON.stringify(dir.replace(/\\/g, '/'))}, 'HEAD', ['src/index.ts', 'README.md'])
      const out = {}
      for (const [path, blob] of blobs) out[path] = { sha: blob.sha, text: blob.data.toString('utf8') }
      process.stdout.write(JSON.stringify(out))
    `
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      encoding: 'utf8',
    })
    const parsed = JSON.parse(raw)
    assert.equal(parsed['src/index.ts'].text, 'export const a = 1\nexport const b = 2\n')
    assert.equal(parsed['README.md'].text, '# fixture\n')
    assert.match(parsed['src/index.ts'].sha, /^[0-9a-f]{40}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git-objects：路径不在提交里时必须报错，不能静默返回空', () => {
  const dir = makeRepo('missing')
  try {
    const module = join(dir, 'scripts', 'lib', 'git-objects.mjs')
    const script = `
      import { readBlobs } from ${JSON.stringify(pathToFileURL(module).href)}
      try {
        readBlobs(${JSON.stringify(dir.replace(/\\/g, '/'))}, 'HEAD', ['src/does-not-exist.ts'])
        process.stdout.write('NO-THROW')
      } catch (error) {
        process.stdout.write('THREW:' + error.message)
      }
    `
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.match(raw, /^THREW:/, '读不到就必须抛错：静默返回 undefined 会让归档少一个文件而没人发现')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('源码包脚本仍然保留白名单与排除规则（防止根因修复顺手放宽）', () => {
  const source = readFileSync(PACKER, 'utf8')
  assert.match(source, /ALLOWED_DIRS/)
  assert.match(source, /ALLOWED_FILES/)
  assert.match(source, /FORBIDDEN_NAMES/)
  assert.match(source, /FORBIDDEN_DIRS/)
  // fixture 例外必须是精确路径，不能是目录前缀或通配。
  assert.match(source, /TRACKED_FIXTURE_EXCEPTIONS/)
  const exceptionBlock = /const TRACKED_FIXTURE_EXCEPTIONS = new Set\(\[([\s\S]*?)\]\)/.exec(source)
  assert.ok(exceptionBlock !== null)
  const entries = exceptionBlock[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith("'"))
  assert.ok(entries.length > 0, '例外表不能为空')
  for (const entry of entries) {
    assert.ok(
      !entry.includes('*'),
      `例外必须是整条路径，不能含通配：${entry}`,
    )
  }
  void dirname
})
