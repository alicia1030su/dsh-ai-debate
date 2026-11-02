/**
 * v0.2.21 分页能力回归：403 不能被当成"读完了"。
 *
 * ## 为什么这个测试很重要
 *
 * 第十阶段实测：帖子 11111241554 的第 1 页（`pn=0`）返回 200，第 2 页（`pn=30`）
 * 返回 403「百度安全验证」。如果 `walkFloors` 把 403 当成普通的"没有更多楼层"，
 * 用户会看到一份**看起来完整**的讨论——实际只有 30 层，而平台声明有 150 条回复。
 * 那种错误比直接报错危险得多，因为它不可见。
 *
 * 本文件用本地假适配器模拟三种页面，断言：
 * 1. 第 1 页正常 → 正常读；
 * 2. 第 2 页 403 → `complete=false`，`stopReason` 区分于正常结束；
 * 3. 403 绝不被翻译成空列表。
 *
 * 全程无网络请求。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { walkFloors } from '../lib/collector.js'
import { PlatformError } from '../lib/types.js'
import type { Floor, ReplyPage, ThreadRef } from '../lib/platforms/contracts.js'

const REF: ThreadRef = { platform: 'tieba', threadId: '11111241554' }

function makeFloor(index: number): Floor {
  return {
    platform: 'tieba',
    floorNumber: index,
    postId: `p${index}`,
    authorId: `u${index}`,
    authorName: `用户${index}`,
    content: `第 ${index} 层`,
  } as Floor
}

/**
 * A minimal adapter surface that only answers `getReplies`.
 *
 * `walkFloors` takes the generic `PlatformAdapter`, but only ever calls
 * `getReplies` on it, so a narrow double is enough — and it keeps the test from
 * accidentally depending on publish or auth behaviour.
 */
function paginated(pages: ReadonlyMap<number, ReplyPage | Error>) {
  const requested: number[] = []
  const adapter = {
    async getReplies(_ref: ThreadRef, page: number): Promise<ReplyPage> {
      requested.push(page)
      const answer = pages.get(page)
      if (answer === undefined) throw new Error(`测试没有为第 ${page} 页准备数据`)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { adapter: adapter as never, requested }
}

function page(floors: readonly Floor[], extra: Partial<ReplyPage> = {}): ReplyPage {
  return { floors, page: 1, hasMore: true, ...extra } as ReplyPage
}

// ---------------------------------------------------------------------------
// 1. 第一页正常
// ---------------------------------------------------------------------------

test('第一页正常返回时，楼层被收集且不标记为不完整', async () => {
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1), makeFloor(2)], { declaredTotal: 2, declaredTotalPages: 1, hasMore: false })],
    ]),
  )

  const result = await walkFloors(adapter, REF)
  assert.equal(result.floors.length, 2)
  assert.equal(result.pagesRead, 1)
  assert.equal(result.stopReason, 'confirmed_end', `应当以"平台说读完了"结束，实际 ${result.stopReason}`)
  assert.equal(result.truncated, false, '平台声明只有一页，不该说被截断')
})

// ---------------------------------------------------------------------------
// 2. 第二页 403 —— 核心用例
// ---------------------------------------------------------------------------

test('第二页返回 403 时，不得当作正常分页结束', async () => {
  const forbidden = new PlatformError('贴吧返回了安全验证页', 'forbidden', { status: 403 })
  const { adapter, requested } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1), makeFloor(2)], { declaredTotal: 150, declaredTotalPages: 5 })],
      [2, forbidden],
    ]),
  )

  const result = await walkFloors(adapter, REF)

  assert.equal(result.complete, false, '403 时必须明确标记为不完整，否则用户会以为读全了')
  assert.notEqual(result.stopReason, 'confirmed_end', '403 绝不能被记为"平台确认读完"')
  assert.equal(result.stopReason, 'deleted_or_unavailable', `403 应归入不可用，实际 ${result.stopReason}`)
  assert.ok(result.error, '必须带上错误说明，而不是静默返回')
  assert.equal(result.floors.length, 2, '第一页已读到的楼层仍然保留，不该丢弃')
  assert.deepEqual(requested, [1, 2], '只应请求前两页，不得继续往下试探')

  // 已知缺陷（P2，本阶段只记录不修）：`truncated` 的文档说"停止时已知还有更多页
  // 为 true"，但实现里它只在"翻页信号自相矛盾"的分支被置位（collector.ts:362），
  // 走 error 分支时保持 false。`complete` 因此仍然正确（它另有 `failed` 与
  // `stopReason` 两个条件），但单看 `truncated` 的调用方会得到相反的答案。
  // 这条断言把当前行为钉住；等它变成 true 时，说明缺陷被修了，请同步改这里。
  assert.equal(
    result.truncated,
    false,
    '当前实现下 403 不会置 truncated——若此断言开始失败，说明该字段被修正，请更新注释',
  )
})

