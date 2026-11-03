/**
 * An identifier is only the same identifier inside the same namespace.
 *
 * ## P0 under test
 *
 * Tieba publishes two unrelated numeric ids: `user_id` (from the comment page) and
 * `tieba_uid` (from the total-comment API). They are both 9–10 digit decimals drawn
 * from different spaces, so the *number* carries no meaning on its own. Two people
 * can legitimately hold `12345` in each — that is two accounts, not one.
 *
 * The participant key already encoded the namespace. `participant.userId` did not:
 * it stored the bare number, and `resolveOwnerKey` compared bare numbers. So a thread
 * read through one namespace could satisfy an owner configured in the other, and the
 * evidence then recorded the *configured* namespace rather than the observed one —
 * making the record look consistent with a match that never happened.
 *
 * This file reproduces that, then pins the corrected rule.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute } from '../lib/analyzer.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'

const THREAD_ID = '8752343543'
const FLOOR_POST_ID = '133529333135'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
  id: THREAD_ID,
  title: '命名空间测试帖',
  content: '开场白',
  authorId: 'host_un',
  authorName: '楼主甲',
  authorSource: 'wap_floor',
  url: `https://tieba.baidu.com/p/${THREAD_ID}`,
  images: [],
}

const FLOOR: Floor = {
  platform: 'tieba',
  floorNumber: 1,
  postId: FLOOR_POST_ID,
  authorId: 'host_un',
  authorName: '楼主甲',
  authorSource: 'wap_floor',
  content: '大家看看这个方案。',
  images: [],
  nestedCount: 2,
}

/**
 * A nested reply carrying a numeric uid in a stated namespace.
 *
 * `uid` and `kind` are stated together on purpose: the fixture has to say *which*
 * namespace produced the number, because that is the whole question.
 */
function replyWithUid(input: {
  postId: string
  uid: string
  kind: 'user_id' | 'tieba_uid'
  display: string
  content: string
  platform?: string
}): NestedReply {
  return {
    platform: input.platform ?? 'tieba',
    postId: input.postId,
    parentPostId: FLOOR_POST_ID,
    // A row with a numeric uid has no login name; the uid is the account.
    authorNumericUid: input.uid,
    authorNumericUidKind: input.kind,
    authorName: input.display,
    authorSource: input.kind === 'user_id' ? 'comment_page' : 'total_comment',
    content: input.content,
    relationUncertain: false,
  } as unknown as NestedReply
}

function collected(nested: readonly NestedReply[]): CollectedThread {
  return {
    thread: THREAD,
    floors: [
      {
        floor: { ...FLOOR, nestedCount: nested.length },
        nested: [...nested],
        nestedComplete: true,
      },
    ],
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
  } as unknown as CollectedThread
}

// ── the reproduction ───────────────────────────────────────────────────────

test('P0 复现：帖子用 user_id 12345，主人配 tieba_uid 12345 —— 不得匹配', () => {
  const data = collected([
    replyWithUid({
      postId: 'r1',
      uid: '12345',
      kind: 'user_id',
      display: '小明',
      content: '我的看法。',
    }),
  ])

  // Both are `12345`. Different namespaces, so these are different accounts.
  assert.throws(
    () =>
      analyzeDispute(
        data,
        { userId: '12345', userIdNamespace: 'tieba_uid', platform: 'tieba' },
        { postId: 'r1' },
      ),
    /没有这个 ID|没有找到|命名空间|无法/,
    '跨命名空间的相同数字不得被当成同一个人',
  )
})

test('P0 复现：同一 user_id 数字应当正常匹配', () => {
  const data = collected([
    replyWithUid({ postId: 'r1', uid: '12345', kind: 'user_id', display: '小明', content: '我的看法。' }),
  ])
  const dispute = analyzeDispute(
    data,
    { userId: '12345', userIdNamespace: 'user_id', platform: 'tieba' },
    { postId: 'r1' },
  )
  assert.equal(dispute.ownerIdentityAssurance, 'verified')
  assert.equal(dispute.ownerIdentityEvidence.namespace, 'user_id', '证据必须记录实际观察到的命名空间')
})

test('P0 复现：同一 tieba_uid 数字应当正常匹配', () => {
  const data = collected([
    replyWithUid({ postId: 'r1', uid: '12345', kind: 'tieba_uid', display: '小明', content: '我的看法。' }),
  ])
  const dispute = analyzeDispute(
    data,
    { userId: '12345', userIdNamespace: 'tieba_uid', platform: 'tieba' },
    { postId: 'r1' },
  )
  assert.equal(dispute.ownerIdentityAssurance, 'verified')
  assert.equal(dispute.ownerIdentityEvidence.namespace, 'tieba_uid')
})

test('P0 复现：主人没写命名空间 —— 不得据此核验', () => {
  const data = collected([
    replyWithUid({ postId: 'r1', uid: '12345', kind: 'user_id', display: '小明', content: '我的看法。' }),
  ])
  assert.throws(
    () => analyzeDispute(data, { userId: '12345', platform: 'tieba' }, { postId: 'r1' }),
    /没有这个 ID|命名空间|无法|没有找到/,
    '不知道主人配的是哪个命名空间时，不能猜',
  )
})

test('P0 复现：跨平台的相同数字不得匹配', () => {
  const data = collected([
    replyWithUid({
      postId: 'r1',
      uid: '12345',
      kind: 'user_id',
      display: '小明',
      content: '我的看法。',
      platform: 'weibo',
    }),
  ])
  assert.throws(
    () =>
      analyzeDispute(
        data,
        { userId: '12345', userIdNamespace: 'user_id', platform: 'tieba' },
        { postId: 'r1' },
      ),
    /没有这个 ID|没有找到|平台|无法/,
    '另一个平台的同数字不是同一个人',
  )
})

test('P0：多来源合并时命名空间不能被覆盖', () => {
  // Two rows for the same account, both `user_id`, arriving from different surfaces.
  // The merged participant must keep the namespace, not lose it or inherit a later
  // row's kind.
  const data = collected([
    replyWithUid({ postId: 'r1', uid: '12345', kind: 'user_id', display: '小明', content: '第一句。' }),
    replyWithUid({ postId: 'r2', uid: '12345', kind: 'user_id', display: '小明', content: '第二句。' }),
  ])
  const dispute = analyzeDispute(
    data,
    { userId: '12345', userIdNamespace: 'user_id', platform: 'tieba' },
    { postId: 'r1' },
  )
  assert.equal(dispute.ownerIdentityAssurance, 'verified')
  assert.equal(dispute.ownerIdentityEvidence.namespace, 'user_id')
  assert.deepEqual(
    dispute.ownerStatements.map((entry) => entry.postId).sort(),
    ['r1', 'r2'],
    '同一账号的两条发言都算主人的',
  )
})
