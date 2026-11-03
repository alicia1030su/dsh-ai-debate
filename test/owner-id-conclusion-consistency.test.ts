/**
 * The old `ownerUserId` compatibility branch must agree with the publish gate.
 *
 * ## The inconsistency
 *
 * `resolveOwnerKey`'s non-numeric branch returned `assurance: 'verified'`
 * unconditionally, while building evidence that may carry no `source` at all (a
 * legacy row has none). The publish gate recomputes from the evidence and would
 * refuse — so the page said "verified" and the send said "no", for the same session.
 *
 * The fix is not to pick one of the two answers. It is to derive the label from the
 * evidence, so a disagreement is no longer representable.
 *
 * ## What must survive
 *
 * The compatibility branch exists for a reason: Tieba users paste their `un` into
 * the numeric-id field, and refusing those configurations outright would break
 * everyone who set the product up before the uid split. So the branch stays — it
 * just stops claiming more than it can show.
 *
 * Read-only analysis keeps working for a legacy row (a key is still returned); only
 * the *claim* is downgraded.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute } from '../lib/analyzer.js'
import { assuranceFromEvidence } from '../lib/identity.js'
import { checkPublishPolicy } from '../lib/safety.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'

const THREAD_ID = '8752343543'
const FLOOR_POST_ID = '133529333135'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
  id: THREAD_ID,
  title: '旧配置一致性',
  content: '开场',
  authorId: 'host_un',
  authorName: '楼主',
  authorSource: 'wap_floor',
  url: `https://tieba.baidu.com/p/${THREAD_ID}`,
  images: [],
}

const FLOOR: Floor = {
  platform: 'tieba',
  floorNumber: 1,
  postId: FLOOR_POST_ID,
  authorId: 'host_un',
  authorName: '楼主',
  authorSource: 'wap_floor',
  content: '开场',
  images: [],
  nestedCount: 1,
}

function collected(nested: NestedReply[]): CollectedThread {
  return {
    thread: THREAD,
    floors: [
      { floor: { ...FLOOR, nestedCount: nested.length }, nested, nestedComplete: true },
    ],
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
  } as unknown as CollectedThread
}

const POLICY = {
  mode: 'manual' as const,
  maxAutoPublishesPerSession: 0,
  cooldownMs: 0,
  maxPublishesPerThread: 10,
  stopOnChallenge: true,
}

const ATTEMPT = {
  sessionId: 's',
  threadId: 't',
  sessionPublishes: 0,
  threadPublishes: 0,
  humanApproved: true,
  securityDecision: 'allow' as const,
  semanticSettled: true,
  now: 1_000_000,
}

/** A nested reply by `handle`, optionally carrying no provenance (legacy shape). */
function byHandle(handle: string, display: string, legacy = false): NestedReply {
  return {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorId: handle,
    authorName: display,
    ...(legacy ? {} : { authorSource: 'wap_inline' as const }),
    content: '我的看法。',
    relationUncertain: false,
  } as unknown as NestedReply
}

// ── case 1: declared source → both layers say the same thing ──────────────

test('T3：非数字 ownerUserId + 有来源 → 结论与闸门一致（放行）', () => {
  const dispute = analyzeDispute(
    collected([byHandle('silver_fox', '苏小玲')]),
    // The legacy configuration shape: a login name pasted into the id field.
    { handle: undefined, userId: 'silver_fox', platform: 'tieba' } as never,
    { postId: 'r1' },
  )

  assert.equal(dispute.ownerIdentityAssurance, 'verified')
  assert.equal(dispute.ownerIdentityEvidence.kind, 'handle')
  assert.equal(dispute.ownerIdentityEvidence.source, 'wap_inline', '必须记录来源')

  // The gate agrees, because both now read the same evidence.
  assert.equal(assuranceFromEvidence(dispute.ownerIdentityEvidence), 'identity_verified')
  const decision = checkPublishPolicy(POLICY, {
    ...ATTEMPT,
    ownerIdentityAssurance: dispute.ownerIdentityAssurance,
    ownerIdentityEvidence: dispute.ownerIdentityEvidence,
  } as never)
  assert.equal(decision.allowed, true)
})

