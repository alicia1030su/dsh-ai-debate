/**
 * v0.2.34 §3.1：两种协议形状，同一个 `LlmClient`。
 *
 * ## 为什么必须按形状测，而不是按模型名测
 *
 * 「这个模型应该走 responses」是一个**猜测**。同一家厂商的不同模型、同一个模型的
 * 不同部署、以及各种中转网关，都可能只支持其中一种。真实故障的形状是：
 *
 * - 协议填错 → 对方返回 **200**，但 body 里没有我们要的字段；
 * - 于是「协议不对」被报成「模型返回了空内容」或「接口不兼容」；
 * - 而这两句话指向的下一步完全不同（改配置 vs 改提示词）。
 *
 * 所以这一组测试断言的是：**每种形状各自被正确读出，且每种错误有自己的措辞**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { LlmError, OpenAiCompatibleClient } from '../lib/llm.js'

/** 用假 fetch 记下请求体，并回答给定的 body。 */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = []
  const impl = (async (url: any, init?: any) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

const base = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key', model: 'm' }

test('chat 协议：打到 /chat/completions，读 choices[0].message.content', async () => {
  const { impl, calls } = stubFetch({
    choices: [{ message: { content: '回复' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 22 },
  })
  const client = new OpenAiCompatibleClient({ ...base, protocol: 'chat', fetchImpl: impl })
  const result = await client.complete({ messages: [{ role: 'user', content: 'hi' }] })

  assert.equal(calls[0]!.url, 'http://127.0.0.1:1/v1/chat/completions')
  assert.equal(calls[0]!.body.messages[0].content, 'hi')
  assert.equal(calls[0]!.body.max_tokens, 900)
  assert.equal(result.text, '回复')
  assert.equal(result.inputTokens, 11)
  assert.equal(result.outputTokens, 22)
  assert.equal(result.truncated, undefined)
})

test('chat 协议：finish_reason=length 标记为截断（不是「内容为空」）', async () => {
  const { impl } = stubFetch({
    choices: [{ message: { content: '说到一半' }, finish_reason: 'length' }],
  })
  const client = new OpenAiCompatibleClient({ ...base, protocol: 'chat', fetchImpl: impl })
  const result = await client.complete({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.truncated, true)
  assert.equal(result.finishReason, 'length')
})

test('responses 协议：打到 /responses，system 变 instructions，input 用 input_text', async () => {
  const { impl, calls } = stubFetch({ output_text: 'OK', usage: { input_tokens: 5, output_tokens: 1 } })
  const client = new OpenAiCompatibleClient({ ...base, protocol: 'responses', fetchImpl: impl })
  const result = await client.complete({
    system: '只回复 OK',
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 8,
  })

  assert.equal(calls[0]!.url, 'http://127.0.0.1:1/v1/responses')
  assert.equal(calls[0]!.body.instructions, '只回复 OK')
  assert.deepEqual(calls[0]!.body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }])
  assert.equal(calls[0]!.body.max_output_tokens, 8)
  // chat 专属字段不能出现在 responses 请求里。
  assert.equal('max_tokens' in calls[0]!.body, false)
  assert.equal('messages' in calls[0]!.body, false)

  assert.equal(result.text, 'OK')
  assert.equal(result.inputTokens, 5)
})

test('responses 协议：原始形状 output[].content[].text 也能读出', async () => {
  const { impl } = stubFetch({
    output: [
      { type: 'message', content: [{ type: 'output_text', text: '第一段' }, { type: 'output_text', text: '第二段' }] },
    ],
    status: 'completed',
  })
  const client = new OpenAiCompatibleClient({ ...base, protocol: 'responses', fetchImpl: impl })
  const result = await client.complete({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.text, '第一段第二段')
  assert.equal(result.finishReason, 'completed')
})

test('responses 协议：status=incomplete + max_output_tokens 标记为截断', async () => {
  const { impl } = stubFetch({
    output: [{ content: [{ type: 'output_text', text: '半句' }] }],
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
  })
  const client = new OpenAiCompatibleClient({ ...base, protocol: 'responses', fetchImpl: impl })
  const result = await client.complete({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.truncated, true)
  assert.equal(result.finishReason, 'max_output_tokens')
})

test('协议填错（chat 打到 responses）：错误里要指出「协议」这件事', async () => {
  // 这是真实中转网关的行为：URL 对了，但返回的是另一种形状。
  const { impl } = stubFetch({ output_text: 'hi', status: 'completed' }, 200)
  const client = new OpenAiCompatibleClient({ ...base, protocol: 'chat', fetchImpl: impl })
  await assert.rejects(
    () => client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'bad_response')
      // 关键：措辞里必须出现「responses」这个可行动的线索。
      assert.match(error.message, /responses/)
      return true
    },
  )
})

test('协议填错（responses 打到 chat）：错误里要指出「chat」这件事', async () => {
  const { impl } = stubFetch({ choices: [{ message: { content: 'hi' } }] }, 200)
  const client = new OpenAiCompatibleClient({ ...base, protocol: 'responses', fetchImpl: impl })
  await assert.rejects(
    () => client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'bad_response')
      assert.match(error.message, /chat/)
      return true
    },
  )
})

test('responses 里 output 为空数组：是「模型没产出」，不是协议错', async () => {
  const { impl } = stubFetch({ output: [], status: 'completed' })
  const client = new OpenAiCompatibleClient({ ...base, protocol: 'responses', fetchImpl: impl })
  await assert.rejects(
    () => client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      // 「空内容」而不是「接口不兼容」：下一步该改提示词，不是改 Base URL。
      assert.equal(error.code, 'bad_response')
      assert.match(error.message, /空内容/)
      return true
    },
  )
})

test('默认协议是 chat：既有部署升级后行为不变', async () => {
  const { impl, calls } = stubFetch({ choices: [{ message: { content: 'x' } }] })
  const client = new OpenAiCompatibleClient({ ...base, fetchImpl: impl })
  await client.complete({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(calls[0]!.url.endsWith('/chat/completions'), true)
})

test('两种协议都不把 Authorization 之外的密钥写进可观测字段', async () => {
  const { impl, calls } = stubFetch({ output_text: 'ok' })
  const client = new OpenAiCompatibleClient({ ...base, protocol: 'responses', fetchImpl: impl })
  const result = await client.complete({ messages: [{ role: 'user', content: 'hi' }] })
  // key 只在 header 里；返回的对象里没有它。
  assert.equal(calls[0]!.headers.authorization, 'Bearer fixture-key')
  assert.equal(JSON.stringify(result).includes('fixture-key'), false)
})
