/**
 * v0.2.5 defect reproduction: the two holes the task book names.
 *
 * ## Why these are written against `publishCandidate`
 *
 * The first attempt at this file used a hand-rolled fake adapter, and every case —
 * allow, review and block alike — was refused with `identity_unbound`. The tests
 * "passed" for a reason that had nothing to do with security. That is the same trap
 * that let defect 1 survive in the first place: an assertion that holds for an
 * unrelated reason reads as coverage.
 *
 * So this file reuses the project's own fixtures (`threePartyThread`, `FakeAdapter`)
 * and its `BOUND_ACCOUNT`, and pairs each attack case with a **control** that must
 * publish. If the control fails, the attack case proves nothing.
 *
 * ## Defect 1 — a `review` candidate reaches the publish path
 *
 * `mayAutoPublish()` returns `false` for `review` and is **called from nowhere**.
 * `checkPublishPolicy()`'s `PublishAttempt` has no security field, so to the policy a
 * `review` candidate and an `allow` candidate are identical, and
 * `recheckBeforePublish()` refuses only `block`.
 *
 * ## Defect 2 — the model's `confirm=true` *is* the approval
 *
 * `debate_publish_reply` reads a boolean out of its own arguments and passes
 * `humanApproved: true`. Nothing distinguishes "the owner clicked approve" from
 * "the model wrote `confirm: true`", and no approval is ever recorded.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { contentHash } from '../lib/target.js'
import { DebateStore } from '../lib/store.js'
import { publishCandidate, resetInFlight } from '../lib/publisher.js'
import { DEFAULT_POLICY, checkPublishPolicy } from '../lib/safety.js'
import { mayAutoPublish, assessmentFingerprint } from '../lib/security/security-policy.js'
import type { StoredCandidate, StoredSession } from '../lib/store.js'
import { FakeAdapter, threePartyThread } from './helpers.ts'

/** An AI account binding that satisfies the identity gate. */
const BOUND_ACCOUNT = () => ({ aiAccountUserId: '1001', aiAccountName: 'ai-account' })

const FIXTURE = threePartyThread()
const OPPONENT_POST_ID = 'n5'
/**
 * The fixture's opponent user id.
 *
 * A literal was used here first, and every case then failed at the target-author
 * check instead of the security gate — which is how the first version of this file
 * produced a false pass. Reading it from the fixture prevents that.
 */
const OPPONENT_USER_ID = FIXTURE.nested[FIXTURE.floors[0]!.postId]!.find(
  (post) => post.postId === OPPONENT_POST_ID,
)!.authorId

/**
 * The same fixture session the existing suite builds, with one deliberate change:
 * the security verdict. Everything else is identical, so a refusal cannot be
 * attributed to some other check.
 */
function sessionWithVerdict(
  decision: 'allow' | 'review' | 'block',
  text = '你这条论据没有出处，我不同意这个结论。',
): StoredSession {
  const now = new Date().toISOString()
  const threadId = FIXTURE.thread.id
  const floorPostId = FIXTURE.floors[0]!.postId
  const fixtureReply = FIXTURE.nested[floorPostId]!.find((post) => post.postId === OPPONENT_POST_ID)

  const candidate: StoredCandidate = {
    replyId: `s-${decision}-c1`,
    text,
    strategy: 'direct_rebuttal',
    targetPostId: OPPONENT_POST_ID,
    targetSnapshot: {
      platform: 'tieba',
      threadId,
      floorPostId,
      floorNumber: 1,
      nestedReplyId: OPPONENT_POST_ID,
      targetPostId: OPPONENT_POST_ID,
      targetKind: 'nested',
      targetAuthorId: OPPONENT_USER_ID,
      targetAuthorName: '对手B',
      contentHash: contentHash(fixtureReply?.content ?? ''),
      capturedAt: now,
    } as never,
    candidateVersion: 1,
    textHash: contentHash(text),
    confidence: 0.8,
    violations: [],
    notes: [],
    security: {
      injectionDetected: decision !== 'allow',
      ownerIdentityValid: true,
      targetIdentityValid: true,
      stanceConsistency: decision === 'block' ? 'contradictory' : 'consistent',
      ownerDirectedAttack: decision === 'block',
      unauthorizedInstructionFollowed: false,
      secretLeakRisk: false,
      evidenceIntegrityValid: true,
      decision,
      reasons: decision === 'allow' ? [] : [`${decision} 的安全理由`],
      // v0.2.14 §6.4: the automatic slot also requires a settled debate analysis. This fixture
      // is about the v0.2.5 matrix, so it states the assumption rather than exercising it;
      // `semanticSettled` has its own coverage in `v0214-semantic-policy.test.ts`.
      semanticSettled: true,
      fingerprint: assessmentFingerprint({ reply: text, targetPostId: OPPONENT_POST_ID, decision }),
    },
    createdAt: now,
    approved: false,
  }

  return {
    id: `s-${decision}`,
    platform: 'tieba',
    threadId,
    threadUrl: `https://tieba.baidu.com/p/${threadId}`,
    threadTitle: '测试帖',
    forumName: '测试吧',
    ownerKey: 'o',
    ownerName: '主人',
    opponentKey: 'b',
    opponentName: '对手B',
    opponentUserId: OPPONENT_USER_ID,
    disputeFloorPostId: floorPostId,
    disputeFloorNumber: 1,
    triggerPostId: 'p1',
    targetKind: 'nested',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [candidate],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: now,
    updatedAt: now,
  } as StoredSession
}

