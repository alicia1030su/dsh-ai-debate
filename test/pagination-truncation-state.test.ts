/**
 * 分页截断状态机：`truncated` 必须回答"还有没有没读的页"。
 *
 * ## 这个文件补的是什么
 *
 * v0.2.21 的 `walkFloors` 在 catch 分支里只记 `failed` 与 `stopReason`，然后把
 * `truncated` 留在初始值 `false`。于是"平台声明 5 页、第 1 页读完、第 2 页 403"
 * 这种**明确知道后面还有页**的情况，会同时报出：
 *
 *   complete=false, stopReason='deleted_or_unavailable', truncated=false
 *
 * 前两个是对的，第三个是错的——而且错得最难发现，因为读 `truncated` 的调用方
 * 通常只想问一句"要不要提醒用户结果不全"。
 *
 * ## 本文件定义的语义（实现不得反向修改以迁就测试）
 *
 * - `truncated=true` 只在**有正面证据**说明还有未读页面时成立：平台声明的页数
 *   多于已读页数、声明的楼层数多于已见楼层数、或上一页明确 `hasMore: true`。
 * - 第 1 页就失败时，什么都不知道，`truncated` 必须是 `false`。把"不知道"
 *   说成"有截断"同样是撒谎，只是方向相反。
 * - `complete` 与 `truncated` 回答不同问题，允许同时为 `false` / `true`。
 * - 失败分类、重试次数、已读数据的保留，都不因这个标记改变。
 *
 * 全程无网络请求。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { walkFloors } from '../lib/collector.js'
import { PlatformError } from '../lib/types.js'
import type { Floor, ReplyPage, ThreadRef } from '../lib/types.js'

const REF: ThreadRef = { platform: 'tieba', threadId: '11111241554', url: 'https://tieba.baidu.com/p/11111241554' }

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

const forbidden = () => new PlatformError('百度安全验证', 'forbidden', { status: 403 })

// ---------------------------------------------------------------------------
// 1. 已知还有后续页 + 403 → truncated
// ---------------------------------------------------------------------------

test('声明 5 页、读到第 1 页、第 2 页 403：truncated 必须为 true', async () => {
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1), makeFloor(2)], { declaredTotal: 150, declaredTotalPages: 5 })],
      [2, forbidden()],
    ]),
  )

  const result = await walkFloors(adapter, REF)

  assert.equal(result.truncated, true, '平台说共 5 页，只读了 1 页，这就是截断')
  assert.equal(result.complete, false, '截断当然不算读全')
  assert.equal(result.stopReason, 'deleted_or_unavailable', '失败分类不得因为置了 truncated 而改变')
  assert.equal(result.pagesRead, 1)
  assert.equal(result.totalPages, 5)
  assert.equal(result.floors.length, 2, '已读楼层必须保留')
})

test('未声明页数、但上一页说 hasMore=true，第 2 页 403 同样算截断', async () => {
  // 这条专测"页数未知"的另一种情况：平台没给总页数，但它自己的 hasMore 就是证据。
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1)])],
      [2, forbidden()],
    ]),
  )

  const result = await walkFloors(adapter, REF)

  assert.equal(result.totalPages, undefined, '前提：平台没有声明总页数')
  assert.equal(result.truncated, true, 'hasMore=true 已经是"还有下一页"的明确承诺')
  assert.equal(result.complete, false)
})

test('只声明楼层数、没声明页数时，403 同样要能认出还有没读的楼层', async () => {
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1), makeFloor(2)], { declaredTotal: 150, hasMore: false })],
      [2, forbidden()],
    ]),
  )

  const result = await walkFloors(adapter, REF)

  // 第 1 页 hasMore=false 且楼层数没到 150，实际会在第 1 页就以
  // inconsistent_pagination 停下，根本走不到第 2 页。这条用来固定这个事实：
  // 不该为了"走到 403"而放宽自相矛盾检查。
  assert.equal(result.stopReason, 'inconsistent_pagination')
  assert.deepEqual(
    (result as unknown as { truncated: boolean }).truncated,
    false,
    '这不是分页中断，是信号矛盾；不要把它标成 403 截断',
  )
})

test('声明楼层数多于已见楼层、第 2 页 403：截断成立', async () => {
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1), makeFloor(2)], { declaredTotal: 150 })],
      [2, forbidden()],
    ]),
  )

  const result = await walkFloors(adapter, REF)

  assert.equal(result.truncated, true, '声明 150 楼只读到 2 楼，必须承认没读完')
  assert.equal(result.missingCount, 148)
})

// ---------------------------------------------------------------------------
// 2. 什么都不知道时，不得谎称截断
// ---------------------------------------------------------------------------

test('第 1 页就 403、没有任何分页信息：truncated 必须保持 false', async () => {
  const { adapter } = paginated(new Map<number, ReplyPage | Error>([[1, forbidden()]]))

  const result = await walkFloors(adapter, REF)

  assert.equal(result.truncated, false, '一页都没读到，无从知道后面有没有页——不能声称截断')
  assert.equal(result.complete, false, '但同样不能声称完整')
  assert.equal(result.stopReason, 'deleted_or_unavailable')
  assert.equal(result.pagesRead, 0)
  assert.equal(result.floors.length, 0)
  assert.ok(result.error, '必须带错误说明')
})

// ---------------------------------------------------------------------------
// 3. 正常路径不得被这次的改动污染
// ---------------------------------------------------------------------------

test('两页都正常：complete=true 且 truncated=false', async () => {
  const { adapter, requested } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1), makeFloor(2)], { declaredTotal: 3, declaredTotalPages: 2 })],
      [2, page([makeFloor(3)], { declaredTotal: 3, declaredTotalPages: 2, hasMore: false })],
    ]),
  )

  const result = await walkFloors(adapter, REF)

  assert.equal(result.complete, true, `两页都读到且数量对得上，应判完整，实际 ${result.stopReason}`)
  assert.equal(result.truncated, false, '没有未读页面，不得标截断')
  assert.equal(result.stopReason, 'confirmed_end')
  assert.deepEqual(requested, [1, 2])
})

test('最后一页正常结束（hasMore=false）：complete=true', async () => {
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1)], { hasMore: false })],
    ]),
  )

  const result = await walkFloors(adapter, REF)

  assert.equal(result.stopReason, 'confirmed_end')
  assert.equal(result.complete, true)
  assert.equal(result.truncated, false)
})

// ---------------------------------------------------------------------------
// 4. 不重试、不多发请求
// ---------------------------------------------------------------------------

test('403 之后不得重试同一页，也不得试探下一页', async () => {
  const { adapter, requested } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1)], { declaredTotalPages: 5 })],
      [2, forbidden()],
    ]),
  )

  await walkFloors(adapter, REF)

  assert.deepEqual(requested, [1, 2], `第 2 页只应被请求一次且不得继续，实际 ${JSON.stringify(requested)}`)
})

test('403 不是正常结束：stopReason 不得是 confirmed_end', async () => {
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1)], { declaredTotalPages: 5 })],
      [2, forbidden()],
    ]),
  )

  const result = await walkFloors(adapter, REF)

  assert.notEqual(result.stopReason, 'confirmed_end')
  assert.equal(result.complete, false)
  // 空楼层数会让调用方以为"这帖子没人回复"，与事实相反。
  assert.notEqual(result.floors.length, 0)
})

// ---------------------------------------------------------------------------
// 5. issues 里要有给人看的原因
// ---------------------------------------------------------------------------

test('截断时 walkFloors 的 issues 必须说明"第几页断了、声明几页、读了几页"', async () => {
  const { adapter } = paginated(
    new Map<number, ReplyPage | Error>([
      [1, page([makeFloor(1)], { declaredTotalPages: 5 })],
      [2, forbidden()],
    ]),
  )

  const result = await walkFloors(adapter, REF)
  const note = result.issues.find((entry) => entry.includes('中断')) ?? ''

  assert.ok(note.length > 0, `issue 必须说明发生了什么，实际：${result.issues.join(' | ') || '空'}`)
  assert.match(note, /第 2 页/, '要说清断在哪一页')
  assert.match(note, /5 页/, '要引用平台声明的页数')
  assert.match(note, /1 页/, '要说清实际读到几页')
  assert.match(note, /不是完整结果/, '必须明确告诉用户这不是全部')
})
