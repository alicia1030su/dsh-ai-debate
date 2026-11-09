/**
 * 错误指引的回归测试（v0.2.39 §4.2）。
 *
 * ## 这组测试要钉住的是「每句话都能照做」
 *
 * 一个错误提示最容易犯的错不是「不准确」，而是「说完等于没说」：
 * 「调用失败」「请检查配置」「发生错误」三种都准确，也都没用。所以这里的断言不是
 * 比对文案，而是检查**结构**：有没有下一步、下一步是不是空的、是不是至少有一条
 * 指向具体的界面位置或具体动作。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { GUIDE_IDS, guideForError, guideIdOfLlmCode, guideOf } from '../lib/guide.js'
import { LlmError } from '../lib/llm.js'

/** 指向具体动作或位置的词。没有这些，一条「下一步」就只是安慰。 */
const ACTIONABLE =
  /(设置|点|填|确认|打开|切换|复制|粘贴|检查|登录|改|试|看|换|补|等|浏览器|地址|链接|字段|按钮|页面|DSH)/

test('每一类错误都有标题与至少一条下一步', () => {
  for (const id of GUIDE_IDS) {
    const guide = guideOf(id)
    assert.equal(guide.id, id)
    assert.ok(guide.title.length >= 8, `${id} 的标题太短，说不清发生了什么`)
    assert.ok(guide.next.length >= 1, `${id} 没有给出下一步`)
    for (const line of guide.next) {
      assert.ok(line.trim().length >= 6, `${id} 的某条下一步太短`)
    }
  }
})

test('每一条下一步都指向具体动作，不是「请检查配置」这类空话', () => {
  for (const id of GUIDE_IDS) {
    for (const line of guideOf(id).next) {
      assert.match(line, ACTIONABLE, `${id} 的下一步「${line}」没有指向任何具体动作`)
    }
  }
})

test('标题互不重复：五种「失败」不能共用一句话', () => {
  const titles = GUIDE_IDS.map((id) => guideOf(id).title)
  assert.equal(new Set(titles).size, titles.length)
})

test('可重试与不可重试分开：认证失败不该鼓励反复点按钮', () => {
  assert.equal(guideOf('auth_failed').retryable, false)
  assert.equal(guideOf('no_host_model').retryable, false)
  assert.equal(guideOf('timeout').retryable, true)
  assert.equal(guideOf('network').retryable, true)
})

test('材料不足被标成不可重试：重试不会让材料变多', () => {
  assert.equal(guideOf('insufficient_evidence').retryable, false)
})

test('LlmError 的码能翻成指引，且认不出的返回 undefined', () => {
  assert.equal(guideIdOfLlmCode('unauthorized'), 'auth_failed')
  assert.equal(guideIdOfLlmCode('timeout'), 'timeout')
  assert.equal(guideIdOfLlmCode('rate_limited'), 'quota')
  assert.equal(guideIdOfLlmCode('bad_response'), 'protocol_mismatch')
  assert.equal(guideIdOfLlmCode('cancelled'), undefined)
  assert.equal(guideIdOfLlmCode('unknown'), undefined)
  assert.equal(guideIdOfLlmCode('something-new'), undefined, '新码不该被猜成某一条')
})

test('从真实错误对象上取指引：认 code，不认消息文本', () => {
  const auth = new LlmError('401 Unauthorized', 'unauthorized')
  assert.equal(guideForError(auth)?.id, 'auth_failed')

  // 消息里写着「没有可用模型」但 code 是 unknown：不能靠文本猜。
  const misleading = new LlmError('宿主有提供方，但没有可用模型', 'unknown')
  assert.equal(guideForError(misleading), undefined)
})

test('带 guide 字段的错误按字段取，优先于 code', () => {
  const error = Object.assign(new LlmError('x', 'unknown'), { guide: 'no_comments' })
  assert.equal(guideForError(error)?.id, 'no_comments')
})

test('非对象、null、字符串都不会让指引崩溃', () => {
  assert.equal(guideForError(null), undefined)
  assert.equal(guideForError(undefined), undefined)
  assert.equal(guideForError('boom'), undefined)
  assert.equal(guideForError(42), undefined)
})

test('十一种用户会遇到的错误都在表里', () => {
  const required = [
    'no_host_model',
    'host_model_unavailable',
    'bad_base_url',
    'auth_failed',
    'protocol_mismatch',
    'import_format',
    'no_comments',
    'insufficient_evidence',
    'network',
    'timeout',
    'clipboard_blocked',
  ]
  for (const id of required) {
    assert.ok(GUIDE_IDS.includes(id as never), `缺少 ${id} 的指引`)
  }
})
