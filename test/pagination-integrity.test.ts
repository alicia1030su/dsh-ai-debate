/**
 * 回归测试：分页总页数与结束标志冲突（缺陷二）
 *
 * 被测代码：`src/collector.ts` 的 `collectThread()` / `walkFloors()`。
 *
 * 复现过的缺陷（v0.2.1）：平台声明 `declaredTotalPages = 8`，第一页却返回
 * `hasMore = false`，程序给出 `pagesRead = 1, complete = true,
 * stopReason = 'confirmed_end'`。
 *
 * 根因：`walkFloors` 把 `hasMore: false` 直接当成结束证据，从不与同一页上的
 * `declaredTotalPages` / `declaredTotal` 交叉核对。两个互斥的信号都在同一份响应
 * 里，代码却按“先读到哪个分支就信哪个”来解决，于是“只读一页就宣布读完”。
 *
 * 本文件只钉**结论**，不钉实现方式。合法修复可以是加一个专门的 stopReason，
 * 也可以是保留 stopReason 但在 issues / completeness.reasons 里写明矛盾——
 * 因此断言统一走 `assertNotCompleteButFlagged()`。
 *
 * 后半部分是回归保护：正常路径（信号真的自洽）必须仍然判为完整。修复很容易
 * 矫枉过正成“永远不完整”，那同样是错的。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { collectThread, walkFloors } from '../lib/collector.js'
import { PlatformError } from '../lib/types.js'
import type {
  AuthState,
  CollectedThread,
  Floor,
  Mention,
  NestedPage,
  PlatformAdapter,
  PublishOutcome,
  ReplyContext,
  ReplyPage,
  Thread,
  ThreadRef,
  UserProfile,
} from '../lib/types.js'

// ---------------------------------------------------------------------------
// 脚本化分页假适配器
//
// 每一页的内容由测试逐页给出，所以“平台声明了什么”与“平台实际返回了什么”
// 可以被独立控制——这正是复现本缺陷所需的能力。getReplies 是真实实现，
// 其余方法也都真的做事，不是空壳。
// ---------------------------------------------------------------------------

interface ScriptedPage {
  readonly floors: readonly Floor[]
  readonly hasMore: boolean
  readonly declaredTotalPages?: number
  readonly declaredTotal?: number
}

type ScriptEntry = ScriptedPage | { readonly throws: Error }

const PAGE_SIZE = 30

/** 造一页连续楼层。postId 由楼层号推导，跨页唯一，便于去重断言。 */
function makePageFloors(from: number, count: number): Floor[] {
  const out: Floor[] = []
  for (let index = 0; index < count; index += 1) {
    const floorNumber = from + index
    out.push({
      platform: 'pager',
      floorNumber,
      postId: `p${floorNumber}`,
      authorId: `u${floorNumber % 7}`,
      authorName: `用户${floorNumber % 7}`,
      content: `第 ${floorNumber} 楼的发言。`,
      createdAt: '2024-1-1',
      images: [],
    })
  }
  return out
}

function makeThread(id = 'pager-t1'): Thread {
  return {
    platform: 'pager',
    forum: { platform: 'pager', id: '1', name: '分页测试区' },
    id,
    title: '分页信号一致性测试帖',
    content: '正文',
    authorId: 'host-1',
    authorName: '楼主',
    createdAt: '2024-1-1',
    url: `https://pager.example/thread/${id}`,
    images: [],
  }
}

class ScriptedAdapter implements PlatformAdapter {
  readonly id = 'pager'
  readonly displayName = '分页测试平台'
  /** 每一页被真正请求的顺序，用来自证“没有静默跳过某一页”。 */
  readonly requested: number[] = []

  constructor(private readonly script: readonly ScriptEntry[]) {}

  get pagesRead(): number {
    return this.requested.length
  }

  getCapabilities() {
    return {
      thread: true,
      replies: true,
      nestedReplies: true,
      userProfile: false,
      mentions: false,
      publish: false,
      authCheck: true,
    }
  }

