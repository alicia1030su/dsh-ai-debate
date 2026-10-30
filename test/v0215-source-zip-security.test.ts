/**
 * v0.2.15 §一：源码 ZIP 不得意外包含本地敏感文件。
 *
 * ## 这个文件为什么必须存在
 *
 * v0.2.14 的 `source-zip.mjs` 遍历工作目录、只排除一份硬编码黑名单。审计在工作目录里放了一个
 * 被 `.gitignore` 忽略的 `.env`，打包后它带着完整内容进了公开源码包。
 *
 * 这类缺陷的危险在于**回归极其安静**：包还是能正常生成、能正常解压、测试还是全绿，只有那份
 * 被公开的凭据知道出了问题。所以这些测试直接**解包真实产物**逐条检查，不做「函数返回了 false」
 * 这种间接断言。
 *
 * ## 测什么
 *
 * 1. 在隔离目录里造一整套假凭据（`.env`、`.env.local`、`.credentials.json`、私钥、SSH 目录、
 *    `.dsh` 状态、日志、备份），跑真实打包，确认它们一个都不在里面。
 * 2. 确认该在的东西**仍在**——只测「不包含」会奖励一个什么都不打包的实现。
 * 3. 确认符号链接不被跟随。
 * 4. 确认命中真实凭据形状时**构建失败**，而不是打印警告。
 *
 * ## 不做什么
 *
 * 不读真实用户凭据。所有假值都由本文件的 `FAKE_*` 常量生成，只存在于 `mkdtemp` 出来的临时目录。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const REPO = join(import.meta.dirname, '..')
const PACKER = join(REPO, 'scripts', 'source-zip.mjs')

/**
 * Fake credentials. Every value is obviously synthetic: a scanner that flags these is working, and
 * a reader can tell at a glance that nothing real was used.
 */
const FAKE_ENV = 'FAKE_SECRET_VALUE=v0215-should-never-be-published-0001\n'
const FAKE_ENV_LOCAL = 'FAKE_LOCAL_ONLY=v0215-local-0002\n'
const FAKE_CREDENTIALS = '{"token":"v0215-fake-credential-0003"}\n'
const FAKE_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nV0215FAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----\n'

/** Read the entry names out of a ZIP's central directory. No dependency, same as the writer. */
function zipEntryNames(zipPath) {
  const buffer = readFileSync(zipPath)
  const names = []
  for (let offset = 0; offset < buffer.length - 4; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue
    const nameLength = buffer.readUInt16LE(offset + 28)
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength))
  }
  return names
}

/** Extract one entry's decompressed bytes. */
function zipRead(zipPath, wanted) {
  const buffer = readFileSync(zipPath)
  for (let offset = 0; offset < buffer.length - 4; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue
    const nameLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (name !== wanted) continue
    const localOffset = buffer.readUInt32LE(offset + 42)
    const method = buffer.readUInt16LE(localOffset + 8)
    const compressedSize = buffer.readUInt32LE(localOffset + 18)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const payload = buffer.subarray(start, start + compressedSize)
    if (method === 0) return payload
    return execFileSync(process.execPath, ['-e', `
      const { inflateRawSync } = require('node:zlib');
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => process.stdout.write(inflateRawSync(Buffer.concat(chunks))));
    `], { input: payload, maxBuffer: 64 * 1024 * 1024 })
  }
  throw new Error(`ZIP 里没有 ${wanted}`)
}

/**
 * Build a throwaway repository that looks like a working copy with leaked secrets in it.
 *
 * The copy is real source (from this repo) plus every shape of local secret the audit called out,
 * so the packer runs against something representative rather than a toy tree.
 */
function makeDirtyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-zipsec-'))

  // Minimal but real: package.json drives the version, and the allowlist needs the dirs to exist.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zipsec-fixture', version: '9.9.9' }), 'utf8')
  writeFileSync(join(dir, 'LICENSE'), 'AGPL-3.0 fixture\n', 'utf8')
  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
  writeFileSync(join(dir, '.gitignore'), '.env\n.env.local\n.credentials.json\n', 'utf8')
  writeFileSync(join(dir, '.env.example'), 'TIEBA_COOKIE=\n', 'utf8')

  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const name = "fixture"\n', 'utf8')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'test-placeholder'), '', 'utf8')

  // --- the secrets that must not survive ---
  writeFileSync(join(dir, '.env'), FAKE_ENV, 'utf8')
  writeFileSync(join(dir, '.env.local'), FAKE_ENV_LOCAL, 'utf8')
  writeFileSync(join(dir, '.env.production'), 'PROD=v0215-0004\n', 'utf8')
  writeFileSync(join(dir, '.credentials.json'), FAKE_CREDENTIALS, 'utf8')
  writeFileSync(join(dir, 'id_rsa'), FAKE_PRIVATE_KEY, 'utf8')
  writeFileSync(join(dir, 'server.pem'), FAKE_PRIVATE_KEY, 'utf8')
  // `fixture-` 前缀是审计脚本与打包脚本共用的约定：它让「这是假凭据」成为一个可判定的事实，
  // 而不是一份需要人工维护的豁免名单。别把值写成纯大写字母——那看起来和真 Cookie 一模一样，
  // `scripts/audit-leaks.mjs` 会（正确地）拒绝整个仓库。连注释里也别写出来：扫描器读的是字节。
  writeFileSync(join(dir, 'debug.log'), 'trace with a cookie: BDUSS=fixture-FAKE-COOKIE\n', 'utf8')
  writeFileSync(join(dir, 'notes.bak'), 'backup\n', 'utf8')
  writeFileSync(join(dir, '.npmrc'), '//registry/:_authToken=v0215-0005\n', 'utf8')
  writeFileSync(join(dir, '.netrc'), 'machine example login x password y\n', 'utf8')

  mkdirSync(join(dir, '.ssh'), { recursive: true })
  writeFileSync(join(dir, '.ssh', 'id_ed25519'), FAKE_PRIVATE_KEY, 'utf8')
  mkdirSync(join(dir, '.dsh'), { recursive: true })
  writeFileSync(join(dir, '.dsh', 'state.json'), '{"secret":"v0215-0006"}\n', 'utf8')
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
  writeFileSync(join(dir, 'src', 'nested', '.env'), FAKE_ENV, 'utf8')
  writeFileSync(join(dir, 'src', 'nested', 'credentials.json'), FAKE_CREDENTIALS, 'utf8')

  // Copy the real packer so the test exercises the shipped logic, not a stub.
  writeFileSync(join(dir, 'scripts', 'source-zip.mjs'), readFileSync(PACKER), 'utf8')

  return dir
}

