/**
 * A measured baseline for "does a long thread stay bounded".
 *
 * ## Why a measurement and not an assertion about speed
 *
 * Wall-clock thresholds are the classic flaky test: they pass on the author's machine and
 * fail on a loaded CI runner, and the usual fix is to raise the number until it never
 * fires — at which point it measures nothing. What actually matters here is *shape*:
 *
 * - reading a much longer thread must cost proportionally more, not quadratically more;
 * - the compressed context handed to the model must stay inside its budget no matter how
 *   long the thread is, because the budget is the only thing standing between a 500-floor
 *   thread and a request the provider rejects;
 * - the numbers must be recorded, so a future regression is visible as a delta rather than
 *   as "it feels slower".
 *
 * So this file asserts the *bounds* (which are properties of the algorithm) and prints the
 * measurements via `t.diagnostic()` (which is where the baseline lives). Nothing here
 * writes to stdout: `node --test` uses a file's own stdout as its result channel, and a
 * stray `ff 0f` byte pair in that stream corrupts the parent's frame parser — the exact
 * defect v0.2.27 fixed in six other files.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compressContext, resolveBudget, splitBudget } from '../lib/compressor.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'
import { analyzeDispute } from '../lib/analyzer.js'

const NOW = '2026-11-04T00:00:00.000Z'

function makeThread(floors: number, repliesPerFloor: number): CollectedThread {
  const thread: Thread = {
    platform: 'tieba',
    id: '900100200',
    url: 'https://tieba.baidu.com/p/900100200',
    title: '长帖基线',
    forum: { platform: 'tieba', name: '测试吧' },
    content: '楼主开场。',
    images: [],
    authorId: 'owner_un',
    authorName: '楼主本人',
  }

  const floorList: Floor[] = []
  const nested: Record<string, NestedReply[]> = {}
  for (let index = 1; index <= floors; index += 1) {
    const postId = String(9100000000 + index)
    // Alternating speakers, so the analyzer sees a real exchange rather than one voice.
    const isOwner = index % 2 === 1
    floorList.push({
      platform: 'tieba',
      postId,
      floorNumber: index,
      authorId: isOwner ? 'owner_un' : 'twin_a',
      authorName: isOwner ? '楼主本人' : '同名用户',
      content: `第 ${index} 楼：${'这是一段需要被压缩的论证。'.repeat(6)}`,
      images: [],
      createdAt: NOW,
    })
    const rows: NestedReply[] = []
    for (let reply = 1; reply <= repliesPerFloor; reply += 1) {
      rows.push({
        platform: 'tieba',
        postId: String(9200000000 + index * 100 + reply),
        parentPostId: postId,
        authorId: reply % 2 === 1 ? 'twin_a' : 'owner_un',
        authorName: reply % 2 === 1 ? '同名用户' : '楼主本人',
        content: `楼中楼 ${index}-${reply}：${'成本会翻倍，你没有依据。'.repeat(4)}`,
        createdAt: NOW,
      })
    }
    nested[postId] = rows
  }

  return {
    thread,
    floors: floorList.map((floor) => ({ floor, nested: nested[floor.postId] ?? [], nestedComplete: true })),
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

function measure(floors: number, replies: number): {
  floors: number
  replies: number
  tokens: number
  budget: number
  omissions: number
  elapsedMs: number
  characters: number
} {
  const collected = makeThread(floors, replies)
  // The summon is a nested reply on the first floor — the shape a real 召唤 takes, and the
  // one the analyzer requires: a trigger that is not in the collected timeline is refused.
  const triggerPostId = String(9200000000 + 1 * 100 + 1)
  const dispute = analyzeDispute(
    collected,
    { platform: 'tieba', handle: 'owner_un', userName: '楼主本人' },
    { postId: triggerPostId },
  )
  // `budget` is a `{ tokens, quoteLimit }` pair, not a number — passing a bare number made
  // `quoteLimit` undefined, the compressor produced an empty context, and the test passed
  // while measuring nothing. This is exactly the "green but vacuous" failure the file exists
  // to avoid, so the assertion below also checks the context is non-empty.
  //
  // The compressor is given the *context share*, exactly as `runGeneration` gives it
  // (`splitBudget(total).contextTokens`). Handing it the whole request budget — as this
  // file first did — measures a number production never produces.
  const preset = resolveBudget({ preset: 'medium' })
  const split = splitBudget(preset.tokens)
  const budget = { tokens: split.contextTokens, quoteLimit: preset.quoteLimit }

  const started = Date.now()
  const context = compressContext({
    collected,
    dispute,
    trigger: { postId: triggerPostId },
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150, emojiLevel: 0, sarcasmLevel: 1, directness: 3 },
    budget,
    totalTokens: split.total,
  })
  const elapsedMs = Date.now() - started

  return {
    floors,
    replies,
    tokens: context.tokens,
    budget: split.contextTokens,
    omissions: context.omissions?.length ?? 0,
    elapsedMs,
    characters: typeof context.text === 'string' ? context.text.length : 0,
  }
}

test('长帖：上下文预算不随帖长增长，成本按规模近似线性', (t) => {
  // Three sizes, ~8x apart from smallest to largest, with the same shape.
  const small = measure(10, 3)
  const medium = measure(40, 3)
  const large = measure(80, 3)

  for (const row of [small, medium, large]) {
    t.diagnostic(
      `floors=${row.floors} replies/floor=${row.replies} tokens=${row.tokens}/${row.budget} ` +
        `omissions=${row.omissions} elapsed=${row.elapsedMs}ms`,
    )
  }

  // ## The budget is a ceiling, not a suggestion
  //
  // This is the property that keeps a 500-floor thread from producing a request the
  // provider rejects. If compression ever stops honouring it, this is where it shows.
  for (const row of [small, medium, large]) {
    assert.ok(
      row.tokens <= row.budget,
      `压缩后的上下文 ${row.tokens} 超出了预算 ${row.budget}（floors=${row.floors}）`,
    )
  }

  // ## A passed budget comparison is worthless if there was nothing to compare
  //
  // This file first measured `tokens=0/6000` for every size and went green: the budget was
  // passed as a bare number instead of `{ tokens, quoteLimit }`, so the compressor clamped
  // every statement to zero characters and returned an empty context. "0 ≤ 6000" is true and
  // means nothing. Requiring real content is what makes the ceiling above a measurement.
  for (const row of [small, medium, large]) {
    assert.ok(
      row.characters > 500,
      `上下文几乎是空的（${row.characters} 字符，floors=${row.floors}），这个预算比较没有意义`,
    )
    assert.ok(row.tokens > 0, `上下文 token 为 0（floors=${row.floors}）`)
  }

  // The largest thread must still produce a *usable* context, not a degenerate one: the
  // trigger and the opponent's latest line are what the reply is actually written against.
  assert.ok(
    large.tokens >= 400,
    `80 楼的帖只剩下 ${large.tokens} token 的上下文，回复已经没有依据可写`,
  )

  // ## Growth must not be super-linear
  //
  // 8x the input may not cost 64x the time. A generous constant (25x) is deliberate: the
  // point is to catch an accidental O(n²) — a nested scan, a `find` inside a `map` — not
  // to police milliseconds. A tighter bound would fail on a loaded runner for reasons that
  // have nothing to do with the code.
  const ratio = large.elapsedMs / Math.max(small.elapsedMs, 1)
  t.diagnostic(`time ratio large/small = ${ratio.toFixed(2)}x for 8x the input`)
  assert.ok(
    ratio < 25,
    `规模放大 8 倍后耗时放大了 ${ratio.toFixed(1)} 倍，像是出现了平方级复杂度`,
  )

  // The bigger thread must drop more than the small one: if omissions stay flat while the
  // input grows eightfold, the compressor is either keeping everything (and would blow the
  // budget) or reporting nothing (and the page would claim a complete read).
  assert.ok(
    large.omissions >= small.omissions,
    `更大的帖应当省略更多或同样多（small=${small.omissions}, large=${large.omissions}）`,
  )
})
