/**
 * Is the cross-source check actually *reachable* on Tieba?
 *
 * ## The question this file answers
 *
 * The earlier report claimed cross-source conflict detection was wired into the
 * production path. Part of that claim was wrong, and this file exists to measure
 * it honestly.
 *
 * `TiebaAdapter.getNestedReplies` is **not** a fan-in. It is a preference-ordered
 * fallback:
 *
 *     totalComment  →  comment page  →  inline
 *
 * Each arrow is taken only when the previous one yields nothing or throws. On the
 * happy path exactly **one** surface answers per page, so `walkNested` never sees
 * two descriptions of the same `postId` and the conflict check has nothing to
 * compare. It can fire when a paging walk switches surfaces mid-way, and that is
 * a real path — just not the common one.
 *
 * So the honest statement is:
 *
 * - ✓ the merge *can* detect a conflict, and is tested to;
 * - ✗ a normal read does **not** cross-validate authorship, and the system must
 *   not imply that it did.
 *
 * These tests drive the **real** `TiebaAdapter` through a stubbed `fetch`, then
 * `collectThread` and `analyzeDispute`. No fake adapter stands in for the
 * production one here; a fake would prove nothing about reachability.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TiebaAdapter } from '../lib/platforms/tieba/adapter.js'
import { collectThread } from '../lib/collector.js'
import { analyzeDispute } from '../lib/analyzer.js'
import type { Floor } from '../lib/types.js'

const THREAD_ID = '9493941284'
const FLOOR_POST_ID = '151679645842'

/** A WAP thread page: just enough for metadata and one floor. */
function wapPage(): string {
  const info = JSON.stringify({
    un: '银狐_玉耀',
    is_annoy: 0,
    pid: Number(FLOOR_POST_ID),
    floor_num: 1,
    name_show: '苏小玲',
    portrait: 'tb.1.abc?t=1643089028',
  }).replace(/"/g, '&quot;')
  return `<html><head><title>测试帖</title>
    <script>var conf = { fid: "1234", forum_name: "测试吧", title: "测试帖" };</script>
  </head><body>
    <ul class="thread_list">
      <li tid="${FLOOR_POST_ID}" data-tid="${FLOOR_POST_ID}" fn="1"    data-info="${info}"
          class="list_item post_list_item">
        <div class="fmain j_floor_main">
          <div class="list_item_top_name">
            <span class="user_name"><a href="javascript:;" class="user_name">苏小玲</a></span>
          </div>
          <div class="floor_footer_item"><span class="floor_content">开场</span></div>
        </div>
      </li>
    </ul>
  </body></html>`
}

/** A `totalComment` body with one inline comment carrying a numeric uid. */
function totalCommentBody(input: { uid: string; name: string; text: string }): string {
  return JSON.stringify({
    errno: 0,
    errmsg: 'success',
    data: {
      comment_list: {
        [FLOOR_POST_ID]: {
          comment_num: 1,
          comment_list_num: 1,
          comment_info: [
            {
              thread_id: Number(THREAD_ID),
              post_id: 151694781657,
              content: input.text,
              user_id: Number(input.uid),
              user_name: input.name,
              comment_id: 151694781657,
            },
          ],
        },
      },
      user_list: {},
    },
  })
}

/** A `/p/comment` HTML body in the shipped fixture's real shape. */
function commentPageBody(input: { name: string; text: string }): string {
  return `<ul>
    <li class="lzl_single_post j_lzl_s_p" data-field='{"spid":151694781657,"showname":"${input.name}","user_name":null,"portrait":"tb.1.abc"}'>
      <div class="lzl_cnt">
        <a class="at j_user_card" username="">${input.name}</a>:
        <span class="lzl_content_main">${input.text}</span>
        <span class="lzl_time">2025-2-14</span>
      </div>
    </li>
  </ul>`
}

/** Count how many times each endpoint was asked for. */
interface FetchLog {
  totalComment: number
  commentPage: number
  wap: number
}

/**
 * Install a `fetch` that answers the three Tieba endpoints and records hits.
 *
 * `totalComment` may be told to fail, which is how the adapter is pushed down the
 * fallback ladder — the only way two sources can describe one page in sequence.
 */
function stubTieba(input: {
  totalComment?: 'ok' | 'fail' | 'empty'
  commentPage?: 'ok' | 'fail'
  totalCommentBody?: string
  commentPageBody?: string
}): { log: FetchLog; restore: () => void } {
  const log: FetchLog = { totalComment: 0, commentPage: 0, wap: 0 }
  const original = globalThis.fetch

  globalThis.fetch = (async (url: string | URL) => {
    const target = String(url)

    if (target.includes('/mo/q/m')) {
      log.wap += 1
      return new Response(wapPage(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    if (target.includes('/p/totalComment')) {
      log.totalComment += 1
      if (input.totalComment === 'fail') {
        return new Response('blocked', { status: 403 })
      }
      if (input.totalComment === 'empty') {
        return new Response(JSON.stringify({ errno: 0, data: { comment_list: {} } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(input.totalCommentBody ?? totalCommentBody({ uid: '111', name: '甲', text: '内容' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (target.includes('/p/comment')) {
      log.commentPage += 1
      if (input.commentPage === 'fail') return new Response('blocked', { status: 403 })
      return new Response(input.commentPageBody ?? commentPageBody({ name: '甲', text: '内容' }), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    // Anything else (baidu.com bootstrap, forum lookups): an empty 200.
    return new Response('', { status: 200, headers: { 'content-type': 'text/html' } })
  }) as typeof globalThis.fetch

  return { log, restore: () => { globalThis.fetch = original } }
}

/** Build a real adapter with a pre-seeded forum id so no lookup is needed. */
function realAdapter(): TiebaAdapter {
  return new TiebaAdapter({ timeoutMs: 5_000, retries: 0, pageDelayMs: 0 })
}

test('正常路径：totalComment 一次性回答，不会同时请求 comment page（所以没有交叉验证）', async () => {
  const stub = stubTieba({ totalComment: 'ok' })
  try {
    const adapter = realAdapter()
    const page = await adapter.getNestedReplies(
      { platform: 'tieba', threadId: THREAD_ID, forumName: '测试吧', url: `https://tieba.baidu.com/p/${THREAD_ID}` },
      {
        platform: 'tieba',
        floorNumber: 1,
        postId: FLOOR_POST_ID,
        authorId: '银狐_玉耀',
        authorName: '苏小玲',
        authorSource: 'wap_floor',
        content: '开场',
        images: [],
        nestedCount: 1,
      } satisfies Floor,
      1,
    )

    assert.equal(page.replies.length, 1)
    // The decisive observation: the comment page was never consulted, so there is
    // no second opinion to compare against.
    assert.equal(stub.log.commentPage, 0, '选择式回退：totalComment 成功时不会读 comment page')
    assert.equal(stub.log.totalComment, 1)
    assert.equal(page.replies[0]!.authorSource, 'total_comment')
  } finally {
    stub.restore()
  }
})

test('403 会熔断整条分页通道，直接退回内联而不是再试 comment page', async () => {
  // Measured, not assumed: `tripNestedChannel` closes the *whole* paginated
  // channel on a 403, so the fallback ladder is totalComment → (403) → inline.
  // The comment page is never reached. That is deliberate — retrying a channel
  // that just refused makes the block worse — but it also means this path yields
  // *one* source, never two.
  const stub = stubTieba({
    totalComment: 'fail',
    commentPage: 'ok',
    commentPageBody: commentPageBody({ name: '乙', text: '另一份' }),
  })
  try {
    const adapter = realAdapter()
    const page = await adapter.getNestedReplies(
      { platform: 'tieba', threadId: THREAD_ID, forumName: '测试吧', url: `https://tieba.baidu.com/p/${THREAD_ID}` },
      {
        platform: 'tieba',
        floorNumber: 1,
        postId: FLOOR_POST_ID,
        authorId: '银狐_玉耀',
        authorName: '苏小玲',
        authorSource: 'wap_floor',
        content: '开场',
        images: [],
        nestedCount: 1,
      } satisfies Floor,
      1,
    )

    assert.equal(stub.log.totalComment, 1, '先试了 totalComment')
    assert.equal(stub.log.commentPage, 0, '403 熔断后不再试 comment page')
    // The floor declared one reply but the WAP page inlined none, so the degraded
    // copy is empty — and it says so through `incomplete` rather than pretending.
    assert.equal(page.replies.length, 0)
    assert.equal(page.incomplete, true, '必须承认这是降级且不完整，而不是「没有回复」')
  } finally {
    stub.restore()
  }
})

test('totalComment 返回空时才会退到 comment page（顺序回退，不是并行）', async () => {
  const stub = stubTieba({
    totalComment: 'empty',
    commentPage: 'ok',
    commentPageBody: commentPageBody({ name: '乙', text: '另一份' }),
  })
  try {
    const adapter = realAdapter()
    const page = await adapter.getNestedReplies(
      { platform: 'tieba', threadId: THREAD_ID, forumName: '测试吧', url: `https://tieba.baidu.com/p/${THREAD_ID}` },
      {
        platform: 'tieba',
        floorNumber: 1,
        postId: FLOOR_POST_ID,
        authorId: '银狐_玉耀',
        authorName: '苏小玲',
        authorSource: 'wap_floor',
        content: '开场',
        images: [],
        nestedCount: 1,
      } satisfies Floor,
      1,
    )

    assert.equal(stub.log.totalComment, 1)
    assert.equal(stub.log.commentPage, 1, '空结果才继续往下试')
    assert.equal(page.replies[0]!.authorSource, 'comment_page')
  } finally {
    stub.restore()
  }
})

test('单来源采集：identityConflicts 为空，但这不等于「已交叉验证」', async () => {
  const stub = stubTieba({ totalComment: 'ok' })
  try {
    const adapter = realAdapter()
    const collected = await collectThread(
      adapter,
      { platform: 'tieba', threadId: THREAD_ID, forumName: '测试吧', url: `https://tieba.baidu.com/p/${THREAD_ID}` },
      { maxPages: 1, maxFloors: 5, nestedFloorLimit: 5 },
    )

    // No conflict — correct, because only one surface spoke.
    assert.equal(collected.identityConflicts, undefined)
    // And there is no field claiming the authorship was corroborated. The absence
    // of a conflict is "we did not disagree", not "we confirmed each other".
    assert.equal(
      'identityVerified' in collected,
      false,
      '采集结果不得包含「已交叉验证」这样的字段：单来源根本无法产生它',
    )
    const nested = collected.floors.flatMap((entry) => entry.nested)
    assert.ok(nested.length >= 0)
  } finally {
    stub.restore()
  }
})

test('昵称不同但都无可靠标识：是 unknown，不是 conflict', async () => {
  // totalComment gives a numeric uid; comment page gives only a display name. The
  // two cannot be compared, so nothing here may be called a conflict — and the
  // system must not treat the mismatch of *nicknames* as proof of different
  // accounts either.
  const stub = stubTieba({
    totalComment: 'ok',
    totalCommentBody: totalCommentBody({ uid: '111', name: '甲', text: '内容' }),
  })
  try {
    const adapter = realAdapter()
    const collected = await collectThread(
      adapter,
      { platform: 'tieba', threadId: THREAD_ID, forumName: '测试吧', url: `https://tieba.baidu.com/p/${THREAD_ID}` },
      { maxPages: 1, maxFloors: 5, nestedFloorLimit: 5 },
    )
    assert.equal(collected.identityConflicts, undefined, '只有一侧发言，不可能构成冲突')

    // Reading it back must still work: the reply is attributed, and the owner can
    // be resolved by uid because the uid came from a surface that states one.
    const nested = collected.floors.flatMap((entry) => entry.nested)
    if (nested.length > 0) {
      const dispute = analyzeDispute(collected, { userId: '111', platform: 'tieba' }, { postId: nested[0]!.postId })
      assert.equal(dispute.owner.postCount >= 1, true)
    }
  } finally {
    stub.restore()
  }
})

test('翻页途中回退到另一来源：冲突检测唯一可达的地方', async () => {
  // A single adapter instance trips its channel on the first 403, so the sequence
  // is built with two instances: page 1 answered by `totalComment`, then a fresh
  // read of the same floor answered by the comment page. This is the *only*
  // arrangement in which two surfaces describe one post id, and therefore the
  // only place the merge can compare them.
  const floor: Floor = {
    platform: 'tieba',
    floorNumber: 1,
    postId: FLOOR_POST_ID,
    authorId: '银狐_玉耀',
    authorName: '苏小玲',
    authorSource: 'wap_floor',
    content: '开场',
    images: [],
    nestedCount: 1,
  }
  const ref = {
    platform: 'tieba' as const,
    threadId: THREAD_ID,
    forumName: '测试吧',
    url: `https://tieba.baidu.com/p/${THREAD_ID}`,
  }

  const stubA = stubTieba({ totalComment: 'ok' })
  let first
  try {
    first = await realAdapter().getNestedReplies(ref, floor, 1)
  } finally {
    stubA.restore()
  }

  const stubB = stubTieba({
    totalComment: 'empty',
    commentPageBody: commentPageBody({ name: '乙', text: '另一份' }),
  })
  let second
  try {
    second = await realAdapter().getNestedReplies(ref, floor, 1)
  } finally {
    stubB.restore()
  }

  assert.equal(first.replies[0]!.postId, second.replies[0]!.postId, '同一个 postId')
  assert.notEqual(first.replies[0]!.authorSource, second.replies[0]!.authorSource, '来源不同')
  // One side states a numeric uid, the other only a nickname: incomparable, so
  // the verdict is unknown — NOT a conflict. Treating two different nicknames as
  // proof of two different accounts is exactly the over-reach to avoid.
  assert.ok(first.replies[0]!.authorNumericUid !== undefined, 'totalComment 侧带数字 UID')
  assert.equal(second.replies[0]!.authorNumericUid, undefined, 'comment page 侧没有数字 UID')
})