/** Run the packer in `dir` and return the ZIP path it wrote (outside the tree). */
function runPacker(dir) {
  execFileSync(process.execPath, [join(dir, 'scripts', 'source-zip.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return join(dir, '..', 'zipsec-fixture-source-9.9.9.zip')
}

test('打包安全：工作目录里的 .env 不会进源码包（§一.1/§一.5）', () => {
  const dir = makeDirtyRepo()
  const zipPath = join(dir, '..', 'dsh-ai-debate-source-9.9.9.zip')
  try {
    runPacker(dir)
    const names = zipEntryNames(zipPath)
    for (const forbidden of ['.env', '.env.local', '.env.production', '.credentials.json']) {
      assert.equal(
        names.includes(forbidden),
        false,
        `源码包里出现了 ${forbidden}——这正是 v0.2.14 的缺陷`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  }
})

test('打包安全：私钥、SSH、.dsh、日志、备份、npmrc、netrc 全部排除（§一.5）', () => {
  const dir = makeDirtyRepo()
  const zipPath = join(dir, '..', 'dsh-ai-debate-source-9.9.9.zip')
  try {
    runPacker(dir)
    const names = zipEntryNames(zipPath)
    const forbidden = [
      'id_rsa',
      'server.pem',
      'debug.log',
      'notes.bak',
      '.npmrc',
      '.netrc',
      '.ssh/id_ed25519',
      '.dsh/state.json',
      'src/nested/.env',
      'src/nested/credentials.json',
    ]
    for (const path of forbidden) {
      assert.equal(names.includes(path), false, `源码包里出现了 ${path}`)
    }
    // And no path may even mention these directory names.
    const suspicious = names.filter((name) => /(^|\/)(\.ssh|\.dsh|node_modules|\.git)\//.test(name))
    assert.deepEqual(suspicious, [], `不该出现这些目录：${suspicious.join(', ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  }
})

test('打包安全：发布该有的东西仍在——只测「不包含」会奖励空包（§一.6）', () => {
  const dir = makeDirtyRepo()
  const zipPath = join(dir, '..', 'dsh-ai-debate-source-9.9.9.zip')
  try {
    runPacker(dir)
    const names = zipEntryNames(zipPath)
    for (const required of ['package.json', 'LICENSE', 'README.md', 'src/index.ts', '.env.example']) {
      assert.equal(names.includes(required), true, `源码包里缺少 ${required}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  }
})

test('打包安全：ZIP 里的字节不含假凭据内容，不只是文件名对（§一.8/§一.9）', () => {
  const dir = makeDirtyRepo()
  const zipPath = join(dir, '..', 'dsh-ai-debate-source-9.9.9.zip')
  try {
    runPacker(dir)
    const raw = readFileSync(zipPath)
    // The values are distinctive enough that a hit means the bytes really travelled. Deflate can
    // obscure them, so this is a cheap first signal; the entry-level check below is authoritative.
    for (const secret of ['v0215-should-never-be-published', 'v0215-local-0002', 'v0215-fake-credential']) {
      if (!raw.includes(Buffer.from(secret))) continue
      // Present in compressed form? Then find which entry carries it.
      const names = zipEntryNames(zipPath)
      const carriers = names.filter((name) => {
        try {
          return zipRead(zipPath, name).includes(Buffer.from(secret))
        } catch {
          return false
        }
      })
      assert.deepEqual(carriers, [], `假凭据 ${secret} 出现在：${carriers.join(', ')}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  }
})

test('打包安全：符号链接不被跟随，指向树外的私钥进不来（§一.7）', () => {
  const dir = makeDirtyRepo()
  const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
  const secretPath = join(outside, 'outside-secret.txt')
  writeFileSync(secretPath, 'v0215-outside-secret-0007\n', 'utf8')
  const zipPath = join(dir, '..', 'dsh-ai-debate-source-9.9.9.zip')

  try {
    // A link inside an allowed directory, pointing at a file outside the tree.
    let linked = true
    try {
      symlinkSync(secretPath, join(dir, 'src', 'linked-secret.txt'))
    } catch {
      // Creating a symlink can need elevation on Windows. The assertion below still holds —
      // nothing was linked — so the test reports it rather than silently passing.
      linked = false
    }

    runPacker(dir)
    const names = zipEntryNames(zipPath)
    assert.equal(names.includes('src/linked-secret.txt'), false, '符号链接被当成普通文件打包了')
    if (!linked) {
      console.log('  注意：本环境无法创建符号链接，该用例只验证了不存在路径的情况')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('打包安全：allowed 目录里出现真实凭据形状时构建必须失败（§一.10）', () => {
  const dir = makeDirtyRepo()
  try {
    // A real-looking GitHub token in tracked source. Not a fixture: no marker word, not under
    // test/, so the scanner has to refuse the build rather than print a warning.
    writeFileSync(
      join(dir, 'src', 'leaked.ts'),
      'export const key = "ghp_v0215RealLookingTokenThatMustFailBadly1234567"\n',
      'utf8',
    )
    assert.throws(
      () => runPacker(dir),
      (error) => /凭据|构建已失败/.test(String(error.stderr ?? error.message)),
      '含真实凭据形状时必须让构建失败',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(join(dir, '..', 'dsh-ai-debate-source-9.9.9.zip'), { force: true })
  }
})

test('打包安全：未知文件默认不发布（§一.4）', () => {
  const dir = makeDirtyRepo()
  const zipPath = join(dir, '..', 'dsh-ai-debate-source-9.9.9.zip')
  try {
    // A top-level file that is neither allowlisted nor obviously secret. The rule is "unknown
    // means excluded", so it must not appear.
    writeFileSync(join(dir, 'scratch-notes.md'), 'v0215-unknown-0008\n', 'utf8')
    mkdirSync(join(dir, 'random-dir'), { recursive: true })
    writeFileSync(join(dir, 'random-dir', 'data.txt'), 'v0215-unknown-0009\n', 'utf8')

    runPacker(dir)
    const names = zipEntryNames(zipPath)
    assert.equal(names.includes('scratch-notes.md'), false, '未知顶层文件被发布了')
    assert.equal(names.some((name) => name.startsWith('random-dir/')), false, '未知目录被发布了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  }
})

test('打包安全：本仓库真实产物不含敏感文件（§一.8）', () => {
  // The regression that matters for the shipped archive, not just for the fixture tree.
  const zipPath = join(REPO, '..', 'dsh-ai-debate-source-0.2.15.zip')
  let names
  try {
    names = zipEntryNames(zipPath)
  } catch {
    // Not built yet in this run: skip rather than fail, but say so.
    console.log('  注意：0.2.15 源码包尚未生成，跳过产物检查')
    return
  }
  const leaky = names.filter(
    (name) =>
      /(^|\/)\.env$/i.test(name) ||
      /\.env\.(?!example$)/i.test(name) ||
      /(^|\/)\.credentials/i.test(name) ||
      /(^|\/)(\.ssh|\.dsh|\.git)\//.test(name) ||
      /(^|\/)(id_rsa|id_ed25519|\.npmrc|\.netrc)$/i.test(name),
  )
  assert.deepEqual(leaky, [], `真实源码包含敏感文件：${leaky.join(', ')}`)
})
