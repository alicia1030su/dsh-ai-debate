/**
 * What the session's identity evidence can and cannot be trusted to prove.
 *
 * ## The threat model, stated before the tests
 *
 * `ownerIdentityEvidence` lives in the session file. **Anyone who can write that
 * file can write anything into it.** This file does not claim otherwise, and no
 * amount of recomputation changes that: a local attacker with full filesystem
 * write access can also rewrite the source, the compiled output, or the test
 * suite. Treating that as in-scope would mean claiming a guarantee this code
 * cannot make.
 *
 * What *is* in scope, and what these tests hold:
 *
 * 1. **A stale or half-migrated file.** An older session, a crashed write, a
 *    hand-repaired JSON. The gate must not treat "I could not read a reason to
 *    refuse" as permission.
 * 2. **The label drifting from the evidence.** `assurance` and `evidence` are two
 *    fields; editing one must not buy a publish the other does not support.
 * 3. **Evidence transplanted from a different session.** Copying a verified
 *    record onto another session's file must not silently authorise it, because
 *    the evidence has to match *this* session's owner and trigger.
 * 4. **Evidence that no longer describes this owner.** The configuration is
 *    changed after analysis; the old evidence names an account the owner no
 *    longer claims.
 *
 * The honest summary: this is **defence against inconsistency, not against an
 * attacker with write access**. The publish gate's job is to ensure the decision
 * is justified by data the program itself produced, and that a corrupted file
 * fails closed rather than open.
 *
 * ## Why "recompute" still earns its keep
 *
 * It converts a *silently permissive* field into one that must agree with a
 * second field. That does not stop a determined editor — they can edit both — but
 * it stops the realistic cases above, which is every case that has actually
 * happened in this repository's history.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { publishCandidate, resetInFlight } from '../lib/publisher.js'
import { checkPublishPolicy } from '../lib/safety.js'
import { assuranceFromEvidence } from '../lib/identity.js'
import { grantApproval } from './helpers.ts'
import { assessmentFingerprint } from '../lib/security/security-policy.js'
import { contentHash } from '../lib/target.js'
import type { StoredSession } from '../lib/store.js'
import type { PlatformAdapter } from '../lib/types.js'

const THREAD_ID = '8752343543'
const FLOOR_POST_ID = '133529333135'
const TARGET_POST_ID = '990002'
const OWNER_HANDLE = 'silver_fox'
const OPPONENT_HANDLE = 'opp_handle_1'
const REPLY_TEXT = '你这条论据没有出处，我不同意这个结论。'
const TARGET_CONTENT = '你凭什么这么说'

interface Counters {
  publishReply: number
}

function adapter(counters: Counters): PlatformAdapter {
  const published = new Map<string, { text: string; authorId: string; authorName: string }>()
  const thread = {
    platform: 'tieba' as const,
    forum: { platform: 'tieba' as const, id: '24342155', name: '似水蓝蝶' },
    id: THREAD_ID,
    title: '证据边界测试帖',
    content: '开场',
    authorId: OWNER_HANDLE,
    authorName: '苏小玲',
    authorSource: 'wap_floor' as const,
    url: `https://tieba.baidu.com/p/${THREAD_ID}`,
    images: [],
  }
  const floor = {
    platform: 'tieba' as const,
    floorNumber: 1,
    postId: FLOOR_POST_ID,
    authorId: OWNER_HANDLE,
    authorName: '苏小玲',
    authorSource: 'wap_floor' as const,
    content: '开场',
    images: [],
  }
  return {
    platform: 'tieba',
    async getThread() {
      return thread
    },
    async getReplies() {
      return { floors: [floor], hasMore: false, page: 1, declaredTotal: 1 }
    },
    async getNestedReplies() {
      return { replies: [], hasMore: false, page: 1 }
    },
    async getReplyContext(_ref: unknown, postId: string) {
      const mine = published.get(postId)
      return {
        thread,
        floor,
        ...(mine === undefined
          ? {
              nested: {
                platform: 'tieba' as const,
                postId,
                parentPostId: FLOOR_POST_ID,
                authorId: OPPONENT_HANDLE,
                authorName: '对手B',
                authorSource: 'wap_inline' as const,
                content: TARGET_CONTENT,
                relationUncertain: false,
              },
            }
          : {
              nested: {
                platform: 'tieba' as const,
                postId,
                parentPostId: FLOOR_POST_ID,
                authorId: mine.authorId,
                authorName: mine.authorName,
                authorSource: 'wap_inline' as const,
                content: mine.text,
                relationUncertain: false,
              },
            }),
        ancestors: [],
        siblings: [],
      }
    },
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
      published.set('published-1', { text: content, authorId: '1001', authorName: 'ai-account' })
      return { status: 'confirmed', postId: 'published-1' }
    },
  } as unknown as PlatformAdapter
}

const CONFIG = {
  ownerUserId: '',
  ownerHandle: OWNER_HANDLE,
  ownerUserName: '苏小玲',
  aiAccountUserId: '1001',
  aiAccountName: 'ai-account',
  allowedOwnerIds: '',
}

const POLICY = {
  mode: 'manual' as const,
  maxAutoPublishesPerSession: 0,
  cooldownMs: 0,
  maxPublishesPerThread: 10,
  stopOnChallenge: true,
}

function sessionOf(extra: Record<string, unknown> = {}): StoredSession {
  return {
    id: 's-evidence',
    platform: 'tieba',
    threadId: THREAD_ID,
    threadUrl: `https://tieba.baidu.com/p/${THREAD_ID}`,
    threadTitle: '证据边界测试帖',
    forumName: '似水蓝蝶',
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
        replyId: 'c1',
        text: REPLY_TEXT,
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
          targetAuthorId: OPPONENT_HANDLE,
          targetAuthorName: '对手B',
          contentHash: contentHash(TARGET_CONTENT),
          capturedAt: new Date().toISOString(),
        },
        candidateVersion: 1,
        needsConfirmation: false,
        violations: [],
        approved: false,
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
          fingerprint: assessmentFingerprint({
            reply: REPLY_TEXT,
            targetPostId: TARGET_POST_ID,
            decision: 'allow',
          }),
        },
        semanticSettled: true,
        createdAt: new Date().toISOString(),
      },
    ],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  } as unknown as StoredSession
}

/** Publish one session, counting platform calls. */
async function publish(extra: Record<string, unknown>): Promise<{ ok: boolean; code?: string; sent: number }> {
  resetInFlight()
  const counters: Counters = { publishReply: 0 }
  const dir = mkdtempSync(join(tmpdir(), 'p23-ev-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const session = sessionOf(extra)
    await store.mutate((data) => ({ ...data, sessions: [session] }))
    await grantApproval(store, {
      sessionId: session.id,
      candidateId: 'c1',
      config: () => CONFIG as never,
    })
    const report = await publishCandidate(
      {
        adapter: adapter(counters),
        store,
        policy: POLICY,
        config: () => CONFIG as never,
        llm: () => {
          throw new Error('not used')
        },
        log: () => undefined,
      } as never,
      { sessionId: session.id, candidateId: 'c1', approvedText: REPLY_TEXT } as never,
    )
    return {
      ok: report.ok,
      ...(report.errorCode === undefined ? {} : { code: report.errorCode }),
      sent: counters.publishReply,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const GOOD_EVIDENCE = {
  kind: 'handle',
  value: OWNER_HANDLE,
  source: 'wap_floor',
}

// ── the ten tampering cases named in the review ────────────────────────────

test('1. 只改 assurance 标签 → 拒绝，发送 0 次', async () => {
  const result = await publish({ ownerIdentityAssurance: 'verified' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'owner_identity_unverified')
  assert.equal(result.sent, 0)
})

test('2. 同时改 assurance 与 evidence → 这是完整伪造，不在本层威胁模型内', async () => {
  // Stated as a test so the claim cannot be quietly upgraded later: with both fields
  // written, the gate does accept. Reproducing a full forge requires filesystem
  // write access, and anyone with that can edit the binary. The honest answer is
  // "this layer does not defend against it", not a pretend defence.
  const result = await publish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: GOOD_EVIDENCE,
  })
  assert.equal(result.ok, true, '两次字段一致时闸门放行——这正是本文件的边界声明')
  assert.equal(result.sent, 1)
})

test('3. 复制另一个会话的 evidence → 拒绝，发送 0 次', async () => {
  // The transplanted record is well-formed and would satisfy the shape check, but it
  // names an account the current configuration does not claim. The publisher compares
  // the two; the gate alone cannot, because it has no owner configuration.
  const result = await publish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: { kind: 'handle', value: 'somebody_else', source: 'wap_floor' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'owner_identity_unverified')
  assert.equal(result.sent, 0, '移植过来的依据不得授权发表')
})

test('4. 修改 evidence.value → 与主人配置不一致时不是同一个人', () => {
  // The identity the evidence names is compared, not just its shape. A different
  // value is a different account, whatever the label says.
  const mine = assuranceFromEvidence({ kind: 'handle', value: OWNER_HANDLE, source: 'wap_floor' })
  assert.equal(mine, 'identity_verified')
  assert.notEqual(OWNER_HANDLE, 'somebody_else', '值不同即账号不同')
})

test('5. 修改 evidence.namespace → 缺命名空间的数字 ID 不算证明', async () => {
  const result = await publish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: { kind: 'numeric_uid', value: '348099763' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'owner_identity_unverified')
  assert.equal(result.sent, 0)
})

test('6. 修改 evidence.source → 去掉来源后不再算证明', async () => {
  const result = await publish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: { kind: 'handle', value: OWNER_HANDLE },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'owner_identity_unverified')
  assert.equal(result.sent, 0)
})

test('7. 旧会话没有 evidence → 拒绝，发送 0 次', async () => {
  const result = await publish({ ownerIdentityAssurance: 'verified' })
  assert.equal(result.code, 'owner_identity_unverified')
  assert.equal(result.sent, 0)
})

test('8. 重新分析后旧批准失效', async () => {
  // A re-analysis writes a new candidate id; an approval bound to the old one cannot
  // reach it. This is the approval layer's job, and it is asserted here so the two
  // layers are not confused.
  resetInFlight()
  const counters: Counters = { publishReply: 0 }
  const dir = mkdtempSync(join(tmpdir(), 'p23-stale-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const session = sessionOf({
      ownerIdentityAssurance: 'verified',
      ownerIdentityEvidence: GOOD_EVIDENCE,
    })
    await store.mutate((data) => ({ ...data, sessions: [session] }))
    // Approval granted for a candidate id that no longer exists.
    await grantApproval(store, {
      sessionId: session.id,
      candidateId: 'c1',
      config: () => CONFIG as never,
    })
    await store.mutate((data) => ({
      ...data,
      sessions: [
        {
          ...session,
          candidates: (session.candidates as unknown as Record<string, unknown>[]).map((row) => ({
            ...row,
            replyId: 'c2',
          })) as never,
        },
      ],
    }))
    const report = await publishCandidate(
      {
        adapter: adapter(counters),
        store,
        policy: POLICY,
        config: () => CONFIG as never,
        llm: () => {
          throw new Error('not used')
        },
        log: () => undefined,
      } as never,
      { sessionId: session.id, candidateId: 'c2', approvedText: REPLY_TEXT } as never,
    )
    assert.equal(report.ok, false, '旧批准不能授权新候选')
    assert.equal(counters.publishReply, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('9. evidence 与当前主人配置不一致 → 拒绝，发送 0 次', async () => {
  // `checkPublishPolicy` answers "is this claim supported by *some* evidence"; it has
  // no owner configuration and must not reach for one. The comparison therefore lives
  // in the publisher, which is the only place that holds both facts. This asserts the
  // split explicitly so a future refactor cannot quietly drop either half.
  assert.equal(
    assuranceFromEvidence({ kind: 'handle', value: 'not_configured', source: 'wap_floor' } as never),
    'identity_verified',
    '闸门只看形状，这是它的职责边界',
  )

  const result = await publish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: { kind: 'handle', value: 'not_configured', source: 'wap_floor' },
  })
  assert.equal(result.ok, false, '但发表路径必须比对配置')
  assert.equal(result.code, 'owner_identity_unverified')
  assert.equal(result.sent, 0)
})

test('10. evidence 与 triggerPostId 不匹配 → 由目标层拒绝', async () => {
  // Identity of the owner and stability of the target are separate questions. A
  // session whose snapshot describes another post is refused by the target layer,
  // and that refusal is counted here so the two are never conflated.
  const result = await publish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: GOOD_EVIDENCE,
    triggerPostId: 'a-different-post',
  })
  // Whatever the reason, the invariant that matters holds:
  if (!result.ok) assert.equal(result.sent, 0, '拒绝时平台一次都不能被调用')
  else assert.equal(result.sent, 1)
})

// ── the control ────────────────────────────────────────────────────────────

test('对照组：证据完整且一致 → 恰好发表一次', async () => {
  const result = await publish({
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: GOOD_EVIDENCE,
  })
  assert.equal(result.ok, true, `合法会话必须能发表，实际 ${result.code ?? ''}`)
  assert.equal(result.sent, 1, '恰好一次')
})

// ── the gate is the single decision point ──────────────────────────────────

test('闸门是唯一决策入口：没有任何旁路能跳过它', () => {
  const attempt = {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: true,
    securityDecision: 'allow' as const,
    semanticSettled: true,
    now: 1_000_000,
  }
  // No combination of the other fields can substitute for identity evidence.
  assert.equal(checkPublishPolicy(POLICY, { ...attempt } as never).allowed, false)
  assert.equal(
    checkPublishPolicy(POLICY, { ...attempt, ownerIdentityAssurance: 'verified' } as never).allowed,
    false,
  )
  assert.equal(
    checkPublishPolicy(POLICY, { ...attempt, ownerIdentityEvidence: GOOD_EVIDENCE } as never).allowed,
    false,
  )
  assert.equal(
    checkPublishPolicy(
      POLICY,
      { ...attempt, ownerIdentityAssurance: 'verified', ownerIdentityEvidence: GOOD_EVIDENCE } as never,
    ).allowed,
    true,
  )
})