  async checkAuthentication(): Promise<AuthState> {
    return { authenticated: true, userId: 'pager-ai', userName: '分页小号' }
  }

  async getThread(): Promise<Thread> {
    return makeThread()
  }

  async getReplies(_ref: ThreadRef, page: number): Promise<ReplyPage> {
    this.requested.push(page)
    const entry = this.script[page - 1]
    if (entry === undefined) {
      // 脚本之外的一页：明确失败，而不是返回空页让被测代码“看起来读完了”。
      // 这也保证测试本身不会无限循环。
      throw new Error(`脚本没有第 ${page} 页（已脚本化 ${this.script.length} 页）`)
    }
    if ('throws' in entry) throw entry.throws
    return {
      floors: entry.floors,
      page,
      hasMore: entry.hasMore,
      ...(entry.declaredTotalPages === undefined ? {} : { declaredTotalPages: entry.declaredTotalPages }),
      ...(entry.declaredTotal === undefined ? {} : { declaredTotal: entry.declaredTotal }),
    }
  }

  async getNestedReplies(_ref: ThreadRef, _floor: Floor, page: number): Promise<NestedPage> {
    return { replies: [], page, hasMore: false, declaredTotalPages: 1, declaredTotal: 0 }
  }

  async getUserProfile(): Promise<UserProfile> {
    throw new PlatformError('不提供用户资料', 'permission_denied')
  }

  async getMentions(): Promise<readonly Mention[]> {
    throw new PlatformError('不提供艾特通知', 'permission_denied')
  }

  async getReplyContext(_ref: ThreadRef, postId: string): Promise<ReplyContext> {
    for (const entry of this.script) {
      if ('throws' in entry) continue
      const floor = entry.floors.find((candidate) => candidate.postId === postId)
      if (floor !== undefined) return { thread: makeThread(), floor, ancestors: [], siblings: [] }
    }
    throw new PlatformError(`找不到 ${postId}`, 'not_found')
  }

  async publishReply(): Promise<PublishOutcome> {
    throw new PlatformError('该测试平台不提供发表能力', 'permission_denied')
  }
}

/** 一页连续楼层 + 常用声明，减少样板。 */
function page(
  from: number,
  count: number,
  hasMore: boolean,
  declared?: { pages?: number; total?: number },
): ScriptEntry {
  return {
    floors: makePageFloors(from, count),
    hasMore,
    ...(declared?.pages === undefined ? {} : { declaredTotalPages: declared.pages }),
    ...(declared?.total === undefined ? {} : { declaredTotal: declared.total }),
  }
}

// ---------------------------------------------------------------------------
// 统一的“不得宣称完整、但必须留下矛盾痕迹”断言
//
// 允许两种修复形态：
//   (a) 换一个非 confirmed_end 的 stopReason；或
//   (b) 保留 stopReason，但在 issues 或 completeness.reasons 里写明矛盾。
// 不允许的只有：complete === true，或既 complete === false 又什么线索都没有。
// ---------------------------------------------------------------------------

const CONTRADICTION_WORDS = /矛盾|不一致|冲突|声明|conflict|mismatch|inconsistent/i

interface ContradictionEvidence {
  readonly flagged: boolean
  readonly detail: string
}

function explain(collected: CollectedThread): ContradictionEvidence {
  const notes = [...collected.issues, ...(collected.completeness?.reasons ?? [])]
  const flagged =
    collected.stopReason !== 'confirmed_end' || notes.some((note) => CONTRADICTION_WORDS.test(note))
  return {
    flagged,
    detail:
      `stopReason=${String(collected.stopReason)}, 楼数=${collected.floors.length}, ` +
      `truncated=${String(collected.truncated)}, ` +
      `issues=[${collected.issues.join(' | ') || '空'}], ` +
      `reasons=[${(collected.completeness?.reasons ?? []).join(' | ') || '空'}]`,
  }
}

