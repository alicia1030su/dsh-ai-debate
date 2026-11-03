/**
 * Fixtures for the author-identity split (v0.2.23).
 *
 * Every case here is built from the *shape* observed on the live thread
 * `9493941284` during phase 14 (its WAP page, its inline nested list, and the
 * comment-page `lzl_single_post` rows). The strings are synthesised so no real
 * account is reproduced; the markup structure is not — it is what the parser has
 * to survive.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseWapFloors,
  parseInlineNested,
  parseCommentPage,
} from '../lib/platforms/tieba/parse.js'

/**
 * One WAP floor, in the structure the mobile page really uses.
 *
 * Details that matter and are therefore reproduced:
 *
 * - `findFloorAnchors` keys on `<li tid="…" data-tid="…" fn="…">`.
 * - `data-info` is **double**-quoted with `&quot;` entities inside, while the
 *   inline nested rows use a single-quoted attribute. Both styles appear in
 *   one page; normalising them in the fixture would stop testing the parser.
 * - The author's display name live inside an `<a class="user_name">` that also
 *   carries a `nicknameEmoji` `<img>`, so the text has to be flattened.
 */
function wapFloor(input: {
  pid: string
  floor: number
  un?: string
  showname?: string
  content?: string
  nested?: string
}): string {
  const info = JSON.stringify({
    ...(input.un === undefined ? {} : { un: input.un }),
    is_annoy: 0,
    pid: Number(input.pid),
    floor_num: input.floor,
    ...(input.showname === undefined ? {} : { name_show: input.showname }),
    portrait: 'tb.1.3eb5ad5e.HmV9Nb53cH52TnfxL2HLbA?t=1643089028',
  }).replace(/"/g, '&quot;')
  const nested =
    input.nested === undefined
      ? ''
      : `<div class="fr_list ${String(input.floor)} j_floor_panel" data-list-count="5">
           <ul class="flist">${input.nested}</ul>
         </div>`
  const shown = input.showname ?? input.un ?? ''
  return `<li tid="${input.pid}" data-tid="${input.pid}" fn="${String(input.floor)}"    data-info="${info}"    class="list_item post_list_item default_feedback">
    <div class="fmain j_floor_main">
      <div class="list_item_top_name">
        <span class="user_name"><a href="javascript:;" class="user_name">${shown}</a></span>
      </div>
      <div class="floor_footer_item">
        <span class="floor_content">${input.content ?? '正文'}</span>
      </div>
    </div>
    ${nested}
  </li>`
}

/** One inline nested row: `un` only, never a numeric uid. */
function inlineNested(input: { pid: string; un: string; name: string; body: string }): string {
  return `<li pid="${input.pid}" data-info='{"pid":${input.pid},"un":"${input.un}"}'
    class="list_item_floor j_list_item_floor">
    <div class="fmain j_floor_main">
      <div class="floor_footer_item">
        <a href="/home/main?un=${input.un}" class="user_name ">${input.name}:</a>
        <span class="floor_content">${input.body}</span>
      </div>
    </div>
  </li>`
}

/**
 * One comment-page row.
 *
 * The lead markup deliberately carries **two** anchors, author first and reply
 * target second, because that is the shape that broke v0.2.22: it took the first
 * `at`-classed anchor, which is the author here but is *not* guaranteed to be by
 * position alone. The `username` attribute is what actually marks the account.
 */
function commentRow(input: {
  spid: string
  authorHandle: string
  authorName: string
  replyTo?: string
  body: string
}): string {
  const target =
    input.replyTo === undefined
      ? ''
      : `回复 <a class="at" username="${input.replyTo}">${input.replyTo}</a>：`
  return `<li class="lzl_single_post j_lzl_single_post" data-field='{"spid":${input.spid},"user_name":"${input.authorHandle}","showname":"${input.authorName}"}'>
    <div class="lzl_cnt">
      <a class="at" username="${input.authorHandle}">${input.authorName}</a>：
      <span class="lzl_content_main">${target}${input.body}</span>
      <span class="lzl_time">2025-2-14</span>
    </div>
  </li>`
}

test('WAP 楼层的 authorId 是登录名，不是数字 UID', () => {
  const html = wapFloor({
    pid: '151679645842',
    floor: 1,
    un: '银狐_玉耀',
    showname: '苏小玲',
    content: '今天的组队真难',
  })
  const floors = parseWapFloors(html)
  assert.equal(floors.length, 1)
  const floor = floors[0]!.floor
  assert.equal(floor.authorId, '银狐_玉耀', 'authorId 存的是 un')
  assert.equal(floor.authorName, '苏小玲', 'authorName 存的是显示名')
  assert.equal(floor.authorNumericUid, undefined, 'WAP 不提供数字 UID，不能凭空填')
  assert.equal(floor.authorSource, 'wap_floor', '必须标明来源，供上层判断可比性')
})

test('WAP 上的 un 即使是纯数字，也不能被当成数字 UID', () => {
  // The live thread had `un="1254480024"`. If this were copied into the uid
  // namespace it would equal a real uid belonging to somebody else.
  const html = wapFloor({ pid: '151690629791', floor: 5, un: '1254480024', showname: '寻º乐' })
  const floor = parseWapFloors(html)[0]!.floor
  assert.equal(floor.authorId, '1254480024')
  assert.equal(
    floor.authorNumericUid,
    undefined,
    '纯数字的登录名仍然是登录名：命名空间由来源决定，不是由文本决定',
  )
  assert.equal(floor.authorSource, 'wap_floor')
})

test('内联楼中楼带上 authorSource，且不冒充数字 UID', () => {
  const nested = inlineNested({
    pid: '151694781657',
    un: '银狐_玉耀',
    name: '苏小玲',
    body: '回复 寻º乐 :这个首饰能减冷却',
  })
  const html = `<ul class="flist">${nested}</ul>`
  const parsed = parseInlineNested(html, '151679645842')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]!.reply.authorSource, 'wap_inline')
  assert.equal(parsed[0]!.reply.authorId, '银狐_玉耀')
  assert.equal(parsed[0]!.reply.authorNumericUid, undefined)
  assert.equal(parsed[0]!.reply.replyToName, '寻º乐', '回复对象是另一个人，不能混进作者')
})

