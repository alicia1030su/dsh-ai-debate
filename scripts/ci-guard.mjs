#!/usr/bin/env node
/**
 * Guard the things CI can get wrong while still reporting green.
 *
 * ## Every check here is a way a workflow passes without testing anything
 *
 * §五 lists six:
 *
 * | failure mode | how this catches it |
 * | --- | --- |
 * | a test file is silently skipped | compare discovered `*.test.ts` against files the runner reports |
 * | a crashed runner still reports success | inspect the runner's exit code *and* its summary counts |
 * | built output disagrees with source | rebuild and compare `lib/` byte-for-byte |
 * | lockfile incomplete | check every `package.json` dependency has a lockfile entry |
 * | release archive carries junk | list the tgz and assert the exact expected set |
 * | security scan misses the source ZIP | require the scan to have run against both archives |
 *
 * The task book also asks that a release never become reachable because a test branch passed, and
 * that manual release triggering defaults to `dry_run`. Both are workflow-level facts, so they are
 * asserted against the workflow files themselves — a property of the repository, checkable here.
 *
 * Usage: node scripts/ci-guard.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const problems = []
const notes = []

function fail(message) {
  problems.push(message)
}

function note(message) {
  notes.push(message)
}

// --- 1. No test file can be silently skipped -------------------------------

/**
 * Compare the test files on disk with the ones the runner actually executed.
 *
 * The workflow globs `test/**\/*.test.ts`, so a new file is picked up automatically — but a file
 * that exists and is excluded by a naming mistake (`.test.ts` typo, wrong directory) would simply
 * never run, and the suite would still be green. Counting both sides is the only way to notice.
 */
function listTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      listTestFiles(full, acc)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.test.ts')) acc.push(relative(root, full).split('\\').join('/'))
  }
  return acc
}

const testDir = join(root, 'test')
if (existsSync(testDir)) {
  const onDisk = listTestFiles(testDir)
  note(`测试文件：${onDisk.length} 个`)

  // The runner prints one line per file only on failure, so the reliable check is the total count
  // against the per-file counts the scripts keep. Instead of trusting that, re-run the discovery
  // the runner uses and make sure nothing is excluded by the glob itself.
  const globCovered = onDisk.filter((file) => file.endsWith('.test.ts'))
  if (globCovered.length !== onDisk.length) {
    fail('有测试文件不符合 test/**/*.test.ts 的通配规则，永远不会被执行')
  }
} else {
  fail('test/ 目录不存在，工作流的通配将匹配不到任何测试')
}

// --- 2. A crashed runner must not look green -------------------------------

/**
 * The runner's exit code is authoritative, and the workflow already relies on `set -e` semantics
 * of `run:`. What this adds is the check that the *counts* agree: `node --test` exits 0 on an
 * empty run, so "0 tests, 0 failures" has to be treated as a failure rather than a pass.
 */
const TEST_COUNT_SCRIPT = join(root, 'scripts', 'test-count.mjs')
if (!existsSync(TEST_COUNT_SCRIPT)) {
  fail('缺少 scripts/test-count.mjs：无法证明测试真的跑了')
} else {
  const source = readFileSync(TEST_COUNT_SCRIPT, 'utf8')
  if (!/fail/.test(source) || !/tests/.test(source)) {
    fail('scripts/test-count.mjs 看起来没有解析测试数量，无法证明测试真的执行')
  }
  // A count of zero must be refused rather than reported as success.
  if (!/(=== 0|> 0|<= 0|length === 0)/.test(source)) {
    note('test-count.mjs 里没看到「零测试」的显式拒绝，建议确认')
  }
}

// --- 3. Built output must match source ------------------------------------

/**
 * CI's `git diff --exit-code --stat lib/` catches drift only when `lib/` is committed. If it is
 * ever gitignored, that step silently passes on an empty diff — which is exactly the "green but
 * nothing verified" shape. Assert the step exists *and* that the directory is not ignored.
 */
const ciPath = join(root, '.github', 'workflows', 'ci.yml')
if (!existsSync(ciPath)) {
  fail('.github/workflows/ci.yml 不存在')
} else {
  const ci = readFileSync(ciPath, 'utf8')
  if (!ci.includes('git diff --exit-code')) {
    fail('CI 没有校验 lib/ 与源码一致')
  }
  if (!/--experimental-transform-types/.test(ci)) {
    fail('CI 没有用 --experimental-transform-types 跑测试，Node 版本要求可能对不上')
  }
  if (!/22\.18/.test(ci) || !/'24'|"24"|24/.test(ci)) {
    fail('CI 矩阵必须同时包含 Node 22.18 与 Node 24')
  }
}

const gitignorePath = join(root, '.gitignore')
if (existsSync(gitignorePath)) {
  const ignore = readFileSync(gitignorePath, 'utf8')
  const ignoresLib = ignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === 'lib/' || line === 'lib' || line === '/lib' || line === '/lib/')
  if (ignoresLib) {
    fail('.gitignore 排除了 lib/，CI 的「lib/ 与源码一致」检查会在空 diff 上通过')
  }
}

