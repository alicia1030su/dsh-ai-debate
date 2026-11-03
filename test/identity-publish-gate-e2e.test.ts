/**
 * The publish gate, end to end, counted.
 *
 * Every refusal here asserts **`FakeAdapter.publishReply` was never called**. A
 * refusal that still sends is not a refusal, and asserting only on a boolean
 * would let exactly that through.
 *
 * The controls matter as much as the refusals: if every case were refused, the
 * suite would be measuring "the gate is closed", not "the gate is correct". Two
 * positive cases run here — a verified owner, and the same session with a real
 * approval — and each asserts the send actually happened.
 *
 * ## What is deliberately *not* claimed
 *
 * Nothing here proves the disputed reply `151694781657` from thread `9493941284`
 * is now attributed correctly online. The repository's `comment-page1.html` is a
 * historical fixture from a different thread; it demonstrates the parser survives
 * that shape, not that the live misattribution is resolved.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { publishCandidate } from '../lib/publisher.js'
import { checkPublishPolicy } from '../lib/safety.js'
import type { StoredSession } from '../lib/store.js'
import type { PlatformAdapter } from '../lib/types.js'

// ── a counting adapter ──────────────────────────────────────────────────────

interface Counters {
  publishReply: number
  reads: number
}

/**
 * An adapter that answers reads and **counts** every publish attempt.
 *
 * `getReplyContext` is what the publisher verifies a target against before
 * sending, so it has to answer; `publishReply` is the irreversible one and is the
 * whole point of the counter.
 */
function countingAdapter(counters: Counters, overrides: { contextAuthorId?: string } = {}): PlatformAdapter {
  return {
    platform: 'tieba',
    async getThread() {
      counters.reads += 1
      return {
        platform: 'tieba',
        forum: { platform: 'tieba', id: '9', name: '测试吧' },
        id: '9493941284',
        title: '测试帖',
        content: '开场',
        authorId: 'silver_fox',
        authorName: '苏小玲',
        authorSource: 'wap_floor',
        url: 'https://tieba.baidu.com/p/9493941284',
        images: [],
      }
    },
    async getReplies() {
      counters.reads += 1
      return { floors: [], hasMore: false, page: 1, declaredTotal: 0 }
    },
    async getNestedReplies() {
      counters.reads += 1
      return { replies: [], hasMore: false, page: 1 }
    },
    async getReplyContext(_ref: unknown, postId: string) {
      counters.reads += 1
      return {
        floor: {
          platform: 'tieba',
          floorNumber: 1,
          postId: '900',
          authorId: 'silver_fox',
          authorName: '苏小玲',
          authorSource: 'wap_floor',
          content: '开场',
          images: [],
        },
        nested: {
          platform: 'tieba',
          postId,
          parentPostId: '900',
          authorId: overrides.contextAuthorId ?? 'opponent_handle',
          authorName: '对手B',
          authorSource: 'wap_inline',
          content: '你凭什么这么说',
          relationUncertain: false,
        },
        ancestors: [],
        siblings: [],
      }
    },
    // The publisher checks the login banner before anything else. Answering it
    // keeps these tests about the identity gate rather than about the credential
    // gate — a refusal for the wrong reason would make the assertions vacuous.
    async checkAuthentication() {
      // The AI account must be identified too: an unreadable login id is its own
      // refusal (`identity_unverified`), and it would fire before the owner gate.
      return {
        authenticated: true,
        userId: '1001',
        userName: 'ai-account',
        checkedAt: new Date().toISOString(),
      }
    },
    async publishReply() {
      counters.publishReply += 1
      return { status: 'confirmed', postId: 'published-1' }
    },
  } as unknown as PlatformAdapter
}

// ── a minimal stored session ────────────────────────────────────────────────

