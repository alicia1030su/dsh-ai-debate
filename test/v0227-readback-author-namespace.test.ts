/**
 * A publish must not be declared a mismatch because the account is named two ways.
 *
 * ## The defect
 *
 * Tieba identifies an author in two unrelated namespaces:
 *
 * - `authorId` — the **login name** (`ai_account`), which is what a comment row's
 *   `username` attribute carries;
 * - `authorNumericUid` — a **numeric id** (`600001`), which is what the owner binds as
 *   `aiAccountUserId`.
 *
 * `verifyPublished()` compared only the first against the second:
 *
 * ```ts
 * if (actualId !== expectation.aiAccountUserId) mismatches.push('回复的作者是 …')
 * ```
 *
 * Those two can never be equal, so **every** publish by a numeric-bound account was
 * reported as 「发表后回读与审核内容不一致：回复的作者是 ai_account，而绑定账号是 600001」.
 * The reply was correct; the check was not. The consequence is worse than a cosmetic
 * wrong message: the session is moved to `NEEDS_CONFIRMATION` with
 * `verification_mismatch`, the page says 「结果不确定（不会自动重试）」, and the owner is
 * told to go verify by hand a publish that in fact succeeded exactly as approved.
 *
 * `verification-runner.ts` had already been fixed for the same confusion in v0.2.26 (its
 * comment records the identical symptom on the 验收 path). The publish path kept the
 * handle-only comparison — which is why one browser run could report 46/46 passing stages
 * while the stored session said the read-back disagreed.
 *
 * ## What this pins
 *
 * That a reply whose read-back carries both namespaces verifies cleanly, and that a
 * genuinely different account is still refused — the second half matters, because "match
 * either field" would otherwise be a way to make any stranger look like the bound account.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DebateStore } from '../lib/store.js'
import { publishCandidate, resetInFlight, type PublishReport } from '../lib/publisher.js'
import { DEFAULT_POLICY } from '../lib/safety.js'
import { assessmentFingerprint } from '../lib/security/security-policy.js'
import { contentHash } from '../lib/target.js'
import type { StoredSession } from '../lib/store.js'
import type { ReplyContext } from '../lib/types.js'
import { FakeAdapter, threePartyThread, grantApproval } from './helpers.ts'

const BOUND = () => ({ aiAccountUserId: '600001', aiAccountName: 'AI小号' })
const TEXT = '两个命名空间都要能认出发帖账号。'

function readySession(): StoredSession {
  const fixture = threePartyThread()
  const now = new Date().toISOString()
  const floorPostId = fixture.floors[0]!.postId
  const target = fixture.nested[floorPostId]!.find((post) => post.postId === 'n5')!
  return {
    id: 's-namespace',
    platform: 'tieba',
    threadId: fixture.thread.id,
    threadUrl: fixture.thread.url,
    threadTitle: fixture.thread.title,
    forumName: '测试吧',
    ownerKey: 'o',
    ownerIdentityAssurance: 'verified' as const,
    ownerIdentityEvidence: { kind: 'handle' as const, value: 'owner-1', source: 'wap_floor' as const },
    ownerName: '主人',
    opponentKey: 'b',
    opponentName: '对手B',
    opponentUserId: target.authorId,
    disputeFloorPostId: floorPostId,
    disputeFloorNumber: 1,
    triggerPostId: 'n7',
    targetKind: 'nested',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [
      {
        replyId: 's-namespace-c1',
        text: TEXT,
        strategy: 'direct_rebuttal',
        targetPostId: 'n5',
        targetSnapshot: {
          platform: 'tieba',
          threadId: fixture.thread.id,
          floorPostId,
          floorNumber: 1,
          nestedReplyId: 'n5',
          targetPostId: 'n5',
          targetKind: 'nested',
          targetAuthorId: target.authorId,
          targetAuthorName: target.authorName,
          contentHash: contentHash(target.content),
          capturedAt: now,
        } as never,
        candidateVersion: 1,
        textHash: contentHash(TEXT),
        confidence: 0.8,
        violations: [],
        notes: [],
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
          fingerprint: assessmentFingerprint({ reply: TEXT, targetPostId: 'n5', decision: 'allow' }),
        },
        createdAt: now,
        approved: false,
      },
    ],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** An adapter whose read-back names the author the way a real comment row does. */
