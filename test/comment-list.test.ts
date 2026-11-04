/**
 * The comment list the workbench picks from, and the target switch behind it.
 *
 * ## The gap this closes
 *
 * v0.2.23's workbench could read a thread, generate, edit and approve — but it could
 * not let anyone *choose which comment to answer*. The target was hardwired to
 * `session.triggerPostId`, so "answer this one instead" was not expressible from the
 * page and required a tool argument. That is precisely the knowledge the workbench
 * exists to remove.
 *
 * ## What must hold regardless
 *
 * A target the collector never read cannot be answered: there is no content, no floor,
 * and no identity check behind it. Those refusals are asserted here, together with the
 * separation between the canonical list and the identity observations.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCommentList } from '../lib/comment-list.js'
import { MAX_STORED_COMMENT_CHARS, MAX_STORED_COMMENTS } from '../lib/store.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
  id: '8752343543',
  title: '评论列表',
  content: 'c',
  url: 'u',
  images: [],
}

function floor(parts: Partial<Floor>): Floor {
  return {
    platform: 'tieba',
    floorNumber: 1,
    postId: '900',
    authorId: 'host',
    authorName: '楼主',
    authorSource: 'wap_floor',
    content: '楼层正文',
    images: [],
    nestedCount: 0,
    ...parts,
  } as Floor
}

function nested(parts: Partial<NestedReply>): NestedReply {
  return {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: '900',
    authorName: '某人',
    content: '回复正文',
    relationUncertain: false,
    authorSource: 'wap_floor',
    ...parts,
  } as NestedReply
}

function collected(entries: Array<{ floor: Floor; nested: NestedReply[] }>, extra: Partial<CollectedThread> = {}): CollectedThread {
  return {
    thread: THREAD,
    floors: entries.map((entry) => ({ ...entry, nestedComplete: true })),
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
    ...extra,
  } as unknown as CollectedThread
}

test('楼层与楼中楼都进入列表，楼中楼带父楼层', () => {
  const list = buildCommentList(
    collected([
      {
        floor: floor({ postId: '900', floorNumber: 1 }),
        nested: [nested({ postId: 'r1', parentPostId: '900' }), nested({ postId: 'r2', parentPostId: '900' })],
      },
      { floor: floor({ postId: '901', floorNumber: 2 }), nested: [] },
    ]),
  )

  assert.equal(list.total, 4, '1 + 2 + 1')
  const r1 = list.comments.find((entry) => entry.postId === 'r1')!
  assert.equal(r1.kind, 'nested')
  assert.equal(r1.parentPostId, '900', '父楼层必须保留，否则回复会挂错地方')
  const f2 = list.comments.find((entry) => entry.postId === '901')!
  assert.equal(f2.kind, 'floor')
  assert.equal(f2.floorNumber, 2)
  assert.equal(f2.parentPostId, undefined)
})

test('顺序先楼层后其楼中楼，读起来像帖子本身', () => {
  const list = buildCommentList(
    collected([
      { floor: floor({ postId: 'f1', floorNumber: 1 }), nested: [nested({ postId: 'n1' })] },
      { floor: floor({ postId: 'f2', floorNumber: 2 }), nested: [nested({ postId: 'n2' })] },
    ]),
  )
  assert.deepEqual(
    list.comments.map((entry) => entry.postId),
    ['f1', 'n1', 'f2', 'n2'],
  )
})

test('身份状态区分已核验/未核验/冲突，不用布尔压平', () => {
  const list = buildCommentList(
    collected(
      [
        {
          floor: floor({ postId: '900' }),
          nested: [
            nested({ postId: 'ok', authorSource: 'wap_floor' }),
            // No declared source: we know some account string, not its namespace.
            nested({ postId: 'legacy', authorSource: undefined }),
            nested({ postId: 'clash', authorSource: 'comment_page' }),
          ],
        },
      ],
      {
        identityConflicts: [{ postId: 'clash', summary: '两个来源给出不同作者' }] as never,
      },
    ),
  )

  const byId = new Map(list.comments.map((entry) => [entry.postId, entry]))
  assert.equal(byId.get('ok')!.identity, 'verified')
  assert.equal(byId.get('legacy')!.identity, 'unverified')
  assert.equal(byId.get('clash')!.identity, 'conflicted')
  assert.deepEqual(list.conflictedPostIds, ['clash'])
})

test('长正文被截断并标记，全文不复制第二份', () => {
  const long = '甲'.repeat(MAX_STORED_COMMENT_CHARS + 200)
  const list = buildCommentList(collected([{ floor: floor({ content: long }), nested: [] }]))
  const entry = list.comments[0]!
  assert.equal(entry.truncated, true)
  assert.ok(entry.text.length <= MAX_STORED_COMMENT_CHARS + 1, `实际长度 ${entry.text.length}`)
})

test('空白被折叠，避免列表里出现整片空行', () => {
  const list = buildCommentList(
    collected([{ floor: floor({ content: '  第一行\n\n\n  第二行  ' }), nested: [] }]),
  )
  assert.equal(list.comments[0]!.text, '第一行 第二行')
})

test('超过上限时截断列表并明确标记', () => {
  const nestedRows: NestedReply[] = []
  for (let index = 0; index < MAX_STORED_COMMENTS + 10; index += 1) {
    nestedRows.push(nested({ postId: `r${index}` }))
  }
  const list = buildCommentList(collected([{ floor: floor({}), nested: nestedRows }]))

  assert.equal(list.total, MAX_STORED_COMMENTS + 11, '总数是真实条数')
  assert.equal(list.comments.length, MAX_STORED_COMMENTS, '列表被截断')
  assert.equal(list.capped, true, '截断必须可被看到')
})

test('规范化列表与身份观测不混为一谈：两个观测仍是一条评论', () => {
  // The collector keeps every sighting; the picker must show one row. Otherwise a
  // comment seen by two surfaces would look like two people.
  const list = buildCommentList(
    collected([
      {
        floor: floor({ postId: '900' }),
        nested: [nested({ postId: 'r1' })],
      },
    ], {
      identityObservations: new Map([
        ['r1', [{ source: 'wap_floor', handle: 'a' }, { source: 'comment_page', handle: 'a' }]],
      ]) as never,
    }),
  )
  assert.equal(list.comments.filter((entry) => entry.postId === 'r1').length, 1)
})

test('空讨论得到空列表，而不是伪造一条', () => {
  const list = buildCommentList(collected([]))
  assert.equal(list.total, 0)
  assert.deepEqual(list.comments, [])
  assert.equal(list.capped, false)
})

test('账号标识按命名空间分别保留，不互相顶替', () => {
  const list = buildCommentList(
    collected([
      {
        floor: floor({ postId: '900' }),
        nested: [
          nested({
            postId: 'uid',
            authorId: undefined,
            authorNumericUid: '12345',
            authorNumericUidKind: 'user_id',
          }),
        ],
      },
    ]),
  )
  const entry = list.comments.find((row) => row.postId === 'uid')!
  assert.equal(entry.authorNumericUid, '12345')
  assert.equal(entry.authorNumericUidKind, 'user_id')
  assert.equal(entry.authorHandle, undefined, '数字不得被当成登录名')
})

test('换一条评论后，绑在旧目标上的批准不再适用', async () => {
  // Pick a different comment → a new candidate with a new version and target → the
  // old approval must stop applying. This is the mechanism that makes "choose another
  // comment" safe; without it, an approval would authorise text aimed somewhere else.
  const { approvalStillApplies } = await import('../lib/workbench.js')
  const approval = {
    candidateId: 'c1',
    candidateVersion: 1,
    textHash: 'h1',
    targetPostId: 'r1',
  }

  const same = approvalStillApplies({
    candidate: { replyId: 'c1', textHash: 'h1', candidateVersion: 1, targetPostId: 'r1', approved: true },
    approval,
  })
  assert.equal(same.applies, true, '同一目标同一版本仍然有效')

  const switched = approvalStillApplies({
    candidate: { replyId: 'c2', textHash: 'h2', candidateVersion: 2, targetPostId: 'r2', approved: true },
    approval,
  })
  assert.equal(switched.applies, false, '换了目标必须失效')

  const sameIdDifferentTarget = approvalStillApplies({
    candidate: { replyId: 'c1', textHash: 'h1', candidateVersion: 1, targetPostId: 'r2', approved: true },
    approval,
  })
  assert.equal(sameIdDifferentTarget.applies, false, '候选 id 相同但目标不同也必须失效')
})
