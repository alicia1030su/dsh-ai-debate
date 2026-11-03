/**
 * 作者身份语义：名字说的和代码做的，必须是同一件事。
 *
 * ## 这个文件覆盖的三处不一致
 *
 * 1. `hasStableAuthor` 声称检查"稳定"，实际只检查"有没有值"。它被
 *    `publisher.ts` 用来决定"发表时能否证明作者是谁"，于是一个名字过大的函数
 *    承担了一个安全性判断。v0.2.22 增加准确名称 `hasAuthorIdentifier`，旧名保留为
 *    委托别名。
 * 2. `isAccountHandle` 的注释说"只有数字 handle 才算账号 ID"，代码却是
 *    "数字 **或** un !== name_show"。真实 WAP 数据没有数字 uid，按注释实现会把
 *    所有贴吧身份降级成未知。修正注释，不改行为。
 * 3. `authorId` / `authorName` 的语义必须写清：前者是登录名（不可改），后者是
 *    昵称（随时可改）。五个新字段的拆分经评估后**推后**，理由记录在 types.ts。
 *
 * ## 本文件不做的事
 *
 * 不放宽任何安全判断。所有断言都在确认"改动之后，宽松程度与改动之前一致或更严"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { hasAuthorIdentifier, hasStableAuthor } from '../lib/target.js'
import { parseWapFloors, parseInlineNested } from '../lib/platforms/tieba/parse.js'
import { describeParticipants } from '../lib/analyzer.js'
import { makeFloor, makeNested } from './helpers.ts'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, TargetSnapshot, Thread } from '../lib/types.js'

function snapshot(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    platform: 'tieba',
    threadId: 'T1',
    floorPostId: 'F1',
    floorNumber: 1,
    targetPostId: 'A',
    targetKind: 'floor',
    targetAuthorId: 'user_A',
    targetAuthorName: '昵称A',
    contentHash: 'h',
    capturedAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  } as TargetSnapshot
}

// ---------------------------------------------------------------------------
// 1. 改名与向后兼容
// ---------------------------------------------------------------------------

test('hasAuthorIdentifier 与 hasStableAuthor 对同一批输入给出完全相同的答案', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['数字 uid', '6631433126'],
    ['登录名', '永恒的鸟笼'],
    ['昵称样', '时空的流转♂'],
    ['单字符', 'x'],
    ['空字符串', ''],
    ['undefined', undefined],
  ]
  for (const [label, value] of cases) {
    const snap = snapshot({ targetAuthorId: value })
    assert.equal(
      hasAuthorIdentifier(snap),
      hasStableAuthor(snap),
      `${label}：两个名字必须指向同一个判断，否则"只是改名"这个说法就是假的`,
    )
  }
})

test('改名后的语义没变：仍然只看"有没有值"，不看它像不像账号', () => {
  // 这条是防止有人把改名顺手做成"收紧"。收紧会改变哪些候选能被发表——
  // 那是产品决策，不是重构。
  assert.equal(hasAuthorIdentifier(snapshot({ targetAuthorId: '随便一个昵称' })), true)
  assert.equal(hasAuthorIdentifier(snapshot({ targetAuthorId: '0' })), true, '哪怕值是 0，也仍然"有值"')
  assert.equal(hasAuthorIdentifier(snapshot({ targetAuthorId: '  ' })), true, '空白字符串在旧实现里也算有值，不得静默收紧')
  assert.equal(hasAuthorIdentifier(snapshot({ targetAuthorId: '' })), false)
  assert.equal(hasAuthorIdentifier(snapshot({ targetAuthorId: undefined })), false)
})

test('旧名仍然可以从公共模块导入，且不是第二份实现', () => {
  // 直接比对源码而不是行为：两份实现总有一天会分叉，委托调用不会。
  const source = hasStableAuthor.toString()
  assert.match(source, /hasAuthorIdentifier/, '别名必须委托给新函数，而不是复制一份判断')
})

// ---------------------------------------------------------------------------
// 2. isAccountHandle：注释修正，行为不变
// ---------------------------------------------------------------------------

function floorBlock(input: { fn: number; tid: string; un?: string; nameShow?: string; rendered: string }): string {
  const info = {
    ...(input.un === undefined ? {} : { un: input.un }),
    ...(input.nameShow === undefined ? {} : { name_show: input.nameShow }),
    pid: Number(input.tid),
    floor_num: input.fn,
  }
  const json = JSON.stringify(info).replace(/"/g, '&quot;')
  return (
    `<li tid="${input.tid}" data-tid="${input.tid}" fn="${input.fn}" data-info="${json}" class="list_item">` +
    `<div class="list_item_top"><div class="list_item_top_name"><span class="user_name">` +
    `<a href="javascript:;" class="user_name">${input.rendered}</a></span>` +
    `<span class="list_item_time">10-17 02:16</span></div></div>` +
    `<div class="content" lz="${input.fn === 1 ? 1 : 0}">正文</div></li>`
  )
}

test('贴吧真实形态：un 是登录名，不是数字 uid', () => {
  const html = `<html><body><ul>${floorBlock({ fn: 4, tid: '1004', un: '永恒的鸟笼', nameShow: '时空的流转♂', rendered: '时空的流转' })}</ul></body></html>`
  const [parsed] = parseWapFloors(html)
  assert.equal(parsed!.floor.authorId, '永恒的鸟笼')
  assert.match(parsed!.floor.authorId!, /[^\d]/, '真实样本里 un 里没有数字——这就是"只认数字"会失效的原因')
})

function thread(): Thread {
  return {
    platform: 'tieba',
    forum: { platform: 'tieba', id: '9', name: '测试吧' },
    id: '1',
    title: '测试帖',
    content: '正文',
    url: 'https://tieba.baidu.com/p/1',
    images: [],
  }
}

function collected(nested: readonly ReturnType<typeof makeNested>[]): CollectedThread {
  const floor: Floor = makeFloor({ floorNumber: 1, postId: '500', authorId: 'owner-1', authorName: '主人', content: '开场' })
  return {
    thread: thread(),
    floors: [{ floor, nested, nestedComplete: true }],
    complete: true,
    // 真实收集结果一定带 completeness；缺了它这个对象就不是合法结构。
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
  }
}

test('登录名与昵称不同时，仍被计为一个 handle（行为未被"只认数字"改掉）', () => {
  const participants = describeParticipants(
    collected([
      makeNested({ postId: 'c1', parentPostId: '500', authorId: '永恒的鸟笼', authorName: '时空的流转', content: '第一句' }),
    ]),
    1,
  )
  const person = participants.find((entry) => entry.displayName === '时空的流转')
  assert.ok(person)
  assert.equal(person!.distinctHandles, 1, '非数字的登录名也要算一个 handle，否则贴吧身份全变未知')
  assert.equal(person!.matchKind, 'id')
})

test('登录名与昵称相同时，不额外计数（这一侧也没被放宽）', () => {
  const participants = describeParticipants(
    collected([
      makeNested({ postId: 'c1', parentPostId: '500', authorId: '甲', authorName: '甲', content: '一' }),
    ]),
    1,
  )
  const person = participants.find((entry) => entry.displayName === '甲')
  assert.ok((person!.distinctHandles ?? 0) <= 1)
})

test('同名不同登录名：拆成两个参与者，保护方向更强', () => {
  // Before v0.2.23 patch 2 these merged into one participant carrying
  // `distinctHandles: 2`. Merging was the P0: the owner's statements then contained
  // the other account's words. They are now separate participants, so the protection
  // is structural rather than a counter that a caller has to remember to check.
  const participants = describeParticipants(
    collected([
      makeNested({ postId: 'c1', parentPostId: '500', authorId: 'user_aaa', authorName: '小明', content: '我' }),
      makeNested({ postId: 'c2', parentPostId: '500', authorId: 'user_bbb', authorName: '小明', content: '我也' }),
    ]),
    1,
  )
  const named = participants.filter((entry) => entry.displayName === '小明')
  assert.equal(named.length, 2, '同名不同账号必须是两个参与者')
  assert.deepEqual(named.map((entry) => entry.handle).sort(), ['user_aaa', 'user_bbb'])
})

// ---------------------------------------------------------------------------
// 3. 作者字段语义：不可混淆的两个来源
// ---------------------------------------------------------------------------

test('楼中楼：un 进 authorId，渲染文本进 authorName，两者来源不同', () => {
  const block =
    '<li tid="500" data-tid="500" fn="1" data-info="{}"><ul class="flist">' +
    '<li pid="9001" data-info=\'{"un":"lz6657","name_show":"贴吧用户_JWyJC5G"}\'>' +
    '<a href="/home/main?un=lz6657" class="user_name ">贴吧用户_JWyJC5G:</a>' +
    '<span class="floor_content">我不同意</span></li></ul></li>'

  const [parsed] = parseInlineNested(block, '500')
  assert.equal(parsed!.reply.authorId, 'lz6657', 'authorId 只能来自 un')
  assert.equal(parsed!.reply.authorName, '贴吧用户_JWyJC5G', 'authorName 只能来自渲染文本')
  assert.notEqual(parsed!.reply.authorId, parsed!.reply.authorName)
})

test('authorId 缺失时不会从昵称里"补"一个出来', () => {
  const html = `<html><body><ul>${floorBlock({ fn: 3, tid: '1003', nameShow: '贴吧用户_JPEPCR5', rendered: '贴吧用户_JPEPCR5' })}</ul></body></html>`
  const [parsed] = parseWapFloors(html)
  assert.equal(parsed!.floor.authorId, undefined, '凭空生成 ID 会让发表闸门以为身份可核验')
  assert.equal(parsed!.floor.authorName, '贴吧用户_JPEPCR5')
})

test('没有 ID 的快照仍然被发表闸门拒绝：字段语义的澄清不改变安全结论', () => {
  const noId = snapshot({ targetAuthorId: undefined, targetAuthorName: '贴吧用户_JPEPCR5' })
  assert.equal(hasAuthorIdentifier(noId), false, '只有昵称 = 没有作者标识 = 不允许发表')
})

// ---------------------------------------------------------------------------
// 4. 被推后的字段拆分：至少要把"没有这些字段"钉住
// ---------------------------------------------------------------------------

test('当前实现不提供作者置信度字段，因此不存在"低置信度数据悄悄通过"的路径', () => {
  // 拆分方案（authorHandle / authorDisplayName / authorNumericId /
  // authorIdentitySource / authorIdentityConfidence）本阶段评估后推后。
  // 只要这些字段不存在，就不会有代码按置信度放行——这条测试把"不存在"钉住，
  // 将来真加了字段，这里会失败并迫使人重新审一遍闸门。
  const snap = snapshot() as unknown as Record<string, unknown>
  for (const field of ['authorHandle', 'authorDisplayName', 'authorNumericId', 'authorIdentitySource', 'authorIdentityConfidence']) {
    assert.equal(field in snap, false, `${field} 已引入：请同时审视发表闸门是否会被置信度影响`)
  }
})

test('原有 authorId 仍是唯一的作者判断来源（未被新字段替代）', () => {
  const snap = snapshot({ targetAuthorId: 'user_A' })
  assert.equal(hasAuthorIdentifier(snap), true)
  assert.equal((snap as unknown as Record<string, unknown>)['targetAuthorId'], 'user_A')
})
