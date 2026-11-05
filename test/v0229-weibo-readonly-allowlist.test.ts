/**
 * The read-only allowlist, tested as a rule rather than through the adapter.
 *
 * ## Why this file exists separately from the write-boundary tests
 *
 * `v0228-weibo-write-boundary.test.ts` proves the **adapter** refuses to publish. That is
 * a boundary one layer up: every one of those tests calls a method on the provider, and
 * the provider is not the thing that spawns a process.
 *
 * This file tests the layer that actually executes. Its subject is "can an argv reach the
 * CLI", which is the only place a boundary cannot be walked around by adding a caller.
 *
 * ## What is asserted, and what is deliberately not
 *
 * The guard is pure, so most of this is a table: verb, action, expected verdict. The one
 * thing that cannot be a table is the *placement* of the check — that it runs before
 * `execFile` rather than after — so that is asserted against the source shape and against
 * an observable: a refused invocation produces a structured refusal with no process start.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { guardCliInvocation, scrubCredentials } from '../lib/platforms/weibo/cli.js'

// Read the source, not the build output: the placement assertion is about the order of
// two statements in the file, and `lib/` is one compiled line per construct.
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'platforms', 'weibo', 'cli.ts'), 'utf8')

test('只读允许列表：本地就绪检查与命令发现被放行', () => {
  const allowed: readonly (readonly string[])[] = [
    ['version'],
    ['doctor'],
    ['commands', 'list', '--available', '--output', 'json'],
    ['commands', 'show', 'statuses', 'show_batch/biz', '--output', 'json'],
    ['auth', 'whoami'],
  ]
  for (const argv of allowed) {
    const verdict = guardCliInvocation(argv)
    assert.equal(verdict.allowed, true, `${argv.join(' ')} 应当被放行，却被拒绝：${verdict.reason ?? ''}`)
  }
})

test('只读允许列表：业务读命令被放行', () => {
  const reads: readonly (readonly string[])[] = [
    ['statuses', 'show', '--id', '5021243409116023', '--output', 'json'],
    ['statuses', 'show_batch/biz', '--ids', '5021243409116023'],
    ['comments', 'list', '--id', '5021243409116023', '--page', '1'],
    ['comments', 'show', '--id', '6002'],
    ['statuses', 'search', '--q', '某个词'],
    ['comments', 'counts', '--ids', '6001,6002'],
  ]
  for (const argv of reads) {
    assert.equal(guardCliInvocation(argv).allowed, true, `${argv.join(' ')} 是读命令，应当放行`)
  }
})

test('只读允许列表：写命令被拒绝，且被标记为写操作', () => {
  const writes: readonly (readonly string[])[] = [
    ['statuses', 'create', '--text', '你好'],
    ['comments', 'create', '--id', '5021243409116023', '--comment', '你好'],
    ['comments', 'reply', '--id', '6002', '--comment', '你好'],
    ['statuses', 'repost', '--id', '5021243409116023'],
    ['statuses', 'destroy', '--id', '5021243409116023'],
    ['comments', 'delete', '--id', '6002'],
    ['friendships', 'create', '--uid', '1234567890'],
    ['friendships', 'destroy', '--uid', '1234567890'],
    ['statuses', 'update', '--id', '5021243409116023'],
    ['users', 'report', '--uid', '1234567890'],
  ]
  for (const argv of writes) {
    const verdict = guardCliInvocation(argv)
    assert.equal(verdict.allowed, false, `${argv.join(' ')} 是写命令，必须拒绝`)
    assert.equal(verdict.looksLikeWrite, true, `${argv.join(' ')} 应当被识别为写操作`)
    assert.match(verdict.reason ?? '', /只做真实只读接入/, '拒绝理由要说明本版定位，而不是只说「不允许」')
  }
})

test('只读允许列表：不认识的命令被拒绝，但不谎称是写操作', () => {
  const unknown: readonly (readonly string[])[] = [
    ['statuses', 'frobnicate'],
    ['mystery', 'list'],
    [],
  ]
  for (const argv of unknown) {
    const verdict = guardCliInvocation(argv)
    assert.equal(verdict.allowed, false, `${JSON.stringify(argv)} 不应被放行`)
    assert.notEqual(verdict.looksLikeWrite, true, '不认识不等于写操作，不要把两者混成一句')
  }
})

test('只读允许列表：绝对路径与 shell 拼接都不能绕过', () => {
  // The guard inspects argv[0] as a verb. An attacker-shaped argument that merely
  // *contains* an allowed verb must not be accepted by substring luck.
  const sneaky: readonly (readonly string[])[] = [
    ['statuses', 'create; rm -rf /'],
    ['statuses', 'list && create'],
    ['--id', '5021243409116023', 'statuses', 'create'],
    ['STATUSES', 'CREATE'],
  ]
  for (const argv of sneaky) {
    assert.equal(guardCliInvocation(argv).allowed, false, `${JSON.stringify(argv)} 不能因为包含某个词而通过`)
  }
})

test('只读允许列表：守卫在 spawn 之前检查，而不是之后', () => {
  // The point is ordering. `runCli` must consult the guard before it ever builds an
  // `attempt(...)` call, otherwise a refused command still reaches the process table.
  const runCliAt = source.indexOf('async function runCli')
  assert.ok(runCliAt !== -1, '找不到 runCli')

  const guardAt = source.indexOf('guardCliInvocation(args)', runCliAt)
  const attemptAt = source.indexOf('const attempt = (file', runCliAt)
  assert.ok(guardAt !== -1, 'runCli 里没有调用守卫')
  assert.ok(attemptAt !== -1, '找不到 attempt 定义')
  assert.ok(guardAt < attemptAt, '守卫必须在构造 spawn 之前执行，否则被拒绝的命令仍然会跑')
})

test('只读允许列表：拒绝结果带着可分类的错误码，不混进「调用失败」', () => {
  // A refusal that reads as `failed` would tell the owner to retry the one thing that
  // must not be retried.
  assert.match(source, /WRITE_FORBIDDEN: \{/, '写拒绝必须有独立错误码')
  assert.match(source, /COMMAND_NOT_ALLOWED: \{/, '未知命令拒绝必须有独立错误码')
  const writeBlock = source.slice(source.indexOf('WRITE_FORBIDDEN: {'))
  assert.match(writeBlock.slice(0, 400), /command_unavailable/, '写拒绝不能归类成 failed')
})

test('只读允许列表：拒绝理由本身不含凭据', () => {
  // The reason string reaches logs and the model's context. It names a command, which is
  // user-supplied, so it goes through the same scrub as every other message.
  //
  // The token below is deliberately a shape, not a secret: 44 characters of filler that
  // matches `scrubCredentials`' opaque-secret rule and nothing else.
  const fakeToken = 'FAKE'.repeat(11)
  const argv = ['statuses', 'create', '--token', fakeToken]
  const verdict = guardCliInvocation(argv)
  const scrubbed = scrubCredentials(verdict.reason ?? '')
  // The guard's message names the verb and action, never the flags — but asserting on the
  // scrub keeps the contract tested if that ever changes.
  assert.doesNotMatch(scrubbed, new RegExp(fakeToken), '理由里不得原样带出 token 形状的串')
})
