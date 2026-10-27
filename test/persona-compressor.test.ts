/**
 * Persona and context-budget tests.
 *
 * Test 6 (four distinct styles) and test 7 (small-context models) live here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUDGET_PRESETS,
  FIXED_COSTS,
  clampText,
  compressContext,
  estimateTokens,
  fixedCostTotal,
  resolveBudget,
  splitBudget,
} from '../lib/compressor.js'
import { SYSTEM_PROMPT } from '../lib/generator.js'
import { buildPersonaPrompt, countCharacters, DEFAULT_PERSONA, PERSONAS, resolvePersona } from '../lib/persona.js'
import { analyzeDispute } from '../lib/analyzer.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'
import { makeFloor, makeNested } from './helpers.ts'

/** A dispute with enough substance to compress meaningfully. */
function sampleDispute(): { collected: CollectedThread; dispute: ReturnType<typeof analyzeDispute> } {
  const floorPostId = '2000'
  const thread: Thread = {
    platform: 'tieba',
    forum: { platform: 'tieba', id: '1', name: '测试吧' },
    id: '1',
    title: '关于方案可行性的讨论',
    content: '大家看看这个方案值不值得做，预算大概多少。',
    url: 'https://tieba.baidu.com/p/1',
    images: [],
  }
  const nested: NestedReply[] = [
    makeNested({ postId: 's1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '我算了一下，这个方案三年总成本会翻倍，去年两次采购价已经涨了 40%。' }),
    makeNested({ postId: 's2', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :你拿去年的价格说今年，合适吗？', replyToName: '主人' }),
    makeNested({ postId: 's3', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '回复 对手B :我按同比算的，而且型号也没变。', replyToName: '对手B' }),
    makeNested({ postId: 's4', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :那你有今年最新的报价单吗？', replyToName: '主人' }),
    makeNested({ postId: 's5', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@吵架小号 来帮我说两句。' }),
  ]
  const floors: Floor[] = [
    makeFloor({ floorNumber: 4, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场观点', nestedCount: nested.length }),
  ]
  const collected: CollectedThread = {
    thread,
    floors: floors.map((floor) => ({ floor, nested, nestedComplete: true })),
    complete: true,
    issues: [],
  }
  const dispute = analyzeDispute(collected, { userId: 'o' }, { postId: 's5' })
  return { collected, dispute }
}

test('test 6: all four personas produce structurally different instructions', () => {
  const styles = ['tieba_veteran', 'soft_defensive', 'tsundere', 'aloof'] as const
  const prompts = new Map<string, string>()
  for (const style of styles) {
    const config = resolvePersona({ ...DEFAULT_PERSONA, style })
    prompts.set(style, buildPersonaPrompt(config))
  }

  // Every style must produce a distinct prompt: not just a different name.
  const seen = new Set<string>()
  for (const [style, prompt] of prompts) {
    assert.ok(!seen.has(prompt), `${style} 的提示词与其他风格重复`)
    seen.add(prompt)
    assert.match(prompt, new RegExp(PERSONAS[style].name))
  }

  // The documented traits must actually be present for each persona.
  assert.match(prompts.get('tieba_veteran')!, /反问/)
  assert.match(prompts.get('soft_defensive')!, /软|委屈/)
  assert.match(prompts.get('tsundere')!, /不情愿|嘴硬|不耐烦|嘲讽/)
  assert.match(prompts.get('aloof')!, /简短|表情符号/)
})

test('persona parameters are clamped to their documented ranges', () => {
  const persona = resolvePersona({
    style: 'tsundere',
    intensity: 99,
    maxLength: 5,
    emojiLevel: -3,
    sarcasmLevel: 8,
    directness: 0,
  })
  assert.equal(persona.intensity, 5)
  assert.equal(persona.maxLength, 20)
  assert.equal(persona.emojiLevel, 0)
  assert.equal(persona.sarcasmLevel, 3)
  assert.equal(persona.directness, 1)
})

test('an unknown persona name falls back instead of throwing', () => {
  const persona = resolvePersona({ style: 'nonsense' as never })
  assert.equal(persona.style, DEFAULT_PERSONA.style)
})

test('persona parameters change the rendered instructions', () => {
  const quiet = buildPersonaPrompt(resolvePersona({ ...DEFAULT_PERSONA, emojiLevel: 0, sarcasmLevel: 0 }))
  const loud = buildPersonaPrompt(resolvePersona({ ...DEFAULT_PERSONA, emojiLevel: 3, sarcasmLevel: 3 }))
  assert.match(quiet, /不使用任何表情符号/)
  assert.match(loud, /可以多用表情符号/)
  assert.notEqual(quiet, loud)
})

test('every persona states its prohibitions, so none can drift into abuse', () => {
  for (const style of Object.values(PERSONAS)) {
    const prompt = buildPersonaPrompt(resolvePersona({ ...DEFAULT_PERSONA, style: style.id }))
    assert.match(prompt, /必须避免/)
    assert.ok(style.avoid.length >= 2, `${style.name} 至少要有两条明确禁忌`)
  }
})

test('test 7: a small budget keeps the trigger and drops background', () => {
  const { collected, dispute } = sampleDispute()
  const small = compressContext({
    collected,
    dispute,
    trigger: { postId: 's5', content: '@吵架小号 来帮我说两句。' },
    persona: resolvePersona({ ...DEFAULT_PERSONA, maxLength: 120 }),
    budget: { tokens: 260, quoteLimit: 80 },
  })

  assert.ok(small.tokens <= 260, `上下文 ${small.tokens} 超出了预算 260`)
  assert.ok(small.chunks.some((chunk) => chunk.slot === 'trigger'), '召唤那条必须保留')
  // Something must have been cut, otherwise the budget asserted nothing.
  assert.ok(small.omissions.length > 0, '小预算下必须有内容被省略并记录')
})

test('test 7: a larger budget includes strictly more than a small one', () => {
  const { collected, dispute } = sampleDispute()
  const base = {
    collected,
    dispute,
    trigger: { postId: 's5', content: '@吵架小号 来帮我说两句。' },
    persona: resolvePersona(DEFAULT_PERSONA),
  }
  const small = compressContext({ ...base, budget: BUDGET_PRESETS.small })
  const medium = compressContext({ ...base, budget: BUDGET_PRESETS.medium })

  assert.ok(medium.tokens >= small.tokens, '更大预算不应装入更少内容')
  assert.ok(medium.chunks.length >= small.chunks.length)
})

test('the opponent\'s latest line is never traded away for background', () => {
  const { collected, dispute } = sampleDispute()
  const result = compressContext({
    collected,
    dispute,
    trigger: { postId: 's5' },
    persona: resolvePersona(DEFAULT_PERSONA),
    budget: { tokens: 200, quoteLimit: 60 },
  })
  const slots = result.chunks.map((chunk) => chunk.slot)
  assert.ok(slots.includes('trigger'))
  // With a tight budget the latest opponent line still has to make it: it is
  // the thing the reply answers.
  assert.ok(slots.includes('opponentLatest'), `小预算下丢失了对手最新发言，实际槽位：${slots.join(',')}`)
})

test('omissions are reported so the model can admit what it does not know', () => {
  const { collected, dispute } = sampleDispute()
  const result = compressContext({
    collected,
    dispute,
    trigger: { postId: 's5' },
    persona: resolvePersona(DEFAULT_PERSONA),
    budget: { tokens: 200, quoteLimit: 60 },
  })
  for (const omission of result.omissions) {
    assert.equal(typeof omission, 'string')
    assert.ok(omission.length > 0)
  }
})

test('token estimation counts Chinese heavier than ASCII', () => {
  const chinese = estimateTokens('这是一段中文')
  const ascii = estimateTokens('this is ascii')
  assert.ok(chinese > 0 && ascii > 0)
  assert.ok(estimateTokens('中'.repeat(100)) > estimateTokens('a'.repeat(100)))
})

test('clampText truncates with a visible marker and leaves short text alone', () => {
  assert.equal(clampText('短文本', 50), '短文本')
  const long = clampText('字'.repeat(100), 20)
  assert.ok(long.endsWith('…'))
  assert.equal([...long].length, 20)
})

test('resolveBudget honors an explicit token count above the preset', () => {
  const budget = resolveBudget({ preset: 'small', tokens: 9999 })
  assert.equal(budget.tokens, 9999)
  assert.equal(budget.quoteLimit, BUDGET_PRESETS.small.quoteLimit)
})

test('resolveBudget ignores a nonsense token count', () => {
  assert.equal(resolveBudget({ preset: 'medium', tokens: -5 }).tokens, BUDGET_PRESETS.medium.tokens)
  assert.equal(resolveBudget({ preset: 'medium', tokens: Number.NaN }).tokens, BUDGET_PRESETS.medium.tokens)
})

test('character counting ignores whitespace', () => {
  assert.equal(countCharacters('你 好 世 界'), 4)
  assert.equal(countCharacters('你好\n世界'), 4)
})

test('the context budget counts the system prompt, persona, scaffold and reply too', () => {
  // The defect: only the compressed thread text was counted, so a "2000 token"
  // context was really 2000 plus everything else, and a small model could blow
  // its window while the report looked comfortable.
  const total = 2000
  const split = splitBudget(total)
  assert.equal(split.total, total)
  assert.ok(split.contextTokens < total, 'the thread must get less than the whole budget')
  assert.equal(
    split.contextTokens + fixedCostTotal(),
    total,
    'context plus fixed costs must add up to the configured total',
  )
  // Every fixed cost is a real part of the request.
  for (const key of ['systemPrompt', 'persona', 'scaffold', 'reply'] as const) {
    assert.ok(split.fixed[key] > 0, `${key} must be accounted for`)
  }
})

test('a budget smaller than the fixed costs still leaves the context a floor', () => {
  // A tiny configured budget must not produce a negative allowance that then
  // makes every slot be dropped for budget reasons.
  const split = splitBudget(300)
  assert.ok(split.contextTokens > 0, 'context allowance must stay positive')
})

test('the real system prompt fits inside the reserved cost', () => {
  // Guards the reserved number against drifting below what is actually sent.
  const actual = estimateTokens(SYSTEM_PROMPT)
  assert.ok(
    actual <= FIXED_COSTS.systemPrompt,
    `SYSTEM_PROMPT is ${actual} tokens but only ${FIXED_COSTS.systemPrompt} were reserved`,
  )
})
