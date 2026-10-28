#!/usr/bin/env node
/**
 * Count tests per file by running each file and reading the runner's own tally.
 *
 * Written because the delivered test counts drifted from reality: a hand-written
 * number in a README is a claim nobody re-checks. This computes it from the runner
 * so the docs can be generated instead of typed.
 *
 * ## Why the reporter is pinned
 *
 * Node picks its default test reporter from the environment. On a TTY it uses the
 * `spec` shape (`ℹ pass 12`); when stdout is a pipe — which is what a CI runner is
 * — it can emit TAP (`# pass 12`) instead. v0.2.3's version of this script matched
 * only `ℹ pass`, so on CI every file parsed as zero passing tests and the "total"
 * was a confident, wrong number.
 *
 * Two rules follow, and both are enforced below:
 *
 * 1. **Ask for a specific reporter.** `--test-reporter=tap` makes the output shape
 *    a property of this script rather than of the caller's terminal. Parsing then
 *    has one documented format to read, not two to guess between.
 * 2. **A non-zero exit is a failure, never a partial count.** If a file crashes,
 *    its tally may be missing or short. Reporting the sum of whatever parsed would
 *    describe a suite that does not exist, so the whole run fails instead.
 *
 * Both formats are still *parsed*, because `runOne` is also used against captured
 * output in the regression test; but only TAP is *produced*.
 *
 * Usage:
 *   node scripts/test-count.mjs           # print a markdown table
 *   node scripts/test-count.mjs --total   # print just the total
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The reporter this script asks for, and therefore the format it expects. */
export const TEST_REPORTER = 'tap'

/**
 * Parse a runner tally out of captured output.
 *
 * Accepts TAP (`# pass 12`) and the spec shape (`ℹ pass 12`) so captured logs from
 * either reporter can be checked, but a caller that wants a stable number must pin
 * the reporter.
 *
 * Returns `undefined` for a count that is not present, rather than 0: "the runner
 * did not say" and "zero tests passed" are different facts, and only one of them
 * is safe to add to a total.
 */
export function parseTally(output) {
  const read = (label) => {
    const tap = new RegExp(`^# ${label}\\s+(\\d+)\\s*$`, 'm').exec(output)
    if (tap) return Number(tap[1])
    const spec = new RegExp(`^\\u2139 ${label}\\s+(\\d+)\\s*$`, 'm').exec(output)
    if (spec) return Number(spec[1])
    return undefined
  }
  return { pass: read('pass'), fail: read('fail'), tests: read('tests') }
}

/**
 * Every `.test.ts` under `test/`, recursively.
 *
 * Recursive because v0.2.3 added `test/security/`. A non-recursive listing silently
 * omitted 46 tests from the README table, which is worse than being wrong loudly:
 * the table looked complete.
 */
function testFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...testFiles(join(dir, entry.name), relative))
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(relative)
    }
  }
  return out
}

/**
 * Collapse per-file results into a total, refusing to paper over failures.
 *
 * Throws rather than returning a partial table: the only honest total is one where
 * every file ran and every file's numbers came back.
 */
export function totalize(rows) {
  const crashed = rows.filter((row) => row.status !== 0)
  const unparsed = rows.filter((row) => row.pass === undefined || row.fail === undefined)
  const problems = []
  if (crashed.length > 0) {
    problems.push(
      `${crashed.length} 个测试文件运行失败：` +
        crashed.map((row) => `${row.file}(exit ${row.status})`).join('、'),
    )
  }
  if (unparsed.length > 0) {
    problems.push(
      `${unparsed.length} 个测试文件的统计无法解析（报告格式不对？）：` +
        unparsed.map((row) => row.file).join('、'),
    )
  }
  if (problems.length > 0) {
    throw new Error(`test-count: ${problems.join('；')}。不能把部分结果当成全量测试数。`)
  }
  return {
    pass: rows.reduce((sum, row) => sum + row.pass, 0),
    fail: rows.reduce((sum, row) => sum + row.fail, 0),
  }
}

/** Run one test file and read its tally. */
function runOne(file) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--test', `--test-reporter=${TEST_REPORTER}`, join(testDir, file)],
    { cwd: root, encoding: 'utf8', shell: false, env: childEnv() },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const { pass, fail } = parseTally(output)
  return { file, pass, fail, status: result.status ?? 1 }
}

/**
 * The environment a child runner gets.
 *
 * `NODE_TEST_CONTEXT` is set by `node:test` inside a test process and inherited by
 * anything it spawns. A child that sees it believes it is a nested runner, prints
 * "run() is being called recursively within a test file. skipping running files"
 * and runs nothing — exit code 0, no tally, which `parseTally` reports as
 * `undefined` and `totalize` refuses. That is the correct outcome for the totals,
 * but it makes this script untestable from inside the suite, and worse, it means
 * the same bug would appear for anyone calling it from a test.
 *
 * Deleting the variable gives the child a clean "I am the outermost runner"
 * environment, which is what a count run needs.
 */
function childEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}

const root = join(import.meta.dirname, '..')
const testDir = join(root, 'test')

/** Only run when invoked directly; the exports exist for the regression test. */
function main() {
  const files = testFiles(testDir).sort()
  const rows = files.map(runOne)

  let totals
  try {
    totals = totalize(rows)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }

  if (process.argv.includes('--total')) {
    process.stdout.write(`${totals.pass}\n`)
    process.exit(totals.fail === 0 ? 0 : 1)
  }

  process.stdout.write('| 测试文件 | 数量 |\n| --- | --- |\n')
  for (const row of rows) {
    process.stdout.write(`| \`test/${row.file}\` | ${row.pass} |\n`)
  }
  process.stdout.write(`| **合计** | **${totals.pass}** |\n`)
  process.stdout.write(`\nfail: ${totals.fail}\n`)
  process.exit(totals.fail === 0 ? 0 : 1)
}

// `import.meta.main` is available on Node 24+; fall back to comparing argv so the
// script also runs on Node 22, which this project's CI still covers.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.main === true ||
    process.argv[1].replace(/\\/g, '/').endsWith('scripts/test-count.mjs'))

if (invokedDirectly) main()
