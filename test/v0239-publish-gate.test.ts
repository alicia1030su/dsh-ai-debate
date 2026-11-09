/**
 * 发布模式必须 fail-closed，且凭据扫描不能靠目录名放行（v0.2.39 复审 §1/§2）。
 *
 * ## 这一组测试针对的不是「功能缺失」，是「安静地做错事」
 *
 * 复审在 `scripts/source-zip.mjs` 里找到两个同类的洞，共同点是**构建成功、产物看起来正常**：
 *
 * 1. `--rev` 写错（标签还没打、手滑多一个字符）时，`git rev-parse` 失败，脚本把这个失败
 *    当成「这里没有 Git」，回落到工作树继续打包。于是发布者以为打的是标签，实际打的是
 *    磁盘上恰好存在的那一堆文件 —— 而且输出里只有一行容易被忽略的「working-tree」。
 * 2. 内容扫描对 `test/`、`docs/` 采用**整目录豁免**。把一把真 AWS key 粘进任何测试文件，
 *    构建仍然是绿的；行级 `fixture` 关键字同样能被一句注释骗过。
 *
 * 两条都属于「发布闸门」，所以这里的断言只看两件事：**退出码**与**产物是否出现**。
 * 一个会失败的打包器不需要再解释自己为什么失败；一个不该成功的打包也不能靠日志措辞洗白。
 *
 * ## 先红后绿
 *
 * 本文件在整改前运行会失败 5 条（见 `docs/v0.2.39-review-fixes.md` 的红/绿记录）：
 * 无效 rev 成功、空 rev 成功、无 Git 无参数成功、test/ 里的真 key 成功、docs/ 里的真 key 成功。
 * 整改后全部转绿。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createTgz } from '../scripts/tar.mjs'

const REPO = join(import.meta.dirname, '..')
const PACKER = join(REPO, 'scripts', 'source-zip.mjs')
const GIT_OBJECTS = join(REPO, 'scripts', 'lib', 'git-objects.mjs')
const FIXTURE_ALLOWLIST = join(REPO, 'scripts', 'lib', 'fixture-allowlist.mjs')

/** 把待测打包器与它的两个依赖装进一个隔离目录。 */
function installPacker(dir: string): void {
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
  copyFileSync(PACKER, join(dir, 'scripts', 'source-zip.mjs'))
  copyFileSync(GIT_OBJECTS, join(dir, 'scripts', 'lib', 'git-objects.mjs'))
  copyFileSync(FIXTURE_ALLOWLIST, join(dir, 'scripts', 'lib', 'fixture-allowlist.mjs'))
}

/** 一个真实的 Git 仓库：打包器的发布模式要求它。 */
function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-gate-${name}-`))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'test'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gate-fixture', version: '9.9.9' }), 'utf8')
  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1\n', 'utf8')
  installPacker(dir)

  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'fixture')
  git('config', 'core.autocrlf', 'false')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  return dir
}

/** 一个没有 Git 的目录，结构与真实仓库相同。 */
function makePlainDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-gate-${name}-`))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'test'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gate-fixture', version: '9.9.9' }), 'utf8')
  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1\n', 'utf8')
  installPacker(dir)
  return dir
}

