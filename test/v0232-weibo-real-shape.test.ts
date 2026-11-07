/**
 * v0.2.32：用**真实接口返回的原始响应**钉住分页语义。
 *
 * ## 这个文件与其它 weibo 测试的区别
 *
 * 别的测试用的是「按公开文档构造的 fixture」——形状是人写的，可能与真实响应不同。
 * 这里的 fixture 是 **2026-11-07 从官方 `weibo-cli` 实际取回来的原始 JSON**，
 * 原文照抄、没有编辑。它们证明的不是「我以为平台会这样回」，而是「平台确实这样回」。
 *
 * ## 发现了什么
 *
 * 末页的 `next_cursor` 是数字 `0`。原来的 `textOf()` 把它变成字符串 `"0"`，
 * 于是 `cursor !== undefined` 成立 → `hasMore: true` → 一次已经读完的读取
 * **声称还有更多**，采集器继续翻页，翻到一个内容相同的「下一页」。
 *
 * 这条在真实数据上暴露，是因为真实数据到末页了；假数据永远不会到末页，
 * 所以它一直在测试里活着。
 *
 * ## 固定的是判定，不是数字
 *
 * 断言写的是「这一份真实响应应当被读成 done」，不是「所有接口末页都返回 0」。
 * 后者是从一个样本推全体，而微博的不同命令各有各的游标语义（`page`/`cursor`/
 * `max_id` 三种都见过）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { unwrapComments } from '../lib/platforms/weibo/projection.js'

/**
 * 2026-11-07 实测：`weibo-cli comments show/all --id 4769386810049975 --count 5 --page 1`
 *
 * 只保留判定需要的字段，`comments` 里每条也只留 id 与 floor_number——
 * 真实响应有 ~180KB，把它整个塞进仓库既没必要也难看。**字段名与取值未改**。
 */
const PAGE_1 = {
  comments: [
    { id: 4769391277769236, floor_number: 7, text: '孝顺是中华百善之首' },
    { id: 4769390756893473, floor_number: 6, text: '（@ 若干账号）' },
    { id: 4769390648365625, floor_number: 5, text: '不孝子' },
    { id: 4769390572080782, floor_number: 4, text: '我靠 不会吧 那么不道德' },
    { id: 4769389875827085, floor_number: 3, text: '#不孝子#' },
  ],
  hasvisible: false,
  previous_cursor: 0,
  next_cursor: 4769389788533551,
  total_number: 7,
  marks: [],
}

/**
 * 2026-11-07 实测：同一微博 `--page 2`
 *
 * 这一份是关键证据：`next_cursor` 是 **0**，而且是数字不是字符串。
 */
const PAGE_2 = {
  comments: [
    { id: 4769389788533551, floor_number: 2, text: '哎看看就好，淡定' },
    { id: 4769389614603518, floor_number: 1, text: '逆子！' },
  ],
  hasvisible: false,
  previous_cursor: 4769389788533551,
  next_cursor: 0,
  total_number: 7,
  marks: [],
}

/**
 * 2026-11-07 实测：`comments show/all --id 4769393202168348`
 *
 * `total_number` 说 1，但 `comments` 是空数组。这是平台自己的不一致，
 * 不是我们的解析问题——测试把它钉住，是为了以后有人「修」它之前先看清事实。
 */
const EMPTY_BUT_TOTAL_1 = {
  comments: [],
  hasvisible: false,
  previous_cursor: 0,
  next_cursor: 0,
  total_number: 1,
  marks: [],
}

test('真实响应 · 第 1 页：有游标，声明还有更多', () => {
  const page = unwrapComments(PAGE_1)
  assert.equal(page.comments.length, 5, '实测拿到 5 条')
  assert.equal(page.declaredTotal, 7, 'total_number 是 7')
  assert.equal(page.hasMore, true, '有 next_cursor，必须说还有更多')
  assert.equal(page.pagingState, 'more')
  assert.equal(page.nextCursor, '4769389788533551', '游标要原样带出去')
})

test('真实响应 · 第 2 页：next_cursor 是 0，这是结束而不是「第 0 条」', () => {
  const page = unwrapComments(PAGE_2)
  assert.equal(page.comments.length, 2, '实测第 2 页拿到 2 条（5+2=7）')
  assert.equal(
    page.hasMore,
    false,
    'next_cursor=0 是平台的结束标记。判成 true 会让读取声称「还有更多」，' +
      '采集器于是继续翻页，翻到一个内容相同的「下一页」',
  )
  assert.equal(page.pagingState, 'done')
  assert.equal(page.nextCursor, undefined, '结束时不该再带一个游标出去')
})

test('真实响应 · 游标写成了字符串 "0" 时，同样按结束处理', () => {
  /**
   * 同一字段在不同接口里有的是数字、有的是字符串。按类型区分会让「换个接口就出错」，
   * 所以两种都认。
   */
  const page = unwrapComments({ ...PAGE_2, next_cursor: '0' })
  assert.equal(page.hasMore, false)
  assert.equal(page.pagingState, 'done')
})

test('真实响应 · 完全没有游标字段时是 unknown，不是 done', () => {
  /**
   * 这一条与上一条的区别很重要：`next_cursor: 0` 是**平台说结束了**，
   * 而「没有这个字段」是**我们不知道**。前者可以收工，后者必须继续或报不完整。
   *
   * 把两者都当成 done，就是 v0.2.12 审计里那条「一页读取看起来像平台确认了结尾」。
   */
  const noCursor = { ...PAGE_1, next_cursor: undefined, previous_cursor: undefined }
  const page = unwrapComments(noCursor)
  assert.equal(page.pagingState, 'unknown', '没有游标字段时不能声称结束')
  assert.equal(page.hasMore, true, 'unknown 意味着「可能还有」，不能停')
})

test('真实响应 · total_number=1 但 comments 为空：如实呈现，不自行修补', () => {
  /**
   * 平台说一共 1 条评论，列表却是空的。可能是评论被删/被隐藏，也可能是平台自己的
   * 计数口径。**我们不做推断**：`declaredTotal` 原样带出，列表就是空。
   *
   * 这一条钉住的是「不修补」：如果有人以后想在这里「补一条」或「把 total 改 0」，
   * 会让上层看不到真实的不一致。
   */
  const page = unwrapComments(EMPTY_BUT_TOTAL_1)
  assert.equal(page.comments.length, 0)
  assert.equal(page.declaredTotal, 1, '真实总数要如实带出，哪怕它与列表不一致')
  assert.equal(page.pagingState, 'done', '游标是 0，这一页确实到底了')
})

test('真实响应 · 两页合起来覆盖了 total_number 声明的 7 条', () => {
  /**
   * 覆盖率的判定方式是「按 id 去重后的条数 vs declaredTotal」，不是「页数」。
   * 实测 5 + 2 = 7，与 total_number 一致——这是「完整读取」的唯一证据。
   */
  const first = unwrapComments(PAGE_1)
  const second = unwrapComments(PAGE_2)
  const ids = new Set([...first.comments, ...second.comments].map((c) => String(c.id)))
  assert.equal(ids.size, 7, '两页去重后 7 条')
  assert.equal(ids.size, first.declaredTotal, '去重条数与平台声明的总数一致')
})
