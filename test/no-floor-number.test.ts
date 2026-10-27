/**
 * A platform is not required to number its posts.
 *
 * v0.2.1 acceptance: "核心 Agent 不应依赖贴吧式楼层". The core used to group the
 * conversation by `floorNumber` — a label a microblog does not have — so a
 * non-forum platform had to invent 1, 2, 3… just to make the analyzer work.
 * This file pins the replacement: the core groups and addresses by the floor
 * post's stable id, and `floorNumber` may be entirely absent.
 *
 * Every test here runs with *no* `floorNumber` anywhere in the collected thread,
 * which is the whole point — if any core path still needs the number, one of
 * these fails rather than silently degrading.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeDispute, describeParticipants, nestedOf } from '../lib/analyzer.js'
import { buildTimeline, floorLabel } from '../lib/collector.js'
import type { CollectedThread } from '../lib/collector.js'
import { BUDGET_PRESETS, compressContext } from '../lib/compressor.js'
import { DEFAULT_PERSONA } from '../lib/persona.js'
import { targetFromSnapshot } from '../lib/target.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'

const PLATFORM = 'micro'

/**
 * One microblog post and its comments, with no floor numbers at all.
 *
 * The shape matters: the owner is the AI's account, the opponent answered the
 * owner, and the trigger is the opponent's latest comment. That is the smallest
 * arrangement where the analyzer has a real dispute to reconstruct.
 */
function microThread(): CollectedThread {
  const root: Floor = {
    platform: PLATFORM,
    // No floorNumber on purpose: a status has no 楼层.
    postId: 'post-root',
    authorId: 'host-1',
    authorName: '发帖人',
    content: '随便聊聊今天的加班。',
    createdAt: '2026-10-01T10:00:00Z',
    images: [],
    nestedCount: 4,
  }
  const nested: NestedReply[] = [
    {
      platform: PLATFORM,
      postId: 'c-owner-1',
      parentPostId: 'post-root',
      authorId: 'me-ai',
      authorName: '我的小号',
      content: '加班到这个点，公司该给个说法了。',
      createdAt: '2026-10-01T10:01:00Z',
    },
    {
      platform: PLATFORM,
      postId: 'c-rival-1',
      parentPostId: 'post-root',
      authorId: 'rival-1',
      authorName: '对面',
      content: '不想干可以走，别在这儿带节奏。',
      createdAt: '2026-10-01T10:02:00Z',
      replyToPostId: 'c-owner-1',
      replyToName: '我的小号',
    },
    {
      platform: PLATFORM,
      postId: 'c-owner-2',
      parentPostId: 'post-root',
      authorId: 'me-ai',
      authorName: '我的小号',
      content: '带节奏？把事实说出来就叫带节奏？',
      createdAt: '2026-10-01T10:03:00Z',
      replyToPostId: 'c-rival-1',
      replyToName: '对面',
    },
    {
      platform: PLATFORM,
      postId: 'c-rival-2',
      parentPostId: 'post-root',
      authorId: 'rival-1',
      authorName: '对面',
      content: '事实？你那是事实还是情绪，自己心里没数？',
      createdAt: '2026-10-01T10:04:00Z',
      replyToPostId: 'c-owner-2',
      replyToName: '我的小号',
    },
  ]

  const thread: Thread = {
    platform: PLATFORM,
    threadId: 'status-1',
    url: 'https://micro.example/status/1',
    title: '加班这条',
    content: '随便聊聊今天的加班。',
    authorId: 'host-1',
    authorName: '发帖人',
    forum: { id: 'micro-home', name: '首页' },
    declaredReplyCount: 4,
    images: [],
  }

  return {
    ref: { platform: PLATFORM, threadId: 'status-1' },
    thread,
    floors: [{ floor: root, nested }],
    issues: [],
  } as unknown as CollectedThread
}

test('没有楼层号也能构建时间线：楼层归属由楼层帖 id 决定', () => {
  const timeline = buildTimeline(microThread())
  assert.equal(timeline.length, 5)

  // Every entry points at the floor post, and none of them carries a number.
  for (const entry of timeline) {
    assert.equal(entry.floorPostId, 'post-root', `${entry.postId} 应归到 post-root`)
    assert.equal(entry.floorNumber, undefined, `${entry.postId} 不应凭空有楼层号`)
  }

  // The floor itself is order 0, its comments 1..n.
  assert.deepEqual(
    timeline.map((entry) => entry.order),
    [0, 1, 2, 3, 4],
  )
})

test('没有楼层号也能识别争论对象', () => {
  const dispute = analyzeDispute(microThread(), { userId: 'me-ai' }, { postId: 'c-rival-2' })

  assert.equal(dispute.floorPostId, 'post-root')
  assert.equal(dispute.floorNumber, undefined)
  // `key` is the display name by design (it is the merge key across mixed
  // handles), so assert on the resolved account id, which is what identifies.
  assert.equal(dispute.owner.userId, 'me-ai')
  assert.equal(dispute.opponent?.userId, 'rival-1', '应认出是在回复对面')
  assert.equal(dispute.needsConfirmation, false)

  // The exchange is the owner↔opponent back-and-forth, oldest first.
  assert.deepEqual(
    dispute.exchange.map((statement) => statement.postId),
    ['c-owner-1', 'c-rival-1', 'c-owner-2', 'c-rival-2'],
  )
  for (const statement of dispute.exchange) {
    assert.equal(statement.floorNumber, undefined)
  }
})