/** 跑打包器，返回退出码与合并输出；不抛异常 —— 我们就是来看它怎么失败。 */
function runPacker(dir: string, args: readonly string[]): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [join(dir, 'scripts', 'source-zip.mjs'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

/** 产物路径（`--out` 指定）。 */
function archiveIn(outDir: string): string {
  return join(outDir, 'dsh-ai-debate-source-9.9.9.zip')
}

/**
 * 构造一个「看起来像真的」AWS key。
 *
 * 不在源码里写完整字面量：本文件自己也会进源码包、也会被扫描。拆成两段再拼，
 * 文件字节里就不存在连续 20 位的 key 形状 —— 这不是为了躲扫描，而是为了让这条测试
 * 在「扫描器被正确收紧」之后仍然只测它要测的东西。
 */
function realLookingAwsKey(): string {
  return ['AKIA', 'QYLPMN5HHMWUZ7AG'].join('')
}

test('发布模式：`--rev` 解析不到提交时必须失败，不能回退工作树', () => {
  const dir = makeRepo('bad-rev')
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-out-'))
  try {
    // 工作树里放一个只存在于磁盘的标记：如果打包器偷偷回落，它就会进包。
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const workingTreeOnly = true\n', 'utf8')

    const result = runPacker(dir, ['--out', outDir, '--rev', 'no-such-rev-0239'])
    assert.notEqual(result.code, 0, '无效的 --rev 必须让打包失败')
    assert.equal(existsSync(archiveIn(outDir)), false, '失败时不得留下一个「看似成功」的包')
    assert.match(result.output, /no-such-rev-0239/, '错误必须点名解析不了的那个 rev')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('发布模式：`--rev` 后面没有值时也必须失败', () => {
  const dir = makeRepo('empty-rev')
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-out-'))
  try {
    const result = runPacker(dir, ['--out', outDir, '--rev'])
    assert.notEqual(result.code, 0, '一个空的 --rev 不能悄悄变成 HEAD')
    assert.match(result.output, /--rev/)
    assert.equal(existsSync(archiveIn(outDir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('发布模式：没有 Git 时默认拒绝，必须显式选择本地模式', () => {
  const dir = makePlainDir('no-git')
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-out-'))
  try {
    const result = runPacker(dir, ['--out', outDir])
    assert.notEqual(result.code, 0, '正式发布不能在没有 Git 的目录里静默回落')
    assert.match(result.output, /--allow-working-tree/, '错误要告诉人怎么做：显式本地模式')
    assert.equal(existsSync(archiveIn(outDir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('本地模式：显式 `--allow-working-tree` 才允许无 Git 回落，并说明不可复现', () => {
  const dir = makePlainDir('local')
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-out-'))
  try {
    const result = runPacker(dir, ['--out', outDir, '--allow-working-tree'])
    assert.equal(result.code, 0, `显式本地模式应当成功，实际输出：\n${result.output}`)
    assert.match(result.output, /working-tree/)
    assert.match(result.output, /不能.*复现/)
    assert.equal(existsSync(archiveIn(outDir)), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('本地模式不能替代一个指定不了的 rev：没有 Git 时 `--rev` 仍然失败', () => {
  const dir = makePlainDir('rev-no-git')
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-out-'))
  try {
    const result = runPacker(dir, ['--out', outDir, '--rev', 'HEAD', '--allow-working-tree'])
    assert.notEqual(result.code, 0, '要求了具体提交就不能拿磁盘顶替')
    assert.equal(existsSync(archiveIn(outDir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('发布模式：仓库还没有提交（HEAD 未出生）时失败，而不是打当前目录', () => {
  const dir = makePlainDir('unborn')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-out-'))
  try {
    git('init', '-q')
    const result = runPacker(dir, ['--out', outDir])
    assert.notEqual(result.code, 0, '没有 HEAD 就没有「已提交的那一份」，不能拿工作树冒充')
    assert.equal(existsSync(archiveIn(outDir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('扫描：test/ 下的真凭据形状必须阻断发布（整目录豁免已删除）', () => {
  const dir = makeRepo('leak-test')
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-out-'))
  try {
    writeFileSync(
      join(dir, 'test', 'leaked.test.ts'),
      `export const key = ${JSON.stringify(realLookingAwsKey())}\n`,
      'utf8',
    )
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'leak'], { cwd: dir })

    const result = runPacker(dir, ['--out', outDir])
    assert.notEqual(result.code, 0, 'test/ 不是免检区：真的凭据形状必须让构建失败')
    assert.match(result.output, /test\/leaked\.test\.ts/, '输出要指出是哪个文件')
    assert.equal(existsSync(archiveIn(outDir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('扫描：docs/ 下的真凭据形状同样阻断发布', () => {
  const dir = makeRepo('leak-docs')
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-out-'))
  try {
    writeFileSync(
      join(dir, 'docs', 'notes.md'),
      `示例配置：${realLookingAwsKey()}\n`,
      'utf8',
    )
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'leak'], { cwd: dir })

    const result = runPacker(dir, ['--out', outDir])
    assert.notEqual(result.code, 0, 'docs/ 也不是免检区')
    assert.match(result.output, /docs\/notes\.md/)
    assert.equal(existsSync(archiveIn(outDir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('扫描：例外只认「这个文件里的这一串假值」，同文件里换一把钥匙仍然失败', () => {
  const dir = makeRepo('leak-allowlisted-file')
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-out-'))
  try {
    // 真实仓库里被登记为假数据的那个文件，原样复制进夹具：它应当能过。
    const allowlisted = 'test/security/security-events.test.ts'
    mkdirSync(join(dir, 'test', 'security'), { recursive: true })
    copyFileSync(join(REPO, allowlisted), join(dir, allowlisted))

    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'fixtures'], { cwd: dir })
    const clean = runPacker(dir, ['--out', outDir])
    assert.equal(clean.code, 0, `登记过的假数据应当放行，实际输出：\n${clean.output}`)
    rmSync(archiveIn(outDir), { force: true })

    // 同一个文件里再放一把**没有登记**的真 key。整文件豁免会放它过去，精确例外不会。
    writeFileSync(
      join(dir, allowlisted),
      `${readFileSync(join(dir, allowlisted), 'utf8')}\nexport const second = ${JSON.stringify(realLookingAwsKey())}\n`,
      'utf8',
    )
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'second key'], { cwd: dir })

    const dirty = runPacker(dir, ['--out', outDir])
    assert.notEqual(dirty.code, 0, '例外是逐条字面量，不是整文件通行证')
    assert.match(dirty.output, /security-events\.test\.ts/)
    assert.equal(existsSync(archiveIn(outDir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('扫描：独立扫描器也不再对 test/ 整目录放行', () => {
  const archive = join(mkdtempSync(join(tmpdir(), 'dsh-gate-tgz-')), 'dsh-ai-debate-9.9.9.tgz')
  try {
    // 一个只有 test/ 文件的 tgz。扫描器自己的规则必须拒绝它，而不是因为路径前缀放行。
    const bytes = createTgz([
      {
        path: 'package/test/leaked.test.ts',
        data: Buffer.from(`export const key = ${JSON.stringify(realLookingAwsKey())}\n`, 'utf8'),
      },
    ])
    writeFileSync(archive, bytes)

    let code = 0
    let output = ''
    try {
      output = execFileSync(process.execPath, [join(REPO, 'scripts', 'scan-archive.mjs'), archive], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      code = failure.status ?? 1
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
    }
    assert.notEqual(code, 0, '独立扫描器对 test/ 也必须按内容判定')
    assert.match(output, /test\/leaked\.test\.ts/)
  } finally {
    rmSync(join(archive, '..'), { recursive: true, force: true })
  }
})

test('扫描：例外表必须仍能对上真实文件（没有过期条目，也没有漏登记）', async () => {
  const module = (await import('../scripts/lib/fixture-allowlist.mjs')) as {
    FAKE_CREDENTIAL_LITERALS: Map<string, readonly string[]>
  }
  assert.ok(module.FAKE_CREDENTIAL_LITERALS instanceof Map, '必须有一个可核对的例外表')

  let entries = 0
  for (const [path, literals] of module.FAKE_CREDENTIAL_LITERALS) {
    assert.match(path, /^(test|docs)\//, `例外只能出现在 test/ 或 docs/，越界：${path}`)
    assert.ok(literals.length > 0, `${path} 没有登记任何字面量`)
    const text = readFileSync(join(REPO, path), 'utf8')
    for (const literal of literals) {
      entries += 1
      assert.ok(text.includes(literal), `${path} 里找不到登记的字面量（过期条目）：${literal.slice(0, 12)}…`)
      assert.ok(!literal.includes('\n'), '一个字面量不能跨行：它必须能在一行内被精确匹配')
    }
  }
  assert.ok(entries >= 1, '例外表不能为空')
})

test('扫描：真实仓库在发布模式下能打出干净的源码包', () => {
  // 这一条同时证明「例外表是充分的」：如果某个假数据忘了登记，或者登记了但文件已经改了，
  // 上一组断言或这一条会失败。打包内容来自 HEAD，所以它验证的是提交里的字节。
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-gate-real-'))
  try {
    const result = runPacker(REPO, ['--out', outDir])
    assert.equal(result.code, 0, `真实仓库应当能打包，实际输出：\n${result.output.slice(-2000)}`)
    assert.match(result.output, /来源：git HEAD/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
