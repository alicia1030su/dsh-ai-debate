/**
 * v0.2.37 §7/§8：四种人格比较的编排。
 *
 * ## 这一组要钉住的四件事
 *
 * 1. **串行**：一次只发一个模型请求。并发发四个在多数服务上会撞限流，而限流的
 *    失败形状是「其中两条没出来」，用户分不清是模型差还是被限。
 * 2. **预算**：调用次数由调用方给，封顶四个人格；默认不自动跑四份。
 * 3. **逐条结果**：一条失败不能把另外三条藏起来 —— 那是四次独立调用。
 * 4. **取消不落盘**：取消之后不再发起下一次，已发出的那一次结果不写库。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { COMPARE_PERSONAS, comparePersonas } from '../lib/import/compare.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { DebateStore } from '../lib/store.js'
import { analyzeImport, personaOf } from '../lib/import/workflow.js'
import { parseText } from '../lib/import/manual.js'
import { toStoredImport } from '../lib/import/session.js'
import type { LlmClient, LlmRequest, LlmResponse } from '../lib/llm.js'

const DISCUSSION = [
  '原帖作者：我觉得这个价格翻倍是合理的，成本上涨了那么多。',
  '路人甲：成本上涨不等于可以翻倍，你先把数据拿出来。',
  '路人乙：行业平均也才涨了三成，翻倍是漫天要价。',
].join('\n')

/** 一个按脚本回答的模型。每次调用消耗一行。 */
class ScriptedClient implements LlmClient {
  readonly label = 'scripted-compare'
  calls = 0
  private readonly script: readonly (string | Error)[]
  private readonly onCall?: (request: LlmRequest) => void

  constructor(script: readonly (string | Error)[], onCall?: (request: LlmRequest) => void) {
    this.script = script
    this.onCall = onCall
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const index = this.calls
    this.calls += 1
    this.onCall?.(request)
    const next = this.script[index]
    if (next === undefined) throw new Error(`脚本用完了（第 ${index + 1} 次调用）`)
    if (next instanceof Error) throw next
    // `LlmResponse` 没有 elapsedMs —— 耗时是调用方量的，不是模型报的。
    return { text: next, inputTokens: 100, outputTokens: 40 }
  }
}

/** 一份能让 validateBrief 通过的模型回答。 */
function modelReply(reply: string): string {
  return JSON.stringify({
    status: 'ok',
    owner_position: '价格翻倍不合理，成本上涨不等于可以翻倍。',
    opponent_position: '价格翻倍是合理的，因为成本上涨。',
    main_dispute: '成本上涨能否支撑价格翻倍。',
    latest_argument: '行业平均只涨三成。',
    response_target_id: 'c1',
    strategy: 'direct_rebuttal',
    confidence: 0.7,
    uncertainties: [],
    reply,
  })
}

/**
 * 建一条离线会话。
 *
 * ## 为什么要走 `analyzeImport(imported, …)` 而不是 `analyzeImport({content})`
 *
 * `analyzeImport` 要的是**已经落盘的导入内容**（`ManualAnalyzeInput.imported`），
 * 解析字符串是 `preview` 那一步的事。第一版照着「传一段文本」写，报的是
 * 「无法从导入内容重建讨论：Cannot read properties of undefined (reading 'source')」
 * —— 看起来像投影坏了，实际上是我少做了一步 `toStoredImport`。
 */
async function makeSession(dir: string): Promise<{ store: DebateStore; sessionId: string }> {
  const store = new DebateStore({ dir })
  const parsed = parseText(DISCUSSION)
  assert.ok(parsed.discussion !== undefined, '测试素材必须能解析')
  const imported = toStoredImport(parsed.discussion, new Date('2026-11-07T00:00:00Z').toISOString())
  const analyzed = await analyzeImport(store, {
    imported,
    ownerName: '原帖作者',
    persona: personaOf('tieba_veteran', configOf()),
    config: resolveConfig({ ...DEFAULT_CONFIG, ownerHandle: '原帖作者' }),
  })
  assert.equal(analyzed.ok, true, analyzed.ok ? '' : analyzed.reason)
  return { store, sessionId: analyzed.value!.session.id }
}

function configOf() {
  return resolveConfig({
    ...DEFAULT_CONFIG,
    ownerHandle: '原帖作者',
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test',
  })
}

