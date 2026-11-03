/**
 * The publish gate, both directions, counted.
 *
 * ## Why this file exists in this shape
 *
 * v0.2.23's first pass proved the gate says *no* — and stopped there. A gate that
 * only ever says no is not safe, it is broken: the product cannot do its job, and
 * the "tests" pass while nothing works. This file pins both halves:
 *
 * - every refusal asserts `publishReply` was called **zero** times, because a
 *   refusal that still sends is not a refusal;
 * - the success case asserts it was called **exactly once**, because otherwise
 *   every refusal above could be the gate blocking everything.
 *
 * ## Evidence, not labels
 *
 * Sessions state *what was observed* (`ownerIdentityEvidence`), not just a
 * verdict. The gate recomputes from the evidence, so a session edited to claim
 * `verified` without proof is refused exactly like an honest `unverified`.
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
import { publishCandidate, resetInFlight } from '../lib/publisher.js'
import { checkPublishPolicy } from '../lib/safety.js'
import { contentHash } from '../lib/target.js'
import { assessmentFingerprint } from '../lib/security/security-policy.js'
import { grantApproval } from './helpers.ts'
import type { StoredSession } from '../lib/store.js'
import type { PlatformAdapter } from '../lib/types.js'

// ── a counting adapter ──────────────────────────────────────────────────────

interface Counters {
  publishReply: number
  reads: number
}

const OPPONENT_HANDLE = 'opp_handle_1'
const OWNER_HANDLE = 'silver_fox'
const THREAD_ID = '9493941284'
const FLOOR_POST_ID = '151679645842'
const TARGET_POST_ID = '151694781657'
const REPLY_TEXT = '你这条论据没有出处，我不同意这个结论。'
/** The target's text, as the fixture adapter reports it on every re-read. */
const TARGET_CONTENT = '你凭什么这么说'

/**
 * An adapter that answers reads and **counts** every publish attempt.
 *
 * `getReplyContext` is what the publisher verifies a target against before
 * sending, so it has to answer; `publishReply` is the irreversible one and is the
 * whole point of the counter.
 */
