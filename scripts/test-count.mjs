#!/usr/bin/env node
/**
 * Count tests per file by running each file and reading the runner's own tally.
 *
 * Written because the delivered test counts drifted from reality: a hand-written
 * number in a README is a claim nobody re-checks. This computes it from the runner
 * so the docs can be generated instead of typed.
 *
 * Usage:
 *   node scripts/test-count.mjs           # print a markdown table
 *   node scripts/test-count.mjs --total   # print just the total
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const testDir = join(root, 'test')

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

const files = testFiles(testDir).sort()

// The repo's tests are TypeScript run through Node's own type stripping.
const NODE_ARGS = ['--experimental-transform-types', '--test']

/** Run one test file and read `ℹ pass N` / `ℹ fail N` from the output. */
function runOne(file) {
  const result = spawnSync(process.execPath, [...NODE_ARGS, join(testDir, file)], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const pass = Number(/ℹ pass (\d+)/.exec(output)?.[1] ?? 0)
  const fail = Number(/ℹ fail (\d+)/.exec(output)?.[1] ?? 0)
  return { file, pass, fail, status: result.status ?? 1 }
}

const rows = files.map(runOne)
const totalPass = rows.reduce((sum, row) => sum + row.pass, 0)
const totalFail = rows.reduce((sum, row) => sum + row.fail, 0)

if (process.argv.includes('--total')) {
  process.stdout.write(`${totalPass}\n`)
  process.exit(totalFail === 0 ? 0 : 1)
}

process.stdout.write('| 测试文件 | 数量 |\n| --- | --- |\n')
for (const row of rows) {
  process.stdout.write(`| \`test/${row.file}\` | ${row.pass} |\n`)
}
process.stdout.write(`| **合计** | **${totalPass}** |\n`)
process.stdout.write(`\nfail: ${totalFail}\n`)
process.exit(totalFail === 0 ? 0 : 1)