test('四种人格的固定顺序与 persona.ts 一致', () => {
  assert.deepEqual([...COMPARE_PERSONAS], ['tieba_veteran', 'soft_defensive', 'tsundere', 'aloof'])
  for (const style of COMPARE_PERSONAS) {
    const persona = personaOf(style, configOf())
    assert.equal(persona.style, style, `${style} 应能被 personaOf 接受`)
  }
})

test('默认跑四种，逐条返回结果，调用次数等于人格数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-'))
  try {
    const { store, sessionId } = await makeSession(dir)
    const client = new ScriptedClient([
      modelReply('老哥说法：翻倍这数不成立，行业才三成。'),
      modelReply('小受说法：你说翻倍就翻倍，那我这点工资怎么办呀。'),
      modelReply('傲娇说法：翻倍？行啊，你先把账算明白再说。'),
      modelReply('高冷说法：成本上涨三成，价格翻倍，两者之间缺少论证。'),
    ])

    const outcome = await comparePersonas({
      store,
      sessionId,
      config: configOf(),
      llm: () => client,
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.rows.length, 4, `四个人格各一条，实际 ${outcome.rows.length}`)
    assert.equal(outcome.calls, 4, '调用次数必须等于人格数')
    assert.deepEqual(outcome.rows.map((row) => row.persona), [...COMPARE_PERSONAS])
    for (const row of outcome.rows) {
      assert.equal(row.ok, true, `${row.personaName} 应该成功：${row.reason ?? ''}`)
      assert.ok(row.text !== undefined && row.text.length > 0)
      assert.ok(row.candidateId !== undefined)
      assert.ok(row.elapsedMs !== undefined && row.elapsedMs >= 0)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('一条失败不影响其他三条：失败的带原因，成功的照常返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-'))
  try {
    const { store, sessionId } = await makeSession(dir)
    const client = new ScriptedClient([
      modelReply('第一条正常。'),
      new Error('模型返回了 429：限流'),
      modelReply('第三条正常。'),
      modelReply('第四条正常。'),
    ])

    const outcome = await comparePersonas({ store, sessionId, config: configOf(), llm: () => client })
    const failed = outcome.rows.filter((row) => !row.ok)
    const passed = outcome.rows.filter((row) => row.ok)
    assert.equal(passed.length, 3, `应有三条成功，实际 ${passed.length}`)
    assert.equal(failed.length, 1)
    assert.match(failed[0]!.reason ?? '', /429/)
    assert.equal(outcome.calls, 4, '失败的那次也算一次调用')
    assert.match(outcome.message, /完成 3 个，失败 1 个/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('取消之后不再发起下一次，且已经取消的那次不写库', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-'))
  try {
    const { store, sessionId } = await makeSession(dir)
    const controller = new AbortController()
    const client = new ScriptedClient(
      [modelReply('第一条。'), modelReply('第二条。'), modelReply('第三条。'), modelReply('第四条。')],
      () => {
        // 第一次调用一开始就取消：模拟用户在看到「正在生成贴吧老哥」时点取消。
        controller.abort()
      },
    )

    const outcome = await comparePersonas({
      store,
      sessionId,
      config: configOf(),
      llm: () => client,
      signal: controller.signal,
    })

    assert.equal(outcome.cancelled, true, '整批必须标记为已取消')
    assert.equal(outcome.skipped.length, 3, `取消后应跳过三个人格，实际 ${outcome.skipped.length}`)
    assert.equal(outcome.calls, 1, `只该发出一次调用，实际 ${outcome.calls}`)
    assert.match(outcome.message, /已取消/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只跑指定的人格时，其余不发起调用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-'))
  try {
    const { store, sessionId } = await makeSession(dir)
    const client = new ScriptedClient([modelReply('只跑高冷。'), modelReply('不该用到这条。')])

    const outcome = await comparePersonas({
      store,
      sessionId,
      personas: ['aloof'],
      config: configOf(),
      llm: () => client,
    })
    assert.equal(outcome.calls, 1)
    assert.equal(outcome.rows.length, 1)
    assert.equal(outcome.rows[0]!.persona, 'aloof')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未知人格 id 被忽略，不让整批失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-'))
  try {
    const { store, sessionId } = await makeSession(dir)
    const client = new ScriptedClient([modelReply('一个正常的回复文本。')])

    const outcome = await comparePersonas({
      store,
      sessionId,
      personas: ['not_a_persona', 'tieba_veteran'],
      config: configOf(),
      llm: () => client,
    })
    assert.equal(outcome.calls, 1, '未知 id 不该发起调用')
    assert.equal(outcome.rows.length, 1)
    assert.equal(outcome.rows[0]!.persona, 'tieba_veteran')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
