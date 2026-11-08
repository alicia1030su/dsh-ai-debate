/**
 * v0.2.35 §6：模型调用的可靠性，按**故障形状**逐条测。
 *
 * ## 这一组为什么必须存在
 *
 * 真实模型的失败不是一种，而是十几种：HTTP 200 但没有正文、JSON 结构不对、被截断、
 * 429、500、超时、用户取消……它们在调用方看来都是一句 `Error`，但**下一步动作完全不同**：
 * 截断要调大输出上限，429 要等，401 要换 Key，取消不该重试。把它们的处理压成一句
 * 「模型调用失败」，就是把可修的问题变成不可修的问题。
 *
 * 这里用假的 fetch 逐条构造每种返回，断言的是**分类**与**是否重试**两个决定，
 * 而不是错误文案的措辞。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { LlmError, OpenAiCompatibleClient } from '../lib/llm.js'

/** A fetch that answers with one canned response and records the requests. */
function fakeFetch(responses: readonly { status?: number; body: string; headers?: Record<string, string> }[]) {
  const calls: { url: string; body: string }[] = []
  let index = 0
  const impl = (async (url: string, init: { body?: string }) => {
    calls.push({ url: String(url), body: String(init.body ?? '') })
    const next = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return new Response(next.body, { status: next.status ?? 200, headers: next.headers })
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** The request every case sends. */
const request = { messages: [{ role: 'user' as const, content: 'ping' }], maxTokens: 16 }

/** Run one completion and return the failure, asserting it is an LlmError. */
async function failureOf(client: OpenAiCompatibleClient): Promise<LlmError> {
  try {
    await client.complete(request)
  } catch (error) {
    assert.ok(error instanceof LlmError, `必须抛 LlmError，实际 ${String(error)}`)
    return error
  }
  throw new Error('期望失败，但调用成功了')
}

test('HTTP 200 但正文为空：报 bad_response，不重试', async () => {
  const fake = fakeFetch([{ body: JSON.stringify({ choices: [{ message: { content: '   ' } }] }) }])
  const client = new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: fake.impl,
    maxRetries: 2,
  })
  const error = await failureOf(client)
  assert.equal(error.code, 'bad_response')
  assert.equal(fake.calls.length, 1, '空正文重试也不会有正文，必须只发一次')
})

test('返回体不是 JSON：报 bad_response 并带上可读片段', async () => {
  const fake = fakeFetch([{ body: '<html>gateway</html>' }])
  const client = new OpenAiCompatibleClient({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetchImpl: fake.impl })
  const error = await failureOf(client)
  assert.equal(error.code, 'bad_response')
  assert.match(error.message, /非 JSON/)
})

test('chat 协议被问到 responses 形状：提示换协议栏', async () => {
  const fake = fakeFetch([{ body: JSON.stringify({ output: [], output_text: 'hi' }) }])
  const client = new OpenAiCompatibleClient({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetchImpl: fake.impl })
  const error = await failureOf(client)
  assert.equal(error.code, 'bad_response')
  assert.match(error.message, /choices/, '必须说清缺的是 choices')
  assert.match(error.message, /responses/, '必须告诉用户去换协议')
})

test('responses 协议被问到 chat 形状：同样指向协议栏', async () => {
  const fake = fakeFetch([{ body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) }])
  const client = new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'm',
    protocol: 'responses',
    fetchImpl: fake.impl,
  })
  const error = await failureOf(client)
  assert.equal(error.code, 'bad_response')
  assert.match(error.message, /chat/, '必须提示换回 chat')
})

test('截断：chat 的 finish_reason=length 与 responses 的 incomplete 都要识别', async () => {
  const chat = fakeFetch([
    { body: JSON.stringify({ choices: [{ message: { content: '半句话' }, finish_reason: 'length' }] }) },
  ])
  const chatClient = new OpenAiCompatibleClient({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetchImpl: chat.impl })
  const first = await chatClient.complete(request)
  assert.equal(first.truncated, true)
  assert.equal(first.finishReason, 'length')

  const responses = fakeFetch([
    {
      body: JSON.stringify({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ content: [{ type: 'output_text', text: '半句' }] }],
      }),
    },
  ])
  const responsesClient = new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'm',
    protocol: 'responses',
    fetchImpl: responses.impl,
  })
  const second = await responsesClient.complete(request)
  assert.equal(second.truncated, true)
})

