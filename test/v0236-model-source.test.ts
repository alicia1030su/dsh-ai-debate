/**
 * v0.2.36 §3.1：模型来源的选择规则。
 *
 * 这个文件里没有网络、没有磁盘 —— 它只回答「这一次会用哪条路，为什么」。
 * 把规则钉在这里，是因为它是本版最容易悄悄伤害用户的决定：
 *
 * - 用户填了自己的接口，却被宿主抢走 → 花了他不知道的另一份额度；
 * - 用户明确选了「只用宿主」，宿主坏了却偷偷回落到自己的 key → 更糟；
 * - 两条路都没有，却报一个「模型没说话」→ 一次配置问题被记成模型问题。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { chooseModelSource } from '../lib/model-source.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { LlmError } from '../lib/llm.js'
import type { HostLlmLike } from '../lib/host-llm.js'

const host: HostLlmLike = {
  listProviders: () => ['deepseek-official'],
  listModels: async () => [{ id: 'deepseek-v4-flash' }],
  stream: async function* () {
    yield { type: 'text-delta', index: 0, text: 'x' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

function configOf(patch: Record<string, unknown>) {
  return resolveConfig({ ...DEFAULT_CONFIG, ...patch })
}

test('auto：自己配齐了就用自己那份（用户显式配置优先于推断）', () => {
  const choice = chooseModelSource(
    configOf({ llmBaseUrl: 'https://api.example.com/v1', llmModel: 'my-model', llmApiKey: 'k' }),
    { host },
  )
  assert.equal(choice.source, 'custom')
  assert.match(choice.reason, /自己配置的接口/)
})

test('auto：没配就用宿主的，并说明密钥由宿主持有', () => {
  const choice = chooseModelSource(configOf({}), { host })
  assert.equal(choice.source, 'host')
  assert.match(choice.reason, /宿主模型服务/)
  assert.match(choice.reason, /不读取/, '这句话要能被页面直接显示给用户看')
})

test('auto：只填了 Base URL、没填模型名，不算「配齐」——交给宿主', () => {
  const choice = chooseModelSource(configOf({ llmBaseUrl: 'https://api.example.com/v1' }), { host })
  assert.equal(choice.source, 'host')
})

test('auto：两条路都没有时，错误里同时给出两种做法', () => {
  assert.throws(
    () => chooseModelSource(configOf({}), {}),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'unavailable')
      assert.match(error.message, /Base URL/)
      assert.match(error.message, /宿主/)
      return true
    },
  )
})

test('host：宿主不存在时直接拒绝，不回落到自己的配置', () => {
  assert.throws(
    () =>
      chooseModelSource(
        configOf({ llmSource: 'host', llmBaseUrl: 'https://api.example.com/v1', llmModel: 'm', llmApiKey: 'k' }),
        {},
      ),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'unavailable')
      assert.match(error.message, /宿主/)
      return true
    },
    '选了「只用宿主」的用户，不该在宿主故障时被悄悄花掉另一份额度',
  )
})

test('custom：没填完就报「还没填」，而不是去用宿主', () => {
  assert.throws(
    () => chooseModelSource(configOf({ llmSource: 'custom' }), { host }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'unavailable')
      assert.match(error.message, /自己配置/)
      return true
    },
  )
})

test('custom：填齐了就返回 OpenAI 兼容客户端，标签里带模型名', () => {
  const choice = chooseModelSource(
    configOf({ llmSource: 'custom', llmBaseUrl: 'https://api.example.com/v1', llmModel: 'my-model', llmApiKey: 'k' }),
    { host },
  )
  assert.equal(choice.source, 'custom')
  assert.match(choice.client.label, /my-model/)
})

test('host：返回的客户端在真正生成时才解析模型，标签是 host:auto', () => {
  const choice = chooseModelSource(configOf({ llmSource: 'host' }), { host })
  assert.equal(choice.source, 'host')
  assert.equal(choice.client.label, 'host:auto')
})

test('出网守卫：客户端拿到的 fetch 是被包过的，且拒绝时不触底', async () => {
  const { EgressGuard, EgressLog } = await import('../lib/net-audit.js')
  const guard = new EgressGuard({ mode: 'offline', allowedHosts: [] }, new EgressLog())
  let touched = 0
  const base = (async () => {
    touched += 1
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch

  const choice = chooseModelSource(
    configOf({ llmSource: 'custom', llmBaseUrl: 'https://api.example.com/v1', llmModel: 'm', llmApiKey: 'k' }),
    { host, egress: guard, fetchImpl: base },
  )

  await assert.rejects(
    () => choice.client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    /已阻止一次出网/,
  )
  assert.equal(touched, 0, 'offline 下模型请求不能真的发出去')
})
