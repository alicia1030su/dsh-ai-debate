/**
 * 贴吧分页能力声明：一次 403 不构成"分页全坏了"的证据。
 *
 * ## 手上的证据只有一条
 *
 * 第十/十二阶段实测（帖子 11111241554，WAP）：
 *
 * - 第 1 页 `pn=0` → 200
 * - 第 2 页 `pn=30` → 403「百度安全验证」
 *
 * 一个帖子、一个网络环境、一次请求。这足以说明"这条路径会撞到安全验证"，
 * **不足以**说明"贴吧的所有分页都不可用"。能力声明是给所有帖子用的，按 n=1
 * 的观测把它降级，等于用一次失败去描述整个平台。
 *
 * ## 降级会不会误伤第一页？
 *
 * 本文件把调用关系钉住：`comment.paginate` 目前**没有任何调用点**会去
 * `assertCapability()`。读取路径（`collectThread` / `walkFloors`）压根不经过能力
 * 闸门——闸门只服务发表（`comment.publish` / `comment.reply`）与验收面板。
 * 所以降级不会阻断读取，它只会改变设置页/诊断页显示的那一行。
 *
 * 既然降级既没有必要（不阻断读取）、又会把 n=1 的观测说成全局结论，本阶段
 * **不改声明**，只保证运行时如实报告分页失败。这一点由 Fix A 的
 * `truncated` / `stopReason` / `issues` 承担。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { collectThread, walkFloors } from '../lib/collector.js'
import { PlatformError } from '../lib/types.js'
import { tiebaCapabilities } from '../lib/platforms/tieba/provider.js'
import { stateOf } from '../lib/platforms/contracts.js'
import type { Floor, ReplyPage, ThreadRef } from '../lib/types.js'
import { makeFloor, FakeAdapter, largeThread } from './helpers.ts'

const ROOT = join(import.meta.dirname, '..')
const REF: ThreadRef = { platform: 'tieba', threadId: '11111241554', url: 'https://tieba.baidu.com/p/11111241554' }

function pageOf(floors: readonly Floor[], extra: Partial<ReplyPage> = {}): ReplyPage {
  return { floors, page: 1, hasMore: true, ...extra } as ReplyPage
}

/** An adapter that serves the listed pages and throws the listed errors. */
function scripted(pages: ReadonlyMap<number, ReplyPage | Error>) {
  const requested: number[] = []
  return {
    requested,
    adapter: {
      async getReplies(_ref: ThreadRef, page: number): Promise<ReplyPage> {
        requested.push(page)
        const answer = pages.get(page)
        if (answer === undefined) throw new Error(`测试没有为第 ${page} 页准备数据`)
        if (answer instanceof Error) throw answer
        return answer
      },
    } as never,
  }
}

// ---------------------------------------------------------------------------
// 1. 声明现状：记录，并说明本阶段有意不改
// ---------------------------------------------------------------------------

test('comment.paginate 仍声明为 supported，本阶段不改全局声明', () => {
  const matrix = tiebaCapabilities()
  const declared = stateOf(matrix, 'comment.paginate')

  assert.equal(
    declared.state,
    'supported',
    '本阶段刻意不改：一次 403 是"这条路径会遇到安全验证"，不是"分页全坏了"的证据',
  )
  assert.match(declared.reason, /分页/, '声明里仍然要说明它主张的是什么')
})

test('声明里的 limits 仍然承认页数上限会导致不完整（与 Fix A 一致）', () => {
  const declared = stateOf(tiebaCapabilities(), 'comment.paginate')
  assert.ok(
    (declared.limits ?? []).some((line) => /不完整/.test(line)),
    '声明本来就承认会读到不完整的结果；v0.2.22 只是让运行时真的把这个事实报出来',
  )
})

// ---------------------------------------------------------------------------
// 2. 调用关系：能力闸门不在读取路径上
// ---------------------------------------------------------------------------

