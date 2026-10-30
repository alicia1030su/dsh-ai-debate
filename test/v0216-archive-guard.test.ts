/**
 * v0.2.16 §5 —— 守卫对「源码包还没生成」这件事的判断必须来自调用方，不能来自 `CI` 环境变量。
 *
 * 真实回归：v0.2.16 第一轮 CI 两个 Node 都挂了，失败项是
 * `CI 完整性：runner 真的执行了磁盘上的全部测试文件`。原因是守卫当时用 `process.env.CI`
 * 推断「归档应该已经生成」，而 ci.yml 里测试步骤排在「生成并扫描公开源码包」之前 ——
 * `CI` 是真、归档还没生成也是真，守卫于是把一个正常的执行顺序判成了失败。
 *
 * 「我在 CI 里吗」回答不了「归档建好了吗」。只有调用方知道，所以只有调用方声明。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const GUARD = join(ROOT, 'scripts', 'ci-guard.mjs')

function runGuard(cwd, extraArgs = [], extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(cwd, 'scripts', 'ci-guard.mjs'), ...extraArgs], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    })
    return { code: 0, stdout }
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? '') + String(error.stderr ?? ''),
    }
  }
}

/**
 * 造一个守卫能跑完的最小仓库。必须真的复制而不是桩住：这个测试要证明的就是守卫在
 * 「规则文本齐全、但归档不存在」这一真实组合下的行为。
 */
function makeRepoWithoutArchive() {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-guard-'))
  for (const entry of ['package.json', 'pnpm-lock.yaml', '.gitignore']) {
    const source = join(ROOT, entry)
    if (existsSync(source)) cpSync(source, join(temp, entry))
  }
  for (const entry of ['.github', 'scripts', 'test']) {
    const source = join(ROOT, entry)
    if (existsSync(source)) cpSync(source, join(temp, entry), { recursive: true })
  }
  // 归档放在 root 的上一级；临时目录的上一级不该有同名文件。
  const version = JSON.parse(readFileSync(join(temp, 'package.json'), 'utf8')).version
  const archive = join(temp, '..', `dsh-ai-debate-source-${version}.zip`)
  return { temp, archive }
}

test('守卫：没有源码包且未指定 --require-archive 时跳过归档检查并通过', (t) => {
  const { temp, archive } = makeRepoWithoutArchive()
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  assert.equal(existsSync(archive), false, '前置条件：临时仓库的上一级不该有源码包')

  // 关键一条：`CI` 必须被设置着。旧实现正是在这种情况下一头撞死。
  const result = runGuard(temp, [], { CI: 'true' })

  assert.equal(result.code, 0, `未指定 --require-archive 时不该失败：\n${result.stdout}`)
  assert.match(result.stdout, /源码包尚未生成/, '要明确说明跳过了归档检查，而不是装作检查过')
})

test('守卫：指定 --require-archive 但源码包不存在时必须失败', (t) => {
  const { temp, archive } = makeRepoWithoutArchive()
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  assert.equal(existsSync(archive), false)

  const result = runGuard(temp, ['--require-archive'])

  assert.notEqual(result.code, 0, '显式要求归档时，归档缺失必须判失败')
  assert.match(result.stdout, /require-archive|找不到源码包/, '失败信息要指出是按调用方要求检查的')
})

test('守卫：不得用 CI 环境变量推断归档是否应当存在', () => {
  const source = readFileSync(GUARD, 'utf8')
  // 一旦有人把 `process.env.CI` 加回归档判断，这条会立刻响。
  const archiveSection = source.slice(source.indexOf('const requireArchive'))
  assert.doesNotMatch(
    archiveSection,
    /process\.env\.CI\b/,
    '归档是否应存在只能由调用方声明（--require-archive），不能从 CI 推断',
  )
})

test('工作流：两个工作流的守卫步骤都显式要求归档', () => {
  for (const file of ['ci.yml', 'release.yml']) {
    const text = readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8')
    assert.match(
      text,
      /node scripts\/ci-guard\.mjs --require-archive/,
      `${file} 的守卫步骤必须传 --require-archive，否则归档缺失会被静默跳过`,
    )
  }
})

test('工作流：生成源码包的步骤必须排在守卫步骤之前', () => {
  for (const file of ['ci.yml', 'release.yml']) {
    const text = readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8')
    const packAt = text.indexOf('source-zip.mjs')
    const guardAt = text.indexOf('ci-guard.mjs --require-archive')
    assert.ok(packAt >= 0, `${file} 找不到生成源码包的步骤`)
    assert.ok(guardAt >= 0, `${file} 找不到守卫步骤`)
    assert.ok(packAt < guardAt, `${file} 里守卫步骤排在生成源码包之前，--require-archive 必然失败`)
  }
})
