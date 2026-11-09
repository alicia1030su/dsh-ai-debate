/**
 * 生成结果五态分类的回归测试（v0.2.39 §3.1）。
 *
 * ## 这些测试要钉住的是「什么不算失败」
 *
 * 五态里最容易写错的是 `needs_more_context`：它和 `technical_failure` 一样不产出正文，
 * 和 `invalid_draft` 一样让 `ok` 为假。如果分类器只看「有没有正文」，这三件事就又会混回
 * 一个桶里 —— 而那正是这一版要拆开的东西。
 *
 * 所以每一条断言都写成「给定这些事实，结果必须是 X，且**不能**是 Y」。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyOutcome,
  evidenceIsSufficient,
  outcomeNeedsAction,
  reasonNamesGap,
  OUTCOME_LABELS,
  type OutcomeInput,
} from '../lib/outcome.js'

/** 一份「材料够」的默认事实。测试按需覆盖。 */
const SUFFICIENT = {
  opponentArgumentCount: 1,
  unansweredByOpponent: 0,
  targetConfirmed: true,
} as const

function classify(overrides: Partial<OutcomeInput>): string {
  return classifyOutcome({
    needsInput: false,
    reply: '这条回复有具体内容。',
    violations: [],
    evidence: SUFFICIENT,
    ...overrides,
  })
}

test('正常产出：有正文、无违规 → valid_draft', () => {
  assert.equal(classify({}), 'valid_draft')
})

test('模型拒绝且材料确实不够 → needs_more_context（不是失败）', () => {
  assert.equal(
    classify({
      needsInput: true,
      reply: '',
      needsInputReason: '对方那条被删的评论原文没有读全',
      evidence: { opponentArgumentCount: 0, unansweredByOpponent: 0, targetConfirmed: true },
    }),
    'needs_more_context',
  )
})

test('用户明确要求「先写一条」时，拒绝不算缺陷', () => {
  // 「材料够不够」是语义问题：简报里有一条论据，不等于那条论据能支撑具体主张。
  // 计数规则看不出区别，所以在用户已经表态要试时让位给模型。
  assert.equal(
    classify({ needsInput: true, reply: '', forceAttempt: true }),
    'needs_more_context',
  )
  // 用户没表态时仍然保守判缺陷 —— 宁可漏判，不可错判。
  assert.equal(classify({ needsInput: true, reply: '' }), 'unjustified_refusal')
})

test('模型拒绝但材料够 → unjustified_refusal（这是缺陷）', () => {
  assert.equal(
    classify({
      needsInput: true,
      reply: '',
      needsInputReason: '信息不足，无法回应',
    }),
    'unjustified_refusal',
  )
})

test('目标未确认时拒绝 → 仍算 needs_more_context，不算缺陷', () => {
  // 不知道在跟谁说话时要求确认，是正确行为。判成缺陷会让这个指标失去意义。
  assert.equal(
    classify({
      needsInput: true,
      reply: '',
      evidence: { opponentArgumentCount: 3, unansweredByOpponent: 0, targetConfirmed: false },
    }),
    'needs_more_context',
  )
})

test('有正文但违规 → invalid_draft（不是故障）', () => {
  assert.equal(
    classify({ violations: [{ code: 'fabricated_number' }] }),
    'invalid_draft',
  )
})

test('输出被截断 → technical_failure（不是草稿不合格）', () => {
  assert.equal(
    classify({ reply: '', violations: [{ code: 'truncated' }] }),
    'technical_failure',
  )
  assert.equal(
    classify({ reply: '', violations: [{ code: 'unparseable' }] }),
    'technical_failure',
  )
})

test('技术故障优先于拒绝：截断时模型也说了 needs_more_context，仍算故障', () => {
  // 被截断的输出里可能出现任何字段。把半句话当成「模型的判断」是错的。
  assert.equal(
    classify({ needsInput: true, reply: '', violations: [{ code: 'truncated' }] }),
    'technical_failure',
  )
})

test('既没有正文也没有违规 → technical_failure（空结果不是候选）', () => {
  assert.equal(classify({ reply: '   \n  ' }), 'technical_failure')
})

test('材料是否足够的判据：论据、未答问题、目标确认', () => {
  assert.equal(evidenceIsSufficient(SUFFICIENT), true)
  assert.equal(
    evidenceIsSufficient({ opponentArgumentCount: 0, unansweredByOpponent: 2, targetConfirmed: true }),
    true,
    '有未答问题也算有材料',
  )
  assert.equal(
    evidenceIsSufficient({ opponentArgumentCount: 0, unansweredByOpponent: 0, targetConfirmed: true }),
    false,
  )
  assert.equal(
    evidenceIsSufficient({ opponentArgumentCount: 5, unansweredByOpponent: 0, targetConfirmed: false }),
    false,
    '目标不明时，再多论据也不算够',
  )
})

test('拒绝理由是否点到了具体缺口', () => {
  assert.equal(reasonNamesGap('对方引用的那份报价单原文没有提供'), true)
  assert.equal(reasonNamesGap('信息不足'), false, '空话不算点名')
  assert.equal(reasonNamesGap(''), false)
  assert.equal(reasonNamesGap(undefined), false)
})

test('五态各有自己的界面文案，且互不相同', () => {
  const labels = Object.values(OUTCOME_LABELS)
  assert.equal(labels.length, 5)
  assert.equal(new Set(labels).size, 5, '两种结果不能共用一句文案')
  for (const label of labels) assert.ok(label.length > 0)
})

test('只有 valid_draft 不需要用户额外动作', () => {
  assert.equal(outcomeNeedsAction('valid_draft'), false)
  assert.equal(outcomeNeedsAction('needs_more_context'), true)
  assert.equal(outcomeNeedsAction('unjustified_refusal'), true)
  assert.equal(outcomeNeedsAction('invalid_draft'), true)
  assert.equal(outcomeNeedsAction('technical_failure'), true)
})
