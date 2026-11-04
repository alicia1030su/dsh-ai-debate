/**
 * The model diagnostic must say *why*, and what to do about it (v0.2.27 §九).
 *
 * ## The failure this prevents
 *
 * A probe that reports "模型接口请求失败" is technically true and practically useless: it names
 * neither the cause nor the action, so the reader's only recourse is to guess — and the guess
 * is usually "the plugin is broken". Each failure code below leads to a *different* fix, and
 * they are not interchangeable: retrying a rejected key burns quota, and changing the key
 * when the context was too long fixes nothing.
 *
 * The probe also reports what it measured — protocol, endpoint, latency, tokens — because
 * "connected" and "connected to the endpoint you meant, speaking the protocol it supports"
 * are different statements, and only the second one helps when a generation fails later.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { testModel } from '../lib/diagnostics.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { LlmError } from '../lib/llm.js'

/** A runtime whose only interesting part is the model client. */
function runtimeWith(complete: () => Promise<unknown>): never {
  return { llm: () => ({ label: 'probe', complete }) } as never
}

function config(overrides: Record<string, unknown> = {}): never {
  return resolveConfig({ ...DEFAULT_CONFIG, llmBaseUrl: 'http://127.0.0.1:1/v1', llmModel: 'm', ...overrides }) as never
}

test('未配置时不发请求，并指名缺哪一项', async () => {
  const probe = await testModel(runtimeWith(async () => ({ text: 'OK' })), config({ llmBaseUrl: '', llmModel: '' }))
  assert.equal(probe.ok, false)
  assert.equal(probe.errorCode, 'unavailable')
  const hints = (probe.suggestions ?? []).join(' ')
  assert.match(hints, /Base URL/)
  assert.match(hints, /模型名称/)
})

test('连上时报告协议、地址、耗时与 token', async () => {
  const probe = await testModel(
    runtimeWith(async () => ({ text: 'OK', inputTokens: 12, outputTokens: 2 })),
    config(),
  )
  assert.equal(probe.ok, true)
  assert.equal(probe.protocol, 'chat/completions', '必须说明说的是哪种协议')
  assert.equal(probe.baseUrl, 'http://127.0.0.1:1/v1')
  assert.equal(probe.inputTokens, 12)
  assert.equal(probe.outputTokens, 2)
  assert.equal(typeof probe.latencyMs, 'number')
})

test('鉴权失败给的是「检查 Key」，不是「检查网络」', async () => {
  const probe = await testModel(
    runtimeWith(async () => {
      throw new LlmError('模型接口鉴权失败（401）', 'unauthorized', { status: 401 })
    }),
    config(),
  )
  assert.equal(probe.ok, false)
  assert.equal(probe.errorCode, 'unauthorized')
  assert.equal(probe.status, 401)
  assert.match((probe.suggestions ?? []).join(' '), /API Key/)
})

test('协议不兼容时指向 Base URL，而不是让用户改提示词', async () => {
  const probe = await testModel(
    runtimeWith(async () => {
      throw new LlmError('模型响应缺少 choices 字段：这个地址可能不是 chat/completions 接口', 'bad_response')
    }),
    config(),
  )
  assert.equal(probe.errorCode, 'bad_response')
  const hints = (probe.suggestions ?? []).join(' ')
  assert.match(hints, /\/v1|\/v1\/responses/, '要指出地址可能不对')
})

test('超时建议调大超时或检查可达性，并说明插件不会自动重试', async () => {
  const probe = await testModel(
    runtimeWith(async () => {
      throw new LlmError('模型接口超时', 'timeout')
    }),
    config(),
  )
  assert.equal(probe.errorCode, 'timeout')
  assert.match((probe.suggestions ?? []).join(' '), /超时|不可达/)
})

test('限流建议说明「默认不自动重试」，避免用户以为插件在偷偷重试', async () => {
  const probe = await testModel(
    runtimeWith(async () => {
      throw new LlmError('模型接口限流（429）', 'rate_limited', { status: 429 })
    }),
    config(),
  )
  assert.equal(probe.errorCode, 'rate_limited')
  assert.match((probe.suggestions ?? []).join(' '), /不自动重试/)
})

test('未知异常也有可执行建议，不把内部异常原文当成全部答案', async () => {
  const probe = await testModel(
    runtimeWith(async () => {
      throw new Error('something exploded')
    }),
    config(),
  )
  assert.equal(probe.ok, false)
  assert.equal(probe.errorCode, 'unknown')
  assert.ok((probe.suggestions ?? []).length > 0, '任何失败都要给一条可执行建议')
})
