/**
 * v0.2.35 §2.1：连接测试必须回答两个问题，而不是一个。
 *
 * ## 为什么「能连上」不够
 *
 * 模型能回 `OK`，和模型能填这张 JSON 契约，是两件事。只测前者的结果是：设置页
 * 全绿，第一次生成失败在「模型返回了无法解析的内容」——而那句话既不说明是模型
 * 选错了，也不说明是哪一步错了。
 *
 * 这一组用两种假模型把这个区别钉死：
 * - 会回 `OK`、但只会说人话的模型 → `ok: true` 且 `contract.ok: false`；
 * - 会按契约回 JSON 的模型 → 两个都通过，并带上耗时与 token。
 *
 * 顺便断言：契约探测失败**不会**把 `ok` 改成 false。连通性成立是个事实，页面需要
 * 同时看到这两件事，而不是让一个盖住另一个。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { testModel } from '../lib/diagnostics.js'
import { ScriptedLlmClient, LlmError } from '../lib/llm.js'
import type { Runtime } from '../lib/runtime.js'

/** A runtime whose model returns the queued answers, in order. */
function runtimeWith(responses: readonly (string | Error)[]): Runtime {
  const client = new ScriptedLlmClient(
    responses.map((item) =>
      item instanceof Error ? item : { text: item, inputTokens: 12, outputTokens: 6 },
    ),
  )
  return {
    adapter: {} as Runtime['adapter'],
    store: {} as Runtime['store'],
    policy: {
      mode: 'manual',
      maxAutoPublishesPerSession: 0,
      cooldownMs: 0,
      maxPublishesPerThread: 0,
      stopOnChallenge: true,
    },
    config: () =>
      resolveConfig({
        ...DEFAULT_CONFIG,
        llmBaseUrl: 'http://127.0.0.1:9/v1',
        llmModel: 'fake-model',
        llmProtocol: 'chat',
      }),
    llm: () => client,
    log: () => undefined,
  } as unknown as Runtime
}

const CONTRACT_OK = JSON.stringify({
  status: 'ok',
  owner_position: '成本会翻倍',
  opponent_position: '翻倍是暂时的',
  main_dispute: '成本是否翻倍',
  latest_argument: '翻倍是暂时的',
  response_target_id: 'opp-post-1',
  strategy: 'direct_rebuttal',
  confidence: 0.7,
  uncertainties: [],
  reply: '翻倍是暂时的，那三年之后呢？',
})

test('只回 OK、不会输出 JSON 的模型：连通但契约不通过', async () => {
  const probe = await testModel(runtimeWith(['OK', '这个方案的成本问题挺复杂的，要看具体情况。']), {
    ...DEFAULT_CONFIG,
    llmBaseUrl: 'http://127.0.0.1:9/v1',
    llmModel: 'fake-model',
  } as never)
  assert.equal(probe.ok, true, '连通性是通的事实，不能因为契约失败就改口')
  assert.equal(probe.contract?.ok, false)
  assert.match(probe.contract?.message ?? '', /没有返回 JSON/)
  assert.equal(probe.protocol, 'chat/completions', '必须报告实际使用的协议')
  assert.equal(typeof probe.latencyMs, 'number')
  assert.equal(typeof probe.totalMs, 'number')
})

test('能按契约输出的模型：两段都通过，并带上耗时与 token', async () => {
  const probe = await testModel(runtimeWith(['OK', CONTRACT_OK]), {
    ...DEFAULT_CONFIG,
    llmBaseUrl: 'http://127.0.0.1:9/v1',
    llmModel: 'fake-model',
  } as never)
  assert.equal(probe.ok, true)
  assert.equal(probe.contract?.ok, true)
  assert.match(probe.contract?.message ?? '', /能按契约/)
  assert.equal(probe.contract?.latencyMs !== undefined, true)
  assert.equal(probe.contract?.inputTokens, 12)
  assert.equal(probe.contract?.outputTokens, 6)
  assert.match(probe.contract?.sample ?? '', /owner_position|成本会翻倍/)
})

test('契约字段缺失时，指出缺了哪几个', async () => {
  const partial = JSON.stringify({ status: 'ok', reply: '一句话' })
  const probe = await testModel(runtimeWith(['OK', partial]), {
    ...DEFAULT_CONFIG,
    llmBaseUrl: 'http://127.0.0.1:9/v1',
    llmModel: 'fake-model',
  } as never)
  assert.equal(probe.contract?.ok, false)
  const missing = probe.contract?.missingFields ?? []
  assert.ok(missing.includes('owner_position'), `应指出缺 owner_position，实际 ${missing.join(',')}`)
  assert.ok(missing.length >= 6, `应列出所有缺失字段，实际 ${missing.join(',')}`)
})

test('responses 协议：协议栏报告的是 responses，不是 chat', async () => {
  const probe = await testModel(runtimeWith(['OK', CONTRACT_OK]), {
    ...DEFAULT_CONFIG,
    llmBaseUrl: 'http://127.0.0.1:9/v1',
    llmModel: 'fake-model',
    llmProtocol: 'responses',
  } as never)
  assert.equal(probe.protocol, 'responses')
})

test('契约探测失败（例如 429）不会把连通性结论吞掉', async () => {
  const probe = await testModel(
    runtimeWith(['OK', new LlmError('模型接口限流（429）：slow down', 'rate_limited', { status: 429 })]),
    {
      ...DEFAULT_CONFIG,
      llmBaseUrl: 'http://127.0.0.1:9/v1',
      llmModel: 'fake-model',
    } as never,
  )
  assert.equal(probe.ok, true)
  assert.equal(probe.contract?.ok, false)
  assert.match(probe.contract?.message ?? '', /rate_limited|限流/)
})

test('未配置时不给建议之外的任何结论', async () => {
  const probe = await testModel(runtimeWith([]), {
    ...DEFAULT_CONFIG,
    llmBaseUrl: '',
    llmModel: '',
  } as never)
  assert.equal(probe.ok, false)
  assert.equal(probe.contract, undefined, '连地址都没有时不该假装做过契约探测')
  assert.ok((probe.suggestions ?? []).length >= 1)
})
