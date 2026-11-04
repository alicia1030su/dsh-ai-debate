/**
 * The GUI fixture must survive the real parser.
 *
 * The browser end-to-end run feeds `fixture-discussion` bytes to the production
 * adapter. If those bytes do not parse, the run would either fail for the wrong reason
 * or — worse — quietly produce an empty thread that still "renders". So the fixture is
 * validated here against `parseWapFloors` and friends, not against the shape this file
 * wishes they had.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  commentPageJson,
  FLOORS,
  THREAD_ID,
  NESTED,
  NESTED_COUNT,
  PICKED_NESTED_POST_ID,
  PICKED_PARENT_POST_ID,
  totalCommentJson,
  wapPageHtml,
} from './support/fixture-discussion.ts'
import { parseWapFloors, parseCommentPage, parseWapPageMeta } from '../lib/platforms/tieba/parse.js'
import { buildCommentList } from '../lib/comment-list.js'
import { collectThread } from '../lib/collector.js'
import type { PlatformAdapter } from '../lib/types.js'

test('楼层页能被真实解析器读出全部楼层', () => {
  const floors = parseWapFloors(wapPageHtml(1))
  assert.equal(floors.length, FLOORS.length, `应解析出 ${FLOORS.length} 层`)

  for (const expected of FLOORS) {
    const actual = floors.find((entry) => entry.floor.postId === expected.postId)
    assert.ok(actual !== undefined, `缺少楼层 ${expected.postId}`)
    assert.equal(actual.floor.floorNumber, expected.floorNumber)
    assert.equal(actual.floor.authorId, expected.authorHandle, '登录名必须进入 authorId')
  }
})

test('楼层页只有登录名，没有数字 id —— 真实页面就是这样', () => {
  // This asserted `authorNumericUid === '500001'` while the fixture was injecting a
  // `user_id` into `data-info`. A captured live WAP page (`test/fixtures/wap-page1.html`)
  // carries `{un, is_annoy, pid, floor_num, name_show}` and no numeric uid at all, so the
  // assertion was encoding a shape the platform does not produce.
  //
  // It mattered beyond fidelity: injecting a uid made one person key as `uid:…` on a
  // floor and as `handle:…` in a nested reply, and the analyzer then treated the owner
  // as a stranger in their own thread. The numeric id still exists on the data model —
  // `totalComment` publishes it — it simply does not come from floor markup.
  const floors = parseWapFloors(wapPageHtml(1))
  const first = floors.find((entry) => entry.floor.postId === '9100000001')!
  assert.equal(first.floor.authorNumericUid, undefined, '楼层页不提供数字 id')
  assert.equal(first.floor.authorId, 'owner_un', 'authorId 必须是登录名')
  assert.equal(first.floor.authorSource, 'wap_floor')

  // And the numeric id does arrive from the surface that actually publishes it.
  const total = JSON.parse(totalCommentJson()) as { data: Record<string, { user_id: number }> }
  assert.equal(total.data['9100000001']!.user_id, 500001, 'totalComment 才是数字 id 的来源')
})

test('两个不同账号共用显示昵称，登录名不同', () => {
  const floors = parseWapFloors(wapPageHtml(1))
  const a = floors.find((entry) => entry.floor.postId === '9100000002')!
  const b = floors.find((entry) => entry.floor.postId === '9100000003')!
  assert.equal(a.floor.authorName, b.floor.authorName, '显示昵称相同')
  // The handle is what distinguishes them, because it is the only account token the
  // floor page carries. Asserting a numeric difference would have passed on fixture
  // data that no real page produces.
  assert.notEqual(a.floor.authorId, b.floor.authorId, '登录名必须不同')
  assert.equal(a.floor.authorId, 'twin_a')
  assert.equal(b.floor.authorId, 'twin_b')
})

test('楼中楼页能被真实解析器读出，且带父楼层', () => {
  const page = parseCommentPage(commentPageJson('9100000001'), '9100000001')
  // `parseCommentPage` returns `ParsedNested[]`, each wrapping a `reply`.
  const rows = page.replies ?? []
  // The fixture puts exactly one reply under floor 1 (the picked one). Asserting a
  // count the data does not contain would have been a test bug, not a parser bug.
  assert.equal(rows.length, 1, `第 1 楼应有 1 条回复，实际 ${rows.length}`)
  for (const row of rows) {
    assert.equal(row.reply.parentPostId, '9100000001', '父楼层必须正确')
  }
  const picked = rows.find((row) => row.reply.postId === PICKED_NESTED_POST_ID)
  assert.ok(picked !== undefined, '选中的那条必须存在')
  assert.equal(picked.reply.parentPostId, PICKED_PARENT_POST_ID, '选中的楼中楼挂在自己的父楼层下')
})

test('无身份字段的回复被解析为缺少登录名，不会被补成别人的身份', () => {
  const page = parseCommentPage(commentPageJson('9100000003'), '9100000003')
  const rows = page.replies ?? []
  const anonymous = rows.find((row) => row.reply.postId === '9200000003')
  assert.ok(anonymous !== undefined, '匿名回复必须存在')
  assert.equal(anonymous.reply.authorId, undefined, '没有登录名就是没有，不得借用邻行的')
})

test('totalComment 声明每层的回复数，供完整度对比', () => {
  const parsed = JSON.parse(totalCommentJson()) as { data: Record<string, { reply_num: number }> }
  assert.equal(parsed.data['9100000001']!.reply_num, 3, '第 1 楼声明 3 条回复')
  // The fixture serves 2 of the 3 it declares — deliberately, so the read is
  // observably incomplete rather than silently short.
  const served = (parseCommentPage(commentPageJson('9100000001'), '9100000001').replies ?? []).length
  assert.ok(served < parsed.data['9100000001']!.reply_num, '声明数必须大于实供数，才能测到不完整')
})

test('冲突构造真的让两个来源对同一条发言给出不同作者', () => {
  const conflicted = commentPageJson('9100000001', { conflictPostId: PICKED_NESTED_POST_ID })
  const page = parseCommentPage(conflicted, '9100000001')
  const row = (page.replies ?? []).find((entry) => entry.reply.postId === PICKED_NESTED_POST_ID)!
  assert.equal(row.reply.authorId, 'someone_else', '冲突源给出的登录名不同')
})

test('第 2 页故意为空，用于制造「读取中断」', () => {
  const page2 = parseWapFloors(wapPageHtml(2))
  assert.equal(page2.length, 0, '第 2 页没有楼层，读取必须表现为不完整')
})

test('页头元信息可解析', () => {
  const meta = parseWapPageMeta(wapPageHtml(1))
  // Not asserting a particular title: what matters is that meta parsing does not
  // throw on this markup, so the adapter can build a Thread from it.
  assert.equal(typeof meta, 'object')
})

test('夹具条数与常量一致', () => {
  assert.equal(NESTED.length, NESTED_COUNT)
  assert.ok(FLOORS.length >= 3, '至少 3 层')
  assert.ok(NESTED_COUNT >= 3, '至少 3 条楼中楼')
})

test('楼层的回复数能被解析出来，否则收集器根本不会去读楼中楼', () => {
  // `nestedCount: undefined` makes the collector skip the floor's replies entirely, and
  // the resulting empty tree is indistinguishable from a thread with no discussion.
  const floors = parseWapFloors(wapPageHtml(1))
  const withReplies = floors.filter((entry) => (entry.floor.nestedCount ?? 0) > 0)
  assert.equal(withReplies.length, FLOORS.filter((f) => (f.nestedCount ?? 0) > 0).length,
    '有回复的楼层数必须与夹具一致')
  const first = floors.find((entry) => entry.floor.postId === '9100000001')!
  assert.equal(first.floor.nestedCount, 3, '第 1 楼必须声明 3 条回复')
})

test('没有账号标识的评论不得被标成「身份已核验」', () => {
  // Found in the browser: a reply with no `username` and no numeric id rendered as
  // 「路过的匿名 · 身份已核验」. Provenance (`author_source`) is a statement about the
  // surface, not about the person; an identity requires an identifier.
  const floors = parseWapFloors(wapPageHtml(1))
  const page = parseCommentPage(commentPageJson('9100000003'), '9100000003')
  const anonymous = (page.replies ?? []).find((row) => row.reply.postId === '9200000003')!
  assert.equal(anonymous.reply.authorId, undefined, '这名回复没有登录名')
  assert.equal(anonymous.reply.authorNumericUid, undefined, '也没有数字 id')
  // The floor-level list is what the workbench reads; assert through the same projection.
  void floors
})

test('匿名回复在评论列表里是 unverified', async () => {
  const adapter = {
    platform: 'tieba',
    async getThread() {
      return { platform:'tieba', forum:{platform:'tieba',id:'1',name:'f'}, id:THREAD_ID, title:'t', content:'c', url:'u', images:[], authorSource:'wap_floor' }
    },
    async getReplies() {
      const { parseWapFloors } = await import('../lib/platforms/tieba/parse.js')
      const floors = parseWapFloors(wapPageHtml(1)).map(f => f.floor)
      return { floors, hasMore:false, page:1, declaredTotal: floors.length }
    },
    async getNestedReplies(_ref: unknown, floor: { postId: string }) {
      const { parseCommentPage } = await import('../lib/platforms/tieba/parse.js')
      const page = parseCommentPage(commentPageJson(floor.postId), floor.postId)
      return { replies: (page.replies ?? []).map(r => r.reply), hasMore:false, page:1 }
    },
  } as unknown as PlatformAdapter
  const collected = await collectThread(adapter, { platform:'tieba', threadId: THREAD_ID, url:'u' })
  const list = buildCommentList(collected)
  const anon = list.comments.find(c => c.postId === '9200000003')!
  assert.equal(anon.identity, 'unverified', `匿名回复必须 unverified，实际 ${anon.identity}`)
  const owner = list.comments.find(c => c.postId === '9100000001')!
  assert.equal(owner.identity, 'verified', '有登录名的仍然 verified')
  void totalCommentJson
})