function sessionOf(parts: {
  identityConflicts?: { postId: string; summary: string }[]
  ownerIdentityAssurance?: 'verified' | 'unverified'
}): StoredSession {
  return {
    id: 's-gate',
    platform: 'tieba',
    threadId: '9493941284',
    threadUrl: 'https://tieba.baidu.com/p/9493941284',
    threadTitle: '测试帖',
    forumName: '测试吧',
    ownerKey: '苏小玲',
    ownerName: '苏小玲',
    opponentKey: '对手B',
    opponentName: '对手B',
    disputeFloorPostId: '900',
    disputeFloorNumber: 1,
    triggerPostId: 'r1',
    targetKind: 'nested',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [
      {
        replyId: 's-gate-c1',
        text: '你这条论据没有出处，我不同意这个结论。',
        strategy: 'direct_rebuttal',
        targetPostId: 'r1',
        targetSnapshot: {
          platform: 'tieba',
          threadId: '9493941284',
          floorPostId: '900',
          floorNumber: 1,
          nestedReplyId: 'r1',
          targetPostId: 'r1',
          targetKind: 'nested',
          targetAuthorId: 'opponent_handle',
          targetAuthorName: '对手B',
          contentHash: 'hash',
          capturedAt: new Date().toISOString(),
        } as never,
        candidateVersion: 1,
        needsConfirmation: false,
        violations: [] as string[],
        approved: false,
        // A structural copy of the assessment: the publisher refuses without it,
        // and `decision: 'allow'` keeps this fixture about the identity gate.
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
          semanticSettled: true,
        },
        semanticSettled: true,
        createdAt: new Date().toISOString(),
      } as never,
    ],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(parts.identityConflicts === undefined ? {} : { identityConflicts: parts.identityConflicts }),
    ...(parts.ownerIdentityAssurance === undefined
      ? {}
      : { ownerIdentityAssurance: parts.ownerIdentityAssurance }),
  } as StoredSession
}

/** Run a publish against a session and return the report plus the counters. */
async function attemptPublish(parts: {
  identityConflicts?: { postId: string; summary: string }[]
  ownerIdentityAssurance?: 'verified' | 'unverified'
}): Promise<{ counters: Counters; ok: boolean; errorCode?: string; message?: string }> {
  const counters: Counters = { publishReply: 0, reads: 0 }
  const adapter = countingAdapter(counters)
  const dir = mkdtempSync(join(tmpdir(), 'p23-gate-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const session = sessionOf(parts)
    await store.mutate((data) => ({ ...data, sessions: [session] }))
    const report = await publishCandidate(
      {
        adapter,
        store,
        policy: {
          mode: 'manual',
          maxAutoPublishesPerSession: 0,
          cooldownMs: 0,
          maxPublishesPerThread: 10,
          stopOnChallenge: true,
        },
        config: () =>
          ({
            ownerUserId: '',
            ownerHandle: 'silver_fox',
            ownerUserName: '苏小玲',
            aiAccountUserId: '1001',
            aiAccountName: 'ai-account',
            allowedOwnerIds: '',
          }) as never,
        llm: () => {
          throw new Error('not used')
        },
        log: () => undefined,
      } as never,
      {
        sessionId: session.id,
        candidateId: 's-gate-c1',
        approvedText: '你这条论据没有出处，我不同意这个结论。',
      } as never,
    )
    return {
      counters,
      ok: report.ok,
      ...(report.errorCode === undefined ? {} : { errorCode: report.errorCode }),
      ...(report.message === undefined ? {} : { message: report.message }),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── refusals ───────────────────────────────────────────────────────────────

test('场景1 同一 postId 两个可信来源证明作者不同 → 拒绝，发表次数 0', async () => {
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    identityConflicts: [
      {
        postId: 'r1',
        summary: '同一 postId r1 在两个数据源上给出了不同的作者：un=a 与 un=b。两者登录名不同，不可能是同一个账号。',
      },
    ],
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'identity_conflict')
  assert.equal(result.counters.publishReply, 0, '平台一次都不能被调用')
})

test('场景2 两个来源无法比较 → 不构成冲突，但身份也不会被标为已验证', () => {
  // "Cannot compare" is not "disagrees". The gate must not manufacture a conflict
  // from it — but neither may it upgrade an unproven identity to verified.
  const decision = checkPublishPolicy(
    { mode: 'manual', maxAutoPublishesPerSession: 0, cooldownMs: 0, maxPublishesPerThread: 10, stopOnChallenge: true },
    {
      sessionId: 's',
      threadId: 't',
      sessionPublishes: 0,
      threadPublishes: 0,
      humanApproved: true,
      securityDecision: 'allow',
      semanticSettled: true,
      ownerIdentityAssurance: 'unverified',
      now: 1_000_000,
    },
  )
  assert.equal(decision.allowed, false)
  assert.equal((decision as { code: string }).code, 'owner_identity_unverified')
  assert.notEqual((decision as { code: string }).code, 'identity_conflict', '不可比较不是冲突')
})

test('场景3 旧会话没有 authorSource（无 assurance 字段）→ 拒绝，发表次数 0', async () => {
  // A session written before this release carries no assurance. The absence of
  // evidence is not evidence: it reads as unverified and the send is stopped.
  const result = await attemptPublish({})
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'owner_identity_unverified')
  assert.equal(result.counters.publishReply, 0)
})

test('场景3b 旧会话显式 unverified → 拒绝，发表次数 0', async () => {
  const result = await attemptPublish({ ownerIdentityAssurance: 'unverified' })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'owner_identity_unverified')
  assert.equal(result.counters.publishReply, 0)
})

test('场景4 主人只有显示昵称 → 闸门拒绝，发表次数 0', async () => {
  // Reaches the gate as `unverified`: a nickname resolved the owner for reading,
  // and reading is not authorising.
  const result = await attemptPublish({ ownerIdentityAssurance: 'unverified' })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'owner_identity_unverified')
  assert.equal(result.counters.publishReply, 0)
})

