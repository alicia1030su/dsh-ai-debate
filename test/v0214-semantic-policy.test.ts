/**
 * v0.2.14 §6.4 → v0.2.21 §二：语义风险与人工批准的先后顺序变了，但两句话都还在。
 *
 * ## 历史
 *
 * v0.2.13 把「双方是否真的在争论」的判断结果只写进 brief 的 `risks` 里，**发布策略完全不知情**。
 * 后果是：一个 `allow` 的候选，即使它所依据的分歧其实不存在（A方案/B方案那类误判），在
 * `limited_auto` 模式下仍然会被自动发出去。v0.2.14 因此加了「语义未确认不占自动额度」。
 *
 * ## v0.2.21 为什么又改了
 *
 * 「不占自动额度」这个说法在 v0.2.21 之后没有对象了 —— 所有模式都不再有自动额度，**任何**
 * 真实发表都必须有该候选的人工批准记录（任务书 §二）。所以原来的规则变成了「兜住一个人工
 * 批准本来就该兜住的东西」。
 *
 * 两条原本的意图仍然成立，只是位置变了：
 *
 * 1. **不能无人审核自动发表** —— 现在由人工批准这一道拦，不分模式。
 * 2. **允许安全地生成澄清式候选** —— 语义未确认不会被 `block`（那会连候选都不给主人看），
 *    主人仍然可以看到它、逐条批准。
 *
 * 另外补了一条 v0.2.21 新增的性质：语义未确认时，**即使主人批准了**，策略也要在理由里说清楚
 * 「这一条依赖你逐条确认」，而不是让批准看起来像「它已经没问题了」。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkPublishPolicy, type PublishAttempt } from '../lib/safety.js'
import { DEFAULT_POLICY } from '../lib/safety.js'

const POLICY = { ...DEFAULT_POLICY, mode: 'limited_auto' as const, maxAutoPublishesPerSession: 5 }

function attempt(overrides: Partial<PublishAttempt> = {}): PublishAttempt {
  return {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: false,
    securityDecision: 'allow',
    now: 1_000_000,
    ...overrides,
  }
}

function codeOf(decision: ReturnType<typeof checkPublishPolicy>): string {
  return decision.allowed === false ? decision.code : ''
}

test('语义策略：语义未确认的候选不能无人审核发表（§6.4 第一句）', () => {
  const decision = checkPublishPolicy(POLICY, attempt({ semanticSettled: false }))
  assert.equal(decision.allowed, false, '语义未确认、又没有人工批准时不该发表')
  // v0.2.21 起先命中人工批准这一道：它更根本，也不依赖调用方有没有算过语义判定。
  assert.equal(codeOf(decision), 'approval_required')
})

test('语义策略：字段缺失读作「未确认」，不是「已确认」', () => {
  // Same reasoning as `securityDecision`: a caller that forgot to compute the verdict has not
  // shown the dispute is understood, and defaulting the other way turns an omission into a
  // permission. 在 v0.2.21 之后它影响的只是理由，因为批准本来就是必须的 —— 但「缺失不等于
  // 通过」这条不许反过来。
  const decision = checkPublishPolicy(POLICY, attempt())
  assert.equal(decision.allowed, false, '缺少语义判定、又没有批准时必须拒绝')
  assert.equal(codeOf(decision), 'approval_required')

  const withApproval = checkPublishPolicy(POLICY, attempt({ humanApproved: true }))
  assert.equal(withApproval.allowed, true)
  assert.ok(
    withApproval.allowed === true &&
      withApproval.reasons.some((reason) => reason.includes('尚未确认') || reason.includes('逐条确认')),
    '缺少语义判定时，即使批准了也要在理由里说明这一条依赖人工确认',
  )
})

test('语义策略：v0.2.21 起不再存在「不经过人工批准就发表」的路径', () => {
  // 这条是 v0.2.14 那条「语义已确认时才允许自动发表」的反面版本。
  // 旧断言是 `semanticSettled: true` → allowed，那在 v0.2.21 是错的：语义清楚不代表主人
  // 看过这条回复。新断言把两者都钉住。
  const settledNoApproval = checkPublishPolicy(POLICY, attempt({ semanticSettled: true }))
  assert.equal(settledNoApproval.allowed, false, '语义已确认但不能替代人工批准')
  assert.equal(codeOf(settledNoApproval), 'approval_required')

  const settledApproved = checkPublishPolicy(POLICY, attempt({ semanticSettled: true, humanApproved: true }))
  assert.equal(
    settledApproved.allowed,
    true,
    `语义已确认 + 人工批准应当允许：${settledApproved.allowed === false ? settledApproved.reason : 'ok'}`,
  )
})

test('语义策略：语义未确认但主人已批准 → 允许（§6.4 第二句）', () => {
  // The candidate is still generated so the owner can look at it. Here the point is that an
  // approval is what unblocks it, not that the semantic gap disappears.
  const decision = checkPublishPolicy(POLICY, attempt({ semanticSettled: false, humanApproved: true }))
  assert.equal(decision.allowed, true, `实际：${decision.allowed === false ? decision.reason : 'ok'}`)
  assert.ok(
    decision.allowed === true && decision.reasons.some((reason) => reason.includes('逐条确认')),
    '语义未确认时，理由里要保留「依赖主人逐条确认」这个事实',
  )
})

test('语义策略：语义未确认在 manual 模式下不改行为（本来就要人工）', () => {
  const manual = { ...POLICY, mode: 'manual' as const }
  const withoutApproval = checkPublishPolicy(manual, attempt({ semanticSettled: false }))
  assert.equal(withoutApproval.allowed, false)
  assert.equal(codeOf(withoutApproval), 'approval_required')

  const withApproval = checkPublishPolicy(manual, attempt({ semanticSettled: false, humanApproved: true }))
  assert.equal(withApproval.allowed, true)
})

test('语义策略：语义未确认不会被 block，候选仍然可以生成', () => {
  // The distinction the task book draws: an unsafe reply is refused outright, an unresolved
  // dispute is *shown to a human*. A `block` here would hide the candidate entirely.
  const decision = checkPublishPolicy(POLICY, attempt({ semanticSettled: false }))
  assert.notEqual(codeOf(decision), 'security_blocked')
  assert.match(
    decision.allowed === false ? decision.reason : '',
    /人工|确认/,
    '理由里要说清是「需要人看」而不是「内容不安全」',
  )
})

test('语义策略：安全 block 优先于语义判定', () => {
  // An unsafe candidate must stay refused for the *security* reason, so the owner is not told
  // "just confirm it and it will go" about content that must never be sent.
  const decision = checkPublishPolicy(
    POLICY,
    attempt({ semanticSettled: false, securityDecision: 'block' }),
  )
  assert.equal(decision.allowed, false)
  assert.equal(codeOf(decision), 'security_blocked')
})