test('comment page：作者取自 username 属性，不取文档里第一个 at 锚点', () => {
  // The row answers `寻º乐`; v0.2.22 could attribute it to the replied-to name
  // because both anchors share the `at` class and it took whichever came first.
  const html = commentRow({
    spid: '151694781657',
    authorHandle: '银狐_玉耀',
    authorName: '苏小玲',
    replyTo: '寻º乐',
    body: '这个首饰能减冷却',
  })
  const page = parseCommentPage(html, '151679645842')
  assert.equal(page.replies.length, 1)
  const reply = page.replies[0]!.reply
  assert.equal(reply.authorId, '银狐_玉耀', '作者必须是 username 属性指明的那个账号')
  assert.equal(reply.authorName, '苏小玲')
  assert.notEqual(reply.authorName, '寻º乐', '绝不能把被回复的人当成作者')
  assert.equal(reply.replyToName, '寻º乐')
  assert.equal(reply.authorSource, 'comment_page')
})

test('回复对象写在正文内部时，作者不会被正文里的锚点带走', () => {
  // This is the only arrangement observed in the saved markup: the author's
  // anchor sits in the lead (before `lzl_content_main`), and the reply target is
  // rendered *inside* the body. The test pins that the body's anchor cannot
  // become the author.
  //
  // A stricter case — several account anchors in the lead, order reversed — is
  // deliberately NOT asserted here: no saved comment-page markup shows that
  // arrangement, and inventing one would test an imagined page rather than the
  // real one. See the phase-15 report's "证据缺失" section.
  const html = `<li class="lzl_single_post" data-field='{"spid":151694781658,"user_name":"silver_fox","showname":"苏小玲"}'>
    <div class="lzl_cnt">
      <a class="at" username="silver_fox">苏小玲</a>：
      <span class="lzl_content_main">回复 <a class="at" username="seeker">寻º乐</a>：这句才是正文</span>
    </div>
  </li>`
  const page = parseCommentPage(html, '151679645842')
  const reply = page.replies[0]!.reply
  assert.equal(reply.authorId, 'silver_fox', 'author 取自 lead，不取正文里的锚点')
  assert.equal(reply.authorName, '苏小玲')
  assert.equal(reply.replyToName, '寻º乐', '正文里的锚点是回复对象')
})

test('同一条回复在 WAP 内联与 comment page 两个来源下，作者字段一致', () => {
  // This is the cross-surface agreement that v0.2.22 silently violated: the same
  // postId was reported under two different author names depending on which
  // channel won the merge.
  const inline = parseInlineNested(
    `<ul class="flist">${inlineNested({
      pid: '151694781657',
      un: '银狐_玉耀',
      name: '苏小玲',
      body: '这个首饰能减冷却',
    })}</ul>`,
    '151679645842',
  )[0]!.reply
  const comment = parseCommentPage(
    commentRow({
      spid: '151694781657',
      authorHandle: '银狐_玉耀',
      authorName: '苏小玲',
      body: '这个首饰能减冷却',
    }),
    '151679645842',
  ).replies[0]!.reply

  assert.equal(inline.postId, comment.postId)
  assert.equal(inline.authorId, comment.authorId, '两个来源必须给出同一个登录名')
  assert.equal(inline.authorName, comment.authorName, '两个来源必须给出同一个显示名')
  assert.notEqual(inline.authorSource, comment.authorSource, '但来源本身要如实记为不同')
})

test('楼层与楼中楼同一个人：handle 相同、显示名相同，可判为同一账号', () => {
  const floor = parseWapFloors(
    wapFloor({ pid: '151679645842', floor: 1, un: '银狐_玉耀', showname: '苏小玲' }),
  )[0]!.floor
  const nested = parseInlineNested(
    `<ul class="flist">${inlineNested({
      pid: '151694781657',
      un: '银狐_玉耀',
      name: '苏小玲',
      body: '补充一句',
    })}</ul>`,
    '151679645842',
  )[0]!.reply
  assert.equal(floor.authorId, nested.authorId, '同一个人在两个楼层里 handle 必须一致')
})

test('un 缺失时：不编造 handle，只保留显示名', () => {
  const html = wapFloor({ pid: '151679645900', floor: 6, showname: '贴吧用户_GC5SN4Q' })
  const floor = parseWapFloors(html)[0]!.floor
  assert.equal(floor.authorId, undefined, '没有 un 就不能虚构一个')
  assert.equal(floor.authorName, '贴吧用户_GC5SN4Q')
  assert.equal(floor.authorSource, 'wap_floor', '来源仍要记，好让上层知道这里没 handle')
})
