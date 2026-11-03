/**
 * Cross-source authorship conflict: does the real pipeline notice when two
 * surfaces describe the same `postId` with different authors?
 *
 * The tests here go through `walkNested` — the function `collectThread` calls —
 * rather than through `conflictBetween` alone. A helper that is never wired into
 * the production path proves nothing, and wiring it is exactly what v0.2.22
 * lacked: `getAllNested` and `walkNested` both did
 *
 *     if (!seen.has(reply.postId)) { seen.set(...) }
 *
 * which keeps the first sighting and silently discards the disagreement.
 *
 * Every fixture here is synthetic: the real comment-page structure is covered
 * separately by `test/tieba-author-source.test.ts` against the shipped
 * `comment-page1.html`. The point of *this* file is the conflict path, and it
 * must not pretend to prove platform compatibility.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { walkNested } from '../lib/collector.js'
import type { Floor, NestedReply, PlatformAdapter } from '../lib/types.js'

/** A floor to hang nested replies under. */
function floor(postId = '900'): Floor {
  return {
    platform: 'tieba',
    floorNumber: 1,
    postId,
    authorId: 'silver_fox',
    authorName: '苏小玲',
    authorSource: 'wap_floor',
    content: '正文',
    images: [],
  }
}

/** One nested reply as a source would return it. */
function reply(input: {
  postId: string
  parentPostId?: string
  handle?: string
  name?: string
  numericUid?: string
  numericUidKind?: 'user_id' | 'tieba_uid'
  source?: NestedReply['authorSource']
  body?: string
}): NestedReply {
  return {
    platform: 'tieba',
    postId: input.postId,
    parentPostId: input.parentPostId ?? '900',
    ...(input.handle === undefined ? {} : { authorId: input.handle }),
    ...(input.name === undefined ? {} : { authorName: input.name }),
    ...(input.numericUid === undefined ? {} : { authorNumericUid: input.numericUid }),
    ...(input.numericUidKind === undefined ? {} : { authorNumericUidKind: input.numericUidKind }),
    ...(input.source === undefined ? {} : { authorSource: input.source }),
    content: input.body ?? '内容',
    relationUncertain: false,
  }
}

/**
 * An adapter that serves a fixed reply list per page, in order.
 *
 * This is the minimum needed to drive `walkNested` through two sources: page 1
 * pretends to be the inline copy, page 2 the paginated one.
 */
function adapterOf(pages: readonly (readonly NestedReply[])[]): PlatformAdapter {
  let served = 0
  return {
    platform: 'tieba',
    async getNestedReplies() {
      const page = pages[served] ?? []
      served += 1
      return {
        replies: page,
        hasMore: served < pages.length,
        declaredTotal: undefined,
        page: served,
      }
    },
  } as unknown as PlatformAdapter
}