test('读取路径不调用 assertCapability：降级不会把第一页也禁掉', () => {
  // 这是架构事实，只能从源码层面固定。用行为测不出来——"没有调用"在运行时
  // 表现为"什么都没发生"，与"调用了但通过了"无法区分。
  const collector = readFileSync(join(ROOT, 'src', 'collector.ts'), 'utf8')
  assert.doesNotMatch(
    collector,
    /assertCapability|assertPlatformCapability/,
    '收集器一旦开始检查能力，降级 comment.paginate 就会连第一页一起禁掉——那才是真正的全局阻断',
  )

  // 闸门唯一的自动调用点在发表路径。
  const publisher = readFileSync(join(ROOT, 'src', 'publisher.ts'), 'utf8')
  assert.match(publisher, /deps\.assertCapability\(session\.platform, capability\)/)
  assert.match(publisher, /capabilityForSession\(session, candidate\)/)
})

test('发表用的是 comment.publish / comment.reply，不是 comment.paginate', () => {
  const publisher = readFileSync(join(ROOT, 'src', 'publisher.ts'), 'utf8')
  assert.doesNotMatch(
    publisher,
    /assertCapability\(.*'comment\.paginate'/,
    '分页能力不该出现在发表闸门上：它描述的是读取，不是发表',
  )
  assert.match(publisher, /'comment\.reply'|'comment\.publish'/)
})

test('整个 src 里没有对 comment.paginate 的闸门调用', () => {
  const files = ['collector.ts', 'publisher.ts', 'runtime.ts', 'tools.ts', 'index.ts']
  for (const file of files) {
    const source = readFileSync(join(ROOT, 'src', file), 'utf8')
    assert.doesNotMatch(
      source,
      /assertCapability\([^)]*'comment\.paginate'/,
      `${file} 里出现了对 comment.paginate 的闸门调用：请重新评估"降级会不会阻断读取"`,
    )
  }
})

// ---------------------------------------------------------------------------
// 3. 运行时如实报告：这才是本阶段真正交付的东西
// ---------------------------------------------------------------------------

test('第 1 页 200、第 2 页 403：第一页数据保留，且明确标记截断与原因', async () => {
  const { adapter, requested } = scripted(
    new Map<number, ReplyPage | Error>([
      [1, pageOf([makeFloor({ floorNumber: 1, postId: 'p1', authorId: 'u1', authorName: '甲', content: '一' })], {
        declaredTotal: 150,
        declaredTotalPages: 5,
      })],
      [2, new PlatformError('百度安全验证', 'forbidden', { status: 403 })],
    ]),
  )

  const result = await walkFloors(adapter, REF)

  assert.equal(result.floors.length, 1, '第一页读到的内容必须保留')
  assert.equal(result.complete, false)
  assert.equal(result.stopReason, 'deleted_or_unavailable', '失败分类不得被这次改动改掉')
  assert.equal(result.truncated, true, '平台说 5 页、只读 1 页，就是截断')
  assert.deepEqual(requested, [1, 2], '不得重试，也不得继续试探第 3 页')
  assert.ok(
    result.issues.some((issue) => /中断/.test(issue)),
    `必须留下给人看的原因，实际：${result.issues.join(' | ') || '空'}`,
  )
})

test('collectThread 层：403 之后 issues 里能同时看到"中断"和"不是完整结果"', async () => {
  // 需要至少两页，否则第 1 页就会以 hasMore=false 正常结束，走不到第 2 页的 403。
  const fixture = largeThread(60)
  const adapter = new FakeAdapter({
    thread: fixture.thread,
    floors: fixture.floors,
    failAtPage: 2,
  })

  const collected = await collectThread(adapter, { platform: 'tieba', threadId: fixture.thread.id, url: fixture.thread.url }, {
    wantNested: () => false,
  })

  assert.equal(collected.complete, false)
  assert.ok(collected.floors.length > 0, '已读楼层必须保留')
  const issues = collected.issues.join('\n')
  assert.match(issues, /中断/, '要说清读取中断了')
  assert.match(issues, /不是完整结果|截断/, '要说明这不是完整结果——否则读者会以为帖子只有这些')
})

test('第一页就 403 时，不谎称"还有页没读"', async () => {
  const { adapter } = scripted(new Map<number, ReplyPage | Error>([[1, new PlatformError('百度安全验证', 'forbidden')]]))
  const result = await walkFloors(adapter, REF)

  assert.equal(result.truncated, false, '什么都没读到，不知道后面有没有页')
  assert.equal(result.complete, false, '但也不能说读完了')
  assert.equal(result.stopReason, 'deleted_or_unavailable')
})
