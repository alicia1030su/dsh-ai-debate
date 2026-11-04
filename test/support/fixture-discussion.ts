/**
 * A fixed discussion, expressed as the HTML and JSON the Tieba adapter actually parses.
 *
 * ## Why this generates markup instead of mocking an adapter
 *
 * The point of the browser end-to-end run is to exercise the *production* chain:
 * real plugin routes, real `collectThread`, real `parseWapFloors`, real analysis. A
 * fake adapter would skip every parser and prove only that the UI can render objects
 * that tests invented — the exact gap that let v0.2.24's workbench ship broken.
 *
 * So this file produces the bytes a live server would return, and the fixture is
 * validated by feeding those bytes through the real parser (`fixture.test.ts`). If the
 * parser changes shape, that test fails and this data is corrected, rather than the
 * GUI run quietly testing nothing.
 *
 * ## What the data must contain, and why each piece exists
 *
 * - Three floors, three nested replies, at least one author posting twice → the
 *   "which of this author's posts did you mean" case that v0.2.25 fixed.
 * - Two different accounts sharing one display name → identity must come from the
 *   handle, not the name.
 * - A nested reply with a parent floor that is not the dispute floor → the parent
 *   must follow the selection.
 * - A comment with no author identity at all → `unverified`, never quietly `verified`.
 * - A comparable identity conflict → two sources disagreeing about one post.
 * - A page 2 that fails → the read is incomplete and must say so.
 */

/** One floor as this fixture describes it, before it becomes markup. */
export interface FixtureFloor {
  readonly postId: string
  readonly floorNumber: number
  readonly authorHandle?: string
  readonly authorName?: string
  readonly numericUid?: number
  readonly content: string
  readonly nestedCount?: number
}

/** One nested reply. */
export interface FixtureNested {
  readonly postId: string
  readonly parentPostId: string
  readonly authorHandle?: string
  readonly authorName?: string
  readonly numericUid?: number
  readonly content: string
}

/**
 * The fixed discussion.
 *
 * `forumId` and `threadId` are deliberately non-numeric-looking constants so a stray
 * real request can never be mistaken for this data.
 */
export const THREAD_ID = '900100200'
export const FORUM_ID = '24342155'
export const FORUM_NAME = '隔离验收吧'

export const FLOORS: readonly FixtureFloor[] = [
  {
    postId: '9100000001',
    floorNumber: 1,
    authorHandle: 'owner_un',
    authorName: '楼主本人',
    numericUid: 500001,
    content: '开个帖聊聊这件事。我认为方案 A 更合适，理由有三点。',
    nestedCount: 3,
  },
  {
    postId: '9100000002',
    floorNumber: 2,
    // Same display name as floor 3's author, different account. The display name is
    // not an identity, and this pair is what proves the code knows that.
    authorHandle: 'twin_a',
    authorName: '同名用户',
    numericUid: 500002,
    content: '方案 A 明显有问题，成本太高了。',
    nestedCount: 1,
  },
  {
    postId: '9100000003',
    floorNumber: 3,
    authorHandle: 'twin_b',
    authorName: '同名用户',
    numericUid: 500003,
    content: '我也叫这个名字，但我和楼上不是一个人。方案 A 其实还行。',
    nestedCount: 1,
  },
]

export const NESTED: readonly FixtureNested[] = [
  {
    postId: '9200000001',
    parentPostId: '9100000001',
    authorHandle: 'twin_a',
    authorName: '同名用户',
    numericUid: 500002,
    content: '回复 楼主本人 : 成本高一倍，这不是小问题。',
  },
  {
    postId: '9200000002',
    parentPostId: '9100000002',
    authorHandle: 'owner_un',
    authorName: '楼主本人',
    numericUid: 500001,
    content: '回复 同名用户 : 成本可以分摊到三年。',
  },
  {
    postId: '9200000003',
    parentPostId: '9100000003',
    // No handle, no uid: a legacy-looking row. It must land as `unverified`, and it
    // must never be promoted by proximity to the verified rows above.
    authorName: '路过的匿名',
    content: '回复 同名用户 : 路过看看。',
  },
]

/** The post that a "reply to this one" selection is expected to address. */
export const PICKED_NESTED_POST_ID = '9200000001'
/** The floor it hangs under — the parent must follow the pick, not the dispute floor. */
export const PICKED_PARENT_POST_ID = '9100000001'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** `data-info` as the WAP page writes it: HTML-escaped JSON. */
function dataInfo(parts: {
  handle?: string
  name?: string
  uid?: number
}): string {
  const info: Record<string, unknown> = {}
  if (parts.handle !== undefined) info.un = parts.handle
  if (parts.name !== undefined) info.name_show = parts.name
  if (parts.uid !== undefined) info.user_id = parts.uid
  // The page HTML-escapes the attribute, so quotes become entities.
  return escapeHtml(JSON.stringify(info))
}