test('429 会重试，401 不会（重试同一个被拒绝的 Key 只会多花三次）', async () => {
  const limited = fakeFetch([
    { status: 429, body: '{"error":"rate"}' },
    { body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) },
  ])
  const limitedClient = new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: limited.impl,
    maxRetries: 2,
    retryDelayMs: 0,
  })
  const recovered = await limitedClient.complete(request)
  assert.equal(recovered.text, 'ok')
  assert.equal(recovered.attempts, 2, '第二次成功要如实记成第 2 次')

  const rejected = fakeFetch([{ status: 401, body: '{"error":"bad key"}' }])
  const rejectedClient = new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'bad',
    model: 'm',
    fetchImpl: rejected.impl,
    maxRetries: 3,
    retryDelayMs: 0,
  })
  const error = await failureOf(rejectedClient)
  assert.equal(error.code, 'unauthorized')
  assert.equal(rejected.calls.length, 1, '401 不许重试')
})

test('500 会重试到上限，然后报 unavailable 并保留状态码', async () => {
  const fake = fakeFetch([{ status: 503, body: 'upstream down' }])
  const client = new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: fake.impl,
    maxRetries: 2,
    retryDelayMs: 0,
  })
  const error = await failureOf(client)
  assert.equal(error.code, 'unavailable')
  assert.equal(error.status, 503)
  assert.equal(fake.calls.length, 3, '1 次原始 + 2 次重试')
})

test('超时：abort 归为 timeout，而不是 unknown', async () => {
  const hanging = (async (_url: string, init: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }) as unknown as typeof fetch
  const client = new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'm',
    timeoutMs: 10,
    fetchImpl: hanging,
  })
  const error = await failureOf(client)
  assert.equal(error.code, 'timeout')
})

test('用户取消：归为 cancelled，且不重试', async () => {
  const hanging = (async (_url: string, init: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }) as unknown as typeof fetch
  const controller = new AbortController()
  const client = new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: hanging,
    maxRetries: 3,
  })
  const promise = client.complete({ ...request, signal: controller.signal })
  controller.abort()
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason as LlmError,
  )
  assert.ok(error instanceof LlmError)
  assert.equal(error.code, 'cancelled')
})

test('模型拒绝回答（空 reply 但 status=ok）在解析层就被拒绝', async () => {
  const { parseDraft } = await import('../lib/generator.js')
  const parsed = parseDraft('{"status":"ok","reply":""}')
  assert.equal(parsed.draft, undefined)
  assert.match(parsed.error ?? '', /reply 为空/)
})

test('非流式的 responses 返回体：output[] 里的 output_text 片段要拼起来', async () => {
  const fake = fakeFetch([
    {
      body: JSON.stringify({
        status: 'completed',
        output: [
          { content: [{ type: 'output_text', text: '第一段' }, { type: 'output_text', text: '第二段' }] },
        ],
        usage: { input_tokens: 11, output_tokens: 7 },
      }),
    },
  ])
  const client = new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'm',
    protocol: 'responses',
    fetchImpl: fake.impl,
  })
  const response = await client.complete(request)
  assert.equal(response.text, '第一段第二段')
  assert.equal(response.inputTokens, 11)
  assert.equal(response.outputTokens, 7)
})

test('请求体按协议走不同的路径与字段名', async () => {
  const chat = fakeFetch([{ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }])
  await new OpenAiCompatibleClient({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetchImpl: chat.impl }).complete({
    system: 'sys',
    messages: [{ role: 'user', content: 'u' }],
    maxTokens: 32,
  })
  assert.match(chat.calls[0]!.url, /\/chat\/completions$/)
  const chatBody = JSON.parse(chat.calls[0]!.body) as Record<string, unknown>
  assert.equal(chatBody.max_tokens, 32)
  assert.equal(Array.isArray(chatBody.messages), true)
  assert.equal(chatBody.instructions, undefined, 'chat 协议不许混入 responses 字段')

  const responses = fakeFetch([
    { body: JSON.stringify({ status: 'completed', output_text: 'ok' }) },
  ])
  await new OpenAiCompatibleClient({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'm',
    protocol: 'responses',
    fetchImpl: responses.impl,
  }).complete({ system: 'sys', messages: [{ role: 'user', content: 'u' }], maxTokens: 32 })
  assert.match(responses.calls[0]!.url, /\/responses$/)
  const responsesBody = JSON.parse(responses.calls[0]!.body) as Record<string, unknown>
  assert.equal(responsesBody.max_output_tokens, 32)
  assert.equal(responsesBody.instructions, 'sys')
  assert.equal(responsesBody.messages, undefined, 'responses 协议不许混入 chat 字段')
})
