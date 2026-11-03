/**
 * R8-1: identity observations must survive comment de-duplication.
 *
 * ## The defect this file was written against
 *
 * `walkNested` de-duplicates nested replies by `postId` (`seen`), then builds the
 * corroboration observations from `replies.filter(postId === x)`. Because `replies`
 * is already unique per post id, that filter always returned **one** row, so every
 * post was reported as `single_source` — no matter how many surfaces had spoken
 * about it. `corroborated`, `incomparable` and `inconsistent` were unreachable
 * through the production path.
 *
 * The fix keeps two things apart on purpose:
 *
 * - the **canonical reply list** — one row per comment, as the rest of the product
 *   expects (counts, candidates, publishing all depend on it);
 * - the **identity observations** — every valid sighting, kept for identity analysis
 *   only, so a cross-source disagreement is not thrown away with the duplicate.
 *
 * ## What must not change
 *
 * - floor and reply counts stay exactly what they were;
 * - a duplicate row never produces a duplicate candidate or a second send;
 * - two parsers over one response are still one source;
 * - a missing source still cannot count as an independent source;
 * - two responses that merely agree are described as "records agree", not "identity
 *   independently authenticated".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { collectThread } from '../lib/collector.js'
import { analyzeDispute } from '../lib/analyzer.js'
import { checkPublishPolicy } from '../lib/safety.js'
import { physicalOriginOf } from '../lib/identity.js'
import type { Floor, NestedReply, PlatformAdapter, Thread } from '../lib/types.js'

const THREAD_ID = '8752343543'
const FLOOR_POST_ID = '133529333135'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
  id: THREAD_ID,
  title: 'R8-1 观测保留',
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

/** A FakeAdapter whose nested pages are supplied per call. */
function adapterWith(pages: Array<{ replies: NestedReply[]; hasMore: boolean }>, floors: Floor[] = [FLOOR]): PlatformAdapter {
  const queue = [...pages]
  return {
    platform: 'tieba',
    async getThread() {
      return THREAD
    },
    async getReplies() {
      return { floors, hasMore: false, page: 1, declaredTotal: floors.length }
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

const BASE_ATTEMPT = {
  sessionId: 's',
  threadId: 't',
  sessionPublishes: 0,
  threadPublishes: 0,
  humanApproved: true,
  securityDecision: 'allow' as const,
  semanticSettled: true,
  now: 1,
}

// ═══════════════════════════════════════════════════════════════════════════
// The reproduction
// ═══════════════════════════════════════════════════════════════════════════

test('R8-1 复现：两个来源同一评论，规范化后 1 条，身份观测 2 条', async () => {
  const collected = await collectThread(
    adapterWith([
      { replies: [row({ postId: 'r1', authorId: 'same', authorSource: 'wap_floor' })], hasMore: true },
      { replies: [row({ postId: 'r1', authorId: 'same', authorSource: 'comment_page' })], hasMore: false },
    ]),
    REF,
  )

  const nested = collected.floors[0]!.nested
  assert.equal(nested.length, 1, '规范化评论列表必须仍按 postId 去重')

  // The point of the fix: the second sighting is kept for identity analysis even
  // though it is not a second comment.
  const observations = collected.identityObservations?.get('r1') ?? []
  assert.equal(observations.length, 2, '两份身份观测都必须保留')
  assert.deepEqual(
    observations.map((entry) => entry.source).sort(),
    ['comment_page', 'wap_floor'],
  )
  assert.equal(collected.corroboration?.get('r1'), 'corroborated', '两个真实响应一致 → corroborated')
})

test('R8-1：同一响应两个解析器只形成一个来源', async () => {
  const collected = await collectThread(
    adapterWith([
      { replies: [row({ postId: 'r1', authorId: 'same', authorSource: 'wap_floor' })], hasMore: true },
      { replies: [row({ postId: 'r1', authorId: 'same', authorSource: 'wap_inline' })], hasMore: false },
    ]),
    REF,
  )

  const observations = collected.identityObservations?.get('r1') ?? []
  assert.equal(observations.length, 2, '两条观测都在')
  assert.equal(
    observations.filter((entry) => physicalOriginOf(entry.source) === 'wap').length,
    2,
    '但它们同属一个物理来源',
  )
  assert.equal(collected.corroboration?.get('r1'), 'single_source', '同一响应的两个解析器不算交叉验证')
})

test('R8-1：不同响应的真实冲突不会被去重吞掉', async () => {
  const collected = await collectThread(
    adapterWith([
      { replies: [row({ postId: 'r1', authorId: 'a1', authorSource: 'wap_floor' })], hasMore: true },
      { replies: [row({ postId: 'r1', authorId: 'a2', authorSource: 'comment_page' })], hasMore: false },
    ]),
    REF,
  )

  assert.equal(collected.floors[0]!.nested.length, 1, '评论仍是一条')
  assert.equal((collected.identityConflicts ?? []).length, 1, '冲突必须被记录')
  assert.equal(collected.corroboration?.get('r1'), 'contested')
})

test('R8-1：两条无来源记录互相矛盾 → inconsistent（数据质量，不是人际冲突）', async () => {
  // `inconsistent` is deliberately narrow: it covers disagreement that *cannot* be
  // attributed to two surfaces, because neither side declared a source. With two
  // declared sources the conflict detector fires first and the verdict is `contested`
  // — verified by the test below, so this is not a hole but a division of labour.
  const collected = await collectThread(
    adapterWith([
      { replies: [row({ postId: 'r1', authorId: 'a1' })], hasMore: true },
      { replies: [row({ postId: 'r1', authorId: 'a2' })], hasMore: false },
    ]),
    REF,
  )

  assert.equal((collected.identityConflicts ?? []).length, 0, '没有可比较的来源，构不成跨源冲突')
  const verdict = collected.corroboration?.get('r1')
  assert.equal(verdict, 'inconsistent', `无来源的自相矛盾应为 inconsistent，实际 ${verdict}`)
  assert.equal(collected.corroborationReasons?.get('r1')?.code, 'self_contradictory')
})

test('R8-1：同一 WAP 站两个页面矛盾 → 先由冲突检测捕获为 contested', async () => {
  // Same physical origin, two pages, different handle. This is the *stronger* verdict
  // and it blocks publishing; `inconsistent` is reserved for the case where nobody can
  // be named as the disagreeing surface.
  const collected = await collectThread(
    adapterWith([
      { replies: [row({ postId: 'r1', authorId: 'a1', authorSource: 'wap_floor' })], hasMore: true },
      { replies: [row({ postId: 'r1', authorId: 'a2', authorSource: 'wap_inline' })], hasMore: false },
    ]),
    REF,
  )
  assert.equal((collected.identityConflicts ?? []).length, 1)
  assert.equal(collected.corroboration?.get('r1'), 'contested')
})

test('R8-1：不同评论不会错误合并', async () => {
  const collected = await collectThread(
    adapterWith([
      {
        replies: [
          row({ postId: 'r1', authorId: 'a1', authorSource: 'wap_floor' }),
          row({ postId: 'r2', authorId: 'a2', authorSource: 'wap_floor' }),
        ],
        hasMore: false,
      },
    ]),
    REF,
  )

  assert.equal(collected.floors[0]!.nested.length, 2)
  assert.equal((collected.identityConflicts ?? []).length, 0, '不同评论不同作者不是冲突')
  assert.equal(collected.identityObservations?.get('r1')?.length, 1)
  assert.equal(collected.identityObservations?.get('r2')?.length, 1)
})

test('R8-1：分页重复出现同一评论不会重复计数', async () => {
  const collected = await collectThread(
    adapterWith([
      { replies: [row({ postId: 'r1', authorId: 'a1', authorSource: 'wap_floor' })], hasMore: true },
      { replies: [row({ postId: 'r1', authorId: 'a1', authorSource: 'wap_floor' })], hasMore: false },
    ]),
    REF,
  )

  assert.equal(collected.floors[0]!.nested.length, 1, '评论数不因分页重复而增加')
  // Two identical sightings from the same origin are one evidence, not two.
  assert.equal(collected.corroboration?.get('r1'), 'single_source')
})

test('R8-1：观测保留不改变楼层与回复总数', async () => {
  const floors: Floor[] = [
    { ...FLOOR, floorNumber: 1, postId: '900' },
    { ...FLOOR, floorNumber: 2, postId: '901' },
  ]
  const collected = await collectThread(
    adapterWith(
      [
        { replies: [row({ postId: 'r1', parentPostId: '900', authorId: 'a1', authorSource: 'wap_floor' })], hasMore: true },
        { replies: [row({ postId: 'r1', parentPostId: '900', authorId: 'a1', authorSource: 'comment_page' })], hasMore: false },
        { replies: [row({ postId: 'r2', parentPostId: '901', authorId: 'b1', authorSource: 'wap_floor' })], hasMore: false },
      ],
      floors,
    ),
    REF,
  )

  assert.equal(collected.floors.length, 2, '楼层数不变')
  const total = collected.floors.reduce((sum, entry) => sum + entry.nested.length, 0)
  assert.equal(total, 2, '回复总数不变（r1 + r2）')
})

// ═══════════════════════════════════════════════════════════════════════════
// The verdicts must reach the gate through the production path
// ═══════════════════════════════════════════════════════════════════════════

test('R8-1：目标身份冲突时闸门拒绝，FakeAdapter 零次', async () => {
  const collected = await collectThread(
    adapterWith([
      { replies: [row({ postId: 'r1', authorId: 'a1', authorSource: 'wap_floor' })], hasMore: true },
      { replies: [row({ postId: 'r1', authorId: 'a2', authorSource: 'comment_page' })], hasMore: false },
    ]),
    REF,
  )

  // The analyzer refuses to resolve an owner at all when the target is contested.
  assert.throws(
    () => analyzeDispute(collected, { handle: 'a1' }, { postId: 'r1' }),
    /冲突|无法确认/,
  )

  const decision = checkPublishPolicy(POLICY, {
    ...BASE_ATTEMPT,
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: { kind: 'handle', value: 'a1', source: 'wap_floor' },
    identityConflict: { postId: 'r1', summary: '不同登录名' },
  } as never)
  assert.equal(decision.allowed, false)
})

test('R8-1：正常身份经真实采集链路可发表', async () => {
  const collected = await collectThread(
    adapterWith([
      { replies: [row({ postId: 'r1', authorId: 'owner', authorSource: 'wap_floor' })], hasMore: false },
    ]),
    REF,
  )
  const dispute = analyzeDispute(collected, { handle: 'owner' }, { postId: 'r1' })
  assert.equal(dispute.ownerIdentityAssurance, 'verified')

  const allowed = checkPublishPolicy(POLICY, {
    ...BASE_ATTEMPT,
    ownerIdentityAssurance: dispute.ownerIdentityAssurance,
    ownerIdentityEvidence: dispute.ownerIdentityEvidence,
  } as never)
  assert.equal(allowed.allowed, true)

  // And the corroboration verdict still does not authorise anything by itself.
  const withoutEvidence = checkPublishPolicy(POLICY, {
    ...BASE_ATTEMPT,
    ownerIdentityAssurance: 'verified',
  } as never)
  assert.equal(withoutEvidence.allowed, false)
})

test('R8-1：观测上限触发时显式标记，不静默丢弃', async () => {
  // Twelve distinct handles for one comment. Beyond the cap the collector must *say*
  // it truncated, because silent truncation is how a real disagreement disappears.
  const replies: NestedReply[] = []
  for (let index = 0; index < 12; index += 1) {
    replies.push(row({ postId: 'r1', authorId: `h${index}`, authorSource: 'wap_floor' }))
  }
  const collected = await collectThread(
    adapterWith([{ replies, hasMore: false }]),
    REF,
  )

  assert.ok(
    (collected.observationOverflow ?? []).includes('r1'),
    `超出上限必须显式记录，实际 ${JSON.stringify(collected.observationOverflow)}`,
  )
  assert.equal(collected.floors[0]!.nested.length, 1, '评论仍然只有一条')
  // Whether it lands on `contested` (the conflict detector saw two named surfaces) or
  // `inconsistent` (nobody could be named), it must never claim agreement.
  assert.notEqual(
    collected.corroboration?.get('r1'),
    'corroborated',
    '截断不能把一个矛盾报告成一致',
  )
})