function renderFloor(floor: FixtureFloor): string {
  const author = floor.authorName ?? '匿名'
  // ## No `user_id` here, and that is not an omission
  //
  // A live WAP floor page carries `{un, is_annoy, pid, floor_num, name_show}` — no
  // numeric uid anywhere in `data-info`. Verified against a real captured page in
  // `test/fixtures/wap-page1.html`.
  //
  // An earlier version of this fixture added one, and the effect was not cosmetic: the
  // same person then keyed as `uid:tieba:unstated:500001` on a floor and as
  // `handle:tieba:owner_un` in a nested reply, because nested pages publish a handle and
  // no uid. Two keys for one human made the owner look like a stranger in their own
  // floor, and the first read confidently named the owner as the opponent to argue
  // with. `numericUid` stays on the data model — `totalComment` is the surface that
  // publishes it — but it does not go into floor markup, because real pages do not.
  const info = dataInfo({
    ...(floor.authorHandle === undefined ? {} : { handle: floor.authorHandle }),
    name: author,
  })
  // `findFloorAnchors` requires exactly this attribute order and spacing.
  return [
    `<li tid="${floor.postId}" data-tid="${floor.postId}" fn="${floor.floorNumber}" data-info="${info}">`,
    `<div class="floor_head"><a href="javascript:;" class="user_name">${escapeHtml(author)}</a></div>`,
    `<div class="floor_content">${escapeHtml(floor.content)}</div>`,
    // `readNestedCount` matches `j_floor_panel"…data-list-count="N"`. Without this
    // exact shape the floor parses with `nestedCount: undefined`, the collector never
    // asks for that floor's replies, and the workbench shows an empty tree that looks
    // like a thread with no discussion.
    floor.nestedCount === undefined
      ? ''
      : `<div class="j_floor_panel" data-list-count="${floor.nestedCount}"></div>`,
    '</li>',
  ].join('')
}

/** The floor-list page. `page` 1 carries every floor; there is no page 2. */
export function wapPageHtml(page = 1): string {
  if (page !== 1) {
    // Reached only by a bug or by the deliberate "page 2 fails" case.
    return '<!DOCTYPE HTML><html><head><meta charset="utf-8"></head><body></body></html>'
  }
  return [
    '<!DOCTYPE HTML><html><head><meta charset="utf-8">',
    `<title>隔离验收帖_贴吧</title>`,
    '</head><body>',
    // ## The four things the publish path reads from this page
    //
    // `parseWapThreadMeta` takes `fid` and `itb_tbs` from the raw HTML, and
    // `readAuthFromHtml` takes the login banner from `data_editor`. Without them the
    // publish would stop at "没有拿到贴吧 CSRF token" or "未登录" — which would look
    // like a passing safety check while proving nothing about the publish path.
    //
    // These values describe the *simulated* account this fixture host is logged in as
    // (`ai_account` / 600001). They are not real credentials and grant nothing.
    `<script>var itb_tbs: 'deadbeefcafe', fid: "24342155", forum_name: "隔离验收吧";</script>`,
    `<script>var data_editor: {"can_post":1,"forbid_flag":0,"user":{"uid":600001,"is_login":1,"user_id":600001}}, base_url: "/";</script>`,
    '<div class="th_title">隔离验收帖</div>',
    `<ul class="flist" data-total="${FLOORS.length}">`,
    ...FLOORS.map(renderFloor),
    '</ul>',
    '</body></html>',
  ].join('')
}

/** The `/p/totalComment` response: which floors have how many replies. */
export function totalCommentJson(): string {
  const data: Record<string, unknown> = {}
  for (const floor of FLOORS) {
    data[floor.postId] = {
      post_id: floor.postId,
      reply_num: floor.nestedCount ?? 0,
      // `totalComment` is the surface that publishes numeric ids. Supplying them here
      // is what makes the numeric-vs-handle distinction observable.
      user_id: floor.numericUid ?? 0,
    }
  }
  return JSON.stringify({ no: 0, data })
}

/**
 * One `/p/comment` page: the nested replies for a floor.
 *
 * The markup is the shape `parseCommentPage` actually reads: `<li class="lzl_single_post">`
 * rows carrying a `data-field` JSON blob, with the body inside
 * `<span class="lzl_content_main">`. Getting this wrong produces an empty reply list
 * rather than an error, which is why `fixture-discussion.test.ts` asserts the parsed
 * result rather than trusting the template.
 *
 * The conflict case is injected through `conflictPostId`, because a conflict is a
 * relationship between two reads rather than a property of one page.
 */
export function commentPageJson(parentPostId: string, options: { conflictPostId?: string } = {}): string {
  const rows = NESTED.filter((reply) => reply.parentPostId === parentPostId)
  const items = rows.map((reply) => {
    const conflicted = reply.postId === options.conflictPostId
    const field = {
      spid: Number(reply.postId),
      pid: Number(parentPostId),
      // On the conflicting row the two surfaces disagree: this one names a different
      // account than `totalCommentJson` does for the same post id.
      un: conflicted ? 'someone_else' : (reply.authorHandle ?? ''),
      user_id: conflicted ? 500099 : (reply.numericUid ?? 0),
      name: reply.authorName ?? '',
      content: reply.content,
    }
    return [
      `<li class="lzl_single_post" data-field='${escapeHtml(JSON.stringify(field))}'>`,
      // NOT wrapped in an outer `<a>`: `findAnchors` matches `<a …>([\s\S]*?)</a>`,
      // so an outer anchor swallows the inner author anchor into its `inner` text and
      // the author is never seen. That is what the real page does too — the wrapper
      // is a span.
      `<span class="lzl_panel_wrapper"><span class="lzl_cnt">`,
      // `parseCommentPage` reads the author handle from this `username` attribute,
      // not from `data-field.un`. A conflict fixture that only changed the JSON would
      // have produced two surfaces that agree, and the conflict test would have been
      // asserting something that never happened.
      `<a class="at" username="${escapeHtml(conflicted ? 'someone_else' : (reply.authorHandle ?? ''))}">${escapeHtml(reply.authorName ?? '')}</a>`,
      `<span class="lzl_content_main">${escapeHtml(reply.content)}</span>`,
      `</span></span>`,
      `</li>`,
    ].join('')
  })
  return [
    `{"total_num":${rows.length},"total_page":1}`,
    '<ul class="lzl_list">',
    ...items,
    '</ul>',
  ].join('')
}

/** Count of nested replies this fixture will serve, for assertions. */
export const NESTED_COUNT = NESTED.length
