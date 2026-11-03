/**
 * v0.2.21 参与者归并回归：`isAccountHandle` 的**实际影响**。
 *
 * ## 这个函数为什么值得单独测
 *
 * `isAccountHandle` 是模块私有函数（`analyzer.ts:285`），注释说"只有数字 handle 才算
 * 账号 ID"，实现却是「数字 **或** un !== name_show」。注释和代码对不上。v0.2.22 的
 * 结论是**修正注释、保留行为**：真实 WAP 页面根本不提供数字 UID（第八阶段扫描
 * 190 KB 页面，`data-uid="数字"` 命中 0 次），把实现改成"只认数字"会让所有贴吧身份
 * 退化成"未知"——一个为了更严格而变得更宽松的改法。
 *
 * 所以这里的做法是：不猜语义，而是**测出它此刻真正造成的后果**，把后果钉住。
 *
 * ## 它到底影响什么
 *
 * 唯一的下游是 `distinctHandles`：同一个显示名下面出现了几个不同的 handle。
 * 这个数字被 `resolveOwnerKey` 用来拒绝"同名但可能是不同人"的主人身份匹配。
 * 也就是说：`isAccountHandle` 放宽 → 更多 un 被计入 → `distinctHandles` 更容易 > 1
 * → 主人身份匹配更容易被拒（偏向安全，不会误认主人）。
 *
 * 它**不影响发表路径的作者比对**——那条走 `targetAuthorId`，不经过这个函数。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { describeParticipants } from '../lib/analyzer.js'
import type { Participant } from '../lib/analyzer.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'
import { makeFloor, makeNested } from './helpers.ts'

const FLOOR_ID = '500'

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

function collected(nested: readonly NestedReply[]): CollectedThread {
  const floor = makeFloor({
    floorNumber: 1,
    postId: FLOOR_ID,
    authorId: 'owner-1',
    authorName: '主人',
    content: '开场',
    nestedCount: nested.length,
  })
  const floors: readonly Floor[] = [floor]
  return {
    thread: thread(),
    floors: floors.map((entry) => ({ floor: entry, nested, nestedComplete: true })),
    complete: true,
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

function byName(participants: readonly Participant[], name: string) {
  return participants.find((entry) => entry.displayName === name)
}

// ---------------------------------------------------------------------------
// 情形 1：un 与 name_show 相同 —— handle 不携带额外信息
// ---------------------------------------------------------------------------

test('un 与 name_show 相同时，同一人不会因为 handle 被算成两个账号', () => {
  const data = collected([
    makeNested({ postId: 'c1', parentPostId: FLOOR_ID, authorId: '甲', authorName: '甲', content: '第一句' }),
    makeNested({ postId: 'c2', parentPostId: FLOOR_ID, authorId: '甲', authorName: '甲', content: '第二句' }),
  ])

  const participants = describeParticipants(data, 1)
  const person = byName(participants, '甲')
  assert.ok(person, '应当能找到「甲」')
  assert.equal(person!.postCount, 2)
  // un === name，所以按实现它**不算**独立 handle；即便算，也只有 1 个。
  assert.ok((person!.distinctHandles ?? 0) <= 1, `同一人不应有多个 handle，实际 ${person!.distinctHandles}`)
})

// ---------------------------------------------------------------------------
// 情形 2：un 与 name_show 不同 —— 这才是 isAccountHandle 放行的那一类
// ---------------------------------------------------------------------------

test('un 与 name_show 不同时，该 handle 会被计入 distinctHandles', () => {
  // 真实样本 fn=4：un='永恒的鸟笼'，name_show='时空的流转♂'
  const data = collected([
    makeNested({
      postId: 'c1',
      parentPostId: FLOOR_ID,
      authorId: '永恒的鸟笼',
      authorName: '时空的流转',
      content: '第一句',
    }),
  ])

  const participants = describeParticipants(data, 1)
  const person = byName(participants, '时空的流转')
  assert.ok(person, '显示名应当能作为归并键')
  assert.equal(person!.distinctHandles, 1, '一个 un 对应一个 distinctHandle')
  assert.equal(person!.matchKind, 'id', 'un 非空且与昵称不同，会被当作 id 匹配')
})

// ---------------------------------------------------------------------------
// 情形 3：un 为空 —— 只有昵称，必须退化为 name 匹配
// ---------------------------------------------------------------------------

test('un 为空时 matchKind 退化为 name，且不产生 handle 计数', () => {
  const data = collected([
    makeNested({
      postId: 'c1',
      parentPostId: FLOOR_ID,
      authorId: undefined,
      authorName: '贴吧用户_JPEPCR5',
      content: '只有昵称',
    }),
  ])

  const participants = describeParticipants(data, 1)
  const person = byName(participants, '贴吧用户_JPEPCR5')
  assert.ok(person)
  assert.equal(person!.matchKind, 'name', '没有 un 就只能按名字匹配')
  assert.equal(person!.distinctHandles, 0, '没有 handle 就不该有计数')
})

// ---------------------------------------------------------------------------
// 情形 4：同名不同 un —— 危险情形，必须能看出"这个名字下面有两个账号"
// ---------------------------------------------------------------------------

test('两个不同 un 共用同一昵称时，是两个参与者而不是一个', () => {
  // v0.2.23 patch 2 changed this from "one participant with distinctHandles = 2" to
  // "two participants". The old shape was the P0 bug: merging them meant the owner's
  // statements silently included the other account's words. Counting them was only a
  // heuristic guard on the nickname path; separating them removes the confusion at
  // the source.
  const data = collected([
    makeNested({ postId: 'c1', parentPostId: FLOOR_ID, authorId: 'user_aaa', authorName: '小明', content: '我是小明' }),
    makeNested({ postId: 'c2', parentPostId: FLOOR_ID, authorId: 'user_bbb', authorName: '小明', content: '我也是小明' }),
  ])

  const participants = describeParticipants(data, 1)
  const named = participants.filter((entry) => entry.displayName === '小明')
  assert.equal(named.length, 2, '两个不同账号即使同名，也必须是两个参与者')
  assert.deepEqual(
    named.map((entry) => entry.handle).sort(),
    ['user_aaa', 'user_bbb'],
    '两个账号各自保留自己的 handle',
  )
  // Each participant carries exactly its own posts.
  for (const entry of named) {
    assert.equal(entry.postCount, 1, `${entry.handle} 只应"拥有"自己那一条发言`)
  }
})

// ---------------------------------------------------------------------------
// 情形 5：同一人跨楼层出现
// ---------------------------------------------------------------------------

test('同一 un 在多条发言里出现，只算一个 handle', () => {
  const data = collected([
    makeNested({ postId: 'c1', parentPostId: FLOOR_ID, authorId: 'user_x', authorName: '昵称X', content: '一' }),
    makeNested({ postId: 'c2', parentPostId: FLOOR_ID, authorId: 'user_x', authorName: '昵称X', content: '二' }),
    makeNested({ postId: 'c3', parentPostId: FLOOR_ID, authorId: 'user_x', authorName: '昵称X', content: '三' }),
  ])

  const participants = describeParticipants(data, 1)
  const person = byName(participants, '昵称X')
  assert.equal(person!.postCount, 3)
  assert.equal(person!.distinctHandles, 1, '同一个 un 重复出现仍然只算一个')
})

// ---------------------------------------------------------------------------
// 与发表安全的关系（说明性断言）
// ---------------------------------------------------------------------------

test('参与者归并完全不参与发表路径：只影响展示与主人匹配', () => {
  // 这一条不测行为，测的是"边界在哪"。如果哪天有人把这个函数接进
  // publisher 的作者比对，这条断言应当被重新审视。
  //
  // 发表路径用的是 `TargetSnapshot.targetAuthorId`（见 target.ts 与
  // publish-author-identity-binding.test.ts），与 `describeParticipants` 无关。
  const data = collected([
    makeNested({ postId: 'c1', parentPostId: FLOOR_ID, authorId: 'u1', authorName: '甲', content: '一' }),
  ])
  const participants = describeParticipants(data, 1)
  // 返回的是展示结构，没有 contentHash / targetSnapshot 这类发表所需字段。
  const sample = participants[0] as unknown as Record<string, unknown>
  assert.equal('contentHash' in sample, false)
  assert.equal('targetSnapshot' in sample, false)
})
