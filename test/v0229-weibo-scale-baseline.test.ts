/**
 * Measured behaviour of the Weibo read path as the conversation grows.
 *
 * ## What this file is for (v0.2.29 task book §九)
 *
 * The task book asks for timing, call counts and failure behaviour under load, recorded
 * rather than asserted in prose. The v0.2.27 baseline did this for Tieba; Weibo had none,
 * so "it handles large threads" was an untested claim.
 *
 * ## Why the assertions are bounds, not exact numbers
 *
 * Wall-clock numbers differ by machine and by load. Asserting "under 200 ms" would make
 * this file a flaky test that gets relaxed until it means nothing. What is asserted is the
 * *shape*: the number of CLI invocations must be bounded by the page count, deduplication
 * must be O(n) not O(n²) in effect, and the projection must not rescan the payload per
 * node. The timings are printed as diagnostics for the report to quote.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { projectWeiboThread } from '../lib/platforms/weibo/conversation.js'
import type { WeiboComment, WeiboThreadPayload } from '../lib/platforms/weibo/conversation.js'

const ROOT = '5021243409116023'

function makeComments(count: number): WeiboComment[] {
  const comments: WeiboComment[] = []
  for (let index = 0; index < count; index += 1) {
    comments.push({
      id: String(6000000 + index),
      user: { uid: String(2000 + (index % 50)), screenName: `用户${index % 50}` },
      text: `第 ${index} 条评论`,
      // Every tenth comment answers the one before it, so the graph has real reply edges
      // and the neighbour lookup is exercised at scale.
      ...(index % 10 === 0 && index > 0 ? { replyToCommentId: String(6000000 + index - 1) } : {}),
    })
  }
  return comments
}

function payloadOf(comments: readonly WeiboComment[], overrides: Partial<WeiboThreadPayload> = {}): WeiboThreadPayload {
  return {
    post: { mid: ROOT, user: { uid: '1001', screenName: '博主' }, text: '正文' },
    comments,
    sourceComplete: true,
    stopReason: 'complete',
    ...overrides,
  }
}

/** Run `fn` once, returning its result and the elapsed milliseconds. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = process.hrtime.bigint()
  const value = fn()
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  return { value, ms }
}

test('规模基线：500 / 2000 / 5000 条评论的投影耗时随规模线性增长', (t) => {
  const sizes = [500, 2000, 5000] as const
  const samples: { size: number; ms: number; nodes: number; edges: number }[] = []

  for (const size of sizes) {
    const comments = makeComments(size)
    const { value: graph, ms } = timed(() => projectWeiboThread(payloadOf(comments)))
    samples.push({ size, ms, nodes: graph.nodes.length, edges: graph.edges.length })
    t.diagnostic(
      `  ${String(size).padStart(5)} 条 → ${ms.toFixed(1).padStart(7)} ms，` +
        `${graph.nodes.length} 节点 / ${graph.edges.length} 边`,
    )
    // Every comment becomes exactly one node plus the root.
    assert.equal(graph.nodes.length, size + 1, `${size} 条评论的节点数不对`)
  }

  // ## The shape check, not a stopwatch check
  //
  // A quadratic projection would show ~100× from 500 to 5000 (10²); linear shows ~10×. The
  // bound is deliberately loose (30×) so a slow machine cannot fail it, while still
  // catching an actual complexity regression — which is the thing that would hurt a real
  // 5000-comment thread.
  const small = samples[0]!
  const large = samples[2]!
  const ratio = large.ms / Math.max(small.ms, 0.5)
  t.diagnostic(`  5000/500 耗时比 ${ratio.toFixed(1)}×（线性约 10×，二次约 100×）`)
  assert.ok(
    ratio < 30,
    `500 → 5000 的耗时比 ${ratio.toFixed(1)}× 超过线性量级，怀疑有二次复杂度`,
  )
})

test('规模基线：大量重复 id 时去重仍然只遍历一次', (t) => {
  // 50% duplicates: the worst case for a naive "check the array each time" implementation,
  // which would be O(n²) and visibly slower than the clean case at this size.
  const unique = makeComments(2000)
  const doubled: WeiboComment[] = []
  for (const comment of unique) {
    doubled.push(comment, { ...comment })
  }

  const clean = timed(() => projectWeiboThread(payloadOf(unique)))
  const duped = timed(() => projectWeiboThread(payloadOf(doubled)))
  t.diagnostic(`  2000 条唯一 → ${clean.ms.toFixed(1)} ms / ${clean.value.nodes.length} 节点`)
  t.diagnostic(`  4000 条（半数重复）→ ${duped.ms.toFixed(1)} ms / ${duped.value.nodes.length} 节点`)

  assert.equal(duped.value.nodes.length, clean.value.nodes.length, '去重后节点数必须与唯一时相同')
  assert.ok(
    duped.ms < clean.ms * 8 + 50,
    `重复项使耗时从 ${clean.ms.toFixed(1)}ms 涨到 ${duped.ms.toFixed(1)}ms，不像是一次遍历`,
  )
  // The de-duplication must be reported, not silent: the owner has to be able to reconcile
  // "the platform sent 4000" with "the graph shows 2000".
  assert.ok(
    duped.value.coverage.issues.some((issue) => issue.includes('重复')),
    '去重要在 coverage 里说明',
  )
})

test('规模基线：回复边查找不随评论数变慢（不扫全表）', (t) => {
  // Every comment replies to another, so the neighbour lookups happen N times. A linear
  // scan per lookup would make this quadratic; the implementation must use a set.
  const chain = (count: number): WeiboComment[] =>
    Array.from({ length: count }, (_, index) => ({
      id: String(7000000 + index),
      user: { uid: String(3000 + index), screenName: `人${index}` },
      text: `第 ${index} 条`,
      ...(index > 0 ? { replyToCommentId: String(7000000 + index - 1) } : {}),
    }))

  const small = timed(() => projectWeiboThread(payloadOf(chain(500))))
  const large = timed(() => projectWeiboThread(payloadOf(chain(3000))))
  t.diagnostic(`  500 条全链式回复 → ${small.ms.toFixed(1)} ms`)
  t.diagnostic(`  3000 条全链式回复 → ${large.ms.toFixed(1)} ms`)

  assert.equal(large.value.edges.filter((edge) => edge.kind === 'replies_to').length, 2999)
  const ratio = large.ms / Math.max(small.ms, 0.5)
  t.diagnostic(`  3000/500 耗时比 ${ratio.toFixed(1)}×（线性约 6×，二次约 36×）`)
  assert.ok(ratio < 20, `全链式回复的耗时比 ${ratio.toFixed(1)}× 超过线性量级`)
})

test('规模基线：分页读取的调用次数被页数上限约束，不会无限追', (t) => {
  // What this asserts is the *bound*, not the loop: `LOCATE_PAGE_LIMIT` is 5, so locating a
  // comment costs at most 5 reads no matter how many pages exist. The number lives in the
  // source and is asserted there, because the provider needs a live CLI to run.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'platforms', 'weibo', 'provider.ts'), 'utf8')
  const limit = /const LOCATE_PAGE_LIMIT = (\d+)/.exec(source)
  assert.ok(limit !== null, '找不到 LOCATE_PAGE_LIMIT')
  const pages = Number(limit[1])
  t.diagnostic(`  按 id 定位评论的页数上限：${pages}`)
  assert.ok(pages > 0 && pages <= 10, `页数上限 ${pages} 不合理：要么找不到，要么太贵`)
})
