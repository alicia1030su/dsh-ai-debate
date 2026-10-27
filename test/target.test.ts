/**
 * Target verification tests.
 *
 * These pin down where a reply lands. The defect they guard against is not a
 * crash: the publisher used to build a target with only `floorPostId`, so a
 * reply meant for a nested post arrived as a brand-new floor — a well-formed
 * request in the wrong place, with no error anywhere.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { contentHash, resolveTarget, snapshotStillValid, targetFromSnapshot } from '../lib/target.js'
import { PlatformError, type ReplyContext, type Thread, type Floor, type NestedReply } from '../lib/types.js'
import { FakeAdapter, makeFloor, makeNested, threePartyThread } from './helpers.ts'

/** A resolver that returns whatever context the test wants. */
function stubResolver(context: ReplyContext | (() => Promise<ReplyContext>)) {
  return {
    getReplyContext: async () => (typeof context === 'function' ? context() : context),
  }
}

/** Wrap an existing post as a context. */
function contextFor(thread: Thread, floor: Floor, nested?: NestedReply): ReplyContext {
  return { thread, floor, ...(nested ? { nested } : {}), ancestors: [], siblings: [] }
}

test('a nested target carries both the floor id and the nested id', async () => {
  // Requirement: `reply_id` (floor) and `comment_id` (nested) must both be set.
  // Sending only the floor id posts a new floor instead of answering in place.
  const data = threePartyThread()
  const floor = data.floors[0]!
  const nested = data.nested[floor.postId]!.find((entry) => entry.postId === 'n5')!
  const resolver = stubResolver(contextFor(data.thread, floor, nested))

  const result = await resolveTarget(resolver, {
    threadId: data.thread.id,
    floorPostId: floor.postId,
    targetPostId: nested.postId,
    targetKind: 'nested',
    targetAuthorId: nested.authorId,
  })

  assert.equal(result.ok, true, result.ok ? '' : result.message)
  if (!result.ok) return
  assert.equal(result.target.floorPostId, floor.postId)
  assert.equal(result.target.nestedReplyId, nested.postId)
  assert.equal(result.target.targetKind, 'nested')
  assert.equal(result.snapshot.floorPostId, floor.postId)
  assert.equal(result.snapshot.nestedReplyId, nested.postId)
})

test('a floor target carries no nested id and says it is a floor', async () => {
  const data = threePartyThread()
  const floor = data.floors[0]!
  const resolver = stubResolver(contextFor(data.thread, floor))

  const result = await resolveTarget(resolver, {
    threadId: data.thread.id,
    floorPostId: floor.postId,
    targetPostId: floor.postId,
    targetKind: 'floor',
  })

  assert.equal(result.ok, true, result.ok ? '' : result.message)
  if (!result.ok) return
  assert.equal(result.target.floorPostId, floor.postId)
  assert.equal(result.target.nestedReplyId, undefined)
  assert.equal(result.target.targetKind, 'floor')
  assert.equal(result.snapshot.nestedReplyId, undefined)
})

test('replying to a specific user inside a nested thread targets that user post', async () => {
  // "回复楼中楼里的某个用户": the target is the nested post written by that user,
  // and the floor stays the container. The two must not be swapped.
  const data = threePartyThread()
  const floor = data.floors[0]!
  const opponentReply = data.nested[floor.postId]!.find((entry) => entry.authorId === 'opp-1')!
  const resolver = stubResolver(contextFor(data.thread, floor, opponentReply))

  const result = await resolveTarget(resolver, {
    threadId: data.thread.id,
    floorPostId: floor.postId,
    targetPostId: opponentReply.postId,
    targetKind: 'nested',
    targetAuthorId: 'opp-1',
  })

  assert.equal(result.ok, true, result.ok ? '' : result.message)
  if (!result.ok) return
  assert.equal(result.target.nestedReplyId, opponentReply.postId)
  assert.equal(result.snapshot.targetAuthorId, 'opp-1')
  assert.equal(result.target.replyToUserId, 'opp-1')
})

test('a deleted target is refused, not redirected to whatever is there now', async () => {
  const data = threePartyThread()
  // Two shapes matter: a platform "not found" and any other read failure. Both
  // must refuse; only the wording differs.
  const notFound = stubResolver(async () => {
    throw new PlatformError('找不到回复', 'not_found')
  })
  const otherFailure = stubResolver(async () => {
    throw new Error('找不到回复 n5')
  })
  const expectation = {
    threadId: data.thread.id,
    floorPostId: data.floors[0]!.postId,
    targetPostId: 'n5',
    targetKind: 'nested' as const,
  }

  const deleted = await resolveTarget(notFound, expectation)
  assert.equal(deleted.ok, false)
  if (!deleted.ok) {
    assert.equal(deleted.problem, 'not_found')
    assert.match(deleted.message, /已经读不到/)
  }

  const broken = await resolveTarget(otherFailure, expectation)
  assert.equal(broken.ok, false)
  if (!broken.ok) {
    assert.equal(broken.problem, 'not_found')
    assert.match(broken.message, /无法重新读取目标回复/)
  }
})