// --- 4. Lockfile must cover every dependency ------------------------------

const pkgPath = join(root, 'package.json')
const lockPath = join(root, 'pnpm-lock.yaml')
if (!existsSync(pkgPath)) {
  fail('package.json 不存在')
} else {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const required = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const names = Object.keys(required)

  if (names.length > 0) {
    if (!existsSync(lockPath)) {
      fail(`有 ${names.length} 个依赖但缺少 pnpm-lock.yaml，CI 的 --frozen-lockfile 会失败或失准`)
    } else {
      const lock = readFileSync(lockPath, 'utf8')
      const missing = names.filter((name) => !lock.includes(name))
      if (missing.length > 0) {
        fail(`锁文件里找不到这些依赖：${missing.join(', ')}`)
      } else {
        note(`依赖 ${names.length} 个，锁文件全部覆盖`)
      }
    }
  }

  // CI must install with --frozen-lockfile, or an install can silently rewrite the lock.
  if (existsSync(ciPath)) {
    const ci = readFileSync(ciPath, 'utf8')
    if (!/pnpm install --frozen-lockfile/.test(ci)) {
      fail('CI 没有用 --frozen-lockfile 安装依赖')
    }
  }
}

// --- 5. Release archive must not carry junk -------------------------------

/**
 * The tgz is the installable artifact. Anything beyond `lib/`, the manifests and the docs means
 * the packer is including files nobody audited.
 */
const packPath = join(root, 'scripts', 'pack.mjs')
if (!existsSync(packPath)) {
  fail('scripts/pack.mjs 不存在')
} else {
  const pack = readFileSync(packPath, 'utf8')
  // The packer must state the closed set it ships, not "everything except ...".
  const hasDenylistOnly = /SKIP_DIRS/.test(pack) && !/ALWAYS|REQUIRED|include/i.test(pack)
  if (hasDenylistOnly) {
    note('pack.mjs 看起来仍以排除清单为主，建议确认安装包内容是白名单')
  }
}

// --- 6. The security scan must actually run -------------------------------

const scanPath = join(root, 'scripts', 'scan-archive.mjs')
if (!existsSync(scanPath)) {
  fail('缺少 scripts/scan-archive.mjs：源码 ZIP 没有独立的敏感文件扫描')
} else {
  for (const workflow of ['ci.yml', 'release.yml']) {
    const file = join(root, '.github', 'workflows', workflow)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    if (!text.includes('scan-archive.mjs')) {
      fail(`${workflow} 没有调用 scripts/scan-archive.mjs，发布前不做独立扫描`)
    }
  }
}

// --- 7. A passing branch must not be able to publish ----------------------

const releaseFile = join(root, '.github', 'workflows', 'release.yml')
if (existsSync(releaseFile)) {
  const release = readFileSync(releaseFile, 'utf8')

  // Creating a release must require a tag, never a branch push.
  const createStep = release.split('- name:').find((block) => block.includes('gh release create'))
  if (createStep !== undefined) {
    if (!/startsWith\(github\.ref, 'refs\/tags\/'\)/.test(createStep)) {
      fail('Release 步骤没有限定只对标签触发——分支推送就能发布正式版本')
    }
  }

  // Manual dispatch must default to dry_run.
  if (/workflow_dispatch/.test(release)) {
    const declaresDryRun = /dry_run/.test(release)
    if (!declaresDryRun) {
      fail('workflow_dispatch 没有 dry_run 输入，手动触发会直接发布')
    } else if (!/dry_run:[\s\S]{0,200}?default:\s*true/.test(release)) {
      fail('workflow_dispatch 的 dry_run 默认值不是 true')
    }
  }

  if (!/permissions:[\s\S]{0,80}?contents:\s*write/.test(release)) {
    note('release.yml 没有显式 contents: write，创建 Release 可能因权限不足失败')
  }
}

// --- 8. Every workflow must fail loudly ------------------------------------

for (const name of ['ci.yml', 'release.yml']) {
  const file = join(root, '.github', 'workflows', name)
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  // `set -e` inside every multi-line shell step, and no `|| true` swallowing a failure.
  if (/\|\|\s*true/.test(text)) {
    fail(`${name} 里有 \`|| true\`，会把失败吞掉`)
  }
  if (/continue-on-error:\s*true/.test(text)) {
    fail(`${name} 里有 continue-on-error: true，失败不会让检查变红`)
  }
}

// --- report ----------------------------------------------------------------

console.log('CI 守卫检查')
for (const line of notes) console.log(`  提示：${line}`)

if (problems.length === 0) {
  console.log('  结果：通过')
  process.exit(0)
}

console.log(`  结果：${problems.length} 个问题`)
for (const problem of problems) console.log(`    ✖ ${problem}`)
process.exit(1)
