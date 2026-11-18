/**
 * 不同统计口径不是「一致」，也不是「矛盾」（v0.3.0 issue #53）。
 *
 * ## 这个文件防的是什么
 *
 * `q30` 的两句话：
 *
 *     主人：今年同比增速是 8%，这是含新店的。
 *     对方：可同店增速只有 2%，你那 8% 是开店堆出来的。
 *
 * 旧实现因为两边都出现「8%」而返回 `agreement`。于是简报里 `disagreements` 为空，
 * 又没有说明为什么为空，`validateBrief` 拒收 —— 生成在 4 毫秒内失败，用户看到的是
 * 「这份导入内容可能不足以支撑一次回复」，而输入其实是完整的。
 *
 * 这里要同时守住三条：
 *
 * 1. 口径不同**不是**矛盾（不能让模型去「驳倒」一个算得对的数）；
 * 2. 口径不同**也不是**一致（不能告诉审阅者双方观点相同）；
 * 3. 修完之后 `validateBrief` 必须仍然能过 —— 空的分歧列表要有**真实**解释。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeDispute } from '../lib/analyzer.js'
import { buildBrief } from '../lib/brief-builder.js'
import { validateBrief } from '../lib/brief.js'
import type { CollectedThread } from '../lib/collector.js'
import { judgeRelation } from '../lib/conflict.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'
import { makeFloor, makeNested } from './helpers.ts'

const OWNER_ID = 'o'
const RIVAL_ID = 'b'

function makeThread(id = '930'): Thread {
  return {
    platform: 'tieba',
    forum: { platform: 'tieba', id: '9', name: '测试吧' },
    id,
    title: '两个增速',
    content: '正文',
    url: `https://tieba.baidu.com/p/${id}`,
    images: [],
  }
}

function collected(
  thread: Thread,
  floors: readonly Floor[],
  nested: Readonly<Record<string, readonly NestedReply[]>>,
): CollectedThread {
  return {
    thread,
    floors: floors.map((floor) => ({
      floor,
      nested: nested[floor.postId] ?? [],
      nestedComplete: true,
    })),
    complete: true,
    issues: [],
  } as CollectedThread
}

/** q30 的最小真实形状：主人说含新店的 8%，对方回同店只有 2%。 */
function q30Thread(): CollectedThread {
  const floorPostId = '930'
  const nested = [
    makeNested({
      postId: 'm1',
      parentPostId: floorPostId,
      authorId: OWNER_ID,
      authorName: '主人',
      content: '今年同比增速是 8%，这是含新店的。',
    }),
    makeNested({
      postId: 'r1',
      parentPostId: floorPostId,
      authorId: RIVAL_ID,
      authorName: '对面',
      content: '回复 主人 :可同店增速只有 2%，你那 8% 是开店堆出来的。',
      replyToName: '主人',
    }),
  ]
  return collected(
    makeThread(),
    [
      makeFloor({
        floorNumber: 3,
        postId: floorPostId,
        authorId: OWNER_ID,
        authorName: '主人',
        content: '开场',
        nestedCount: nested.length,
      }),
    ],
    { [floorPostId]: nested },
  )
}

// ---------------------------------------------------------------------------
// 1. 关系判定
// ---------------------------------------------------------------------------

test('q30 原样两句话不是矛盾，也不是一致', () => {
  const verdict = judgeRelation({
    ownerText: '今年同比增速是 8%，这是含新店的。',
    opponentText: '可同店增速只有 2%，你那 8% 是开店堆出来的。',
  })
  assert.equal(verdict.isContradiction, false, '两个数可以同时成立，不能当成矛盾')
  assert.equal(verdict.relation, 'different_measures', '要有独立的关系，不能塞进 agreement')
  assert.match(verdict.reason, /口径/, '理由必须说清是口径差异')
  assert.equal(verdict.requiresReview, true, '机器判读关系仍然需要人工确认')
})

test('同比 / 环比 同样是口径差异', () => {
  const verdict = judgeRelation({ ownerText: '同比涨了 8%', opponentText: '环比只涨了 2%' })
  assert.equal(verdict.relation, 'different_measures')
  assert.equal(verdict.isContradiction, false)
})

test('两边同一口径不得被判成口径差异', () => {
  const verdict = judgeRelation({ ownerText: '同店增速 3%', opponentText: '同店增速也就 3%' })
  assert.notEqual(verdict.relation, 'different_measures', '同一口径不构成口径差异')
})

test('没有数字的「口径」字样不得触发', () => {
  // 只是提到门店范围、没有在说数量时，不该被当成统计口径之争。
  const verdict = judgeRelation({
    ownerText: '全店的服务态度都得改改',
    opponentText: '同店的服务我觉得还行',
  })
  assert.notEqual(verdict.relation, 'different_measures')
})

test('真正的矛盾仍然是矛盾，不被口径判定吞掉', () => {
  const verdict = judgeRelation({ ownerText: '这个方案不可行。', opponentText: '这个方案可行。' })
  assert.equal(verdict.relation, 'contradiction')
  assert.equal(verdict.isContradiction, true)
})

test('无口径的相同数字仍然是共同前提', () => {
  const verdict = judgeRelation({ ownerText: '去年报价是 12 万。', opponentText: '我记得也是 12 万。' })
  assert.equal(verdict.relation, 'agreement')
})

// ---------------------------------------------------------------------------
// 2. 简报能过校验，且用的是「分析」而不是「反驳」
// ---------------------------------------------------------------------------

test('q30 的简报通过 validateBrief，并解释了为什么没有分歧', () => {
  const data = q30Thread()
  const dispute = analyzeDispute(data, { userId: OWNER_ID, platform: 'tieba' }, { postId: 'm1' })
  const { brief, sources, verdict } = buildBrief({
    platform: 'tieba',
    threadId: '930',
    collected: data,
    dispute,
  })

  assert.deepEqual(validateBrief(brief, sources), [], '生成器必须满足自己的校验器')
  assert.equal(verdict.relation, 'different_measures')
  assert.equal(brief.disagreements.length, 0, '口径差异不是矛盾，不该写成分歧')
  assert.ok(
    brief.risks.some((risk) => /口径/.test(risk) && /不是|不要/.test(risk)),
    `风险里要说明口径不同且不要否认同店数字：${JSON.stringify(brief.risks)}`,
  )
  assert.deepEqual(brief.directions, ['analyse'], '口径差异要走分析，不是反驳')
})

test('口径差异不会被渲染成「一致」', () => {
  const data = q30Thread()
  const dispute = analyzeDispute(data, { userId: OWNER_ID, platform: 'tieba' }, { postId: 'm1' })
  const { brief } = buildBrief({ platform: 'tieba', threadId: '930', collected: data, dispute })
  const rendered = JSON.stringify(brief)
  assert.equal(
    /双方在这一意见上一致/.test(rendered),
    false,
    '不能声称双方观点完全一致',
  )
})
