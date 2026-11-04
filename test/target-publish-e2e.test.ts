/**
 * Picking a comment must change where the reply lands, and only once.
 *
 * v0.2.24 accepted a pick, analysed against it, and then published to the opponent's
 * newest post. These tests drive the real publish path (`publishCandidate`) with a
 * counting adapter, so "did it go where the owner pointed" is answered by what the
 * adapter was asked to do — not by a UI label.
 *
 * The fixtures mirror the shape `publishCandidate` actually reads: the target snapshot
 * lives on the *candidate*, not on the session, and the security fingerprint is the
 * real digest of the text being sent. Getting those wrong produces refusals that look
 * like security findings but are fixture mistakes, so they are built the long way.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { publishCandidate, resetInFlight } from '../lib/publisher.js'
import { contentHash } from '../lib/target.js'
import { assessmentFingerprint } from '../lib/security/security-policy.js'
import { grantApproval } from './helpers.ts'
import type { StoredSession } from '../lib/store.js'
import type { PlatformAdapter } from '../lib/types.js'

const THREAD_ID = '900'
const FLOOR_POST_ID = 'floor-1'
const TEXT = '这是一条准备好的回复正文。'

const POLICY = {
  mode: 'manual' as const,
  maxAutoPublishesPerSession: 0,
  cooldownMs: 0,
  maxPublishesPerThread: 10,
  stopOnChallenge: true,
}

const CONFIG = {
  ownerUserId: '',
  ownerHandle: 'owner',
  ownerUserName: '主人',
  aiAccountUserId: '1001',
  aiAccountName: 'ai-account',
  allowedOwnerIds: '',
}

interface Captured {
  target: { floorPostId?: string; nestedReplyId?: string; targetPostId?: string } | undefined
  content: string
}

function countingAdapter(readBackPostId = 'new-reply-id') {
  const calls: Captured[] = []
  const adapter = {
    platform: 'tieba',
    async checkAuthentication() {
      // The publish path verifies *who is speaking* against the configured AI
      // account. An adapter that only says "authenticated" leaves that check with
      // nothing to compare, and the publish is refused — correctly — as
      // `identity_unverified`. Reporting the same identity the fixture configures is
      // what makes this file about the target rather than about account binding.
      return { authenticated: true, userId: '1001', userName: 'ai-account' }
    },
    async publishReply(_ref: unknown, target: Captured['target'], content: string) {
      calls.push({ target, content })
      return { status: 'published', postId: readBackPostId }
    },
    async getNestedReplies() {
      return {
        replies: [
          {
            platform: 'tieba',
            postId: readBackPostId,
            parentPostId: FLOOR_POST_ID,
            authorName: 'ai-account',
            content: TEXT,
            relationUncertain: false,
          },
        ],
        hasMore: false,
        page: 1,
      }
    },
    async getReplyContext(_ref: unknown, postId: string) {
      // The publish path re-reads the exact post it is about to answer and checks the
      // author against the snapshot. Returning the fixture's own post is what makes
      // that check meaningful rather than skipped.
      const isFloor = postId.startsWith('floor-')
      return {
        thread: { platform: 'tieba', id: THREAD_ID, title: 't', content: 'c', url: 'u', images: [] },
        floor: {
          platform: 'tieba',
          floorNumber: 1,
          postId: isFloor ? postId : FLOOR_POST_ID,
          authorId: 'opponent-handle',
          authorName: '对手',
          content: isFloor ? '对手说的那句话' : '楼层正文',
          images: [],
        },
        ...(isFloor
          ? {}
          : {
              nested: {
                platform: 'tieba',
                postId,
                parentPostId: FLOOR_POST_ID,
                authorId: 'opponent-handle',
                authorName: '对手',
                content: '对手说的那句话',
                relationUncertain: false,
              },
            }),
        ancestors: [],
        siblings: [],
      }
    },
    async getReplies() {
      return { floors: [], hasMore: false, page: 1 }
    },
    async getThread() {
      return { platform: 'tieba', id: THREAD_ID, title: 't', content: 'c', url: 'u', images: [] }
    },
    getCapabilities() {
      return { 'comment.reply': 'supported', 'comment.publish': 'supported' }
    },
  }
  return { adapter: adapter as unknown as PlatformAdapter, calls }
}

function sessionOf(parts: {
  targetPostId?: string
  targetKind?: 'floor' | 'nested'
  floorPostId?: string
  ownerIdentityAssurance?: 'verified' | 'unverified'
  ownerIdentityEvidence?: unknown
} = {}): StoredSession {
  const targetPostId = parts.targetPostId ?? 'nested-7'
  const targetKind = parts.targetKind ?? 'nested'
  const floorPostId = parts.floorPostId ?? FLOOR_POST_ID

  return {
    id: 'sess-1',
    platform: 'tieba',
    threadId: THREAD_ID,
    threadUrl: `https://tieba.baidu.com/p/${THREAD_ID}`,
    threadTitle: '测试帖',
    forumName: '测试吧',
    ownerKey: 'owner',
    ownerName: '主人',
    opponentKey: '对手',
    opponentName: '对手',
    opponentUserId: 'opponent-handle',
    disputeFloorPostId: FLOOR_POST_ID,
    disputeFloorNumber: 1,
    triggerPostId: 'nested-7',
    targetKind,
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [
      {
        replyId: 'cand-1',
        text: TEXT,
        strategy: 'direct_rebuttal',
        targetPostId,
        targetSnapshot: {
          platform: 'tieba',
          threadId: THREAD_ID,
          floorPostId,
          floorNumber: 1,
          ...(targetKind === 'nested' ? { nestedReplyId: targetPostId } : {}),
          targetPostId,
          targetKind,
          targetAuthorId: 'opponent-handle',
          targetAuthorName: '对手',
          // The digest of what the adapter will report on re-read. A placeholder here
          // makes every publish look like the target moved.
          contentHash: contentHash('对手说的那句话'),
          capturedAt: new Date().toISOString(),
        },
        candidateVersion: 1,
        needsConfirmation: false,
        violations: [] as string[],
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
          reasons: [] as string[],
          semanticSettled: true,
          fingerprint: assessmentFingerprint({
            reply: TEXT,
            targetPostId,
            decision: 'allow',
          } as never),
        },
        semanticSettled: true,
        createdAt: new Date().toISOString(),
      },
    ],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(parts.ownerIdentityAssurance === undefined
      ? {}
      : { ownerIdentityAssurance: parts.ownerIdentityAssurance }),
    ...(parts.ownerIdentityEvidence === undefined
      ? {}
      : { ownerIdentityEvidence: parts.ownerIdentityEvidence }),
  } as unknown as StoredSession
}

function depsOf(store: unknown, adapter: unknown) {
  return {
    adapter,
    store,
    policy: POLICY,
    config: () => CONFIG as never,
    llm: () => {
      throw new Error('not used')
    },
    log: () => undefined,
  } as never
}

const REQUEST = { sessionId: 'sess-1', candidateId: 'cand-1', approvedText: TEXT } as never

async function withStore(run: (store: DebateStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-target-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await run(store)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function prepared(store: DebateStore, session: StoredSession): Promise<void> {
  await store.mutate((data) => ({ ...data, sessions: [session] }))
  await grantApproval(store, {
    sessionId: 'sess-1',
    candidateId: 'cand-1',
    config: () => CONFIG as never,
  })
}

const VERIFIED = {
  ownerIdentityAssurance: 'verified' as const,
  ownerIdentityEvidence: { kind: 'handle', value: 'owner', source: 'wap_floor' },
}

test('选中的楼中楼就是发表位置：带 nestedReplyId，挂在它自己的楼层下', async () => {
  resetInFlight()
  await withStore(async (store) => {
    const { adapter, calls } = countingAdapter()
    await prepared(store, sessionOf({ targetPostId: 'nested-7', targetKind: 'nested', ...VERIFIED }))

    const report = await publishCandidate(depsOf(store, adapter), REQUEST)

    assert.equal(calls.length, 1, `必须发表恰好一次：${JSON.stringify(report).slice(0, 240)}`)
    assert.equal(calls[0]!.target?.nestedReplyId, 'nested-7', '落点必须是选中的那条楼中楼')
    assert.equal(calls[0]!.target?.floorPostId, FLOOR_POST_ID, '必须挂在它自己的父楼层下')
  })
})

test('选中的楼层就是发表位置：不带 nestedReplyId', async () => {
  resetInFlight()
  await withStore(async (store) => {
    const { adapter, calls } = countingAdapter()
    await prepared(
      store,
      sessionOf({ targetPostId: 'floor-9', targetKind: 'floor', floorPostId: 'floor-9', ...VERIFIED }),
    )

    await publishCandidate(depsOf(store, adapter), REQUEST)

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.target?.nestedReplyId, undefined, '楼层回复不得带楼中楼 id')
    assert.equal(calls[0]!.target?.floorPostId, 'floor-9', '落点必须是那个楼层')
  })
})

test('连点两次只发表一次', async () => {
  resetInFlight()
  await withStore(async (store) => {
    const { adapter, calls } = countingAdapter()
    await prepared(store, sessionOf(VERIFIED))

    const first = publishCandidate(depsOf(store, adapter), REQUEST)
    const second = publishCandidate(depsOf(store, adapter), REQUEST)
    await Promise.allSettled([first, second])

    assert.equal(calls.length, 1, `重复点击不得二次发表，实际 ${calls.length} 次`)
  })
})

test('身份未核验时一次都不发表', async () => {
  resetInFlight()
  await withStore(async (store) => {
    const { adapter, calls } = countingAdapter()
    // Verified absent on purpose: the gate must refuse regardless of the approval.
    await prepared(store, sessionOf({}))

    await publishCandidate(depsOf(store, adapter), REQUEST)

    assert.equal(calls.length, 0, '主人身份未核验时平台调用必须为 0')
  })
})