function adapterNaming(handle: string, numeric: string | undefined): FakeAdapter {
  const fixture = threePartyThread()
  const floorPostId = fixture.floors[0]!.postId
  const target = fixture.nested[floorPostId]!.find((post) => post.postId === 'n5')!

  const adapter = new FakeAdapter({
    thread: fixture.thread,
    floors: fixture.floors,
    nested: fixture.nested,
    publish: () => ({ status: 'confirmed', postId: 'new-post-ns' }),
    // The pre-send identity check compares the logged-in account against the binding
    // before anything is sent, so the fake must be logged in *as* the bound account.
    auth: { authenticated: true, userId: '600001', userName: 'AI小号' },
  })
  adapter.getReplyContext = async (_ref, postId): Promise<ReplyContext> => {
    const base = {
      // The two fields the interface requires but this test never looks at.
      ancestors: [],
      siblings: [],
      thread: fixture.thread,
      floor: target.parentPostId === floorPostId ? fixture.floors.find((f) => f.postId === floorPostId)! : fixture.floors.find((f) => f.postId === floorPostId)!,
    }
    if (postId === 'n5') {
      return {
        ...base,
        nested: {
          platform: 'tieba',
          postId: 'n5',
          parentPostId: floorPostId,
          authorId: target.authorId,
          authorName: target.authorName,
          content: target.content,
        },
      }
    }
    return {
      ...base,
      nested: {
        platform: 'tieba',
        postId,
        parentPostId: floorPostId,
        authorId: handle,
        authorName: 'AI小号',
        ...(numeric === undefined ? {} : { authorNumericUid: numeric }),
        // A complete row: it also says which reply it answers, so the only dimension this
        // test exercises is the author.
        replyToPostId: 'n5',
        content: TEXT,
      },
    }
  }
  return adapter
}

async function publishWith(adapter: FakeAdapter): Promise<PublishReport> {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-namespace-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const session = readySession()
    await store.mutate((data) => ({ ...data, sessions: [session] }))
    await grantApproval(store, { sessionId: session.id, candidateId: 's-namespace-c1', config: BOUND })
    return await publishCandidate(
      { adapter, store, policy: { ...DEFAULT_POLICY, mode: 'manual' }, config: BOUND },
      { sessionId: session.id, candidateId: 's-namespace-c1', approvedText: TEXT },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('回读的登录名与绑定账号不一致、但数字 ID 一致时，仍然算核对通过', async () => {
  resetInFlight()
  try {
    // This is the shape the simulated platform and a real comment row both produce:
    // handle `ai_account`, numeric `600001`, bound account `600001`.
    const report = await publishWith(adapterNaming('ai_account', '600001'))
    assert.equal(
      report.status,
      'published',
      `作者是同一个账号，不该被判成不一致：${report.message}`,
    )
    assert.equal(report.ok, true)
    assert.equal(report.verified, true, '两个命名空间之一对上就是核对通过')
    assert.doesNotMatch(report.message, /不一致/, report.message)
  } finally {
    resetInFlight()
  }
})

test('数字 ID 对不上时仍然拒绝，不能因为句柄能凑就放过', async () => {
  resetInFlight()
  try {
    // A different account that happens to share nothing. If "match either field" were
    // implemented loosely — e.g. comparing a missing numeric field as equal — this is
    // the case that would slip through as a successful publish.
    const report = await publishWith(adapterNaming('ai_account', '999999'))
    assert.equal(report.status, 'uncertain', `换了一个账号必须被指出：${report.message}`)
    assert.equal(report.ok, false)
    assert.match(report.message, /999999|不一致/, report.message)
  } finally {
    resetInFlight()
  }
})
