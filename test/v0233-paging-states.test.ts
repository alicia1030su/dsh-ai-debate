/**
 * v0.2.33 §六：分页与讨论完整度的五个状态。
 *
 * ## 为什么这些用例要单独成组
 *
 * 「读完了吗」这个问题有五个真诚的答案，而旧代码只有两个（`hasMore: true/false`）：
 *
 * | 状态 | 含义 | 后果 |
 * | --- | --- | --- |
 * | `done` | 平台明确表示结束 | 可以说「读完了」 |
 * | `more` | 有有效游标 | 继续读 |
 * | `unknown` | 没有任何信号 | 不能声称读完 |
 * | `partial` | 读到了，但是降级子集 | 要说「没读全」 |
 * | `failed` | 这一页没拿到数据 | 要说「没开始」 |
 *
 * 把 `unknown` 折进 `done` 是本项目反复出现的那个 bug：**没有证据被当成了
 * 反向证据**。把 `unknown` 折进 `more` 则是相反的错——多翻一页（便宜），
 * 但如果每一页都未知，采集器会一路翻到自己的上限，报告里必须说清那是上限。
 *
 * 这一组测试用真实响应形态（`next_cursor: 0` 是数字、`"0"` 是字符串，
 * `has_more` 是布尔或 0/1）逐个钉住判定。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { unwrapComments } from '../lib/platforms/weibo/projection.js'

/** 一条最小可投影的评论。字段名与真实响应对齐。 */
function comment(id: number): Record<string, unknown> {
  return {
    id,
    text: `评论 ${id}`,
    user: { id: 900 + id, screen_name: `用户${id}`, idstr: String(900 + id) },
    floor_number: id % 100,
  }
}

test('done：next_cursor 是数字 0（2026-11-07 真实末页形态）', () => {
  const page = unwrapComments({
    comments: [comment(1), comment(2)],
    next_cursor: 0,
    total_number: 2,
  })
  assert.equal(page.pagingState, 'done')
  assert.equal(page.hasMore, false)
})

test('done：next_cursor 是字符串 "0" 同样按结束处理', () => {
  // 同一个字段在不同接口里是数字、在另一些里是字符串。按类型区分会让
  // 「换个接口就出错」，所以两者必须同判。
  const page = unwrapComments({ comments: [comment(1)], next_cursor: '0' })
  assert.equal(page.pagingState, 'done')
  assert.equal(page.hasMore, false)
})

test('unknown：字段全缺失时不能声称读完', () => {
  // 只有评论数组，没有任何分页信号。旧代码把它当 done，于是「读了一页」
  // 被报告成「读完了」。
  const page = unwrapComments({ comments: [comment(1), comment(2)] })
  assert.equal(page.pagingState, 'unknown')
  assert.equal(page.hasMore, true, 'unknown 必须按「可能还有」处理，否则会提前停')
})

test('more：正数游标', () => {
  const page = unwrapComments({ comments: [comment(1)], next_cursor: 4769389788533551 })
  assert.equal(page.pagingState, 'more')
  assert.equal(page.hasMore, true)
  assert.equal(page.nextCursor, '4769389788533551')
})

test('done：has_more 明确为 false，即使还有游标字段', () => {
  const page = unwrapComments({ comments: [comment(1)], has_more: false, next_cursor: 123 })
  assert.equal(page.pagingState, 'done')
})

test('more / done：has_more 用 0/1 与 "0"/"1" 表达时也认', () => {
  assert.equal(unwrapComments({ comments: [comment(1)], has_more: 1 }).pagingState, 'more')
  assert.equal(unwrapComments({ comments: [comment(1)], has_more: 0 }).pagingState, 'done')
  assert.equal(unwrapComments({ comments: [comment(1)], has_more: '1' }).pagingState, 'more')
  assert.equal(unwrapComments({ comments: [comment(1)], has_more: '0' }).pagingState, 'done')
})

test('无法识别的 has_more 值不算 done：它是「没看懂」，不是「没有了」', () => {
  const page = unwrapComments({ comments: [comment(1)], has_more: 'maybe' })
  assert.equal(page.pagingState, 'unknown')
})

test('空列表 + 非零总数：这一页不能算「读完了」', () => {
  // 平台可以返回 0 条而同时声明总数非零（窗口落在已删除区间、或接口自身缺陷）。
  // 把它当 done 就是在声称「这帖子没有评论」——而平台刚刚说了有。
  const page = unwrapComments({ comments: [], total_number: 7, next_cursor: 0 })
  assert.equal(page.comments.length, 0)
  assert.equal(page.declaredTotal, 7)
  // `unwrapComments` 只报它看到的事实：游标说结束。把「空页 + 非零总数」判成
  // unknown 是 provider 的责任（它知道这是读取路径，不只是解析）。
  assert.equal(page.pagingState, 'done')
})

test('总数会被解析出来，作为覆盖率的分子/分母依据', () => {
  const page = unwrapComments({ comments: [comment(1)], total_number: 7, next_cursor: 0 })
  assert.equal(page.declaredTotal, 7)
})

test('总数是字符串数字时也要认（真实接口两种都出现过）', () => {
  const page = unwrapComments({ comments: [comment(1)], total_number: '7' })
  assert.equal(page.declaredTotal, 7)
})

test('总数不是数字时不猜：declaredTotal 缺席，而不是 0', () => {
  // 0 是一个断言（「没有评论」），缺席才是「不知道」。
  const page = unwrapComments({ comments: [comment(1)], total_number: 'many' })
  assert.equal(page.declaredTotal, undefined)
})

test('重复评论不会被解析层去重：去重是采集层的责任，判断要知道原始条数', () => {
  const page = unwrapComments({
    comments: [comment(7), comment(7), comment(8)],
    next_cursor: 0,
  })
  assert.equal(page.comments.length, 3, '解析层只做形状，不做语义')
})

test('嵌套信封（data.comments）与顶层数组两种形态都读得出来', () => {
  const nested = unwrapComments({ data: { comments: [comment(1)], next_cursor: 0 } })
  assert.equal(nested.comments.length, 1)
  assert.equal(nested.pagingState, 'done')

  const flat = unwrapComments({ data: [comment(1), comment(2)], next_cursor: 5 })
  assert.equal(flat.comments.length, 2)
  assert.equal(flat.pagingState, 'more')
})

test('非对象响应不抛错，而是报 unknown 且零条', () => {
  for (const raw of [null, undefined, 'string', 42]) {
    const page = unwrapComments(raw)
    assert.equal(page.comments.length, 0)
    assert.equal(page.pagingState, 'unknown')
    assert.equal(page.hasMore, false, '连信封都没有时不该谎称还有更多')
  }
})
