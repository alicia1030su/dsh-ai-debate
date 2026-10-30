/**
 * v0.2.14 §6.4：语义风险必须进入发布策略。
 *
 * ## 这一条为什么重要
 *
 * v0.2.13 把「双方是否真的在争论」的判断结果只写进 brief 的 `risks` 里，**发布策略完全不知情**。
 * 后果是：一个 `allow` 的候选，即使它所依据的分歧其实不存在（A方案/B方案那类误判），在
 * `limited_auto` 模式下仍然会被自动发出去。
 *
 * 任务书的要求是精确的两件事，这里各有一条断言：
 *
 * 1. **不能无人审核自动发表** —— 语义未确认的候选不占自动额度。
 * 2. **允许安全地生成澄清式候选** —— 它不会被 `block`，主人仍然能看到并逐条批准。
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

test('语义策略：语义未确认的候选不能占用自动额度（§6.4 第一句）', () => {
  const decision = checkPublishPolicy(POLICY, attempt({ semanticSettled: false }))
  assert.equal(decision.allowed, false, '语义未确认时不该自动发表')
  assert.equal(decision.allowed === false ? decision.code : '', 'semantic_unsettled')
})

test('语义策略：字段缺失读作「未确认」，不是「已确认」', () => {
  // Same reasoning as `securityDecision`: a caller that forgot to compute the verdict has not
  // shown the dispute is understood, and defaulting the other way turns an omission into a
  // permission.
  const decision = checkPublishPolicy(POLICY, attempt())
  assert.equal(decision.allowed, false, '缺少语义判定时必须按未确认处理')
  assert.equal(decision.allowed === false ? decision.code : '', 'semantic_unsettled')
})

test('语义策略：语义已确认时才允许自动发表', () => {
  const decision = checkPublishPolicy(POLICY, attempt({ semanticSettled: true }))
  assert.equal(decision.allowed, true, `实际：${decision.allowed === false ? decision.reason : 'ok'}`)
})

test('语义策略：语义未确认但主人已批准 → 允许（§6.4 第二句）', () => {
  // The candidate is still generated so the owner can look at it. In `manual` mode a human was
  // required anyway; here the point is that an approval is what unblocks it, not that the
  // semantic gap disappears.
  const decision = checkPublishPolicy(POLICY, attempt({ semanticSettled: false, humanApproved: true }))
  assert.equal(decision.allowed, true, `实际：${decision.allowed === false ? decision.reason : 'ok'}`)
})

test('语义策略：语义未确认在 manual 模式下不改行为（本来就要人工）', () => {
  const manual = { ...POLICY, mode: 'manual' as const }
  const withoutApproval = checkPublishPolicy(manual, attempt({ semanticSettled: false }))
  assert.equal(withoutApproval.allowed, false)
  assert.equal(
    withoutApproval.allowed === false ? withoutApproval.code : '',
    'approval_required',
    'manual 模式下先命中人工批准要求，语义判定不该抢在它前面改变结论',
  )

  const withApproval = checkPublishPolicy(manual, attempt({ semanticSettled: false, humanApproved: true }))
  assert.equal(withApproval.allowed, true)
})

test('语义策略：语义未确认不会被 block，候选仍然可以生成', () => {
  // The distinction the task book draws: an unsafe reply is refused outright, an unresolved
  // dispute is *shown to a human*. A `block` here would hide the candidate entirely.
  const decision = checkPublishPolicy(POLICY, attempt({ semanticSettled: false }))
  assert.notEqual(decision.allowed === false ? decision.code : '', 'security_blocked')
  assert.match(
    decision.allowed === false ? decision.reason : '',
    /人工确认|尚未确认/,
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
  assert.equal(decision.allowed === false ? decision.code : '', 'security_blocked')
})