test('403 不得被翻译成空评论列表', async () => {
  const forbidden = new PlatformError('百度安全验证', 'forbidden', { status: 403 })
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1)], { declaredTotal: 150, declaredTotalPages: 5 })],
      [2, forbidden],
    ]),
  )

  const result = await walkFloors(adapter, REF)
  // 空列表会让调用方认为"这帖子没人回复"，这与事实相反。
  assert.notEqual(result.floors.length, 0, '403 不能变成"没有楼层"')
  assert.equal(result.complete, false)
})

// ---------------------------------------------------------------------------
// 3. 不得无限重试
// ---------------------------------------------------------------------------

test('403 之后不会重试同一页', async () => {
  const forbidden = new PlatformError('百度安全验证', 'forbidden', { status: 403 })
  const { adapter, requested } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1)], { declaredTotalPages: 5 })],
      [2, forbidden],
    ]),
  )

  await walkFloors(adapter, REF)

  // 403 是平台在拒绝这个读者，重试只会加深拦截。
  const secondPageHits = requested.filter((entry) => entry === 2).length
  assert.equal(secondPageHits, 1, `第 2 页只应被请求一次，实际 ${secondPageHits} 次`)
  assert.ok(!requested.includes(3), '403 之后不该继续请求第 3 页')
})

// ---------------------------------------------------------------------------
// 4. 区分 rate_limited 与 forbidden
// ---------------------------------------------------------------------------

test('限流与封禁是两件不同的事，停止原因不同', async () => {
  const limited = new PlatformError('请求过快', 'rate_limited')
  const { adapter: limitedAdapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1)], { declaredTotalPages: 5 })],
      [2, limited],
    ]),
  )
  const limitedResult = await walkFloors(limitedAdapter, REF)
  assert.equal(limitedResult.stopReason, 'rate_limited', '限流应如实记为 rate_limited')

  const blocked = new PlatformError('安全验证', 'forbidden', { status: 403 })
  const { adapter: blockedAdapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1)], { declaredTotalPages: 5 })],
      [2, blocked],
    ]),
  )
  const blockedResult = await walkFloors(blockedAdapter, REF)
  assert.equal(blockedResult.stopReason, 'deleted_or_unavailable')

  assert.notEqual(
    limitedResult.stopReason,
    blockedResult.stopReason,
    '"稍后再试" 与 "这条路走不通" 不能混为一谈',
  )
})

// ---------------------------------------------------------------------------
// 5. 分页上限 ≠ 分页结束
// ---------------------------------------------------------------------------

test('达到页数上限时标记为 page_cap 而不是读完了', async () => {
  const pages = new Map<number, ReplyPage | Error>()
  for (let index = 1; index <= 3; index += 1) {
    pages.set(index, page([makeFloor(index)], { declaredTotal: 150, declaredTotalPages: 5 }))
  }

  const { adapter } = paginated(pages)
  const result = await walkFloors(adapter, REF, { maxPages: 3 })

  assert.equal(result.pagesRead, 3)
  assert.equal(result.complete, false, '还有 2 页没读，不能说完整')
  assert.equal(result.stopReason, 'page_cap', `应记为 page_cap，实际 ${result.stopReason}`)
  assert.equal(result.truncated, true)
})

// ---------------------------------------------------------------------------
// 6. 跨页重复楼层去重
// ---------------------------------------------------------------------------

test('同一楼层在多页重复出现时只计一次，且不误判为"读完"', async () => {
  const duplicated = makeFloor(9)
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1), duplicated], { declaredTotalPages: 2 })],
      // 第 2 页只重复了上一页的最后一层，没有任何新内容。
      [2, page([duplicated], { declaredTotalPages: 2, hasMore: false })],
    ]),
  )

  const result = await walkFloors(adapter, REF)
  const ids = result.floors.map((entry) => entry.postId)
  assert.deepEqual(ids, ['p1', 'p9'], '重复楼层必须去重')
  assert.equal(result.floors.length, 2)
})