function countingAdapter(
  counters: Counters,
  overrides: { contextAuthorId?: string } = {},
): PlatformAdapter {
  /**
   * Text of the post this adapter last "published", keyed by the id it returned.
   *
   * The publisher reads the reply back after sending and compares both the body and
   * the author. A fake that answered every post id with the *target's* content would
   * fail that comparison on every successful send — a fixture artefact, not a real
   * mismatch, which would make the positive path untestable.
   */
  const published = new Map<string, { text: string; authorId: string; authorName: string }>()

  return {
    platform: 'tieba',
    async getThread() {
      counters.reads += 1
      return {
        platform: 'tieba',
        forum: { platform: 'tieba', id: '9', name: '测试吧' },
        id: THREAD_ID,
        title: '测试帖',
        content: '开场',
        authorId: OWNER_HANDLE,
        authorName: '苏小玲',
        authorSource: 'wap_floor',
        url: `https://tieba.baidu.com/p/${THREAD_ID}`,
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
      const mine = published.get(postId)
      if (mine !== undefined) {
        // What the platform would show for the reply we just sent: its text, and the
        // account that posted it.
        return {
          thread: {
            platform: 'tieba',
            forum: { platform: 'tieba', id: '9', name: '测试吧' },
            id: THREAD_ID,
            title: '测试帖',
            content: '开场',
            authorId: OWNER_HANDLE,
            authorName: '苏小玲',
            authorSource: 'wap_floor',
            url: `https://tieba.baidu.com/p/${THREAD_ID}`,
            images: [],
          },
          floor: {
            platform: 'tieba',
            floorNumber: 1,
            postId: FLOOR_POST_ID,
            authorId: OWNER_HANDLE,
            authorName: '苏小玲',
            authorSource: 'wap_floor',
            content: '开场',
            images: [],
          },
          nested: {
            platform: 'tieba',
            postId,
            // The reply hangs off the floor, not off the post it answers.
            parentPostId: FLOOR_POST_ID,
            authorId: mine.authorId,
            authorName: mine.authorName,
            authorSource: 'wap_inline',
            content: mine.text,
            relationUncertain: false,
          },
          ancestors: [],
          siblings: [],
        }
      }
      return {
        // `resolveTarget` checks that the post still belongs to the thread we think
        // it does, so the context has to carry the thread itself.
        thread: {
          platform: 'tieba',
          forum: { platform: 'tieba', id: '9', name: '测试吧' },
          id: THREAD_ID,
          title: '测试帖',
          content: '开场',
          authorId: OWNER_HANDLE,
          authorName: '苏小玲',
          authorSource: 'wap_floor',
          url: `https://tieba.baidu.com/p/${THREAD_ID}`,
          images: [],
        },
        floor: {
          platform: 'tieba',
          floorNumber: 1,
          postId: FLOOR_POST_ID,
          authorId: OWNER_HANDLE,
          authorName: '苏小玲',
          authorSource: 'wap_floor',
          content: '开场',
          images: [],
        },
        nested: {
          platform: 'tieba',
          postId,
          parentPostId: FLOOR_POST_ID,
          authorId: overrides.contextAuthorId ?? OPPONENT_HANDLE,
          authorName: '对手B',
          // A declared surface is what makes a handle count as evidence.
          authorSource: 'wap_inline',
          content: TARGET_CONTENT,
          relationUncertain: false,
        },
        ancestors: [],
        siblings: [],
      }
    },
    // The publisher checks the login banner before anything else. Answering it
    // keeps these tests about identity rather than the credential gate.
    async checkAuthentication() {
      return {
        authenticated: true,
        userId: '1001',
        userName: 'ai-account',
        checkedAt: new Date().toISOString(),
      }
    },
    async publishReply(_target: unknown, content: string) {
      counters.publishReply += 1
      const postId = 'published-1'
      published.set(postId, { text: content, authorId: '1001', authorName: 'ai-account' })
      return { status: 'confirmed', postId }
    },
  } as unknown as PlatformAdapter
}

// ── a minimal stored session ────────────────────────────────────────────────

type Evidence = {
  kind: 'numeric_uid' | 'handle' | 'nickname' | 'legacy' | 'none'
  namespace?: 'user_id' | 'tieba_uid'
  value?: string
  source?: string
}

/** The evidence a legitimately verified owner carries: a handle, and its surface. */
const VERIFIED_EVIDENCE: Evidence = {
  kind: 'handle',
  value: OWNER_HANDLE,
  source: 'wap_floor',
}

function sessionOf(parts: {
  identityConflicts?: { postId: string; summary: string }[]
  ownerIdentityAssurance?: 'verified' | 'unverified'
  ownerIdentityEvidence?: Evidence
  text?: string
  targetAuthorId?: string
  candidateVersion?: number
}): StoredSession {
  const text = parts.text ?? REPLY_TEXT
  return {
    id: 's-gate',
    platform: 'tieba',
    threadId: THREAD_ID,
    threadUrl: `https://tieba.baidu.com/p/${THREAD_ID}`,
    threadTitle: '测试帖',
    forumName: '测试吧',
    ownerKey: '苏小玲',
    ownerName: '苏小玲',
    opponentKey: '对手B',
    opponentName: '对手B',
    opponentUserId: OPPONENT_HANDLE,
    disputeFloorPostId: FLOOR_POST_ID,
    disputeFloorNumber: 1,
    triggerPostId: TARGET_POST_ID,
    targetKind: 'nested',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [
      {
        replyId: 's-gate-c1',
        text,
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
          targetAuthorId: parts.targetAuthorId ?? OPPONENT_HANDLE,
          targetAuthorName: '对手B',
          // The real digest of what the adapter will report on re-read. A
          // placeholder here made every publish look like the target had changed.
          contentHash: contentHash(TARGET_CONTENT),
          capturedAt: new Date().toISOString(),
        } as never,
        candidateVersion: parts.candidateVersion ?? 1,
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
          // The approval is bound to this digest, which the publisher recomputes
          // from the text it is about to send. Stating the real value keeps the
          // approval meaningful instead of stubbing the comparison out.
          fingerprint: assessmentFingerprint({
            reply: text,
            targetPostId: TARGET_POST_ID,
            decision: 'allow',
          }),
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
    ...(parts.ownerIdentityEvidence === undefined
      ? {}
      : { ownerIdentityEvidence: parts.ownerIdentityEvidence }),
  } as StoredSession
}

const POLICY = {
  mode: 'manual' as const,
  maxAutoPublishesPerSession: 0,
  cooldownMs: 0,
  maxPublishesPerThread: 10,
  stopOnChallenge: true,
}

/**
 * Run a publish and return the report plus the counter.
 *
 * `grantApproval` is called first because the stored approval is what authorises
 * a send; a test that skipped it would be measuring the approval gate instead.
 */
async function attemptPublish(parts: {
  identityConflicts?: { postId: string; summary: string }[]
  ownerIdentityAssurance?: 'verified' | 'unverified'
  ownerIdentityEvidence?: Evidence
  text?: string
  targetAuthorId?: string
  /** Skip the approval, to prove the identity gate answers independently. */
  withoutApproval?: boolean
  /**
   * Text the human approved, when it should differ from the candidate's.
   *
   * Editing the candidate *and* approving the edit is not a stale approval; the
   * interesting case is an approval that refers to text no longer in the session.
   */
  approvedText?: string
}): Promise<{ counters: Counters; ok: boolean; errorCode?: string; message?: string }> {
  resetInFlight()
  const counters: Counters = { publishReply: 0, reads: 0 }
  const adapter = countingAdapter(counters)
  const dir = mkdtempSync(join(tmpdir(), 'p23-gate-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const session = sessionOf(parts)
    await store.mutate((data) => ({ ...data, sessions: [session] }))

    const config = {
      ownerUserId: '',
      ownerHandle: OWNER_HANDLE,
      ownerUserName: '苏小玲',
      aiAccountUserId: '1001',
      aiAccountName: 'ai-account',
      allowedOwnerIds: '',
    }

    if (parts.withoutApproval !== true) {
      await grantApproval(store, {
        sessionId: session.id,
        candidateId: 's-gate-c1',
        ...(parts.approvedText === undefined ? {} : { text: parts.approvedText }),
        // `grantApproval` takes a *resolver*, not the config object: it needs to
        // read the per-platform table the publish path will use.
        config: () => config as never,
      })
    }

    const report = await publishCandidate(
      {
        adapter,
        store,
        policy: POLICY,
        config: () => config as never,
        llm: () => {
          throw new Error('not used')
        },
        log: () => undefined,
      } as never,
      {
        sessionId: session.id,
        candidateId: 's-gate-c1',
        approvedText: parts.approvedText ?? parts.text ?? REPLY_TEXT,
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

// ── the positive path ──────────────────────────────────────────────────────

test('正向：身份已核验 + 批准有效 + 目标稳定 → 恰好发表一次', async () => {
  // Every precondition of a legitimate send, stated so the test would fail if any
  // of them were quietly dropped:
  //
  // - owner verified with *evidence* (a handle and the surface that declared it)
  // - AI account identified (`checkAuthentication` returns a matching uid)
  // - target postId stable, and its author unchanged since the snapshot
  // - candidate text untampered, version current
  // - a stored approval that matches this exact text
  // - policy allows manual mode, quota and cooldown satisfied
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: VERIFIED_EVIDENCE,
  })

  assert.equal(result.ok, true, `合法候选必须能发表，实际：${result.errorCode ?? ''} ${result.message ?? ''}`)
  assert.equal(result.counters.publishReply, 1, '恰好发表一次')
})

test('正向：重复提交同一候选不会二次发表', async () => {
  resetInFlight()
  const counters: Counters = { publishReply: 0, reads: 0 }
  const adapter = countingAdapter(counters)
  const dir = mkdtempSync(join(tmpdir(), 'p23-twice-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({
      ...data,
      sessions: [
        sessionOf({
          ownerIdentityAssurance: 'verified',
          ownerIdentityEvidence: VERIFIED_EVIDENCE,
        }),
      ],
    }))
    const config = {
      ownerUserId: '',
      ownerHandle: OWNER_HANDLE,
      ownerUserName: '苏小玲',
      aiAccountUserId: '1001',
      aiAccountName: 'ai-account',
      allowedOwnerIds: '',
    }
    await grantApproval(store, {
      sessionId: 's-gate',
      candidateId: 's-gate-c1',
      config: () => config as never,
    })

    const deps = {
      adapter,
      store,
      policy: POLICY,
      config: () => config as never,
      llm: () => {
        throw new Error('not used')
      },
      log: () => undefined,
    } as never
    const request = {
      sessionId: 's-gate',
      candidateId: 's-gate-c1',
      approvedText: REPLY_TEXT,
    } as never

    const first = await publishCandidate(deps, request)
    assert.equal(first.ok, true, `首次应成功：${first.errorCode ?? ''} ${first.message ?? ''}`)
    assert.equal(counters.publishReply, 1)

    const second = await publishCandidate(deps, request)
    assert.equal(second.ok, false, '第二次不得重复发表')
    assert.equal(counters.publishReply, 1, '平台仍只被调用一次')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── refusals: each asserts zero sends ──────────────────────────────────────

test('拒绝1 身份冲突 → identity_conflict，发送 0 次', async () => {
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: VERIFIED_EVIDENCE,
    identityConflicts: [
      {
        postId: TARGET_POST_ID,
        summary: '同一 postId 在两个数据源上给出了不同的作者：un=a 与 un=b。',
      },
    ],
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'identity_conflict')
  assert.equal(result.counters.publishReply, 0)
})

test('拒绝2 身份冲突不能靠人工批准解除', async () => {
  // The approval is granted inside `attemptPublish`; the conflict must still win.
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: VERIFIED_EVIDENCE,
    identityConflicts: [{ postId: TARGET_POST_ID, summary: '两个来源作者不同' }],
  })
  assert.equal(result.errorCode, 'identity_conflict')
  assert.notEqual(result.errorCode, 'approval_required', '原因必须是身份，不是缺批准')
  assert.equal(result.counters.publishReply, 0)
})

test('拒绝3 只有标签没有证据（手改 session）→ 拒绝，发送 0 次', async () => {
  // The reproduced bypass: edit `"unverified"` to `"verified"` in the state file.
  // The label alone must not open the gate.
  const result = await attemptPublish({ ownerIdentityAssurance: 'verified' })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'owner_identity_unverified')
  assert.equal(result.counters.publishReply, 0)
})

test('拒绝4 证据是昵称 → 拒绝，发送 0 次', async () => {
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: { kind: 'nickname', value: '苏小玲' },
  })
  assert.equal(result.errorCode, 'owner_identity_unverified')
  assert.equal(result.counters.publishReply, 0)
})