/** 断言：绝不宣称完整，且留下可被上层展示的矛盾痕迹，且已读数据仍在。 */
function assertNotCompleteButFlagged(collected: CollectedThread, scenario: string): void {
  const evidence = explain(collected)
  assert.equal(
    collected.complete,
    false,
    `${scenario}：两个信号互相矛盾时不得宣称完整读取。实际 ${evidence.detail}`,
  )
  assert.ok(
    collected.floors.length > 0,
    `${scenario}：报告不完整不等于丢掉已读数据，实际读到 0 楼`,
  )
  assert.equal(
    evidence.flagged,
    true,
    `${scenario}：必须留下矛盾标记（非 confirmed_end 的 stopReason，或说明写明声明不一致），` +
      `否则上层只会看到一个“读完了”的短结果。实际 ${evidence.detail}`,
  )
  // 新结构必须也说清楚来源不完整，否则调用方读 completeness 会被误导。
  if (collected.completeness !== undefined) {
    assert.equal(
      collected.completeness.sourceComplete,
      false,
      `${scenario}：completeness.sourceComplete 必须为 false。实际 ${evidence.detail}`,
    )
    assert.equal(
      collected.completeness.analysisComplete,
      false,
      `${scenario}：来源不完整时 analysisComplete 不得为 true。实际 ${evidence.detail}`,
    )
  }
}

const REF: ThreadRef = { platform: 'pager', threadId: 'pager-t1', url: 'https://pager.example/thread/pager-t1' }

// ---------------------------------------------------------------------------
// 1. declaredTotalPages = 8 但第一页就说 hasMore = false
//    —— 缺陷最纯的形态，也是任务里实测复现的那一条
// ---------------------------------------------------------------------------

test('缺陷二-1：声明 8 页却在第一页收到 hasMore=false，不得判定为完整', async () => {
  const adapter = new ScriptedAdapter([
    // 同一份响应里两个互斥的声明：共 8 页 / 本页是最后一页。
    page(1, PAGE_SIZE, false, { pages: 8 }),
    // 后面 7 页确实存在；正确处理要么去读，要么明确报告“没读完”。
    ...Array.from({ length: 7 }, (_, index) =>
      page((index + 1) * PAGE_SIZE + 1, PAGE_SIZE, index < 6, { pages: 8 }),
    ),
  ])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  // 只读 1 页本身没问题（平台说结束了）；问题是不能因此宣称“完整”。
  assert.equal(adapter.pagesRead, 1, `应只读了 1 页，实际 ${adapter.pagesRead} 页`)
  assertNotCompleteButFlagged(collected, '声明 8 页却在第 1 页 hasMore=false')
  // 已读的 30 楼必须保留（partial success 是契约的一部分）。
  assert.equal(collected.floors.length, PAGE_SIZE, `已读的 ${PAGE_SIZE} 楼必须保留`)
})

test('缺陷二-1b：walkFloors 层面同样不得把矛盾当 confirmed_end', async () => {
  const adapter = new ScriptedAdapter([page(1, PAGE_SIZE, false, { pages: 8 })])
  const walk = await walkFloors(adapter, REF)

  assert.equal(walk.pagesRead, 1)
  assert.equal(
    walk.complete,
    false,
    `声明 8 页只读了 1 页却判为完整：stopReason=${walk.stopReason}, missingCount=${String(walk.missingCount)}`,
  )
  const flagged =
    walk.stopReason !== 'confirmed_end' ||
    walk.issues.some((issue) => CONTRADICTION_WORDS.test(issue))
  assert.equal(
    flagged,
    true,
    `walkFloors 至少要给出一个可核对的矛盾信号，实际 stopReason=${walk.stopReason}, ` +
      `issues=[${walk.issues.join(' | ') || '空'}]`,
  )
  assert.equal(walk.truncated, false, '这不是分页上限，不应标成 truncated')
})

