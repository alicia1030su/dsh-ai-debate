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
run('类型检查（含测试与脚本）', process.execPath, [tsc, '-p', 'tsconfig.test.json'])
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
