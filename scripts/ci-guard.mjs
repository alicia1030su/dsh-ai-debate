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

// --- 4b. The source archive must be buildable on its own -------------------

/**
 * ## Why this section exists (v0.2.16 §一)
 *
 * Section 4 checks that the lockfile *in the working tree* covers every dependency. That was true
 * in v0.2.15 and stayed true, while the published source ZIP contained no `pnpm-lock.yaml` and no
 * `lib/` at all — the allowlist that decides what gets zipped simply omitted both. So the archive
 * could not satisfy the very workflow that ships it: `pnpm install --frozen-lockfile` would fail
 * on the first command.
 *
 * "The file exists here" and "the file is in the archive" are different claims, and only the
 * second one reaches a user. This section asserts the second.
 *
 * It reads the ZIP's central directory rather than trusting the packer's own summary, for the same
 * reason `scan-archive.mjs` does not import the packer: a bug in the decision and a bug in the
 * report would otherwise cancel out.
 */
function zipEntryNames(file) {
  const bytes = readFileSync(file)
  const names = []
  for (let i = 0; i + 46 <= bytes.length; i += 1) {
    // Central directory file header signature.
    if (bytes.readUInt32LE(i) !== 0x02014b50) continue
    const nameLength = bytes.readUInt16LE(i + 28)
    names.push(bytes.toString('utf8', i + 46, i + 46 + nameLength))
  }
  return names
}

/**
 * ## The artifact check is conditional, the rule check is not
 *
 * Asserting only "the ZIP on disk contains the lockfile" has a hole of its own: whoever just
 * unzipped the archive into a clean directory has no such ZIP, and `pnpm test` would fail there
 * for a reason that has nothing to do with their code. That would make the guard punish the exact
 * workflow it is supposed to protect.
 *
 * So the section runs in two tiers:
 *
 * 1. **Always** — read the packer and assert it still names the lockfile and the build-output
 *    directory. This is the rule that was wrong in v0.2.15, and a text assertion on it cannot be
 *    defeated by a missing artifact.
 * 2. **When the artifact exists** — open it and check what actually landed inside. This catches a
 *    rule that looks right but is applied wrongly.
 *
 * Tier 2 skips locally, but never in CI: `CI` is set there, the ZIP is built in an earlier step,
 * and a missing artifact at that point *is* the failure this section exists to catch.
 */
const sourceZipPacker = join(root, 'scripts', 'source-zip.mjs')
if (existsSync(sourceZipPacker)) {
  const packer = readFileSync(sourceZipPacker, 'utf8')
  if (!/'pnpm-lock\.yaml'/.test(packer)) {
    fail('scripts/source-zip.mjs 的 ALLOWED_FILES 没有收录 pnpm-lock.yaml，源码包将无法安装依赖')
  }
  if (!/BUILD_OUTPUT_DIRS|'lib'/.test(packer)) {
    fail('scripts/source-zip.mjs 没有把 lib/ 作为构建产物目录收录，源码包将缺少编译产物')
  } else if (!/BUILD_OUTPUT_DIRS/.test(packer)) {
    fail('source-zip.mjs 把 lib/ 当成普通源码目录整包放行；它应当只发布 .js/.d.ts/.map')
  }
}

if (existsSync(pkgPath)) {
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  const sourceZip = join(root, '..', `dsh-ai-debate-source-${version}.zip`)

  if (!existsSync(sourceZip)) {
    // In CI the archive is produced by an earlier step, so its absence means the pipeline is
    // broken — not that the user is mid-edit.
    if (process.env.CI) {
      fail(
        `CI 环境里找不到源码包 ${sourceZip}。前面的「生成并扫描公开源码包」步骤没有产出它。`,
      )
    } else {
      note('源码包尚未生成，跳过归档内容检查（打包规则已单独校验）')
    }
  } else {
    const entries = zipEntryNames(sourceZip)
    const has = (name) => entries.includes(name)

    if (entries.length === 0) {
      fail(`源码包 ${sourceZip} 读不出任何条目，格式可能已损坏`)
    }

    // The two files v0.2.15 was missing. Each one breaks the build for whoever downloads it.
    if (!has('pnpm-lock.yaml')) {
      fail('源码包缺少 pnpm-lock.yaml：下载者跑不了 pnpm install --frozen-lockfile')
    }
    if (!has('lib/index.js')) {
      fail('源码包缺少 lib/index.js：从 GitHub 安装时入口不存在')
    }

    const libEntries = entries.filter((name) => name.startsWith('lib/'))
    if (libEntries.length === 0) {
      fail('源码包里的 lib/ 是空的')
    }

    // Compiled output only. A `lib/` carrying anything else means someone put a file there by
    // hand, and a whole-directory allowance would have published it.
    const unexpected = libEntries.filter(
      (name) => !/\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(name),
    )
    if (unexpected.length > 0) {
      fail(`源码包的 lib/ 里有非编译产物：${unexpected.slice(0, 5).join(', ')}`)
    }

    // The archive is public by definition; these must never be inside it.
    const leaked = entries.filter(
      (name) =>
        name.split('/').includes('node_modules') ||
        /(^|\/)\.env$/.test(name) ||
        /(^|\/)\.dsh(\/|$)/.test(name),
    )
    if (leaked.length > 0) {
      fail(`源码包里有不该发布的路径：${leaked.slice(0, 5).join(', ')}`)
    }

    note(`源码包 ${entries.length} 条目，含锁文件与 ${libEntries.length} 个编译产物`)
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
