/**
 * The publish gate: an unproven credential state must block the irreversible step.
 *
 * `credential-mirror.test.ts` proves the mirror classifies states correctly. This
 * file proves the plugin *acts* on that classification, because a correct state
 * that nothing consults is worse than no state at all — it looks like a safety
 * feature in the diff while the publish path keeps sending.
 *
 * Three properties:
 *
 * 1. `publishCandidate` refuses before the dedupe record, before the in-flight
 *    claim and before any network call — so a refusal costs nothing and cannot
 *    leave a half-written ledger behind.
 * 2. The refusal names the actual phase, because "credentials unproven" is not
 *    actionable while "凭据库还在初始化" is.
 * 3. A runtime without a credential state still publishes, which is the shape of
 *    every deployment without `ctx.credentials` and of every pre-v0.1.12 test
 *    double. Refusing there would be a regression, not caution.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { publishCandidate } from '../lib/publisher.js'
import { DebateStore } from '../lib/store.js'
import { contentHash } from '../lib/target.js'
import type { TiebaAdapter } from '../lib/platforms/tieba/adapter.js'
import type { PublishOutcome } from '../lib/types.js'

const NOW = new Date(0).toISOString()
const THREAD_ID = '900000000000'
const FLOOR_POST_ID = '900000000001'
const TARGET_POST_ID = 'n5'

/** One stored session whose snapshot matches what a re-read would produce. */
function readySession(): Record<string, unknown> {
  return {
    id: 's-gate',
    platform: 'tieba',
    threadId: THREAD_ID,
    threadUrl: `https://tieba.baidu.com/p/${THREAD_ID}`,
    threadTitle: '测试帖',
    forumName: '测试吧',
    ownerKey: 'o',
    ownerName: '主人',
    opponentKey: 'b',
    opponentName: '对手B',
    opponentUserId: 'opp-1',
    disputeFloorPostId: FLOOR_POST_ID,
    disputeFloorNumber: 1,
    triggerPostId: 'trigger-1',
    targetKind: 'nested',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [
      {
        replyId: 's-gate-c1',
        text: '这是一条通过检查的回复内容。',
        strategy: 'direct_rebuttal',
        targetPostId: TARGET_POST_ID,
        targetSnapshot: {
          platform: 'tieba',
          threadId: THREAD_ID,
          floorPostId: FLOOR_POST_ID,
          floorNumber: 1,
          nestedReplyId: TARGET_POST_ID,
          targetPostId: TARGET_POST_ID,
          targetKind: 'nested',
          targetAuthorId: 'opp-1',
          targetAuthorName: '对手B',
          contentHash: contentHash('对手的发言内容'),
          capturedAt: NOW,
        },
        candidateVersion: 1,
        textHash: contentHash('这是一条通过检查的回复内容。'),
        confidence: 0.8,
        violations: [],
        notes: [],
        // This fixture predates v0.2.5, when a candidate carried no security
        // assessment. Since then the publish path refuses one that has none
        // (`security_blocked`), which would pre-empt the credential refusal these
        // tests exist to pin. Every candidate a real run produces has an assessment,
        // so this is the one a clean generation would produce: `allow`, no findings —
        // leaving the credential phase as the only thing that can refuse.
        security: {
          injectionDetected: false,
          ownerIdentityValid: true,
          targetIdentityValid: true,
          stanceConsistency: 'consistent',
          ownerDirectedAttack: false,
          unauthorizedInstructionFollowed: false,
          secretLeakRisk: false,
          evidenceIntegrityValid: true,
          decision: 'allow',
          reasons: [],
          fingerprint: 'allow:fixture:1',
        },
        createdAt: NOW,
        approved: false,
      },
    ],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** A store seeded with that session. */
async function seededStore(): Promise<DebateStore> {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-gate-'))
  const store = new DebateStore({ dir })
  await store.mutate((data) => ({ ...data, sessions: [readySession() as never] }))
  return store
}

/** An adapter that records every send attempt and answers a minimal thread read. */
function countingAdapter() {
  const state = { sends: 0 }
  const adapter = {
    checkAuthentication: async () => ({ authenticated: true, accountId: 'ai-1', accountName: 'AI' }),
    async publishReply(): Promise<PublishOutcome> {
      state.sends += 1
      return { status: 'published', postId: 'posted-1' } as PublishOutcome
    },
    async readThread(): Promise<unknown> {
      return undefined
    },
  }
  return { adapter: adapter as unknown as TiebaAdapter, state }
}

const POLICY = {
  interactionMode: 'manual',
  maxAutoPerSession: 0,
  cooldownSeconds: 0,
  maxPerThread: 100,
  persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
} as never

function deps(
  store: DebateStore,
  adapter: TiebaAdapter,
  credentialState?: () => { phase: string; canPublish: boolean; error?: string },
) {
  return {
    adapter,
    store,
    policy: POLICY,
    config: () => ({ aiAccountUserId: 'ai-1', aiAccountName: 'AI' }),
    ...(credentialState === undefined ? {} : { credentialState }),
  }
}

const REQUEST = {
  sessionId: 's-gate',
  candidateId: 's-gate-c1',
  approvedText: '这是一条通过检查的回复内容。',
  humanApproved: true,
}

for (const phase of ['loading', 'timeout', 'partial', 'failed', 'unknown'] as const) {
  test(`publishing is refused before any network call while the phase is "${phase}"`, async () => {
    const store = await seededStore()
    const { adapter, state } = countingAdapter()
    const report = await publishCandidate(
      deps(store, adapter, () => ({ phase, canPublish: false })),
      REQUEST,
    )

    assert.equal(report.ok, false)
    assert.equal(report.status, 'refused')
    assert.equal(report.errorCode, 'credentials_unproven')
    assert.equal(state.sends, 0, 'a refused publish must not reach the platform')

    // A refusal must also leave no dedupe record behind, or the trigger would be
    // burned and the retry after the store finishes loading would be blocked.
    const snapshot = store.snapshot()
    assert.equal(
      (snapshot.dedupe ?? []).length,
      0,
      'a credential refusal must not consume the trigger',
    )
  })
}

test('the refusal message names the phase so the owner knows what to do', async () => {
  const store = await seededStore()
  const { adapter } = countingAdapter()

  const loading = await publishCandidate(
    deps(store, adapter, () => ({ phase: 'loading', canPublish: false })),
    REQUEST,
  )
  assert.match(loading.message, /初始化/)

  const failed = await publishCandidate(
    deps(store, adapter, () => ({ phase: 'failed', canPublish: false, error: '磁盘错误' })),
    REQUEST,
  )
  assert.match(failed.message, /读取凭据库失败/)
  assert.match(failed.message, /磁盘错误/, 'the underlying reason is carried through')
  assert.match(failed.message, /不会删除已保存的 Cookie/, 'and it says the data is safe')
})

test('a deployment with no credential state is not blocked by the gate', async () => {
  // Backwards compatibility: a runtime without `ctx.credentials` has nothing to
  // be uncertain about, and refusing here would break every v0.1.5 setup.
  //
  // The assertion is about *this* gate, not about the publish succeeding: the
  // fixture's adapter reports no account id, so the older identity gate still
  // refuses it — correct behaviour, and not what this file tests.
  const store = await seededStore()
  const { adapter } = countingAdapter()
  const report = await publishCandidate(deps(store, adapter), REQUEST)

  assert.notEqual(
    report.errorCode,
    'credentials_unproven',
    'without a credential state the gate must abstain',
  )
})

test('a proven credential state is not blocked by the gate', async () => {
  const store = await seededStore()
  const { adapter } = countingAdapter()
  const report = await publishCandidate(
    deps(store, adapter, () => ({ phase: 'ready', canPublish: true })),
    REQUEST,
  )
  assert.notEqual(report.errorCode, 'credentials_unproven')
})

test('the same request is no longer refused for credentials once the store finishes loading', async () => {
  // The order matters: if the claim landed before the gate, a refusal during
  // warm-up would leave the trigger in flight or in the ledger, and the retry a
  // second later would be rejected for the wrong reason.
  const store = await seededStore()
  const { adapter, state } = countingAdapter()
  let calls = 0

  const refused = await publishCandidate(
    deps(store, adapter, () => {
      calls += 1
      return { phase: 'loading', canPublish: false }
    }),
    REQUEST,
  )
  assert.equal(calls, 1, 'the state is consulted exactly once per attempt')
  assert.equal(refused.status, 'refused')
  assert.equal(state.sends, 0)

  // After the store finishes loading the gate lets the attempt through. What
  // happens next is the rest of the pipeline (identity verification in this
  // fixture), which is deliberately not this file's subject.
  const retry = await publishCandidate(
    deps(store, adapter, () => ({ phase: 'ready', canPublish: true })),
    REQUEST,
  )
  assert.notEqual(
    retry.errorCode,
    'credentials_unproven',
    'the same request must not be refused for credentials once they are proven',
  )
})