test('a target that moved to another floor is refused', async () => {
  const data = threePartyThread()
  const floor = data.floors[0]!
  const nested = data.nested[floor.postId]![0]!
  // Context reports a *different* floor than the analysis believed.
  const otherFloor = makeFloor({ floorNumber: 2, postId: '999', authorId: 'x', authorName: '别人', content: '别的内容' })
  const resolver = stubResolver(contextFor(data.thread, otherFloor, nested))

  const result = await resolveTarget(resolver, {
    threadId: data.thread.id,
    floorPostId: floor.postId,
    targetPostId: nested.postId,
    targetKind: 'nested',
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.problem, 'wrong_floor')
})

test('a target whose author changed is refused', async () => {
  const data = threePartyThread()
  const floor = data.floors[0]!
  const nested = data.nested[floor.postId]!.find((entry) => entry.authorId === 'opp-1')!
  const resolver = stubResolver(contextFor(data.thread, floor, nested))

  const result = await resolveTarget(resolver, {
    threadId: data.thread.id,
    floorPostId: floor.postId,
    targetPostId: nested.postId,
    targetKind: 'nested',
    // The analysis said the opponent is somebody else.
    targetAuthorId: 'someone-else',
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.problem, 'author_mismatch')
})

test('a target in another thread is refused', async () => {
  const data = threePartyThread()
  const floor = data.floors[0]!
  const nested = data.nested[floor.postId]![0]!
  const resolver = stubResolver(contextFor(data.thread, floor, nested))

  const result = await resolveTarget(resolver, {
    threadId: '4300000000',
    floorPostId: floor.postId,
    targetPostId: nested.postId,
    targetKind: 'nested',
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.problem, 'wrong_thread')
})

test('expecting a floor while the post is nested is refused', async () => {
  // This is the exact mismatch that sent an in-floor reply out as a new floor.
  const data = threePartyThread()
  const floor = data.floors[0]!
  const nested = data.nested[floor.postId]![0]!
  const resolver = stubResolver(contextFor(data.thread, floor, nested))

  const result = await resolveTarget(resolver, {
    threadId: data.thread.id,
    floorPostId: floor.postId,
    targetPostId: nested.postId,
    targetKind: 'floor',
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.problem, 'kind_mismatch')
})

test('targetFromSnapshot throws rather than silently posting to the floor', () => {
  // A nested-kind snapshot without a nested id would otherwise produce a target
  // that the adapter treats as a plain floor reply.
  assert.throws(
    () =>
      targetFromSnapshot({
        platform: 'tieba',
        threadId: 't',
        floorPostId: 'f',
        floorNumber: 1,
        targetPostId: 'n',
        targetKind: 'nested',
        contentHash: 'x',
        capturedAt: new Date(0).toISOString(),
      }),
    /nestedReplyId/,
  )
})

test('an edited target invalidates the snapshot taken at review time', () => {
  const base = {
    platform: 'tieba' as const,
    threadId: 't',
    floorPostId: 'f',
    floorNumber: 1,
    nestedReplyId: 'n',
    targetPostId: 'n',
    targetKind: 'nested' as const,
    contentHash: contentHash('原来的内容'),
    capturedAt: new Date(0).toISOString(),
  }

  // Unchanged: still valid.
  assert.equal(snapshotStillValid(base, { ...base }), undefined)
  // Edited body: the reviewed reply no longer matches the situation.
  assert.equal(
    snapshotStillValid(base, { ...base, contentHash: contentHash('改过的内容') }),
    'context_changed',
  )
  // Moved floor.
  assert.equal(snapshotStillValid(base, { ...base, floorPostId: 'other' }), 'wrong_floor')
  // Different author.
  const withAuthor = { ...base, targetAuthorId: 'a' }
  assert.equal(snapshotStillValid(withAuthor, { ...base, targetAuthorId: 'b' }), 'author_mismatch')
})

test('resolveTarget reads through a real adapter and keeps ids consistent', async () => {
  // Uses FakeAdapter rather than a stub, so the floor/nested split is exercised
  // through the same code path the plugin uses.
  const data = threePartyThread()
  const adapter = new FakeAdapter(data)
  const nested = data.nested[data.floors[0]!.postId]!.find((entry) => entry.postId === 'n5')!

  const result = await resolveTarget(adapter, {
    threadId: data.thread.id,
    floorPostId: data.floors[0]!.postId,
    targetPostId: nested.postId,
    targetKind: 'nested',
    targetAuthorId: nested.authorId,
  })

  assert.equal(result.ok, true, result.ok ? '' : result.message)
  if (!result.ok) return
  assert.equal(result.target.nestedReplyId, nested.postId)
  assert.equal(result.snapshot.contentHash, contentHash(nested.content))
})

test('resolving the same floor twice does not re-walk the thread', async () => {
  // P1-4: the lookup used to re-read every page of every floor. Structural caching
  // must cut repeat requests without changing the answer.
  const data = threePartyThread()
  const floor = data.floors[0]!
  const adapter = new FakeAdapter({
    thread: data.thread,
    floors: data.floors,
    nested: data.nested,
  })
  // Count floor-page reads on the fake.
  let pagesRead = 0
  const original = adapter.getReplies.bind(adapter)
  adapter.getReplies = async (...args: Parameters<typeof original>) => {
    pagesRead += 1
    return original(...args)
  }

  const first = await adapter.getReplyContext({ platform: 'tieba', threadId: data.thread.id }, floor.postId)
  const afterFirst = pagesRead
  const second = await adapter.getReplyContext({ platform: 'tieba', threadId: data.thread.id }, floor.postId)

  assert.equal(first.floor.postId, second.floor.postId, 'the answer must not change')
  assert.equal(pagesRead, afterFirst, 'a repeat lookup must not walk the pages again')
})
