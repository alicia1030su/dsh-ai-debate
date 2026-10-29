/**
 * v0.2.11 §五：微博官方 CLI 只读适配层。
 *
 * ## 这个文件测什么、不测什么
 *
 * 本机**没有安装** `weibo-cli`，也没有微博开发者认证。所以：
 *
 * - **不测**真实读取（那是「未验证」，报告里如实标注）；
 * - **测**适配层本身：命令注入防护、凭据脱敏、JSON 解析、失败分类、命令发现结构。
 *
 * 后一组不是形式主义：这一层会把**外部文本**（错误输出、命令清单）带进程序，而它
 * 的调用方是 Agent。一个把 stderr 原样转发的实现会把 token 泄漏进模型上下文；一个
 * 用 `shell: true` 拼参数的实现会让一条微博正文变成命令。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  classifyCommands,
  parseCliJson,
  probeWeiboCli,
  scrubCredentials,
  type WeiboCliCommand,
} from '../lib/platforms/weibo/cli.js'

const SOURCE = join(import.meta.dirname, '..', 'src', 'platforms', 'weibo', 'cli.ts')
const source = readFileSync(SOURCE, 'utf8')

// ---------------------------------------------------------------------------
// 命令注入
// ---------------------------------------------------------------------------

/**
 * The source with comments removed.
 *
 * The first version of these assertions scanned raw text and failed on the module's own
 * documentation — a comment saying "there is no `shell: true` here" contains the string
 * `shell: true`. A shape check has to look at code, not prose about the code.
 */
const CODE = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
  .join('\n')