test('没有楼层号也能列出参与者与层内回复', () => {
  const collected = microThread()
  const participants = describeParticipants(collected, 'post-root')
  // The root author plus the two commenters.
  assert.deepEqual(
    participants.map((participant) => participant.key).sort(),
    ['发帖人', '对面', '我的小号'].sort(),
  )

  // A floor id that does not exist returns nothing rather than guessing a floor.
  assert.deepEqual(describeParticipants(collected, 'post-missing'), [])

  const nested = nestedOf(collected, 'post-root')
  assert.equal(nested.length, 4)
  assert.deepEqual(nestedOf(collected, 'post-missing'), [])
})

test('没有楼层号也能压出模型可读的上下文，且不会写出「undefined 楼」', () => {
  const collected = microThread()
  const dispute = analyzeDispute(collected, { userId: 'me-ai' }, { postId: 'c-rival-2' })
  const compressed = compressContext({
    collected,
    dispute,
    trigger: { postId: 'c-rival-2' },
    persona: DEFAULT_PERSONA,
    budget: BUDGET_PRESETS.medium,
  })

  const text = compressed.chunks.map((chunk) => chunk.text).join('\n')
  // The content must be present...
  assert.match(text, /加班/)
  assert.match(text, /带节奏/)
  // ...and the prompt must not announce a floor that does not exist, because a
  // model told "undefined楼" invents details about where the argument is.
  assert.doesNotMatch(text, /undefined/)
  assert.doesNotMatch(text, /NaN/)
  // It should still say where the argument is — by id, since there is no number.
  assert.match(text, /post-root/)
})

test('没有楼层号也能把目标快照还原成发表目标', () => {
  const target = targetFromSnapshot({
    platform: PLATFORM,
    threadId: 'status-1',
    floorPostId: 'post-root',
    nestedReplyId: 'c-rival-2',
    targetPostId: 'c-rival-2',
    targetKind: 'nested',
    targetAuthorId: 'rival-1',
    contentHash: 'hash',
    capturedAt: '2026-10-01T10:05:00.000Z',
  })

  assert.equal(target.threadId, 'status-1')
  assert.equal(target.floorPostId, 'post-root')
  assert.equal(target.targetPostId, 'c-rival-2')
  assert.equal(target.targetKind, 'nested')
})

test('楼层号存在时仍然是它自己那个值，没有被默认值覆盖', () => {
  // The forum case must keep working exactly as before: a Tieba thread still
  // reports 3F as 3, and the grouping still lands on the same floor.
  const collected = microThread()
  const withNumber: CollectedThread = {
    ...collected,
    floors: collected.floors.map((entry) => ({
      ...entry,
      floor: { ...entry.floor, floorNumber: 3 },
    })),
  }
  const timeline = buildTimeline(withNumber)
  for (const entry of timeline) {
    assert.equal(entry.floorNumber, 3)
    assert.equal(entry.floorPostId, 'post-root')
  }

  const dispute = analyzeDispute(withNumber, { userId: 'me-ai' }, { postId: 'c-rival-2' })
  assert.equal(dispute.floorNumber, 3)
  assert.equal(dispute.exchange.length, 4)
})

test('同一 Runtime 里两个平台的帖子不会因为都没楼层号而混在一起', () => {
  // The real risk of removing the number is not cosmetic: if grouping fell back
  // to something shared (0, or the index), two threads would merge. Grouping by
  // the floor post id keeps them apart even when neither has a number.
  const a = microThread()
  const b: CollectedThread = {
    ...a,
    ref: { platform: PLATFORM, threadId: 'status-2' },
    floors: a.floors.map((entry) => ({
      floor: { ...entry.floor, postId: 'other-root' },
      nested: entry.nested.map((reply) => ({
        ...reply,
        postId: reply.postId.replace('c-', 'd-'),
        parentPostId: 'other-root',
      })),
    })),
  }

  const timelineA = buildTimeline(a)
  const timelineB = buildTimeline(b)
  assert.ok(
    timelineA.every((entry) => entry.floorPostId === 'post-root'),
    'a 的条目不能被 b 的楼层吸走',
  )
  assert.ok(
    timelineB.every((entry) => entry.floorPostId === 'other-root'),
    'b 的条目不能被 a 的楼层吸走',
  )

  // And the participants of each floor stay within it.
  assert.deepEqual(describeParticipants(a, 'other-root'), [])
  assert.equal(describeParticipants(b, 'other-root').length, 3)
})

test('floorLabel 在没有楼层号时用帖子 id，绝不输出占位符', () => {
  assert.equal(floorLabel(3, 'p1'), '第 3 楼')
  assert.equal(floorLabel(undefined, 'p1'), 'p1')
  // The literal failure mode this helper exists to prevent.
  assert.doesNotMatch(floorLabel(undefined, 'p1'), /undefined/)
  assert.doesNotMatch(floorLabel(undefined, 'p1'), /NaN/)
})