/** Run one publish attempt and hand back the report plus the publish count. */
async function attempt(options: {
  decision: 'allow' | 'review' | 'block'
  mode: 'manual' | 'single_shot' | 'limited_auto'
  humanApproved: boolean
}): Promise<{ ok: boolean; errorCode?: string; message: string; published: number }> {
  resetInFlight()
  const dir = mkdtempSync(join(tmpdir(), 'debate-v025-'))
  try {
    const session = sessionWithVerdict(options.decision)
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [session] }))

    const adapter = new FakeAdapter({
      ...FIXTURE,
      publish: () => ({ status: 'confirmed', postId: 'posted-1' }),
    })

    const report = await publishCandidate(
      {
        adapter,
        store,
        config: BOUND_ACCOUNT,
        policy: { ...DEFAULT_POLICY, mode: options.mode, maxAutoPublishesPerSession: 5 },
      },
      {
        sessionId: session.id,
        candidateId: session.candidates[0]!.replyId,
        approvedText: session.candidates[0]!.text,
        humanApproved: options.humanApproved,
      },
    )
    return {
      ok: report.ok,
      errorCode: report.errorCode,
      message: report.message,
      published: adapter.publishes.length,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    resetInFlight()
  }
}

// ---------------------------------------------------------------------------
// Defect 1
// ---------------------------------------------------------------------------

test('复现 1a（对照）：allow 候选在 limited_auto 无批准时可以发表', async () => {
  // The control. Without it, "review was refused" would also hold on a machine
  // where nothing publishes — which is exactly how the first version of this file
  // reported a false pass.
  const report = await attempt({ decision: 'allow', mode: 'limited_auto', humanApproved: false })
  assert.equal(report.ok, true, `对照组应当能发表，实际：${report.errorCode ?? '-'} ${report.message}`)
  assert.equal(report.published, 1)
})

test('复现 1：review 候选在 limited_auto 无批准时仍能发表', async () => {
  const report = await attempt({ decision: 'review', mode: 'limited_auto', humanApproved: false })
  assert.equal(
    report.ok,
    false,
    `review 候选在未批准时被发表了（code=${report.errorCode ?? '-'}）：${report.message}`,
  )
  assert.equal(report.published, 0, 'review 候选不得产生任何平台写操作')
})

test('复现 1b：mayAutoPublish 对 review 返回 false，但生产代码从不调用它', () => {
  const session = sessionWithVerdict('review')
  assert.equal(mayAutoPublish(session.candidates[0]!.security as never), false)
})

test('复现 1c：策略现在会读取安全判定（修复前它读不到）', () => {
  const decision = checkPublishPolicy(
    { ...DEFAULT_POLICY, mode: 'limited_auto', maxAutoPublishesPerSession: 5 },
    {
      sessionId: 's',
      threadId: 't',
      sessionPublishes: 0,
      threadPublishes: 0,
      humanApproved: false,
      // Deliberately omitted: a caller that forgets the verdict has not proven the
      // candidate is clean, so it is read as `review` rather than `allow`.
      now: Date.now(),
    },
  )
  assert.equal(decision.allowed, false, '缺少安全判定时必须按 review 处理并拒绝自动发表')
  assert.equal(decision.allowed === false ? decision.code : '', 'security_review_required')
})

// ---------------------------------------------------------------------------
// Defect 2
// ---------------------------------------------------------------------------

test('复现 2a：manual 模式不再接受调用方自报的 humanApproved', async () => {
  // v0.2.4 published here, because `humanApproved: true` was taken at face value.
  // v0.2.5 looks for a stored approval record, finds none, and refuses — which is
  // the whole point: the flag was a model-supplied boolean wearing the name of a
  // human decision.
  const report = await attempt({ decision: 'allow', mode: 'manual', humanApproved: true })
  assert.equal(
    report.ok,
    false,
    `没有授权记录时不应发表，实际：${report.errorCode ?? '-'} ${report.message}`,
  )
  assert.equal(report.published, 0)
  // Two different checks legitimately refuse here, and the code names which:
  //   `approval_missing`   — the review gate, when the verdict is `review`
  //   `approval_required`  — the policy, when the verdict is `allow` and mode is manual
  // Both mean "there is no stored approval", which is the property under test.
  assert.ok(
    report.errorCode === 'approval_missing' || report.errorCode === 'approval_required',
    `拒绝原因应当指出缺少授权，实际：${report.errorCode ?? '-'}`,
  )
})

test('复现 2：block 候选即使拿到 humanApproved 也被拒（现状正确，作为对照组保持）', async () => {
  const report = await attempt({ decision: 'block', mode: 'manual', humanApproved: true })
  assert.equal(report.ok, false, 'block 候选被发表了')
  assert.equal(report.published, 0)
})

test('复现 2b：状态文件现在有授权记录结构', async () => {
  // The structural half of the fix: an approval is a record with a binding and a
  // consumption timestamp, not a boolean that evaporates with the request.
  const dir = mkdtempSync(join(tmpdir(), 'debate-v025-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const data = store.snapshot() as unknown as Record<string, unknown>
    assert.equal('approvals' in data, true, '状态文件里必须有 approvals 字段')
    assert.deepEqual(data['approvals'], [], '新库的授权列表应当是空的')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

