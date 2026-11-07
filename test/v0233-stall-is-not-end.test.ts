/**
 * 分页「走不动」不等于「读完了」（v0.2.33 §六）。
 *
 * ## 这个文件补的是哪一类谎
 *
 * `truncated` 的定义是「有**正面证据**说明还有未读内容」。此前的实现只在两种
 * 情况下把它置真：撞到 `page_cap`，或者中途某页失败。但还有第三种——
 *
 *     平台声明 9 条 → 第 1 页读到 1 条 → 第 2 页开始重复 → 走不动了
 *
 * 这时有两条独立的正面证据（声明总数 9 > 已见 1；上一页 `hasMore: true`），
 * 而 `truncated` 却是 `false`，读它的人会得到「没有漏」。同一族的错误在
 * v0.2.21 修过一次（403 那回漏了 `truncated`），这里是它的另一半：
 * **失败分支修好了，正常分支没修。**
 *
 * ## 另一类：页面自己说「我不知道」
 *
 * 微博没有 `next_cursor` 时（`pagingState: 'unknown'`），平台答了话，但话里
 * 没有「后面还有没有」。这既不是 `done` 也不是 `more`。此前 `walkFloors`
 * 根本不读页面的 `incomplete`，于是这种读法停在 `repeated_page`，
 * `truncated` 是 `false`，`issues` 是空的——三样加在一起读起来像
 * 「读完了，只是碰巧重复了一页」。
 *
 * 现在它是 `degraded: true` 加一句写清「不知道」的说明。`degraded` 与
 * `truncated` 分开是因为它们答不同问题：
 *
 * - `truncated`：平台**说过**还有，我们没拿到；
 * - `degraded`：平台**没说**有没有，我们不知道。
 *
 * 把「不知道」写成「没有」，比写错一个数字更难被发现。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { walkFloors } from '../lib/collector.js'
import type { Floor, ReplyPage, ThreadRef } from '../lib/types.js'

const REF: ThreadRef = { platform: 'weibo', threadId: '5021243409116023', url: 'https://m.weibo.cn/detail/5021243409116023' }

function floorOf(index: number): Floor {
  return {
    platform: 'weibo',
    postId: `c${index}`,
    authorName: '评论者',
    content: '内容',
  } as Floor
}

/** 一个按脚本回答的适配器：第 n 次调用返回 `pages[n-1]`，用尽后重复最后一页。 */
function adapterOf(pages: readonly Partial<ReplyPage>[]): {
  walk: (maxPages?: number) => Promise<Awaited<ReturnType<typeof walkFloors>>>
  calls: () => number
} {
  let calls = 0
  /**
   * `walkFloors` 只用到 `getReplies`，但参数类型是完整的 `PlatformAdapter`。
   * 其余成员在这里一律是「不该被调用」：真被调到就是这条测试越界了，所以
   * 让它们直接抛错，而不是返回一个看起来合理的东西。
   */
  const forbidden = (name: string) => (): never => {
    throw new Error(`这条测试不该调用 ${name}`)
  }
  const adapter = {
    id: 'weibo' as const,
    displayName: '微博',
    getCapabilities: forbidden('getCapabilities'),
    checkAuthentication: forbidden('checkAuthentication'),
    getThread: forbidden('getThread'),
    getNestedReplies: forbidden('getNestedReplies'),
    getUserProfile: forbidden('getUserProfile'),
    getMentions: forbidden('getMentions'),
    getReplyContext: forbidden('getReplyContext'),
    publishReply: forbidden('publishReply'),
    getReplies: async (_ref: ThreadRef, page: number): Promise<ReplyPage> => {
      calls += 1
      const scripted = pages[Math.min(page - 1, pages.length - 1)] ?? {}
      return {
        floors: scripted.floors ?? [],
        page,
        hasMore: scripted.hasMore ?? false,
        ...(scripted.declaredTotal === undefined ? {} : { declaredTotal: scripted.declaredTotal }),
        ...(scripted.declaredTotalPages === undefined ? {} : { declaredTotalPages: scripted.declaredTotalPages }),
        ...(scripted.incomplete === undefined ? {} : { incomplete: scripted.incomplete }),
        ...(scripted.pagingState === undefined ? {} : { pagingState: scripted.pagingState }),
      }
    },
  }
  return {
    walk: (maxPages = 60) => walkFloors(adapter, REF, { maxPages }),
    calls: () => calls,
  }
}

// ── 1. 声明总数大于实读：必须算截断 ─────────────────────────────────────────