test('拒绝5 数字 UID 缺命名空间 → 拒绝，发送 0 次', async () => {
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: { kind: 'numeric_uid', value: '348099763' },
  })
  assert.equal(result.errorCode, 'owner_identity_unverified')
  assert.equal(result.counters.publishReply, 0)
})

test('拒绝6 登录名缺来源 → 拒绝，发送 0 次', async () => {
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: { kind: 'handle', value: OWNER_HANDLE },
  })
  assert.equal(result.errorCode, 'owner_identity_unverified')
  assert.equal(result.counters.publishReply, 0)
})

test('拒绝7 旧会话无证据字段 → 拒绝，发送 0 次', async () => {
  const result = await attemptPublish({})
  assert.equal(result.errorCode, 'owner_identity_unverified')
  assert.equal(result.counters.publishReply, 0)
})

test('拒绝8 正文被改 → 批准失效，发送 0 次', async () => {
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: VERIFIED_EVIDENCE,
    text: '我改了一句话，但用的是旧批准。',
    approvedText: REPLY_TEXT,
  })
  assert.equal(result.ok, false)
  assert.equal(result.counters.publishReply, 0, '改过正文后不得发送')
})

test('拒绝9 目标作者变了 → 拒绝，发送 0 次', async () => {
  const result = await attemptPublish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: VERIFIED_EVIDENCE,
    targetAuthorId: 'somebody_else',
  })
  assert.equal(result.ok, false)
  assert.equal(result.counters.publishReply, 0)
})

