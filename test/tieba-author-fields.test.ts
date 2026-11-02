/**
 * v0.2.21 身份字段分离与参与者归并：`un` / `name_show` / `replyToName` 的语义。
 *
 * ## 真实数据背景
 *
 * 第八阶段抓到的真实 WAP 页面（帖子 11111241554）里，30 个楼层中有 **13 层**
 * `data-info.un` 与 `data-info.name_show` 不同：
 *
 *   fn=4   un='永恒的鸟笼'     name_show='时空的流转♂'
 *   fn=6   un='lz6657'        name_show='贴吧用户_JWyJC5G'
 *   fn=18  un='缇体'          name_show='阴阳空格🐴'
 *
 * 还有 4 层 `un` 为空、只有 `name_show`。所以：
 * - `un` = 登录名，不可改，可作账号标识；
 * - `name_show` = 昵称，随时可改，只能当展示名；
 * - `replyToName` = "回复 X：" 里的 X，只是**名字**，不是身份。
 *
 * 这些夹具直接照抄真实数据，用的是真实的解析函数，不是手写的假对象。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseWapFloors, parseInlineNested } from '../lib/platforms/tieba/parse.js'

/** Build one floor block exactly the way the WAP page renders it. */
function floorBlock(input: {
  fn: number
  tid: string
  un?: string
  nameShow?: string
  rendered: string
  content?: string
}): string {
  const info = {
    ...(input.un === undefined ? {} : { un: input.un }),
    ...(input.nameShow === undefined ? {} : { name_show: input.nameShow }),
    pid: Number(input.tid),
    floor_num: input.fn,
    portrait: `tb.1.${input.fn}abc.XYZ`,
  }
  const json = JSON.stringify(info).replace(/"/g, '&quot;')
  return (
    `<li tid="${input.tid}" data-tid="${input.tid}" fn="${input.fn}" data-info="${json}" ` +
    `class="list_item post_list_item"><div class="list_item_wrapper"><div class="list_item_top">` +
    `<div class="list_item_top_name"><span class="user_name">` +
    `<a href="javascript:;" class="user_name">${input.rendered}</a></span>` +
    `<span class="list_item_time">10-17 02:16</span></div></div>` +
    `<div class="content" lz="${input.fn === 1 ? 1 : 0}">${input.content ?? '正文'}</div>` +
    `</div></li>`
  )
}

function page(blocks: readonly string[]): string {
  return `<html><body><ul class="thread_list">${blocks.join('')}</ul></body></html>`
}

// ---------------------------------------------------------------------------
// un 与 name_show 的关系
// ---------------------------------------------------------------------------

test('un 与 name_show 相同时，账号名与展示名一致', () => {
  const html = page([
    floorBlock({ fn: 1, tid: '1001', un: '首发罗强花生', nameShow: '首发罗强花生', rendered: '首发罗强花生' }),
  ])
  const [parsed] = parseWapFloors(html)
  assert.equal(parsed!.floor.authorId, '首发罗强花生', 'authorId 取 un')
  assert.equal(parsed!.floor.authorName, '首发罗强花生')
  assert.equal(parsed!.floor.floorNumber, 1)
})

test('un 与 name_show 不同时，authorId 仍是 un，authorName 取渲染文本', () => {
  // 真实样本 fn=4：永恒的鸟笼 / 时空的流转♂
  const html = page([
    floorBlock({ fn: 4, tid: '1004', un: '永恒的鸟笼', nameShow: '时空的流转♂', rendered: '时空的流转' }),
  ])
  const [parsed] = parseWapFloors(html)
  assert.equal(parsed!.floor.authorId, '永恒的鸟笼', 'authorId 必须取 un（登录名），不能取昵称')
  assert.notEqual(parsed!.floor.authorName, parsed!.floor.authorId, '两者不同时应当能看出差异')
})

test('un 为空时 authorId 缺失，只有 authorName——这正是 hasStableAuthor 拒绝的那一类', () => {
  // 真实样本 fn=3：un 为空，name_show='贴吧用户_JPEPCR5'
  const html = page([
    floorBlock({ fn: 3, tid: '1003', nameShow: '贴吧用户_JPEPCR5', rendered: '贴吧用户_JPEPCR5' }),
  ])
  const [parsed] = parseWapFloors(html)
  assert.equal(parsed!.floor.authorId, undefined, '没有 un 就不能编一个 authorId 出来')
  assert.equal(parsed!.floor.authorName, '贴吧用户_JPEPCR5')
})

// ---------------------------------------------------------------------------
// 跨楼层：同一人 / 不同人
// ---------------------------------------------------------------------------

test('同一用户在不同楼层出现时，un 一致，能被归并成一个人', () => {
  const html = page([
    floorBlock({ fn: 1, tid: '1001', un: 'lz6657', nameShow: '贴吧用户_JWyJC5G', rendered: '贴吧用户_JWyJC5G' }),
    floorBlock({ fn: 2, tid: '1002', un: 'lz6657', nameShow: '贴吧用户_JWyJC5G', rendered: '贴吧用户_JWyJC5G' }),
  ])
  const floors = parseWapFloors(html)
  assert.equal(floors.length, 2)
  assert.equal(floors[0]!.floor.authorId, floors[1]!.floor.authorId, '同一个 un 应当能识别为同一人')
})

test('不同用户拥有相同昵称时，un 不同，必须能区分开', () => {
  // 这是「昵称不可作为身份」的反证：两个账号都叫「小明」。
  const html = page([
    floorBlock({ fn: 1, tid: '2001', un: 'user_aaa', nameShow: '小明', rendered: '小明' }),
    floorBlock({ fn: 2, tid: '2002', un: 'user_bbb', nameShow: '小明', rendered: '小明' }),
  ])
  const floors = parseWapFloors(html)
  assert.notEqual(
    floors[0]!.floor.authorId,
    floors[1]!.floor.authorId,
    '昵称相同不代表同一人；只比昵称的实现在这里会把两个人合并成一个',
  )
  assert.equal(floors[0]!.floor.authorName, floors[1]!.floor.authorName, '而昵称确实是一样的')
})

test('同一份页面里 un 与 name_show 的差异不会让楼层号错乱', () => {
  const html = page([
    floorBlock({ fn: 1, tid: '3001', un: 'a', nameShow: 'A 昵称', rendered: 'A 昵称' }),
    floorBlock({ fn: 2, tid: '3002', un: 'b', nameShow: 'b', rendered: 'b' }),
    floorBlock({ fn: 3, tid: '3003', nameShow: '无账号名的用户', rendered: '无账号名的用户' }),
  ])
  const floors = parseWapFloors(html)
  assert.deepEqual(floors.map((entry) => entry.floor.floorNumber), [1, 2, 3])
  assert.deepEqual(floors.map((entry) => entry.floor.postId), ['3001', '3002', '3003'])
})

// ---------------------------------------------------------------------------
// 楼中楼：作者 vs 回复对象
// ---------------------------------------------------------------------------

test('楼中楼：评论作者与被回复者是两个独立字段，不得混淆', () => {
  // B 发了一条「回复 C：……」，这里的 B 是作者，C 只是被点名的人。
  const block =
    '<li tid="500" data-tid="500" fn="1" data-info="{}">' +
    '<ul class="flist">' +
    '<li pid="9001" data-info=\'{"un":"B","name_show":"B的昵称"}\'>' +
    '<a href="/home/main?un=B" class="user_name ">B的昵称:</a>' +
    '<span class="floor_content">回复 C：你这条说得不对</span></li>' +
    '</ul></li>'

  const [parsed] = parseInlineNested(block, '500')
  const reply = parsed!.reply

  assert.equal(reply.postId, '9001')
  assert.equal(reply.authorId, 'B', '作者必须是 B')
  assert.notEqual(reply.authorId, 'C', '绝不能把被回复的人当成作者')
  assert.equal(reply.replyToName, 'C', 'C 只出现在 replyToName 里')
  assert.equal(reply.relationUncertain, true, '只拿到名字时关系必须标注为不确定')
  assert.equal(reply.content, '你这条说得不对', '"回复 C：" 前缀应被剥离，不进入正文')
})

test('楼中楼：没有「回复 X：」时 relationUncertain 为 false', () => {
  const block =
    '<li tid="501" data-tid="501" fn="1" data-info="{}">' +
    '<ul class="flist">' +
    '<li pid="9002" data-info=\'{"un":"D","name_show":"D"}\'>' +
    '<a href="/home/main?un=D" class="user_name ">D:</a>' +
    '<span class="floor_content">我直接说结论</span></li>' +
    '</ul></li>'

  const [parsed] = parseInlineNested(block, '501')
  assert.equal(parsed!.reply.authorId, 'D')
  assert.equal(parsed!.reply.replyToName, undefined)
  assert.equal(parsed!.reply.relationUncertain, false, '没有回复对象时不该谎称不确定')
})

test('楼中楼：被回复者的名字不会被凭空升级成身份 ID', () => {
  const block =
    '<li tid="502" data-tid="502" fn="1" data-info="{}">' +
    '<ul class="flist">' +
    '<li pid="9003" data-info=\'{"un":"E","name_show":"E"}\'>' +
    '<a href="/home/main?un=E" class="user_name ">E:</a>' +
    '<span class="floor_content">回复 某个路人：你说错了</span></li>' +
    '</ul></li>'

  const [parsed] = parseInlineNested(block, '502')
  const reply = parsed!.reply
  assert.equal(reply.replyToName, '某个路人')
  // 结构上被回复者只有名字这一种表示，没有 id 字段可填。
  assert.equal('replyToId' in reply, false, '不存在 replyToId 这个字段——不要为了"看起来完整"而编造它')
})