test('声明 9 条、只读到 1 条就重复：truncated 必须为 true，且说明差了多少', async () => {
  const rig = adapterOf([
    { floors: [floorOf(1)], hasMore: true, declaredTotal: 9, pagingState: 'more' },
  ])
  const walk = await rig.walk(4)

  assert.equal(walk.complete, false, '只读到 1/9 不能算完整')
  assert.equal(walk.truncated, true, '有正面证据说明还有 8 条未读，truncated 必须是 true')
  assert.equal(walk.floors.length, 1)
  assert.ok(
    walk.issues.some((issue) => /声明共 9 条/.test(issue) && /只读到 1 条/.test(issue)),
    `说明里要写清声明 9 与实读 1：${walk.issues.join(' / ')}`,
  )
})

test('没有声明总数、但上一页说 hasMore：走不动时同样是截断', async () => {
  const rig = adapterOf([{ floors: [floorOf(1)], hasMore: true, pagingState: 'more' }])
  const walk = await rig.walk(4)

  assert.equal(walk.truncated, true, 'hasMore: true 是平台明确的承诺，拿不到就是漏了')
  assert.ok(
    walk.issues.some((issue) => /还有更多/.test(issue)),
    `说明里要提到「还有更多」：${walk.issues.join(' / ')}`,
  )
})

test('平台说没有更多、也没有声明总数：走不动就是真的到底，不得判成截断', async () => {
  const rig = adapterOf([{ floors: [floorOf(1)], hasMore: false, pagingState: 'done' }])
  const walk = await rig.walk(4)

  assert.equal(walk.truncated, false, '没有任何承诺时不能反过来谎称有漏')
  assert.equal(walk.complete, true, '平台说结束、且没有矛盾，这就是完整')
  assert.deepEqual(walk.issues, [], '没有矛盾就不该凭空报 issue')
})

// ── 2. 页面说「不知道」：degraded，不是 truncated ───────────────────────────

test('分页信号无法识别：degraded 为 true，且 totalNumber 之外的判断都不升级', async () => {
  const rig = adapterOf([
    { floors: [floorOf(1)], hasMore: true, incomplete: true, pagingState: 'unknown' },
  ])
  const walk = await rig.walk(4)

  assert.equal(walk.degraded, true, '页面自己说不完整，必须记下来')
  assert.equal(walk.complete, false, '不知道有没有读完，就不能说读完')
  assert.ok(
    walk.issues.some((issue) => /没有说明后面还有没有内容/.test(issue)),
    `说明里要写清「不知道」，而不是套用别的措辞：${walk.issues.join(' / ')}`,
  )
})

test('降级说明只写一条：重复 60 页时不该刷 60 条同样的话', async () => {
  const rig = adapterOf([
    { floors: [floorOf(1)], hasMore: true, incomplete: true, pagingState: 'unknown' },
  ])
  const walk = await rig.walk(10)

  const notes = walk.issues.filter((issue) => /没有说明后面还有没有内容/.test(issue))
  assert.equal(notes.length, 1, `只该有一条降级说明，实际 ${notes.length} 条`)
})

test('每一页都说得清时不出现 degraded 字段：false 与「没有」不是一回事', async () => {
  const rig = adapterOf([{ floors: [floorOf(1)], hasMore: false, pagingState: 'done' }])
  const walk = await rig.walk(4)

  assert.equal('degraded' in walk, false, 'degraded 只在真发生过时出现，不写 false')
})

// ── 3. 两个标记互不替代 ─────────────────────────────────────────────────────

test('声明 9 条 + 分页信号不可用：两个标记都要有，各说各的事', async () => {
  const rig = adapterOf([
    { floors: [floorOf(1)], hasMore: true, declaredTotal: 9, incomplete: true, pagingState: 'unknown' },
  ])
  const walk = await rig.walk(4)

  assert.equal(walk.truncated, true, '声明数与实读数对不上，这是有证据的漏读')
  assert.equal(walk.degraded, true, '页面同时说了自己不知道，这也是事实')
  assert.ok(walk.issues.length >= 2, '两件事各需要一句说明，不能合并成一句')
})

test('平台自身矛盾（实读超过声明）优先报矛盾，不降级成截断', async () => {
  const rig = adapterOf([
    {
      floors: [floorOf(1), floorOf(2), floorOf(3)],
      hasMore: true,
      declaredTotal: 2,
      pagingState: 'more',
    },
  ])
  const walk = await rig.walk(4)

  assert.equal(walk.stopReason, 'inconsistent_pagination', '声明 2 却读到 3，是矛盾而不是截断')
  assert.equal(walk.complete, false)
})