// ── the policy matrix, without the publisher ───────────────────────────────

test('闸门矩阵：标签与证据必须同时成立', () => {
  const base = {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: true,
    securityDecision: 'allow' as const,
    semanticSettled: true,
    now: 1_000_000,
  }
  const allow = (extra: Record<string, unknown>) =>
    checkPublishPolicy(POLICY, { ...base, ...extra } as never)

  // Claim without proof: refused.
  assert.equal(allow({ ownerIdentityAssurance: 'verified' }).allowed, false)
  assert.equal(
    allow({ ownerIdentityAssurance: 'verified', ownerIdentityEvidence: { kind: 'nickname' } }).allowed,
    false,
  )
  // Proof without a claim: also refused. Both halves are required.
  assert.equal(
    allow({ ownerIdentityEvidence: { kind: 'handle', value: 'x', source: 'wap_floor' } }).allowed,
    false,
  )
  // Both halves, handle path.
  assert.equal(
    allow({
      ownerIdentityAssurance: 'verified',
      ownerIdentityEvidence: { kind: 'handle', value: 'x', source: 'wap_floor' },
    }).allowed,
    true,
  )
  // Both halves, numeric path.
  assert.equal(
    allow({
      ownerIdentityAssurance: 'verified',
      ownerIdentityEvidence: { kind: 'numeric_uid', namespace: 'user_id', value: '1' },
    }).allowed,
    true,
  )
})
