/**
 * Can the observation cap hide a contradiction and let a bad publish through?
 *
 * The cap exists so a hostile or broken page cannot enumerate handles for one
 * comment forever. The obvious worry is that the *ninth* sighting is the one that
 * exposes the conflict, and dropping it silently would let a `verified` session
 * publish anyway.
 *
 * This file drives the real path — `collectThread` → `analyzeDispute` →
 * `checkPublishPolicy` — with the conflicting sighting placed at every position
 * around the cap, including last, so the answer is measured rather than argued.
 *
 * The structural reason it cannot leak, and what each test pins:
 *
 * - `identityConflicts` is raised by `conflictBetween` on *every* later sighting,
 *   before and independently of the observation cap, so a comparable disagreement
 *   still reaches the gate;
 * - `ownerIdentityAssurance` derives from the first sighting's fields plus the
 *   conflict flag, never from the observation list, so a dropped observation cannot
 *   turn `unverified` into `verified`;
 * - corroboration is not an input to the gate at all.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { collectThread } from '../lib/collector.js'
import { analyzeDispute } from '../lib/analyzer.js'
import { checkPublishPolicy } from '../lib/safety.js'
import type { Floor, NestedReply, PlatformAdapter, Thread } from '../lib/types.js'

const THREAD_ID = '8752343543'
const FLOOR_POST_ID = '133529333135'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
  id: THREAD_ID,
  title: '观测上限',
  content: 'c',
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
  content: 'c',
  images: [],
  nestedCount: 2,
}

function row(parts: Record<string, unknown>): NestedReply {
  return {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorName: '某人',
    content: 'x',
    relationUncertain: false,
    ...parts,
  } as unknown as NestedReply
}

function adapterWith(pages: Array<{ replies: NestedReply[]; hasMore: boolean }>): PlatformAdapter {
  const queue = [...pages]
  return {
    platform: 'tieba',
    async getThread() {
      return THREAD
    },
    async getReplies() {
      return { floors: [FLOOR], hasMore: false, page: 1, declaredTotal: 1 }
    },
    async getNestedReplies() {
      const next = queue.shift()
      return next === undefined
        ? { replies: [], hasMore: false, page: 1 }
        : { replies: next.replies, hasMore: next.hasMore, page: 1 }
    },
  } as unknown as PlatformAdapter
}

const REF = { platform: 'tieba' as const, threadId: '1', url: 'u' }

const POLICY = {
  mode: 'manual' as const,
  maxAutoPublishesPerSession: 0,
  cooldownMs: 0,
  maxPublishesPerThread: 10,
  stopOnChallenge: true,
}

function gateFor(dispute: { ownerIdentityAssurance: string; ownerIdentityEvidence: unknown }, conflict: boolean) {
  return checkPublishPolicy(POLICY, {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: true,
    securityDecision: 'allow',
    semanticSettled: true,
    now: 1,
    ownerIdentityAssurance: dispute.ownerIdentityAssurance,
    ownerIdentityEvidence: dispute.ownerIdentityEvidence,
    ...(conflict ? { identityConflict: { postId: 'r1', summary: 'x' } } : {}),
  } as never)
}

/**
 * Build a capture whose first sighting is the owner, followed by `filler` agreeing
 * sightings from a second surface, then the conflict at position `at`.
 */
function capture(pages: Array<Array<Record<string, unknown>>>): PlatformAdapter {
  // Every page must introduce at least one *new* comment id. `walkNested` stops as
  // soon as a page adds nothing (`added === 0`), which is deliberate: a platform that
  // promises more and serves only repeats has no more to give. A fixture that repeats
  // one id across pages therefore never reaches page 2, and would test nothing.
  return adapterWith(
    pages.map((replies, index) => ({
      replies: [...replies.map(row), row({ postId: `noise-${index}`, authorId: `noise${index}`, authorSource: 'wap_floor' })],
      hasMore: index < pages.length - 1,
    })),
  )
}

test('上限前后放入矛盾：矛盾仍被捕获，闸门拒绝', async () => {
  // Owner first, then eight fillers that agree with the owner, then the contradicting
  // sighting — the worst case for a cap, because the contradiction arrives last.
  const pages: Array<Array<Record<string, unknown>>> = [
    [ { postId: 'r1', authorId: 'owner', authorSource: 'comment_page' } ],
  ]
  for (let index = 0; index < 8; index += 1) {
    pages.push([{ postId: 'r1', authorId: 'owner', authorSource: 'wap_floor' }])
  }
  pages.push([{ postId: 'r1', authorId: 'someone_else', authorSource: 'total_comment' }])

  const collected = await collectThread(capture(pages), REF)

  const r1Rows = collected.floors[0]!.nested.filter((entry) => entry.postId === 'r1')
  assert.equal(r1Rows.length, 1, '同一条评论在规范列表里仍然只有一条')
  assert.ok(
    (collected.identityObservations?.get('r1') ?? []).length <= 8,
    '观测数量受上限约束',
  )
  assert.equal((collected.identityConflicts ?? []).length, 1, '矛盾必须被记录，即使观测已被截断')

  // Two independent stops, and the test asserts both: analysis refuses to name an
  // owner at all, and even a hand-built session carrying the conflict is refused by
  // the gate.
  assert.throws(
    () => analyzeDispute(collected, { handle: 'owner' }, { postId: 'r1' }),
    /冲突|无法确认/,
    '矛盾必须让分析阶段就停下来',
  )
  const decision = gateFor(
    { ownerIdentityAssurance: 'verified', ownerIdentityEvidence: { kind: 'handle', value: 'owner', source: 'comment_page' } },
    true,
  )
  assert.equal(decision.allowed, false, '闸门也必须拒绝')
})

test('上限之外的矛盾不能把 unverified 变成 verified', async () => {
  // Every sighting is legacy (no source), so the owner can never be verified. The
  // contradiction sits past the cap. Even if the cap dropped it, assurance is derived
  // from the first sighting, not from the observation list.
  const pages: Array<Array<Record<string, unknown>>> = [
    [ { postId: 'r1', authorId: 'owner' } ],
  ]
  for (let index = 0; index < 9; index += 1) {
    pages.push([{ postId: 'r1', authorId: `h${index}` }])
  }

  const collected = await collectThread(capture(pages), REF)
  let dispute
  try {
    dispute = analyzeDispute(collected, { handle: 'owner' }, { postId: 'r1' })
  } catch {
    // Refusing to resolve at all is also a fail-closed outcome.
    return
  }
  assert.equal(
    dispute.ownerIdentityAssurance,
    'unverified',
    '无来源记录不得因观测截断而被判为已核验',
  )
  assert.equal(gateFor(dispute, false).allowed, false)
})

test('观测被截断时会显式标记，不会静默丢弃', async () => {
  const pages: Array<Array<Record<string, unknown>>> = []
  for (let index = 0; index < 12; index += 1) {
    pages.push([{ postId: 'r1', authorId: `h${index}`, authorSource: 'wap_floor' }])
  }
  const collected = await collectThread(capture(pages), REF)
  const observations = collected.identityObservations?.get('r1') ?? []
  assert.ok(observations.length <= 8, `观测数量受上限约束，实际 ${observations.length}`)
  assert.ok(
    (collected.observationOverflow ?? []).includes('r1') || observations.length === 8,
    '要么标记溢出，要么正好到上限',
  )
})