// ── case 2: no source → readable, but not verified ────────────────────────

test('T3：非数字 ownerUserId + 旧记录无来源 → unverified，不能声称已核验', () => {
  const dispute = analyzeDispute(
    collected([byHandle('silver_fox', '苏小玲', true)]),
    { userId: 'silver_fox', platform: 'tieba' } as never,
    { postId: 'r1' },
  )

  // Read-only still works: a participant was resolved and the thread is analysable.
  assert.ok(dispute.owner.key.length > 0, '旧记录仍应可读')
  assert.equal(dispute.ownerStatements.length, 1, '仍然能列出主人的发言')

  // But the claim is downgraded, and it matches what the gate will decide.
  assert.equal(
    dispute.ownerIdentityAssurance,
    'unverified',
    '没有来源就不能声称已核验——这正是修复前不一致的地方',
  )
  assert.equal(assuranceFromEvidence(dispute.ownerIdentityEvidence), 'identity_unknown')

  const decision = checkPublishPolicy(POLICY, {
    ...ATTEMPT,
    ownerIdentityAssurance: dispute.ownerIdentityAssurance,
    ownerIdentityEvidence: dispute.ownerIdentityEvidence,
  } as never)
  assert.equal(decision.allowed, false, '旧记录不得授权发表')
})

// ── case 3: two configurations pointing at two people ────────────────────

test('T3：userId 与 handle 指向不同账号 → 拒绝，不静默选一个', () => {
  const data = collected([
    {
      platform: 'tieba',
      postId: 'r1',
      parentPostId: FLOOR_POST_ID,
      authorId: 'account_a',
      authorName: '甲',
      authorSource: 'wap_inline',
      content: '我是 A。',
      relationUncertain: false,
    } as unknown as NestedReply,
    {
      platform: 'tieba',
      postId: 'r2',
      parentPostId: FLOOR_POST_ID,
      authorId: 'account_b',
      authorName: '乙',
      authorSource: 'wap_inline',
      content: '我是 B。',
      relationUncertain: false,
    } as unknown as NestedReply,
  ])

  assert.throws(
    () =>
      analyzeDispute(
        data,
        // Two answers to "who is the owner", pointing at two different people.
        { userId: 'account_a', handle: 'account_b', platform: 'tieba' } as never,
        { postId: 'r1' },
      ),
    /不同|不一致|冲突/,
    '两份配置指向不同账号时，不能静默挑一个',
  )
})

test('T3：userId 与 handle 指向同一账号 → 正常匹配', () => {
  const dispute = analyzeDispute(
    collected([byHandle('silver_fox', '苏小玲')]),
    // Both name the same account; this is a redundant, not a contradictory, config.
    { userId: 'silver_fox', handle: 'silver_fox', platform: 'tieba' } as never,
    { postId: 'r1' },
  )
  assert.equal(dispute.ownerIdentityAssurance, 'verified')
  assert.equal(dispute.ownerStatements.length, 1)
})

// ── case 4: a changed configuration must not reuse old conclusions ───────

test('T3：配置改到另一个账号后，旧会话的 evidence 与新配置不一致', () => {
  // The session was analysed with `old_owner`; the config now names `new_owner`.
  // The publisher compares the two (v0.2.23 patch 3) and refuses. This asserts the
  // *data* needed for that comparison is still present after the branch change.
  const dispute = analyzeDispute(
    collected([byHandle('old_owner', '旧主人')]),
    { userId: 'old_owner', platform: 'tieba' } as never,
    { postId: 'r1' },
  )
  assert.equal(dispute.ownerIdentityEvidence.value, 'old_owner')
  assert.notEqual(dispute.ownerIdentityEvidence.value, 'new_owner')
})