test('同一 postId 两个来源作者不同 → 必须报告 identity_conflict', async () => {
  const adapter = adapterOf([
    [reply({ postId: 'r1', handle: 'silver_fox', name: '苏小玲', source: 'wap_inline' })],
    [reply({ postId: 'r1', handle: 'someone_else', name: '小财神', source: 'comment_page' })],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  assert.equal(result.conflicts?.length, 1, '必须报出一处冲突')
  const conflict = result.conflicts![0]!
  assert.equal(conflict.code, 'identity_conflict')
  assert.equal(conflict.postId, 'r1')
  assert.match(conflict.summary, /silver_fox/, '诊断要保留第一个来源的登录名')
  assert.match(conflict.summary, /someone_else/, '诊断要保留第二个来源的登录名')
  assert.equal(result.complete, false, '存在冲突的读取不能自我声明完整')
})

test('同一 postId 两个来源作者一致 → 不报冲突，且只保留一条', async () => {
  const adapter = adapterOf([
    [reply({ postId: 'r1', handle: 'silver_fox', name: '苏小玲', source: 'wap_inline' })],
    [reply({ postId: 'r1', handle: 'silver_fox', name: '苏小玲', source: 'comment_page' })],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  assert.equal(result.conflicts, undefined, '一致时不应制造冲突')
  assert.equal(result.replies.length, 1)
})

test('一个来源缺少作者标识 → 不得凭空制造冲突', async () => {
  // The inline copy has a handle; the comment page has none (its real shape).
  // "Unknown" is not "disagreement", and reporting one here would block reads
  // that are perfectly sound.
  const adapter = adapterOf([
    [reply({ postId: 'r1', handle: 'silver_fox', name: '苏小玲', source: 'wap_inline' })],
    [reply({ postId: 'r1', name: '苏小玲', source: 'comment_page' })],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  assert.equal(result.conflicts, undefined, '只剩昵称的一侧不能被判成冲突')
  assert.equal(result.replies.length, 1)
})

test('昵称相同、登录名不同 → 仍然是冲突', async () => {
  // The whole point: a shared nickname must not launder two different accounts
  // into agreement.
  const adapter = adapterOf([
    [reply({ postId: 'r1', handle: 'account_a', name: '小财神', source: 'wap_inline' })],
    [reply({ postId: 'r1', handle: 'account_b', name: '小财神', source: 'comment_page' })],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  assert.equal(result.conflicts?.length, 1)
  assert.match(result.conflicts![0]!.summary, /登录名不同/)
})

test('登录名相同、昵称不同 → 同一账号，不算冲突', async () => {
  // A nickname can be changed between two reads; the login name cannot.
  const adapter = adapterOf([
    [reply({ postId: 'r1', handle: 'silver_fox', name: '旧昵称', source: 'wap_inline' })],
    [reply({ postId: 'r1', handle: 'silver_fox', name: '新昵称', source: 'comment_page' })],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  assert.equal(result.conflicts, undefined)
})

test('不同数字 UID、相同昵称 → 冲突', async () => {
  const adapter = adapterOf([
    [reply({ postId: 'r1', numericUid: '111', numericUidKind: 'user_id', name: '小财神', source: 'total_comment' })],
    [reply({ postId: 'r1', numericUid: '222', numericUidKind: 'user_id', name: '小财神', source: 'total_comment' })],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  assert.equal(result.conflicts?.length, 1)
  assert.match(result.conflicts![0]!.summary, /数字 UID 不同/)
})

test('一侧有数字 UID、另一侧只有 handle → 未核验，不是冲突', async () => {
  // No published mapping between `user_id` and `un`, so the two cannot be
  // compared at all. Calling that a conflict would be manufacturing evidence.
  const adapter = adapterOf([
    [reply({ postId: 'r1', numericUid: '111', source: 'total_comment' })],
    [reply({ postId: 'r1', handle: 'silver_fox', name: '苏小玲', source: 'wap_inline' })],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  assert.equal(result.conflicts, undefined)
})

test('旧记录（无 authorSource）不参与数字 UID 判定，也不制造冲突', async () => {
  // A legacy record's `authorId` has no recorded namespace. It must not be
  // promoted to a uid, and it must not be read as contradicting one either.
  const adapter = adapterOf([
    [reply({ postId: 'r1', handle: 'legacy_user', name: '老用户' })],
    [reply({ postId: 'r1', handle: 'legacy_user', name: '老用户', source: 'comment_page' })],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  assert.equal(result.conflicts, undefined, '两条都没有来源标记时不该互相判罪')
})

test('冲突记录会挂到对应 reply 上，供上层显示', async () => {
  const adapter = adapterOf([
    [reply({ postId: 'r1', handle: 'silver_fox', name: '苏小玲', source: 'wap_inline' })],
    [reply({ postId: 'r1', handle: 'someone_else', name: '小财神', source: 'comment_page' })],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  const target = result.replies.find((entry) => entry.postId === 'r1')
  assert.ok(target?.identityConflict !== undefined, 'reply 上必须带冲突标记')
  assert.equal(target!.identityConflict!.code, 'identity_conflict')
  assert.equal(target!.identityConflict!.firstSource, 'wap_inline')
  assert.equal(target!.identityConflict!.secondSource, 'comment_page')
})

test('多个 postId 各自冲突时全部报出，不只报第一个', async () => {
  const adapter = adapterOf([
    [
      reply({ postId: 'r1', handle: 'a1', name: '甲', source: 'wap_inline' }),
      reply({ postId: 'r2', handle: 'b1', name: '乙', source: 'wap_inline' }),
    ],
    [
      reply({ postId: 'r1', handle: 'a2', name: '甲', source: 'comment_page' }),
      reply({ postId: 'r2', handle: 'b2', name: '乙', source: 'comment_page' }),
    ],
  ])
  const result = await walkNested(adapter, { platform: 'tieba' as const, threadId: '1', url: 'https://tieba.baidu.com/p/1' }, floor())

  assert.equal(result.conflicts?.length, 2)
  assert.deepEqual(
    result.conflicts!.map((entry) => entry.postId).sort(),
    ['r1', 'r2'],
  )
})