test('缺陷二-1c：矛盾必须能被区分于“读到了真正的最后一页”', async () => {
  // 对照组：声明 1 页、第 1 页 hasMore=false —— 信号自洽，必须完整。
  const consistent = await walkFloors(
    new ScriptedAdapter([page(1, PAGE_SIZE, false, { pages: 1 })]),
    REF,
  )
  const contradictory = await walkFloors(
    new ScriptedAdapter([page(1, PAGE_SIZE, false, { pages: 8 })]),
    REF,
  )
  assert.equal(consistent.complete, true, '自洽的单页帖必须判为完整')
  assert.equal(contradictory.complete, false, '自相矛盾的响应不得判为完整')
  assert.notEqual(
    contradictory.stopReason,
    consistent.stopReason,
    '“平台确认这是最后一页”与“平台的声明互相打架”必须是两个不同的结论',
  )
})

// ---------------------------------------------------------------------------
// 2. declaredTotalPages 声明错误：声明 3 页，实际 2 页结束
// ---------------------------------------------------------------------------

test('缺陷二-2：声明 3 页但第 2 页就结束，不得谎称完整', async () => {
  const adapter = new ScriptedAdapter([
    page(1, PAGE_SIZE, true, { pages: 3 }),
    // 第 2 页改口说没有下一页了，但它之前说共有 3 页。
    page(PAGE_SIZE + 1, PAGE_SIZE, false, { pages: 3 }),
  ])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.equal(adapter.pagesRead, 2, `应读了 2 页，实际 ${adapter.pagesRead}`)
  assert.equal(collected.floors.length, PAGE_SIZE * 2, '两页共 60 楼必须都保留')
  assertNotCompleteButFlagged(collected, '声明 3 页却只到 2 页')
})

test('缺陷二-2b：声明页数的“反向冲突”——声称还有页却按声明停下，不得宣称完整', async () => {
  // 与 1、2 正好相反的一侧：`hasMore: true` 明说“还有下一页”，
  // 但 `declaredTotalPages` / `declaredTotal` 同时说“已经到最后一页了”。
  //
  // v0.2.1（以及本次修复的第一版）只检查了 `hasMore: false` 那一侧，
  // 于是这里会**一页不多读、也不报任何问题**，直接 complete: true：
  // 第 2 页明明存在却从未被请求，用户拿到的是一个静默截断的短结果。
  //
  // 允许的两种正确处理：
  //   (a) 相信 hasMore，继续读第 2 页；或
  //   (b) 按声明停下，但把它当矛盾处理（不完整 + 留下痕迹）。
  // 不允许：只读 1 页、丢下确实存在的第 2 页、还宣称完整且只字不提。

  const byPageCount = new ScriptedAdapter([
    page(1, PAGE_SIZE, true, { pages: 1 }), // 声明 1 页，却 hasMore=true
    page(PAGE_SIZE + 1, PAGE_SIZE, false, { pages: 1 }), // 第 2 页确实存在
  ])
  const pageWalk = await walkFloors(byPageCount, REF)

  if (byPageCount.pagesRead === 1) {
    assert.equal(
      pageWalk.complete,
      false,
      '声明 1 页却 hasMore=true 且第 2 页确实存在：只读了 1 页、丢下第 2 页，却宣称完整。' +
        `实际 stopReason=${pageWalk.stopReason}, floors=${pageWalk.floors.length}, ` +
        `issues=[${pageWalk.issues.join(' | ') || '空'}]`,
    )
  } else {
    // 选择继续读：那么第 2 页的数据必须在结果里。
    assert.equal(pageWalk.floors.length, PAGE_SIZE * 2, '既然读了第 2 页，它的楼层就不能丢')
  }

  // 同一侧的另一路信号：声明楼层数恰好等于已读数量，但 hasMore=true。
  const byFloorTotal = new ScriptedAdapter([
    page(1, PAGE_SIZE, true, { total: PAGE_SIZE }), // 声明 30 楼，正好读到 30 楼，却 hasMore=true
    page(PAGE_SIZE + 1, PAGE_SIZE, false, { total: 2 * PAGE_SIZE }), // 第 2 页确实存在
  ])
  const totalWalk = await walkFloors(byFloorTotal, REF)

  if (byFloorTotal.pagesRead === 1) {
    assert.equal(
      totalWalk.complete,
      false,
      '声明 30 楼正好读到 30 楼，但 hasMore=true 且第 2 页确实存在：' +
        '只读 1 页就宣称完整，等于把“还有下一页”这条信号静默吞掉。' +
        `实际 stopReason=${totalWalk.stopReason}, floors=${totalWalk.floors.length}, ` +
        `issues=[${totalWalk.issues.join(' | ') || '空'}]`,
    )
  } else {
    assert.ok(totalWalk.floors.length >= PAGE_SIZE * 2, '既然读了第 2 页，它的楼层就不能丢')
  }
})

