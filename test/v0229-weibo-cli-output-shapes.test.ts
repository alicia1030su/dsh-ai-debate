/**
 * The shapes the official CLI actually prints, and what the parser must do with each.
 *
 * ## Why this file exists (v0.2.29)
 *
 * `parseCliJson` had 1885 passing tests behind it and still could not read a list. The
 * reason is visible in what was tested: every existing case fed it a single object,
 * because every existing caller read one post or one comment. The CLI's own README
 * documents the other shape —
 *
 *     weibo statuses friends_timeline/biz --output json | jq '.[] | .text'
 *
 * — and `jq '.[]'` only works on an array. So the moment a `list` command is called with a
 * real account, the parser fails on valid output and the caller reports `failed`.
 *
 * Each case below is a shape the CLI can produce, with the reason it exists beside it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCliJson, scrubCredentials } from '../lib/platforms/weibo/cli.js'

test('顶层是对象：单条微博/单条评论的常见形状', () => {
  const result = parseCliJson<{ id: string; text: string }>(JSON.stringify({ id: '6001', text: '正文' }))
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.data.text, '正文')
})

test('顶层是数组：列表型命令的真实输出（README 里 jq 的用法证明它是数组）', () => {
  const payload = [
    { id: '6001', text: '甲' },
    { id: '6002', text: '乙' },
  ]
  const result = parseCliJson<{ id: string }[]>(JSON.stringify(payload))
  assert.equal(result.ok, true, '数组必须被解析成数组，而不是内部第一个对象')
  if (result.ok) {
    assert.ok(Array.isArray(result.data), '数组形状不能被降级成对象')
    assert.equal(result.data.length, 2)
  }
})

test('对象里嵌数组：容器型响应仍然是对象', () => {
  const result = parseCliJson<{ comments: { id: string }[] }>(
    JSON.stringify({ comments: [{ id: '6001' }] }),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.ok(!Array.isArray(result.data), '外层是对象时不能把内层数组当成整个文档')
    assert.equal(result.data.comments.length, 1)
  }
})

test('前面有进度行时，数组仍被识别', () => {
  const result = parseCliJson<{ id: string }[]>('Fetching page 1...\n[{"id":"6001"}]')
  assert.equal(result.ok, true)
  if (result.ok) assert.ok(Array.isArray(result.data))
})

test('前面有带方括号的日志前缀时，对象仍被识别', () => {
  // `[INFO] ready` opens a `[` long before the document's `{`. Taking the first bracket
  // would parse `[INFO]` — this is why the *outer* bracket decides, with the other span
  // as a fallback.
  const result = parseCliJson<{ id: string }>('[INFO] ready\n{"id":"6001"}')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.data.id, '6001')
})

test('空数组与空对象各自解析成空容器，不是失败', () => {
  const emptyArray = parseCliJson<unknown[]>('[]')
  const emptyObject = parseCliJson<Record<string, never>>('{}')
  assert.equal(emptyArray.ok, true, '空列表是「读到 0 条」，不是「读失败」')
  assert.equal(emptyObject.ok, true)
  if (emptyArray.ok) assert.deepEqual(emptyArray.data, [])
})

test('完全不是 JSON 时如实失败，理由可读', () => {
  const result = parseCliJson('not json at all')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /没有输出 JSON/)
})

test('截断的数组不会被当成完整数组接受', () => {
  // A half-written document must fail rather than yield a shorter list: a shorter list
  // reads as "the platform has fewer comments", which is a wrong fact, not a failure.
  const result = parseCliJson('[{"id":"6001"},{"id":"6002"')
  assert.equal(result.ok, false, '被截断的数组不能解析成「只有一条」')
})

test('解析失败的 reason 不含凭据形状的串', () => {
  // V8 quotes a fragment of the input in its parse errors; that fragment reaches logs.
  const fakeSecret = 'Z'.repeat(48)
  const result = parseCliJson(`{"token":"${fakeSecret}", broken`)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.doesNotMatch(scrubCredentials(result.reason), new RegExp(fakeSecret))
  }
})