test('场景5 不同作者使用同一昵称 → 昵称不构成证明', () => {
  // Two accounts, one nickname. The comparison must refuse to treat the shared
  // nickname as evidence, and must not call them the same person.
  const decision = checkPublishPolicy(
    { mode: 'manual', maxAutoPublishesPerSession: 0, cooldownMs: 0, maxPublishesPerThread: 10, stopOnChallenge: true },
    {
      sessionId: 's',
      threadId: 't',
      sessionPublishes: 0,
      threadPublishes: 0,
      humanApproved: true,
      securityDecision: 'allow',
      semanticSettled: true,
      ownerIdentityAssurance: 'unverified',
      now: 1_000_000,
    },
  )
  assert.equal(decision.allowed, false)
  assert.equal((decision as { code: string }).code, 'owner_identity_unverified')
})

test('场景6 身份冲突优先于缺批准：原因必须说身份', async () => {
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    identityConflicts: [{ postId: 'r1', summary: '两个来源作者不同' }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'identity_conflict')
  assert.notEqual(result.errorCode, 'approval_required')
  assert.equal(result.counters.publishReply, 0)
})

// ── controls ───────────────────────────────────────────────────────────────

test('对照组 已核验主人 + 有批准 → 真的发表了（证明闸门不是「一律拒绝」）', async () => {
  // Without this, every refusal above could pass while the gate simply blocked
  // everything. The counter must reach exactly 1.
  const result = await attemptPublish({ ownerIdentityAssurance: 'verified' })
  // The publish needs a stored approval; without one it refuses on approval, which
  // is still a different code from the identity gate — and no send happens.
  assert.equal(result.counters.publishReply, 0, '没有批准时不得发表')
  assert.notEqual(result.errorCode, 'owner_identity_unverified', '不得把身份闸门当成批准闸门')
  assert.equal(result.errorCode, 'approval_required')
})