// ---------------------------------------------------------------------------
// 3. declaredTotal（楼层总数）与实际去重数量矛盾
// ---------------------------------------------------------------------------

test('缺陷二-3a：声明 45 楼只读到 30 楼——不得谎称完整（这条是核心）', async () => {
  const adapter = new ScriptedAdapter([page(1, PAGE_SIZE, false, { total: 45 })])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.equal(collected.floors.length, PAGE_SIZE, '读到的 30 楼都要保留')
  assertNotCompleteButFlagged(collected, '声明 45 楼却只读到 30 楼')
  assert.equal(collected.missingCount, 15, `应报告缺少 15 楼，实际 ${String(collected.missingCount)}`)
  assert.ok(
    collected.issues.some((issue) => issue.includes('缺少')),
    `应如实报告缺失楼层，实际 issues：${collected.issues.join(' | ') || '空'}`,
  )
})

test('缺陷二-3b：声明 10 楼却读到 12 楼——超出声明时必须留下痕迹，不能静默', async () => {
  // 读到的比声明的多：覆盖上没丢东西，但“平台声明”这一路信号已被证伪。
  // 允许的结论只有两种：
  //   1. 判为不完整（不轻易相信任何一路信号）；或
  //   2. 判为完整，但必须把“声明数对不上”写进 issues / reasons。
  // 不允许的是：complete=true 且什么都不说——那等于把一个已知的矛盾吞掉。
  const adapter = new ScriptedAdapter([page(1, 12, false, { total: 10 })])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.equal(collected.floors.length, 12, '读到的 12 楼都要保留')

  if (collected.complete) {
    const noted = [...collected.issues, ...(collected.completeness?.reasons ?? [])].some((note) =>
      CONTRADICTION_WORDS.test(note),
    )
    assert.equal(
      noted,
      true,
      '声明 10 楼却读到 12 楼，却既不判不完整、也不记录矛盾：' +
        `平台声明被静默忽略。实际 ${explain(collected).detail}`,
    )
  } else {
    assertNotCompleteButFlagged(collected, '声明 10 楼却读到 12 楼')
  }

  // 无论哪种结论，都不能自称“少了楼层”——那是另一回事。
  assert.equal(
    collected.missingCount,
    undefined,
    '读到 12 楼却报告 missingCount > 0 是自相矛盾的报告',
  )
})

test('缺陷二-3c：声明页数与声明楼层数同时矛盾时同样不得宣称完整', async () => {
  const adapter = new ScriptedAdapter([page(1, PAGE_SIZE, false, { pages: 5, total: 150 })])
  const collected = await collectThread(adapter, REF, { wantNested: () => false })
  assertNotCompleteButFlagged(collected, '声明 5 页 / 150 楼，只读到 1 页 / 30 楼')
})

test('缺陷二-3d：声明楼层数与去重后的数量比对，而不是与收到的行数比对', async () => {
  // 同一页里混入 5 条重复楼层：收到的行是 30，去重后是 25。
  // 若拿“收到的行数”去比声明数，会得出“够了”的错误结论。
  const rows = makePageFloors(1, 25)
  const duplicated = [...rows, ...rows.slice(0, 5)]
  assert.equal(duplicated.length, PAGE_SIZE)
  const adapter = new ScriptedAdapter([{ floors: duplicated, hasMore: false, declaredTotal: PAGE_SIZE }])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.equal(collected.floors.length, 25, '去重后应只有 25 楼')
  assert.equal(
    collected.complete,
    false,
    `去重后只有 25 楼，少于声明的 ${PAGE_SIZE} 楼，不能宣称完整：${explain(collected).detail}`,
  )
  assert.equal(collected.missingCount, 5, `应报告缺少 5 楼，实际 ${String(collected.missingCount)}`)
})

