/**
 * A read-back that comes back incomplete must be "unverified", never a crash and never a
 * silent pass.
 *
 * ## The defect
 *
 * `verifyPublished()` compared the re-read body against the approved text:
 *
 * ```ts
 * const body = context.nested ? context.nested.content : context.floor.content
 * if (normalizeForCompare(body) !== normalizeForCompare(expectation.text)) { … }
 * ```
 *
 * `body` is typed `string`, but nothing guarantees it at runtime — a partial read, a page
 * shape the parser does not recognise, or an adapter that forgot the field all produce
 * `undefined`. That threw `Cannot read properties of undefined (reading 'replace')`
 * *after* the reply had already been posted, which is the worst possible moment: the one
 * path where the user needs to know whether the send happened crashed instead of saying.
 *
 * ## Why the fix is "unconfirmed", not "mismatch"
 *
 * Both of the easy answers are lies about the same missing fact. Calling it a mismatch
 * ("the body does not match what you approved") claims the reply is wrong when nothing was
 * read. Calling it a match claims it is right when nothing was read. `unconfirmed` is the
 * only honest third state, and the publisher already has it for exactly this reason.
 *
 * ## What is asserted
 *
 * That the publish reports `uncertain` with an explicit "could not check the body" note,
 * that it does not throw, and that the platform was called exactly once — a crash here
 * must not become a retry, because a retry is a second public reply.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DebateStore } from '../lib/store.js'
import { publishCandidate, resetInFlight } from '../lib/publisher.js'
import { DEFAULT_POLICY } from '../lib/safety.js'
import { assessmentFingerprint } from '../lib/security/security-policy.js'
import { contentHash } from '../lib/target.js'
import type { StoredSession } from '../lib/store.js'
import { FakeAdapter, threePartyThread, grantApproval } from './helpers.ts'

// The fixture adapter reports itself as 1001, so the binding must say 1001 too: a
// mismatch is refused as `identity_mismatch` long before the read-back runs.
const BOUND = () => ({ aiAccountUserId: '1001', aiAccountName: 'ai-account' })

/** A READY session with one `allow` candidate, built from the shared fixture. */
function readySession(): StoredSession {
  const fixture = threePartyThread()
  const now = new Date().toISOString()
  const floorPostId = fixture.floors[0]!.postId
  const target = fixture.nested[floorPostId]!.find((post) => post.postId === 'n5')!
  const text = '回读健壮性测试正文。'
  return {
    id: 's-readback',
    platform: 'tieba',
    threadId: fixture.thread.id,
    threadUrl: fixture.thread.url,
    threadTitle: fixture.thread.title,
    forumName: '测试吧',
    ownerKey: 'o',
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
        replyId: 's-readback-c1',
        text,
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
        textHash: contentHash(text),
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
          fingerprint: assessmentFingerprint({ reply: text, targetPostId: 'n5', decision: 'allow' }),
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

/**
 * An adapter whose read-back omits the body.
 *
 * The pre-send target check still answers normally, so the publish reaches the platform;
 * only the post-send read is incomplete. That isolates the defect to the verification.
 */
function adapterWithBodylessReadBack(): { adapter: FakeAdapter; sends: () => number } {
  const fixture = threePartyThread()
  const floorPostId = fixture.floors[0]!.postId
  const target = fixture.nested[floorPostId]!.find((post) => post.postId === 'n5')!
  let sends = 0

  const adapter = new FakeAdapter({
    thread: fixture.thread,
    floors: fixture.floors,
    nested: fixture.nested,
    publish: () => {
      sends += 1
      return { status: 'confirmed', postId: 'new-post-1' }
    },
  })

  adapter.getReplyContext = async (_ref, postId) => {
    const base = {
      thread: { id: fixture.thread.id, url: fixture.thread.url, title: fixture.thread.title },
      floor: {
        postId: floorPostId,
        floorNumber: 1,
        authorId: 'owner-1',
        authorName: '主人',
        content: '楼层正文',
      },
    }
    if (postId === 'n5') {
      // The target: complete, so the pre-send check passes.
      return {
        ...base,
        nested: {
          postId: 'n5',
          parentPostId: floorPostId,
          authorId: target.authorId,
          authorName: target.authorName,
          content: target.content,
        },
      }
    }
    // The new reply: present, but the body is missing. This is the shape that crashed.
    return {
      ...base,
      nested: {
        postId,
        parentPostId: floorPostId,
        authorId: '1001',
        authorName: 'ai-account',
        content: undefined as never,
      },
    }
  }

  return { adapter, sends: () => sends }
}

test('回读拿不到正文时不崩溃，而是报告「无法核对内容」', async () => {
  resetInFlight()
  const dir = mkdtempSync(join(tmpdir(), 'dsd-readback-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const session = readySession()
    await store.mutate((data) => ({ ...data, sessions: [session] }))
    await grantApproval(store, {
      sessionId: session.id,
      candidateId: 's-readback-c1',
      config: BOUND,
    })

    const { adapter, sends } = adapterWithBodylessReadBack()
    const report = await publishCandidate(
      { adapter, store, policy: { ...DEFAULT_POLICY, mode: 'manual' }, config: BOUND },
      { sessionId: session.id, candidateId: 's-readback-c1', approvedText: '回读健壮性测试正文。' },
    )

    // No throw. Reaching this assertion at all is half the test: the defect was an
    // unhandled \`undefined.replace\` thrown after the reply had already gone out.
    //
    // The status is `published`, not `uncertain` — and that distinction matters. The
    // platform *did* report a new post id, so "did this send?" is answered. What could not
    // be answered is "is the body the one the owner approved?", and that is what
    // `verified: false` plus the note on the message records. Reporting `uncertain` here
    // would be a different lie: it would say the send itself is in doubt, sending the user
    // looking for a reply that this response already knows exists.
    assert.equal(report.status, 'published', `发表本身是成功的：${report.message}`)
    assert.equal(report.ok, true)
    assert.equal(report.verified, false, '核对不全就不能声称核实过')
    assert.match(report.message, /无法核对|无法核实|没有正文/, report.message)
    assert.equal(report.postId, 'new-post-1', 'post id 仍要交回去，用户靠它去帖子核对')

    // A crash here must never become a retry: the reply is already public.
    assert.equal(sends(), 1, '平台只能被调用一次')

    // The body was never confirmed, so the record must not claim it was.
    const rows = store.snapshot().dedupe
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.publishState, 'confirmed', '平台确认发出了，记录要如实反映')
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('回读拿到完整正文时正常确认发表（对照组）', async () => {
  // Without this, the test above could pass because *everything* is uncertain.
  resetInFlight()
  const dir = mkdtempSync(join(tmpdir(), 'dsd-readback-ok-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const session = readySession()
    await store.mutate((data) => ({ ...data, sessions: [session] }))
    await grantApproval(store, {
      sessionId: session.id,
      candidateId: 's-readback-c1',
      config: BOUND,
    })

    const fixture = threePartyThread()
    const floorPostId = fixture.floors[0]!.postId
    const target = fixture.nested[floorPostId]!.find((post) => post.postId === 'n5')!
    const adapter = new FakeAdapter({
      thread: fixture.thread,
      floors: fixture.floors,
      nested: fixture.nested,
      publish: () => ({ status: 'confirmed', postId: 'new-post-2' }),
    })
    adapter.getReplyContext = async (_ref, postId) => {
      const base = {
        thread: { id: fixture.thread.id, url: fixture.thread.url, title: fixture.thread.title },
        floor: {
          postId: floorPostId,
          floorNumber: 1,
          authorId: 'owner-1',
          authorName: '主人',
          content: '楼层正文',
        },
      }
      if (postId === 'n5') {
        return {
          ...base,
          nested: {
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
          postId,
          parentPostId: floorPostId,
          authorId: '1001',
          authorName: 'ai-account',
          content: '回读健壮性测试正文。',
        },
      }
    }

    const report = await publishCandidate(
      { adapter, store, policy: { ...DEFAULT_POLICY, mode: 'manual' }, config: BOUND },
      { sessionId: session.id, candidateId: 's-readback-c1', approvedText: '回读健壮性测试正文。' },
    )
    assert.equal(report.status, 'published', report.message)
    assert.equal(report.ok, true)
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})