test('调用 CLI 时不得经过 shell：源码里不出现 shell:true 或字符串拼接命令行', () => {
  // A text review cannot prove behaviour, but this particular mistake is a *shape*:
  // `exec`/`execSync` with a template string, or `shell: true`, is how it happens. The
  // safe form is `execFile(binary, argArray)` and nothing else.
  assert.equal(/\bshell\s*:\s*true/.test(CODE), false, '不能启用 shell')
  assert.equal(/\bexecSync\b/.test(CODE), false, '不能用 execSync')
  const withoutExecFile = CODE.replace(/execFile/g, '')
  assert.equal(
    /(?<![A-Za-z])exec\s*\(/.test(withoutExecFile),
    false,
    '不能用 exec（只能用 execFile）',
  )
  assert.match(CODE, /execFile\(\s*\n?\s*BINARY/, '必须用固定可执行文件 + 参数数组')
})

test('可执行文件名是固定常量，不接受外部输入', () => {
  // If the binary were configurable, a payload could point it at anything. Assert on the
  // *assignment values* rather than on a regex with a lookahead: the lookahead version
  // used here first back-tracked over the trailing space and matched its own happy path.
  const assignments = [...CODE.matchAll(/\bBINARY\s*=\s*([^\n]+)/g)].map((match) => match[1]!.trim())
  assert.equal(assignments.length, 1, `应当只有一个 BINARY 赋值，实际 ${assignments.length}`)
  assert.equal(assignments[0], `'weibo-cli'`, `可执行文件名必须写死为 'weibo-cli'，实际 ${assignments[0]}`)
})

test('参数以数组传给 execFile，而不是拼成一个字符串', () => {
  // `[...args]` spread into the argv position is the shape that makes shell
  // metacharacters inert. A joined string (`args.join(' ')`) would not be.
  assert.match(CODE, /execFile\(\s*\n?\s*BINARY,\s*\n?\s*\[\.\.\.args\]/, 'argv 必须是数组展开')
  assert.equal(/args\.join\(/.test(CODE), false, '不能把参数 join 成字符串')
})

// ---------------------------------------------------------------------------
// 凭据脱敏
// ---------------------------------------------------------------------------

test('Bearer token 被脱敏', () => {
  const line = 'request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghij'
  const scrubbed = scrubCredentials(line)
  assert.equal(scrubbed.includes('eyJhbGciOiJIUzI1NiJ9abcdefghij'), false, scrubbed)
  assert.match(scrubbed, /Bearer <redacted>/)
})

test('query 形式的 token / code / client_secret 被脱敏', () => {
  const line = 'https://api.weibo.com/x?access_token=2.00abc123def&code=SEKRET&client_secret=zzz'
  const scrubbed = scrubCredentials(line)
  for (const secret of ['2.00abc123def', 'SEKRET', 'zzz']) {
    assert.equal(scrubbed.includes(secret), false, `不应残留 ${secret}：${scrubbed}`)
  }
  assert.match(scrubbed, /access_token=<redacted>/)
})

test('长的不透明串被脱敏（微博 token 形状）', () => {
  const token = 'a'.repeat(48)
  const scrubbed = scrubCredentials(`token=${token}`)
  assert.equal(scrubbed.includes(token), false, scrubbed)
})

test('普通文本不被过度脱敏：错误原因要能读', () => {
  // A scrubber that blanks everything is useless — the owner needs the reason. This
  // pins that short, meaningful words survive.
  const line = '额度不足：本次读取未执行。请运行 weibo-cli doctor 查看状态。'
  assert.equal(scrubCredentials(line), line)
})

// ---------------------------------------------------------------------------
// JSON 解析
// ---------------------------------------------------------------------------

test('纯 JSON 输出正常解析', () => {
  const result = parseCliJson<{ ok: boolean }>('{"ok":true}')
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok === true ? result.data : undefined, { ok: true })
})

test('前面带进度行的输出也能解析（取第一个 { 到最后一个 }）', () => {
  // Real CLIs print "fetching…" before the payload. Assuming stdout is pure JSON would
  // make every such call look like a parse failure.
  const stdout = 'fetching statuses...\n{"mid":"4331051486294436"}\n'
  const result = parseCliJson<{ mid: string }>(stdout)
  assert.equal(result.ok, true)
  assert.equal(result.ok === true ? result.data.mid : undefined, '4331051486294436')
})

test('没有 JSON 时明确失败，不返回空对象', () => {
  // Returning `{}` here would let a caller read "unreadable" as "empty" — the same
  // collapse the whole project keeps having to avoid.
  const result = parseCliJson('error: not authenticated')
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /没有输出 JSON/)
})

test('截断的 JSON 明确失败，不返回半个对象', () => {
  // Two shapes of "not usable", both must fail:
  //   - `{"mid":` has no closing brace, so it is not a JSON object span at all;
  //   - `{"mid": }` has the span but the content is invalid.
  // Which message appears is an implementation detail; returning a value is not.
  for (const stdout of ['{"mid":', '{"mid": }', '{]']) {
    const result = parseCliJson(stdout)
    assert.equal(result.ok, false, `不应解析成功：${JSON.stringify(stdout)}`)
    assert.equal(
      (result.ok === false ? result.reason : '').length > 0,
      true,
      '失败必须带原因',
    )
  }
})

// ---------------------------------------------------------------------------
// 本机真实探测
// ---------------------------------------------------------------------------

test('本机探测：没有 weibo-cli 时状态必须是 cli_missing，而不是笼统的失败', async () => {
  // This runs against the real machine. On this host the CLI is genuinely absent, so
  // the result is `cli_missing` — and the distinction matters: "not installed" tells
  // the owner to install something, "failed" tells them to look for a bug.
  //
  // If the CLI later gets installed, the status legitimately becomes one of the other
  // values; the assertion is therefore about *not* collapsing to `failed`.
  const readiness = await probeWeiboCli()
  assert.equal(readiness.status !== 'failed', true, `不该是笼统的 failed：${JSON.stringify(readiness)}`)
  assert.equal(typeof readiness.message, 'string')
  assert.equal(readiness.message.length > 0, true)
  if (readiness.status === 'cli_missing') {
    assert.equal(readiness.canRead, false)
    assert.equal(readiness.steps.length > 0, true, '缺 CLI 时必须给出安装步骤')
    assert.match(readiness.steps.join(' '), /npm install -g @weibo-ai\/weibo-cli/)
  }
  // Whatever the status, the message must not leak a token.
  assert.equal(/Bearer\s+[A-Za-z0-9]{8,}/.test(readiness.message), false)
})

// ---------------------------------------------------------------------------
// 命令发现的结构
// ---------------------------------------------------------------------------

test('命令发现：识别 statuses / comments 两类读取命令', () => {
  // The exact command names come from the server's catalog; this only checks that the
  // *classifier* recognises the families the manual describes, so a present catalog is
  // not reported as "no read capability".
  const commands: WeiboCliCommand[] = [
    { name: 'statuses/show' },
    { name: 'comments/list' },
    { name: 'users/show' },
  ]
  const classified = classifyCommands(commands)
  assert.equal(classified.statuses, true)
  assert.equal(classified.comments, true)
})

test('命令发现：只有无关命令时，读取能力如实为 false', () => {
  const classified = classifyCommands([{ name: 'article/publish' }, { name: 'users/show' }])
  assert.equal(classified.statuses, false)
  assert.equal(classified.comments, false)
})

test('命令发现：空清单不报错，两类能力都是 false', () => {
  const classified = classifyCommands([])
  assert.equal(classified.statuses, false)
  assert.equal(classified.comments, false)
})