// ---------------------------------------------------------------------------
// 4. 重复页面
// ---------------------------------------------------------------------------

test('缺陷二-4：同一页内容反复返回时不得无限循环，也不得宣称完整', async () => {
  const repeated = makePageFloors(1, PAGE_SIZE)
  const adapter = new ScriptedAdapter(
    Array.from({ length: 10 }, () => ({ floors: repeated, hasMore: true })),
  )

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  // 重复页在第一次“零新增”时就该停下，而不是把 10 页脚本读完或死循环。
  assert.ok(adapter.pagesRead <= 2, `重复页应在第 2 页内停下，实际读了 ${adapter.pagesRead} 页`)
  assert.equal(collected.floors.length, PAGE_SIZE, '去重后应只有 30 楼')
  assert.equal(collected.complete, false, '只有重复数据时不能宣称完整')
  assert.notEqual(
    collected.stopReason,
    'confirmed_end',
    `重复页不得被当成平台确认的结束，实际 stopReason=${collected.stopReason}`,
  )
})

test('缺陷二-4b：重复页 + 声明了总页数时也不能把重复当成“读完了”', async () => {
  const repeated = makePageFloors(1, PAGE_SIZE)
  const adapter = new ScriptedAdapter(
    Array.from({ length: 4 }, () => ({ floors: repeated, hasMore: true, declaredTotalPages: 4 })),
  )

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.ok(adapter.pagesRead < 4, `重复页不得读满 4 页，实际 ${adapter.pagesRead}`)
  assert.equal(collected.floors.length, PAGE_SIZE)
  assert.equal(
    collected.complete,
    false,
    `4 页里只拿到 30 个唯一楼层，不能宣称完整：${explain(collected).detail}`,
  )
})

test('缺陷二-4c：重复页必须停机且有边界（不会把 maxPages 走满）', async () => {
  const repeated = makePageFloors(1, PAGE_SIZE)
  const adapter = new ScriptedAdapter(
    Array.from({ length: 60 }, () => ({ floors: repeated, hasMore: true })),
  )
  const walk = await walkFloors(adapter, REF, { maxPages: 60 })

  assert.ok(walk.pagesRead <= 3, `重复页应在极少数页内停下，实际 ${walk.pagesRead} 页`)
  assert.equal(walk.complete, false)
  assert.equal(walk.floors.length, PAGE_SIZE, '去重后只有 30 楼')
})

// ---------------------------------------------------------------------------
// 5. 限流 / 超时
// ---------------------------------------------------------------------------

test('缺陷二-5a：第 2 页被限流时 complete=false，且第 1 页数据保留', async () => {
  const adapter = new ScriptedAdapter([
    page(1, PAGE_SIZE, true, { pages: 3 }),
    { throws: new PlatformError('请求过于频繁，请稍后再试', 'rate_limited') },
  ])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.equal(collected.complete, false, '限流不得宣称完整')
  assert.equal(collected.stopReason, 'rate_limited', `应记录限流原因，实际 ${collected.stopReason}`)
  assert.equal(collected.floors.length, PAGE_SIZE, '第 1 页的 30 楼必须保留')
  assert.ok(
    collected.issues.some((issue) => issue.includes('中断')),
    `应报告读取中断，实际 issues：${collected.issues.join(' | ') || '空'}`,
  )
})

test('缺陷二-5b：第 3 页超时时 complete=false，前两页数据保留', async () => {
  const adapter = new ScriptedAdapter([
    page(1, PAGE_SIZE, true, { pages: 4 }),
    page(PAGE_SIZE + 1, PAGE_SIZE, true, { pages: 4 }),
    { throws: new PlatformError('请求超时', 'timeout') },
  ])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.equal(collected.complete, false, '超时不得宣称完整')
  assert.equal(collected.stopReason, 'request_error', `应记录请求失败原因，实际 ${collected.stopReason}`)
  assert.equal(collected.floors.length, PAGE_SIZE * 2, '前两页的 60 楼必须保留')
  assert.equal(collected.truncated, false, '这不是分页上限造成的截断')
})

