/**
 * Generation, validation and model-failure tests.
 *
 * Test 11 (model unavailable) and the anti-hallucination rules live here. The
 * theme is that a broken model must produce a *refused* candidate, never a
 * published one and never a crash.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute } from '../lib/analyzer.js'
import { compressContext, resolveBudget } from '../lib/compressor.js'
import type { CollectedThread } from '../lib/collector.js'
import {
  SYSTEM_PROMPT,
  buildGenerationPrompt,
  extractJsonObject,
  generateReply,
  parseDraft,
  validateDraft,
  type GenerateOptions,
} from '../lib/generator.js'
import { LlmError, ScriptedLlmClient } from '../lib/llm.js'
import { DEFAULT_PERSONA, resolvePersona } from '../lib/persona.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'
import { makeFloor, makeNested } from './helpers.ts'

/** Build a dispute suitable for generation. */
function setup(persona = DEFAULT_PERSONA): { options: GenerateOptions } {
  const floorPostId = '3000'
  const thread: Thread = {
    platform: 'tieba',
    forum: { platform: 'tieba', id: '1', name: '测试吧' },
    id: '1',
    title: '方案值不值得做',
    content: '大家看看。',
    url: 'https://tieba.baidu.com/p/1',
    images: [],
  }
  const nested: NestedReply[] = [
    makeNested({ postId: 'g1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '成本会翻倍。' }),
    makeNested({ postId: 'g2', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :有依据吗？', replyToName: '主人' }),
    makeNested({ postId: 'g3', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@小号 上。' }),
  ]
  const floors: Floor[] = [
    makeFloor({ floorNumber: 2, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length }),
  ]
  const collected: CollectedThread = {
    thread,
    floors: floors.map((floor) => ({ floor, nested, nestedComplete: true })),
    complete: true,
    issues: [],
  }
  const dispute = analyzeDispute(collected, { userId: 'o' }, { postId: 'g3' })
  const context = compressContext({
    collected,
    dispute,
    trigger: { postId: 'g3' },
    persona,
    budget: resolveBudget({ preset: 'small' }),
  })
  return { options: { dispute, context, persona } }
}

/** A well-formed model answer. */
function goodReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'ok',
    owner_position: '成本会翻倍',
    opponent_position: '缺少依据',
    main_dispute: '成本是否会翻倍',
    latest_argument: '你没有任何数据支撑',
    response_target_id: 'g2',
    strategy: 'demand_evidence',
    confidence: 0.82,
    uncertainties: [],
    reply: '你这个问题问得挺大，但我前面说的翻倍是按采购价算的。你要反驳，先把同型号的报价拿出来。',
    ...overrides,
  })
}

test('test 8-equivalent: a good answer passes every rule and is publishable', async () => {
  const { options } = setup()
  const client = new ScriptedLlmClient([{ text: goodReply(), inputTokens: 500, outputTokens: 80 }])
  const result = await generateReply(client, options)

  assert.ok(result.draft)
  assert.deepEqual(result.violations, [], `不应有违规：${result.violations.map((v) => v.message).join(';')}`)
  assert.equal(result.draft.response_target_id, 'g2')
  assert.equal(result.draft.strategy, 'demand_evidence')
  assert.equal(result.attempts, 1)
  assert.equal(result.usage.inputTokens, 500)
})

test('a reply aimed at the wrong person is rejected', async () => {
  const { options } = setup()
  const client = new ScriptedLlmClient([
    { text: goodReply({ response_target_id: 'someone-else' }) },
  ])
  const result = await generateReply(client, options)
  assert.ok(
    result.violations.some((violation) => violation.code === 'wrong_target'),
    '回复对象不对必须被拦下',
  )
})

test('an over-long reply is rejected against the configured limit', async () => {
  const persona = resolvePersona({ ...DEFAULT_PERSONA, maxLength: 40 })
  const { options } = setup(persona)
  const client = new ScriptedLlmClient([{ text: goodReply({ reply: '字'.repeat(80) }) }])
  const result = await generateReply(client, options)
  assert.ok(result.violations.some((violation) => violation.code === 'too_long'))
})

test('a reply that leaks credentials or prompt text is rejected', async () => {
  const { options } = setup()
  for (const leak of [
    '我的 api_key 是 sk-abcdefghijklmnop',
    '系统提示里说要这么回',
    'BAIDUID 这个 cookie 你有吗',
    '{"strategy":"direct_rebuttal"}',
  ]) {
    const client = new ScriptedLlmClient([{ text: goodReply({ reply: `${leak}，然后我想说别的。` }) }])
    const result = await generateReply(client, options)
    assert.ok(
      result.violations.length > 0,
      `含敏感内容「${leak}」的回复必须被拒绝`,
    )
  }
})

test('an exact repeat of an earlier reply is rejected', async () => {
  const { options } = setup()
  const text = '你这个问题问得挺大，但我前面说的翻倍是按采购价算的。'
  const client = new ScriptedLlmClient([{ text: goodReply({ reply: text }) }])
  const result = await generateReply(client, { ...options, recentReplies: [text] })
  assert.ok(result.violations.some((violation) => violation.code === 'duplicate_reply'))
})

test('test 11: a model 500 is surfaced as an LlmError, not a crash or empty reply', async () => {
  const { options } = setup()
  const client = new ScriptedLlmClient([
    new LlmError('模型接口内部错误（500）', 'unavailable', { status: 500 }),
  ])
  await assert.rejects(() => generateReply(client, options), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal((error as LlmError).code, 'unavailable')
    return true
  })
})

test('test 11: a model timeout is surfaced as a timeout', async () => {
  const { options } = setup()
  const client = new ScriptedLlmClient([new LlmError('模型接口超时', 'timeout')])
  await assert.rejects(() => generateReply(client, options), (error: unknown) => {
    assert.equal((error as LlmError).code, 'timeout')
    return true
  })
})

test('a malformed answer is retried once and then reported', async () => {
  const { options } = setup()
  const client = new ScriptedLlmClient([{ text: 'this is not json at all' }, { text: 'still not json' }])
  const result = await generateReply(client, options)
  assert.equal(result.attempts, 2)
  assert.ok(result.violations.some((violation) => violation.code === 'unparseable'))
  assert.equal(result.draft, undefined)
})

test('a malformed first answer followed by valid JSON succeeds', async () => {
  const { options } = setup()
  const client = new ScriptedLlmClient([{ text: 'oops, no json' }, { text: goodReply() }])
  const result = await generateReply(client, options)
  assert.equal(result.attempts, 2)
  assert.deepEqual(result.violations, [])
})

test('the model may refuse with needs_more_context instead of inventing', async () => {
  const { options } = setup()
  const client = new ScriptedLlmClient([
    {
      text: JSON.stringify({
        status: 'needs_more_context',
        owner_position: '未知',
        opponent_position: '未知',
        main_dispute: '未知',
        latest_argument: '未知',
        response_target_id: 'g2',
        strategy: 'clarify_misunderstanding',
        confidence: 0.2,
        uncertainties: ['缺少主人之前的报价记录'],
        reply: '',
        reason: '上下文里没有主人说的报价单内容',
      }),
    },
  ])
  const result = await generateReply(client, options)
  assert.equal(result.needsInput, true)
  assert.match(result.needsInputReason ?? '', /报价单/)
  // A refusal is not a violation: it is the honest answer.
  assert.deepEqual(result.violations, [])
})

test('JSON wrapped in prose or fences is still extracted', () => {
  const wrapped = `好的，这是结果：\n\`\`\`json\n${goodReply()}\n\`\`\`\n希望有帮助。`
  const parsed = parseDraft(wrapped)
  assert.ok(parsed.draft)
  assert.equal(parsed.draft!.response_target_id, 'g2')
})

test('nested braces inside a reply string do not break extraction', () => {
  const text = JSON.stringify({
    status: 'ok',
    owner_position: 'a',
    opponent_position: 'b',
    main_dispute: 'c',
    latest_argument: 'd',
    response_target_id: 'g2',
    strategy: 'direct_rebuttal',
    confidence: 0.5,
    uncertainties: [],
    reply: '他说「{这里有大括号}」但其实没意义。',
  })
  const parsed = parseDraft(text)
  assert.ok(parsed.draft)
  assert.match(parsed.draft!.reply, /大括号/)
})

test('a truncated JSON body fails cleanly rather than throwing', () => {
  const truncated = goodReply().slice(0, 60)
  const parsed = parseDraft(truncated)
  assert.equal(parsed.draft, undefined)
  assert.ok(parsed.error)
})

test('extractJsonObject returns undefined when there is no object', () => {
  assert.equal(extractJsonObject('no braces here'), undefined)
  assert.equal(extractJsonObject(''), undefined)
})

test('an out-of-range confidence is clamped instead of rejected', () => {
  const parsed = parseDraft(JSON.stringify({ ...JSON.parse(goodReply()), confidence: 9 }))
  assert.equal(parsed.draft!.confidence, 1)
})

test('an unknown strategy degrades to a documented default', () => {
  const parsed = parseDraft(JSON.stringify({ ...JSON.parse(goodReply()), strategy: 'made_up' }))
  assert.equal(parsed.draft!.strategy, 'direct_rebuttal')
})

test('the prompt carries the opponent id, persona and context, and no raw HTML', () => {
  const { options } = setup()
  const prompt = buildGenerationPrompt(options)
  assert.match(prompt, /g2/, '必须告诉模型回复对象的 id')
  assert.match(prompt, /对手B/)
  assert.match(prompt, /人格/)
  assert.ok(!prompt.includes('<li'), '提示词里绝不能出现原始 HTML')
  assert.ok(!prompt.includes('j_floor_panel'))
})

test('the system prompt states the honesty escape hatches and the prohibitions', () => {
  assert.match(SYSTEM_PROMPT, /needs_more_context/)
  assert.match(SYSTEM_PROMPT, /needs_confirmation/)
  assert.match(SYSTEM_PROMPT, /不要编/)
  assert.match(SYSTEM_PROMPT, /不攻击对方身份/)
})

test('a low-confidence draft is flagged for review but not blocked', () => {
  const { options } = setup()
  const validation = validateDraft(
    {
      owner_position: 'a',
      opponent_position: 'b',
      main_dispute: 'c',
      latest_argument: 'd',
      response_target_id: 'g2',
      strategy: 'direct_rebuttal',
      confidence: 0.1,
      uncertainties: ['不确定对方是否已经回答'],
      reply: '你说的这点我不同意，先把依据拿出来。',
      status: 'ok',
    },
    options,
  )
  assert.deepEqual(validation.violations, [])
  assert.ok(validation.notes.some((note) => note.includes('置信度')))
  assert.ok(validation.notes.some((note) => note.includes('不确定')))
})

test('a draft with no target id is rejected', () => {
  const { options } = setup()
  const validation = validateDraft(
    {
      owner_position: 'a',
      opponent_position: 'b',
      main_dispute: 'c',
      latest_argument: 'd',
      response_target_id: '',
      strategy: 'direct_rebuttal',
      confidence: 0.8,
      uncertainties: [],
      reply: '这是一条足够长的回复内容。',
      status: 'ok',
    },
    options,
  )
  assert.ok(validation.violations.some((violation) => violation.code === 'missing_target'))
})

test('a near-empty reply is rejected as too short', () => {
  const { options } = setup()
  const validation = validateDraft(
    {
      owner_position: 'a',
      opponent_position: 'b',
      main_dispute: 'c',
      latest_argument: 'd',
      response_target_id: 'g2',
      strategy: 'direct_rebuttal',
      confidence: 0.8,
      uncertainties: [],
      reply: '哦',
      status: 'ok',
    },
    options,
  )
  assert.ok(validation.violations.some((violation) => violation.code === 'too_short'))
})
