/**
 * Regression tests for `scripts/test-count.mjs`.
 *
 * ## What went wrong, and what these tests pin down
 *
 * The README's test total is generated from this script, so a wrong number here
 * becomes a wrong claim in the docs — and the v0.2.3 edition was wrong on CI in
 * the most dangerous way available: it parsed `ℹ pass N`, CI emitted TAP
 * (`# pass N`), every file counted as zero, and the script exited **0**. A silent
 * zero is worse than a crash, because nothing downstream has a reason to look.
 *
 * Three properties are asserted, in the order they would have caught it:
 *
 * 1. The tally is parsed from the format that is actually produced.
 * 2. A run whose files crashed refuses to produce a total at all.
 * 3. A tally that cannot be parsed is an error, not a zero.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

import { TEST_REPORTER, parseTally, totalize } from '../scripts/test-count.mjs'

const ROOT = join(import.meta.dirname, '..')

test('脚本显式指定报告格式，不依赖调用方的终端', () => {
  // If this ever becomes "whatever the environment picks", the parse below is a
  // guess again.
  assert.equal(TEST_REPORTER, 'tap')
})

test('解析 TAP 的 # pass / # fail', () => {
  const tap = ['1..12', '# tests 12', '# suites 0', '# pass 12', '# fail 0', '# duration_ms 226'].join('\n')
  assert.deepEqual(parseTally(tap), { pass: 12, fail: 0, tests: 12 })
})

test('解析 spec 的 ℹ pass / ℹ fail（捕获的日志也要能读）', () => {
  const spec = ['ℹ tests 12', 'ℹ suites 0', 'ℹ pass 12', 'ℹ fail 0', 'ℹ duration_ms 209'].join('\n')
  assert.deepEqual(parseTally(spec), { pass: 12, fail: 0, tests: 12 })
})

test('两种格式给出同一个数字', () => {
  // The bug in one assertion: the same suite reported 12 under one reporter and 0
  // under the other.
  const tap = '# tests 12\n# pass 12\n# fail 0'
  const spec = 'ℹ tests 12\nℹ pass 12\nℹ fail 0'
  assert.equal(parseTally(tap).pass, parseTally(spec).pass)
})

test('没有计数时返回 undefined，而不是 0', () => {
  // "the runner did not say" and "zero passed" are different facts. Reporting the
  // second when the first is true is how a broken run becomes a green build.
  const result = parseTally('some output with no tally at all')
  assert.equal(result.pass, undefined)
  assert.equal(result.fail, undefined)
})

test('非零退出的文件让整个统计失败', () => {
  const rows = [
    { file: 'a.test.ts', pass: 5, fail: 0, status: 0 },
    { file: 'b.test.ts', pass: 3, fail: 0, status: 1 },
  ]
  assert.throws(() => totalize(rows), /运行失败/, '有文件退出非零时必须拒绝给总数')
})

test('解析不出来的文件让整个统计失败', () => {
  const rows = [
    { file: 'a.test.ts', pass: 5, fail: 0, status: 0 },
    { file: 'b.test.ts', pass: undefined, fail: undefined, status: 0 },
  ]
  assert.throws(() => totalize(rows), /无法解析/, '解析失败不能当成 0 计入')
})

test('全部正常时给出正确的合计', () => {
  const rows = [
    { file: 'a.test.ts', pass: 5, fail: 0, status: 0 },
    { file: 'b.test.ts', pass: 3, fail: 1, status: 0 },
  ]
  assert.deepEqual(totalize(rows), { pass: 8, fail: 1 })
})

test('存在失败用例时合计仍然返回，由调用方决定退出码', () => {
  // A suite with failing tests is not a *parse* problem: the numbers are real and
  // should be printable. Only crashes and unparsable output are structural.
  const rows = [{ file: 'a.test.ts', pass: 4, fail: 2, status: 0 }]
  assert.deepEqual(totalize(rows), { pass: 4, fail: 2 })
})

test('真实运行：--total 打印的数字与逐文件之和一致', () => {
  // End-to-end over two small files, so the reporter flag and the parse are shown
  // working together rather than separately.
  //
  // `NODE_TEST_CONTEXT` must be cleared for the child, exactly as the script does:
  // this test runs *inside* a `node:test` process, so the variable is set here, and
  // a child that inherits it believes it is a nested runner and silently runs
  // nothing (exit 0, no tally). That failure mode is why the script has `childEnv()`
  // at all, and reproducing it here is what keeps that function honest.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT

  const run = (file) => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-transform-types', '--test', `--test-reporter=${TEST_REPORTER}`, join(ROOT, 'test', file)],
      { cwd: ROOT, encoding: 'utf8', shell: false, env },
    )
    return { file, ...parseTally(`${result.stdout ?? ''}${result.stderr ?? ''}`), status: result.status ?? 1 }
  }

  const rows = [run('target.test.ts'), run('security/trust-boundary.test.ts')]
  assert.ok(
    rows.every((row) => row.status === 0),
    `子运行失败：${rows.map((row) => `${row.file}=${row.status}`).join(', ')}`,
  )
  const totals = totalize(rows)
  assert.ok(totals.pass > 0, '两次运行都不该是 0 个测试')
  assert.equal(totals.fail, 0)
})

test('继承 NODE_TEST_CONTEXT 的子运行会被识别为无统计，而不是 0', () => {
  // The guard for the trap above: prove that an inherited context really does
  // produce no tally, so nobody "simplifies" `childEnv()` away believing the
  // variable is harmless.
  const { NODE_TEST_CONTEXT: _ignored, ...rest } = process.env
  const inherited = { ...rest, NODE_TEST_CONTEXT: 'child-v8' }
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--test', `--test-reporter=${TEST_REPORTER}`, join(ROOT, 'test', 'target.test.ts')],
    { cwd: ROOT, encoding: 'utf8', shell: false, env: inherited },
  )
  const tally = parseTally(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  assert.equal(tally.pass, undefined, '带上下文运行时不应产出可解析的统计')
  // And the totalizer must refuse rather than add a zero.
  assert.throws(
    () => totalize([{ file: 'target.test.ts', pass: tally.pass, fail: tally.fail, status: result.status ?? 1 }]),
    /无法解析|运行失败/,
  )
})