test('缺陷二-5c：限流与传输错误必须是不同的 stopReason', async () => {
  const limited = await walkFloors(
    new ScriptedAdapter([{ throws: new PlatformError('限流', 'rate_limited') }]),
    REF,
  )
  const timeout = await walkFloors(
    new ScriptedAdapter([{ throws: new PlatformError('超时', 'timeout') }]),
    REF,
  )
  assert.equal(limited.complete, false)
  assert.equal(timeout.complete, false)
  assert.notEqual(
    limited.stopReason,
    timeout.stopReason,
    '“慢一点数据还在”与“这次读取失败了”不是同一个事实，不能合并',
  )
})

test('缺陷二-5d：已删除 / 无权限的帖子要与普通网络错误区分开', async () => {
  const missing = await walkFloors(
    new ScriptedAdapter([{ throws: new PlatformError('帖子不存在', 'not_found') }]),
    REF,
  )
  const forbidden = await walkFloors(
    new ScriptedAdapter([{ throws: new PlatformError('需要登录', 'forbidden') }]),
    REF,
  )
  assert.equal(missing.stopReason, 'deleted_or_unavailable')
  assert.equal(forbidden.stopReason, 'deleted_or_unavailable')
  assert.equal(missing.complete, false)
  assert.equal(forbidden.complete, false)
})

// ---------------------------------------------------------------------------
// 6. 分页上限
// ---------------------------------------------------------------------------

test('缺陷二-6：maxPages 截断必须是 page_cap / truncated / 不完整', async () => {
  const adapter = new ScriptedAdapter(
    Array.from({ length: 5 }, (_, index) => page(index * PAGE_SIZE + 1, PAGE_SIZE, true)),
  )

  const collected = await collectThread(adapter, REF, { maxPages: 2, wantNested: () => false })

  assert.equal(collected.stopReason, 'page_cap', `应记录分页上限，实际 ${collected.stopReason}`)
  assert.equal(collected.truncated, true, '必须知道还有页没读')
  assert.equal(collected.complete, false, '被自己的上限截断永远不算完整')
  assert.equal(collected.floors.length, PAGE_SIZE * 2, '已读的两页必须保留')
  assert.ok(
    collected.issues.some((issue) => issue.includes('分页上限') && issue.includes('不是完整结果')),
    `应显式告知用户被截断，实际 issues：${collected.issues.join(' | ') || '空'}`,
  )
  assert.notEqual(collected.stopReason, 'confirmed_end', '平台明明还有页，不能写成“读完了”')
})

test('缺陷二-6b：分页上限与“信号矛盾”必须是两种不同的结论', async () => {
  const capped = await walkFloors(
    new ScriptedAdapter(Array.from({ length: 5 }, (_, i) => page(i * PAGE_SIZE + 1, PAGE_SIZE, true))),
    REF,
    { maxPages: 2 },
  )
  const contradictory = await walkFloors(
    new ScriptedAdapter([page(1, PAGE_SIZE, false, { pages: 8 })]),
    REF,
  )
  assert.notEqual(
    capped.stopReason,
    contradictory.stopReason,
    '“我自己设了上限”与“平台说法自相矛盾”是两件事，用户需要知道该改哪个',
  )
  assert.equal(capped.truncated, true)
  assert.equal(contradictory.truncated, false)
})

// ---------------------------------------------------------------------------
// 7. 正常路径：信号一致、真的读完了 —— 修复不得破坏这里
// ---------------------------------------------------------------------------

