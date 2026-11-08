/**
 * v0.2.36 §3.1：复用宿主模型服务。
 *
 * ## 这一组测试守的是什么
 *
 * 宿主 `ctx.get('llm')` 是一个**结构化**契约，不是一个 import 来的类型。它可能
 * 缺方法、`listModels` 抛错、`stream` 吐出认不出的分片。这类失败最糟的形态不是
 * 抛错，而是**静默返回空字符串** —— 那会被解析层记成「模型说了空话」，把一个
 * 基础设施问题变成一次模型违纪。
 *
 * 所以这里逐个钉住：形状不对要报得出来、分片要按 `text-delta` 拼、`finish` 的
 * 错误要分类、`max-tokens` 要标截断、请求里不许带任何密钥。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HostLlmClient,
  LazyHostLlmClient,
  hostLlmOf,
  pickHostModel,
  probeHostLlm,
  type HostLlmLike,
} from '../lib/host-llm.js'
import { LlmError } from '../lib/llm.js'

/** 一个按脚本吐分片的假宿主。 */
function fakeHost(script: readonly unknown[], options: { readonly onRequest?: (req: unknown) => void } = {}): HostLlmLike {
  return {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async (provider: string) => [{ id: 'deepseek-v4-flash', name: 'V4 Flash', provider }],
    stream: (request: unknown) => {
      options.onRequest?.(request)
      return (async function* () {
        for (const chunk of script) {
          await Promise.resolve()
          yield chunk
        }
      })()
    },
  }
}

test('宿主模型：分片按 text-delta 拼接，usage 与 finish 都读进来', async () => {
  const seen: unknown[] = []
  const host = fakeHost(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '{"status":' },
      { type: 'text-delta', index: 0, text: '"ok"}' },
      { type: 'usage', usage: { inputTokens: 120, outputTokens: 8 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    { onRequest: (req) => seen.push(req) },
  )

  const client = new HostLlmClient(host, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const reply = await client.complete({
    system: '只输出 JSON',
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 64,
    temperature: 0,
  })

  assert.equal(reply.text, '{"status":"ok"}')
  assert.equal(reply.inputTokens, 120)
  assert.equal(reply.outputTokens, 8)
  assert.equal(reply.truncated, undefined, '正常结束不该被标成截断')
  assert.equal(reply.finishReason, 'stop')
  assert.equal(client.label, 'host:deepseek-official/deepseek-v4-flash')

  // 请求形状：system 与 messages 分开，且不含任何密钥字段。
  const request = seen[0] as Record<string, unknown>
  assert.equal(request.provider, 'deepseek-official')
  assert.equal(request.model, 'deepseek-v4-flash')
  assert.equal(request.system, '只输出 JSON')
  assert.equal(request.maxTokens, 64)
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }])
  const serialized = JSON.stringify(request)
  for (const needle of ['apiKey', 'api_key', 'authorization', 'Bearer', 'sk-']) {
    assert.equal(serialized.includes(needle), false, `请求里不该出现 ${needle}`)
  }
})

test('宿主模型：max-tokens 结束要标成截断，而不是「短回答」', async () => {
  const host = fakeHost([
    { type: 'text-delta', index: 0, text: '{"status":"o' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  const reply = await new HostLlmClient(host, { provider: 'p', model: 'm' }).complete({
    messages: [{ role: 'user', content: 'x' }],
  })
  assert.equal(reply.truncated, true)
  assert.equal(reply.finishReason, 'length', '对外仍用 OpenAI 那边同一个词')
})

test('宿主模型：finish 为 error 时按状态码分类，而不是当成空回复', async () => {
  const host = fakeHost([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', status: 401, message: 'bad key' } } },
  ])
  await assert.rejects(
    () => new HostLlmClient(host, { provider: 'p', model: 'm' }).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'unauthorized')
      assert.match(error.message, /bad key/)
      return true
    },
  )
})

test('宿主模型：一个分片都没有时报「形状不对」，不返回空字符串', async () => {
  const host = fakeHost([])
  await assert.rejects(
    () => new HostLlmClient(host, { provider: 'p', model: 'm' }).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'bad_response')
      return true
    },
  )
})

test('宿主模型：aborted 结束抛 cancelled，让上层停止而不是重试', async () => {
  const host = fakeHost([
    { type: 'text-delta', index: 0, text: '半' },
    { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } },
  ])
  await assert.rejects(
    () => new HostLlmClient(host, { provider: 'p', model: 'm' }).complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'cancelled')
      return true
    },
  )
})

test('探测：宿主没服务、形状不对、列不出模型，三种情况都要给出原因', async () => {
  const missing = await probeHostLlm(undefined)
  assert.equal(missing.available, false)
  assert.equal(missing.servicePresent, false)
  assert.match(missing.reason ?? '', /llm/)

  const wrongShape = await probeHostLlm({ listProviders: () => ['x'] } as unknown as HostLlmLike)
  assert.equal(wrongShape.available, false)
  assert.equal(wrongShape.servicePresent, true)
  assert.match(wrongShape.reason ?? '', /stream/)

  const noModels = await probeHostLlm({
    listProviders: () => ['p'],
    listModels: () => [],
    stream: async function* () {},
  })
  assert.equal(noModels.available, false)
  assert.deepEqual(noModels.providers, ['p'])
  assert.match(noModels.reason ?? '', /没有可用模型/)
})

test('探测：列模型抛错时把错误带出来，而不是报「没有模型」', async () => {
  const probe = await probeHostLlm({
    listProviders: () => ['p'],
    listModels: () => {
      throw new Error('not logged in')
    },
    stream: async function* () {},
  })
  assert.equal(probe.available, false)
  assert.match(probe.reason ?? '', /not logged in/)
})

test('默认模型：优先 deepseek-official，其次 flash，最后第一个', () => {
  assert.equal(
    pickHostModel([
      { provider: 'other', model: 'x' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    ])?.provider,
    'deepseek-official',
  )
  assert.equal(
    pickHostModel([
      { provider: 'a', model: 'big-model' },
      { provider: 'b', model: 'small-flash' },
    ])?.model,
    'small-flash',
  )
  assert.equal(pickHostModel([{ provider: 'a', model: 'only' }])?.model, 'only')
  assert.equal(pickHostModel([]), undefined)
})

test('延迟客户端：第一次才解析，失败时说清「宿主不可用」而不是空回复', async () => {
  const lazy = new LazyHostLlmClient({
    listProviders: () => [],
    listModels: () => [],
    stream: async function* () {},
  })
  await assert.rejects(
    () => lazy.complete({ messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'unavailable')
      assert.match(error.message, /宿主模型服务不可用/)
      return true
    },
  )
})

test('从 ctx 取服务：get("llm") 与 ctx.llm 两种形状都认，取不到返回 undefined', () => {
  const service = fakeHost([{ type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(hostLlmOf({ get: (name: string) => (name === 'llm' ? service : undefined) }), service)
  assert.equal(hostLlmOf({ llm: service }), service)
  assert.equal(hostLlmOf({}), undefined)
  assert.equal(hostLlmOf({ get: () => ({}) }), undefined, '形状不对不算有服务')
  assert.equal(hostLlmOf(null), undefined)
})
