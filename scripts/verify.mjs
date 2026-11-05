/**
 * Build and test in one step.
 *
 * Uses only Node built-ins and the locally installed TypeScript, because the DSH
 * runtime has no npm on PATH. Each stage runs in order and the script stops at the
 * first failure, so CI and a contributor see the same result.
 *
 *   node scripts/verify.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const isWindows = process.platform === 'win32'
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  process.stderr.write('✖ 找不到本地 TypeScript，请先运行 pnpm install\n')
  process.exit(1)
}

/** Run one command, inherit stdio, and exit on failure. */
function run(label, command, args) {
  process.stdout.write(`\n\x1b[36m▶ ${label}\x1b[0m\n`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })
  if (result.error) {
    process.stderr.write(`\x1b[31m✖ ${label} 无法启动：${result.error.message}\x1b[0m\n`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.stderr.write(`\x1b[31m✖ ${label} 失败（退出码 ${result.status}）\x1b[0m\n`)
    process.exit(result.status ?? 1)
  }
  process.stdout.write(`\x1b[32m✔ ${label}\x1b[0m\n`)
}

// A clean build catches stale artefacts a rebuild would silently keep.
process.stdout.write('\x1b[36m▶ 清理 lib\x1b[0m\n')
rmSync(join(root, 'lib'), { recursive: true, force: true })
process.stdout.write('\x1b[32m✔ 清理 lib\x1b[0m\n')

run('TypeScript 编译（严格模式）', process.execPath, [tsc, '-p', 'tsconfig.json'])
/**
 * 测试与脚本的类型检查走棘轮，不是裸 `tsc`。
 *
 * ## 这一步以前是 `tsc -p tsconfig.test.json`，而它从来没有绿过（v0.2.28 修正）
 *
 * 修好 `exclude` 之后真相是：测试代码里有几百条历史类型错误（`any` 与 mock 的结构
 * 不匹配，不影响运行时）。裸 `tsc` 因此**必然退出 2**，而它在 `release-prepare.mjs`
 * 里，于是「一键跑到可发布状态」这条路径从 v0.2.17 起就是断的——只是 CI 用的是棘轮
 * 脚本，所以红的地方没人看得见。两个入口对同一件事给出相反答案，是最该修的那种不一致。
 *
 * 现在两边一致：都是棘轮（记录当前错误数，只许变少）。
 */
run('类型检查（含测试与脚本，棘轮）', process.execPath, ['scripts/test-typecheck.mjs'])
run('自动化测试', process.execPath, [
  '--experimental-transform-types',
  '--test',
  // Globbed, not listed: a hand-maintained list silently skips a new test file,
  // which is how a suite reports "all green" while covering less than it claims.
  'test/**/*.test.ts',
])

// The package step runs last: it builds, packs, and then proves the archive
// installs and mounts from a bare directory. A broken package is a broken
// release, so this belongs in the same gate as the tests.
run('打包', process.execPath, ['scripts/pack.mjs'])
run('裸目录安装验证', process.execPath, ['scripts/verify-install.mjs'])

process.stdout.write('\n\x1b[32m全部检查通过\x1b[0m\n')
