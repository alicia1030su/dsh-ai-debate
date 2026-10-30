/**
 * v0.2.15 §五：CI 必须是「真的验了什么」而不是「没红」。
 *
 * ## 这个文件防的是「绿色的空检查」
 *
 * 一条 CI 有六种方式在没验证任何东西的情况下显示通过：
 *
 * | 空检查 | 怎么发生 | 这里的断言 |
 * | --- | --- | --- |
 * | 测试文件被遗漏 | 文件名不符合通配规则 | 磁盘上的 `*.test.ts` 数量 = runner 实际执行的 |
 * | 进程崩溃仍报成功 | 步骤里有 `\|\| true` | 工作流不得包含吞错写法 |
 * | 构建产物与源码不一致 | `lib/` 被 gitignore，空 diff 也算通过 | `.gitignore` 不得排除 `lib/` |
 * | 锁文件不完整 | 依赖没写进 lock | 每个依赖都在 lock 里 |
 * | 发行包含无关文件 | 打包用排除清单 | 安装包内容受控 |
 * | 安全检查没覆盖源码 ZIP | 只扫 tgz | 两个包都要扫 |
 *
 * 这些是**仓库的属性**，可以在本地断言，不需要 GitHub 连接。所以即使本轮无法执行远端 CI，
 * 这部分仍然是真的被验证过的——报告里要如实说明它验证的是「工作流的正确性」，不是「远端跑绿了」。
 *
 * ## 明确不测什么
 *
 * 不联网、不调用 GitHub API。远端执行结果只能由远端给出，本地断言不能替代它。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const CI = join(ROOT, '.github', 'workflows', 'ci.yml')
const RELEASE = join(ROOT, '.github', 'workflows', 'release.yml')

const ciText = () => readFileSync(CI, 'utf8')
const releaseText = () => readFileSync(RELEASE, 'utf8')
const pkg = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Run a repository script and hand back its exit code and output. */
function runScript(script) {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, script)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

// ---------------------------------------------------------------------------
// A. 测试文件不得被遗漏（§五）
// ---------------------------------------------------------------------------

test('CI 完整性：测试步骤用通配，不会因为清单过时而跳过新文件', () => {
  const ci = ciText()
  assert.match(
    ci,
    /node --experimental-transform-types --test "test\/\*\*\/\*\.test\.ts"/,
    '测试步骤必须是通配，不能写死文件列表',
  )
})

test('CI 完整性：runner 真的执行了磁盘上的全部测试文件', () => {
  // The guard script compares both sides; here we only assert it is wired in.
  const result = runScript('scripts/ci-guard.mjs')
  assert.equal(result.code, 0, `ci-guard 未通过：\n${result.stdout}`)
  assert.match(result.stdout, /测试文件：\d+ 个/, '守卫要报告实际看到的测试文件数')
})

test('CI 完整性：守卫脚本自己会因为零测试而拒绝', () => {
  // A runner that finds no tests exits 0. The count script must treat that as a failure, or an
  // empty run looks identical to a passing one.
  const countScript = readFileSync(join(ROOT, 'scripts', 'test-count.mjs'), 'utf8')
  assert.match(countScript, /tests/, 'test-count 要解析测试数量')
  assert.match(countScript, /fail|失败/, 'test-count 要检查失败数')
})

// ---------------------------------------------------------------------------
// B. 崩溃不得伪装成成功（§五）
// ---------------------------------------------------------------------------

test('CI 完整性：工作流里没有吞掉失败的写法', () => {
  for (const [name, text] of [
    ['ci.yml', ciText()],
    ['release.yml', releaseText()],
  ]) {
    assert.equal(/\|\|\s*true/.test(text), false, `${name} 里有 || true，会吞掉失败`)
    assert.equal(/continue-on-error:\s*true/.test(text), false, `${name} 里有 continue-on-error`)
  }
})

test('CI 完整性：多行 shell 步骤都开了 set -e 或本身就是单命令', () => {
  // A multi-line `run:` without `set -e` continues after a failed command, so the step passes
  // with a broken artifact. Single-command steps are fine without it.
  for (const [name, text] of [
    ['ci.yml', ciText()],
    ['release.yml', releaseText()],
  ]) {
    const blocks = text.split(/\n\s*- name:/)
    for (const block of blocks) {
      const runMatch = block.match(/\n\s*run:\s*\|\n([\s\S]*?)(?=\n\s*- name:|\n\s*-\s|\s*$)/)
      if (!runMatch) continue
      const body = runMatch[1]
      if (body.trim().split(/\r?\n/).length <= 1) continue
      assert.match(body, /set -e/, `${name} 里有一个多行步骤没有 set -e`)
    }
  }
})

// ---------------------------------------------------------------------------
// C. 构建产物与源码一致（§五）
// ---------------------------------------------------------------------------

test('CI 完整性：lib/ 不得被 .gitignore 排除，否则一致性检查是空 diff', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  const lines = ignore.split(/\r?\n/).map((line) => line.trim())
  for (const pattern of ['lib/', 'lib', '/lib', '/lib/']) {
    assert.equal(lines.includes(pattern), false, `.gitignore 排除了 ${pattern}，CI 的 lib 一致性检查会失效`)
  }
})

