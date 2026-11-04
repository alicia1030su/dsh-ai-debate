/**
 * The CI failure that looked like a flaky platform, pinned as a real mechanism.
 *
 * ## What actually happened
 *
 * The v0.2.26 main build failed one job with:
 *
 * ```
 * not ok 138 - test/v028-corrupt-overwrite.test.ts
 *   failureType: 'uncaughtException'
 *   error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
 *   stack: #processRawBuffer (node:internal/test_runner/runner)
 *          FileTest.parseMessage (node:internal/test_runner/runner)
 * ```
 *
 * …while the same file reported `1..3` with all three subtests `ok` immediately above it.
 * A test that passed every assertion was reported as a failing file.
 *
 * The first reading — "GitHub had a hiccup" — was wrong. `node --test` without an explicit
 * reporter streams each file's results to the parent over **that file's stdout**, as
 * V8-serialized frames. A frame starts with the two-byte header `ff 0f`; the parent scans
 * for that pair, reads the next four bytes as a length, and deserializes that many bytes.
 * Text between frames is harmless. Text that *contains* the header pair is not: it resets
 * the frame boundary, and the following bytes are read as a length that no longer describes
 * a frame.
 *
 * So a test that prints to stdout — `console.log` is the obvious way — can make the runner
 * misparse its own transport. Whether it does depends on the bytes printed, which is why it
 * looked intermittent and why it hit a file whose debugging output happened to collide.
 *
 * ## What this file proves
 *
 * Both directions, by running the real runner in a child process:
 *
 * 1. `console.log` with ordinary text is survivable — it is *the header bytes* that break it,
 *    not "printing" as such. Stating this prevents the wrong fix ("ban all output") and the
 *    wrong conclusion ("text is always fine").
 * 2. A test writing `ff 0f` to stdout makes the runner report the file as `not ok` with that
 *    exact error, even though its assertions passed.
 *
 * Then it asserts the rule the project now follows: test diagnostics go through
 * `t.diagnostic()`, which travels inside the protocol, and no test file writes to stdout
 * directly. `scripts/ci-guard.mjs` enforces the same rule on every push; this test explains
 * it and keeps it from being deleted as "over-strict" without evidence.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')

/** Run `node --test` over a throwaway file and return the decoded output. */
function runSingleton(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tap-'))
  try {
    writeFileSync(join(dir, 'probe.test.mjs'), body, 'utf8')
    // ## The child must not think it is a nested runner
    //
    // `node --test` sets `NODE_TEST_CONTEXT=child-v8` for the child it spawns. Inheriting
    // that makes our grandchild emit nothing at all — measured: 0 bytes of output, exit 0.
    // `test/test-count.test.ts` documents the same trap from the other direction ("a child
    // that inherits it believes it is a nested runner and silently runs nothing"). Deleting
    // it is what makes this probe observe the real protocol.
    const env = { ...process.env }
    delete env['NODE_TEST_CONTEXT']
    try {
      return execFileSync(process.execPath, ['--test', 'probe.test.mjs'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
    } catch (error) {
      // A non-zero exit is the failing case under test; its output is the evidence.
      const failure = error as { stdout?: string; stderr?: string }
      return `${failure.stdout ?? ''}${failure.stderr ?? ''}`
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('普通文本输出不会破坏 node --test 的传输（所以「别打印」不是正确的规则）', () => {
  const out = runSingleton(`
import { test } from 'node:test'
test('prints text', () => { console.log('  普通调试文本，不含控制字节') })
test('passes', () => {})
`)
  assert.doesNotMatch(
    out,
    /Unable to deserialize/,
    `普通文本不该触发反序列化失败，实际输出：\n${out.slice(0, 600)}`,
  )
  assert.match(out, /# pass 2/, `两个用例都应通过，实际：\n${out.slice(0, 400)}`)
})

test('往 stdout 写 V8 帧头字节会让运行器把整个文件判为失败，而断言其实全过了', () => {
  // `ff 0f` is the V8 serializer header. Writing it to stdout inside a test makes the
  // parent treat what follows as a frame header plus a four-byte length.
  const out = runSingleton(`
import { test } from 'node:test'
test('writes the v8 header', () => {
  process.stdout.write(Buffer.from([0xff, 0x0f, 0x00, 0x00, 0x00, 0x10]))
})
test('assertions would pass', () => {})
`)
  assert.match(
    out,
    /not ok/,
    `写帧头字节必须让文件被判失败，否则这个机制就不成立。实际输出：\n${out.slice(0, 800)}`,
  )
  assert.match(
    out,
    /Unable to deserialize cloned data/,
    `错误必须是反序列化失败——这正是 v0.2.26 main CI 上的那条。实际输出：\n${out.slice(0, 800)}`,
  )
})

test('t.diagnostic 是安全的诊断通道，且不会让用例失败', () => {
  const out = runSingleton(`
import { test } from 'node:test'
test('diagnoses', (t) => {
  t.diagnostic('  这条诊断走协议内部')
})
`)
  assert.doesNotMatch(out, /Unable to deserialize/, `t.diagnostic 不该破坏传输：\n${out.slice(0, 500)}`)
  assert.match(out, /# pass 1/, `仍然应当通过：\n${out.slice(0, 400)}`)
})

test('仓库里的测试文件不再直接写 stdout', () => {
  // The same rule `scripts/ci-guard.mjs` enforces, asserted here so the reason travels with
  // the code. `console.log` inside a child-process template literal is exempt: that child's
  // stdout is a pipe the test reads, not the runner's transport.
  const dir = join(ROOT, 'test')
  const offenders: string[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.ts')) continue
    const lines = readFileSync(join(dir, name), 'utf8').split('\n')
    let inTemplate = false
    for (let i = 0; i < lines.length; i += 1) {
      const startedInside = inTemplate
      if (((lines[i].match(/`/g) ?? []).length) % 2 === 1) inTemplate = !inTemplate
      if (startedInside) continue
      if (/^\s*console\.(log|info|debug|warn)\(/.test(lines[i])) offenders.push(`${name}:${i + 1}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些位置直接写 stdout，会让 CI 报 "Unable to deserialize cloned data"：${offenders.join('、')}。请改用 t.diagnostic()`,
  )
})