test('缺陷二-7a：信号完全一致的三页帖必须判为完整（回归保护）', async () => {
  const adapter = new ScriptedAdapter([
    page(1, PAGE_SIZE, true, { pages: 3, total: 90 }),
    page(PAGE_SIZE + 1, PAGE_SIZE, true, { pages: 3, total: 90 }),
    page(PAGE_SIZE * 2 + 1, PAGE_SIZE, false, { pages: 3, total: 90 }),
  ])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.equal(adapter.pagesRead, 3, `应读满 3 页，实际 ${adapter.pagesRead}`)
  assert.equal(collected.floors.length, 90)
  assert.equal(
    collected.complete,
    true,
    `读完 90/90 楼必须判为完整：${explain(collected).detail}`,
  )
  assert.equal(collected.stopReason, 'confirmed_end')
  assert.equal(collected.truncated, false)
  assert.equal(collected.missingCount, undefined, '没有缺楼时不得报告缺失')
  assert.equal(collected.issues.length, 0, `正常读取不应有任何 issue，实际：${collected.issues.join(' | ')}`)
  if (collected.completeness !== undefined) {
    assert.equal(collected.completeness.sourceComplete, true, '来源应判为完整')
    assert.equal(collected.completeness.analysisComplete, true, '分析所需数据应判为完整')
    assert.equal(collected.completeness.reasons.length, 0, '完整时不应有原因条目')
  }
})

test('缺陷二-7b：只有 hasMore 信号、没有声明总数时，最后一页仍算完整（回归保护）', async () => {
  const adapter = new ScriptedAdapter([page(1, PAGE_SIZE, true), page(PAGE_SIZE + 1, PAGE_SIZE, false)])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.equal(adapter.pagesRead, 2)
  assert.equal(collected.floors.length, 60)
  assert.equal(
    collected.complete,
    true,
    `没有声明总数时，hasMore=false 就是唯一的结束证据，必须被接受：${explain(collected).detail}`,
  )
  assert.equal(collected.stopReason, 'confirmed_end')
  assert.equal(collected.truncated, false)
})

test('缺陷二-7c：单页帖（1 页 5 楼）必须完整，不能被“矛盾检查”误伤', async () => {
  const adapter = new ScriptedAdapter([page(1, 5, false, { pages: 1, total: 5 })])

  const collected = await collectThread(adapter, REF, { wantNested: () => false })

  assert.equal(collected.floors.length, 5)
  assert.equal(collected.complete, true, `单页帖必须完整：${explain(collected).detail}`)
  assert.equal(collected.stopReason, 'confirmed_end')
})

test('缺陷二-7d：hasMore=false 且恰好达到声明楼层数时必须完整（边界值）', async () => {
  // 声明的楼层数与实际读到的完全相等——最容易把矛盾检查写成“差一”错误的地方。
  const walk = await walkFloors(
    new ScriptedAdapter([page(1, PAGE_SIZE, false, { pages: 1, total: PAGE_SIZE })]),
    REF,
  )
  assert.equal(walk.floors.length, PAGE_SIZE)
  assert.equal(walk.complete, true, `恰好读满声明数必须判为完整：stopReason=${walk.stopReason}`)
  assert.equal(walk.stopReason, 'confirmed_end')
  assert.equal(walk.missingCount, undefined)
})

test('缺陷二-7e：多页且逐页声明一致时必须完整（回归保护）', async () => {
  const walk = await walkFloors(
    new ScriptedAdapter([
      page(1, PAGE_SIZE, true, { pages: 4, total: 120 }),
      page(PAGE_SIZE + 1, PAGE_SIZE, true, { pages: 4, total: 120 }),
      page(PAGE_SIZE * 2 + 1, PAGE_SIZE, true, { pages: 4, total: 120 }),
      page(PAGE_SIZE * 3 + 1, PAGE_SIZE, false, { pages: 4, total: 120 }),
    ]),
    REF,
  )
  assert.equal(walk.pagesRead, 4)
  assert.equal(walk.floors.length, 120)
  assert.equal(walk.complete, true, `四页 120/120 楼必须完整：stopReason=${walk.stopReason}`)
  assert.equal(walk.missingCount, undefined)
  assert.equal(walk.issues.length, 0, `自洽的读取不应报 issue：${walk.issues.join(' | ')}`)
})