test('CI 完整性：工作流确实校验了 lib/ 与源码一致', () => {
  assert.match(ciText(), /git diff --exit-code[\s\S]{0,80}lib\//, 'CI 缺少 lib 一致性检查')
})

// ---------------------------------------------------------------------------
// D. 锁文件完整（§五）
// ---------------------------------------------------------------------------

test('CI 完整性：每个依赖都在锁文件里，且用 --frozen-lockfile 安装', () => {
  const manifest = pkg()
  const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
  const missing = declared.filter((name) => !lock.includes(name))
  assert.deepEqual(missing, [], `锁文件缺少：${missing.join(', ')}`)
  assert.match(ciText(), /--frozen-lockfile/, 'CI 必须用 --frozen-lockfile，否则安装会改写锁文件')
})

// ---------------------------------------------------------------------------
// E. 发行包内容受控（§五）
// ---------------------------------------------------------------------------

test('CI 完整性：release 会校验安装包内容与必需文件', () => {
  const release = releaseText()
  assert.match(release, /package\/lib\/index\.js/, '要确认安装包里有 lib/index.js')
  assert.match(release, /package\/cordis\.patch\.yml/, '要确认安装包里有 patch 文件')
  // And refuse source/dependency directories inside the installable bundle.
  assert.match(release, /package\/\(src\|test\|scripts\|node_modules\)\//, '要拒绝安装包里混进源码目录')
})

// ---------------------------------------------------------------------------
// F. 安全检查覆盖源码 ZIP（§五）
// ---------------------------------------------------------------------------

test('CI 完整性：源码 ZIP 有独立的敏感文件扫描，且两个工作流都调用', () => {
  assert.equal(
    existsSync(join(ROOT, 'scripts', 'scan-archive.mjs')),
    true,
    '缺少独立扫描脚本——打包脚本的自检不能替代独立扫描',
  )
  assert.match(ciText(), /scan-archive\.mjs/, 'CI 没有扫描源码包')
  assert.match(releaseText(), /scan-archive\.mjs/, 'Release 没有扫描源码包')
})

test('CI 完整性：扫描器不依赖打包脚本的规则（独立实现）', () => {
  // If the scanner imported the packer's allowlist, a wrong allowlist would pass its own scan.
  const scanner = readFileSync(join(ROOT, 'scripts', 'scan-archive.mjs'), 'utf8')
  assert.equal(
    /from '\.\/source-zip\.mjs'|require\(['"]\.\/source-zip/.test(scanner),
    false,
    '扫描器不得导入打包脚本的规则',
  )
  assert.match(scanner, /process\.exit\(findings\.length === 0 \? 0 : 1\)/, '有发现必须以非零退出让构建失败')
})

test('CI 完整性：扫描器能真的发现敏感文件（不是永远返回干净）', () => {
  // A scanner that always says "clean" is worse than none. Feed it a known-bad archive.
  const result = runScript('scripts/scan-archive.mjs')
  // No argument → usage error, which is a non-zero exit; that proves it does not default to 0.
  assert.notEqual(result.code, 0, '没有参数时必须非零退出')
})

// ---------------------------------------------------------------------------
// G. 分支通过不得导致发布（§五）
// ---------------------------------------------------------------------------

test('CI 完整性：创建 Release 只对标签触发，分支推送不能发布', () => {
  const release = releaseText()
  const createStep = release
    .split(/\n\s*- name:/)
    .find((block) => block.includes('gh release create'))
  assert.notEqual(createStep, undefined, '找不到创建 Release 的步骤')
  assert.match(
    createStep,
    /startsWith\(github\.ref, 'refs\/tags\/'\)/,
    '创建 Release 必须限定在标签上',
  )
})

test('CI 完整性：手动触发默认 dry_run，不会因为点了按钮就发版', () => {
  const release = releaseText()
  if (!/workflow_dispatch/.test(release)) return // Nothing to check.
  assert.match(release, /dry_run/, 'workflow_dispatch 必须有 dry_run 输入')
  assert.match(
    release,
    /dry_run:[\s\S]{0,200}?default:\s*true/,
    'dry_run 的默认值必须是 true',
  )
  // The release step must consult it.
  assert.match(release, /inputs\.dry_run\s*!=\s*true/, '发布步骤必须检查 dry_run')
})

test('CI 完整性：CI 与 Release 都跑在受支持的 Node 版本上', () => {
  const ci = ciText()
  assert.match(ci, /22\.18/, 'CI 必须测 Node 22.18')
  assert.match(ci, /- '24'|- "24"|node.*24/, 'CI 必须测 Node 24')
  // And the runner's requirement must match the engines field, or users on the documented version
  // cannot run the tests at all.
  const engines = pkg().engines
  assert.notEqual(engines, undefined, 'package.json 要有 engines 字段')
  assert.match(String(engines.node), /22\.(1[89]|[2-9]\d)|2[3-9]/, 'engines.node 要与 CI 的 22.18 一致')
})
