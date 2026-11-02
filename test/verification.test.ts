/**
 * The one-off verification flow's policy layer.
 *
 * These tests cover only the *decision* logic — what may be attempted, and when a
 * capability may be upgraded. They deliberately do not touch the network: proving
 * that the flow would publish is different from publishing, and conflating the two
 * is how a "verification" becomes an unapproved post.
 *
 * The invariants under test:
 *
 * 1. Nothing but `unverified` may be tested.
 * 2. Every authorization field is required; nothing is defaulted.
 * 3. One authorization, one attempt.
 * 4. The live account must be the authorized one.
 * 5. `supported` requires all four read-back facts.
 * 6. A refusal leaves the capability exactly where it was.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorizationKey,
  checkVerification,
  decideCapabilityUpgrade,
  describeAuthorizationRequirements,
  VERIFIABLE_CAPABILITIES,
  type VerificationAuthorization,
  type VerificationRecord,
} from '../lib/verification.js'

function authorization(overrides: Partial<VerificationAuthorization> = {}): VerificationAuthorization {
  return {
    platform: 'tieba',
    authorizedAccountId: 'account-1',
    authorizedThreadId: 'thread-1',
    authorizedBy: '主人',
    capability: 'comment.publish',
    approvedText: '这是一条用于验收的回复。',
    ...overrides,
  }
}

test('只有 unverified 的能力允许走一次性验收', () => {
  const used = new Set<string>()
  for (const state of ['supported', 'permission_required', 'degraded', 'unavailable'] as const) {
    const decision = checkVerification({
      authorization: authorization(),
      capabilityState: state,
      usedKeys: used,
    })
    assert.equal(decision.ok, false, `${state} 不允许验收`)
    assert.equal(decision.refusal, 'wrong_state')
  }

  const allowed = checkVerification({
    authorization: authorization(),
    capabilityState: 'unverified',
    liveAccountId: 'account-1',
    usedKeys: used,
  })
  assert.equal(allowed.ok, true, 'unverified 才是一次性验收的对象')
})

test('不能把非发表能力塞进这个流程', () => {
  assert.deepEqual(
    VERIFIABLE_CAPABILITIES,
    ['comment.publish', 'comment.reply'],
    '可验收的能力是固定清单，不能由调用方扩大',
  )
  const decision = checkVerification({
    authorization: authorization({ capability: 'thread.read' }),
    capabilityState: 'unverified',
    liveAccountId: 'account-1',
    usedKeys: new Set(),
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.refusal, 'not_verifiable')
})

test('授权字段缺一不可，插件不替主人填写', () => {
  const cases: { field: keyof VerificationAuthorization; label: string }[] = [
    { field: 'authorizedAccountId', label: '授权账号' },
    { field: 'authorizedThreadId', label: '授权帖子' },
    { field: 'authorizedBy', label: '授权人' },
    { field: 'approvedText', label: '已批准的正文' },
  ]
  for (const { field, label } of cases) {
    const decision = checkVerification({
      authorization: authorization({ [field]: '' }),
      capabilityState: 'unverified',
      liveAccountId: 'account-1',
      usedKeys: new Set(),
    })
    assert.equal(decision.ok, false, `${label} 为空时必须拒绝`)
    assert.equal(decision.refusal, 'incomplete_authorization')
    assert.ok(decision.message.includes(label), `提示里要说明缺的是${label}`)
  }
})

test('同一份授权只能发一条，重复使用会被拒绝', () => {
  const auth = authorization()
  const used = new Set([authorizationKey(auth)])
  const decision = checkVerification({
    authorization: auth,
    capabilityState: 'unverified',
    liveAccountId: 'account-1',
    usedKeys: used,
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.refusal, 'already_used')

  // A different thread is a different authorization, so it is a separate attempt
  // — but it still needs its own explicit approval.
  const other = checkVerification({
    authorization: authorization({ authorizedThreadId: 'thread-2' }),
    capabilityState: 'unverified',
    liveAccountId: 'account-1',
    usedKeys: used,
  })
  assert.equal(other.ok, true)
})

test('登录账号必须是授权账号，不能拿别人的登录态发帖', () => {
  const decision = checkVerification({
    authorization: authorization(),
    capabilityState: 'unverified',
    liveAccountId: 'someone-else',
    usedKeys: new Set(),
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.refusal, 'account_mismatch')
})

test('无法确认登录账号时必须拒绝，不能用配置账号代替真实账号', () => {
  // ## Why this test says the opposite of what it used to (v0.2.21 P0-2)
  //
  // Until P0-2 this asserted `ok === true` with a comment saying the flow "may proceed" when
  // the session exposed no id. That was the bug, not the contract: proceeding meant sending a
  // reply and then writing a record claiming the authorised account made it, on the strength of
  // an identity nobody had read. A verification whose whole purpose is to attribute a real post
  // to a real account cannot skip the part where it establishes who is logged in.
  //
  // Both "absent" and "empty" are covered because the two arrive by different routes (a probe
  // that could not answer, and a probe that answered with nothing) and both must refuse.
  for (const liveAccountId of [undefined, ''] as const) {
    const decision = checkVerification({
      authorization: authorization(),
      capabilityState: 'unverified',
      ...(liveAccountId === undefined ? {} : { liveAccountId }),
      usedKeys: new Set(),
    })
    assert.equal(decision.ok, false, '读不到登录账号却放行，等于用配置账号冒充真实身份')
    assert.equal(decision.refusal, 'account_unknown')
    assert.match(decision.message, /不会发表|登录/)
  }
})

function record(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    key: 'k1',
    platform: 'tieba',
    capability: 'comment.publish',
    authorizedAccountId: 'account-1',
    authorizedThreadId: 'thread-1',
    authorizedBy: '主人',
    approvedText: '验收回复',
    startedAt: '2026-10-28T00:00:00.000Z',
    outcome: 'succeeded',
    publishedPostId: 'post-1',
    readBack: {
      postFound: true,
      authorMatched: true,
      textMatched: true,
      parentMatched: true,
      notes: [],
    },
    ...overrides,
  }
}

test('四项回读证据齐全才能升级为 supported', () => {
  assert.equal(decideCapabilityUpgrade(record()).upgrade, true)

  const cases: { patch: Partial<NonNullable<VerificationRecord['readBack']>>; why: string }[] = [
    { patch: { postFound: false }, why: '帖子没出现' },
    { patch: { authorMatched: false }, why: '作者不符' },
    { patch: { textMatched: false }, why: '正文不符' },
    { patch: { parentMatched: false }, why: '父级不符' },
  ]
  for (const { patch, why } of cases) {
    const decision = decideCapabilityUpgrade(
      record({ readBack: { postFound: true, authorMatched: true, textMatched: true, parentMatched: true, notes: [], ...patch } }),
    )
    assert.equal(decision.upgrade, false, `${why} 时不得升级`)
    assert.ok(decision.reason.length > 0)
  }
})

test('发表在平台侧失败时能力保持 unverified', () => {
  for (const outcome of ['failed', 'uncertain', 'pending'] as const) {
    const decision = decideCapabilityUpgrade(record({ outcome }))
    assert.equal(decision.upgrade, false, `${outcome} 不能升级能力`)
  }
})

test('没有回读记录时不得升级', () => {
  const decision = decideCapabilityUpgrade(
    record({ readBack: undefined }),
  )
  assert.equal(decision.upgrade, false)
  assert.ok(decision.reason.includes('回读'))
})

test('授权说明里明确写出一条、留痕与失败即停', () => {
  const text = describeAuthorizationRequirements('tieba')
  assert.match(text, /只会有?发表一条|只会发表一条/)
  assert.match(text, /授权/)
  assert.match(text, /unverified/)
  assert.match(text, /403/)
})
