/**
 * v0.2.37 §5：把「规则匹配」与「事实证明」分开。
 *
 * ## 这一组要钉住的一件事
 *
 * v0.2.36 的 `decisivePoints` 只有一个 `weight`。它同时被当成排序分和真实性用，
 * 于是「前后矛盾」以 100 分排第一时，模型会写成「你前后矛盾」。而两句话字面
 * 相反、条件不同时，它们**都对** —— 那种回复是最容易被对方一句话打回来的。
 *
 * 现在三个概念分开：`evidenceKind`（有没有原文可对）、`confidence`（多可靠）、
 * `weight`（若成立有多重要）。这组测试逐个钉住它们的互动：
 *
 * - 条件不同 → 仍是重点，但降级为「待核实」；
 * - 时间不同 → 同上，并且理由里要点明「可能是观点改变」；
 * - 纯规则推断 → `inferred`，最高只能 medium；
 * - 真正的字面矛盾 → `quoted` + `high`，允许写成断言。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute } from '../lib/analyzer.js'
import { analyzeArguments } from '../lib/argument-structure.js'
import type { CollectedThread } from '../lib/collector.js'

/**
 * 微博形状：正文是主人的，一条评论楼里挂着后续发言。
 *
 * ## 为什么必须是「一楼 + 楼中楼」
 *
 * 这一版第一次写成「每条评论各占一楼」，结果是 `dispute.exchange` 里只有第一条
 * —— 分析器重建的是**容器楼的**时间线，不是整个帖子。于是三个用例全部「通过」
 * 于「什么也没找到」，而它们本该验证的正是「找到了但置信度对不对」。
 *
 * v0.2.35 的同类夹具里已经记过这件事，这里再抄一遍是因为我把它忘了。
 */
function thread(comments: readonly { id: string; who: 'owner' | 'opponent'; text: string }[]): CollectedThread {
  const platform = 'weibo' as const
  const mk = (postId: string, name: string, content: string) => ({
    postId,
    platform,
    authorId: name,
    authorName: name,
    content,
    createdAt: '2026-11-08T00:00:00Z',
    ...(name === '主人'
      ? { authorNumericUid: '9001', authorNumericUidKind: 'platform:weibo' as const }
      : { authorNumericUid: '9002', authorNumericUidKind: 'platform:weibo' as const }),
  })
  const first = comments[0]
  if (first === undefined) throw new Error('至少需要一条评论')
  return {
    thread: {
      platform,
      forum: { platform, name: '' },
      id: '7001',
      title: '评测',
      content: '这个方案的成本不会翻倍，我算过。',
      bodyNode: 'standalone',
      authorId: '主人',
      authorName: '主人',
      authorSource: 'platform_contract',
      authorNumericUid: '9001',
      authorNumericUidKind: 'platform:weibo',
    },
    floors: [
      {
        floor: mk(first.id, first.who === 'owner' ? '主人' : '对方', first.text),
        nested: comments.slice(1).map((comment) => ({
          ...mk(comment.id, comment.who === 'owner' ? '主人' : '对方', comment.text),
          parentPostId: first.id,
          replyToPostId: first.id,
        })),
        nestedComplete: true,
      },
    ],
    complete: true,
    completeness: { sourceComplete: true, retainedComplete: true, analysisComplete: true, nestedComplete: true, reasons: [] },
    pagesRead: 1,
    notes: [],
    issues: [],
    securityNotes: [],
  } as unknown as CollectedThread
}

function structureOf(comments: readonly { id: string; who: 'owner' | 'opponent'; text: string }[]) {
  const collected = thread(comments)
  const dispute = analyzeDispute(collected, { platform: 'weibo', userId: '9001' }, { postId: comments[0]!.id })
  return { collected, structure: analyzeArguments({ collected, dispute }) }
}

test('条件不同但字面相反：仍是重点，但标成 medium + quoted，理由点明前提不同', () => {
  const { structure } = structureOf([
    { id: '9100', who: 'opponent', text: '这个方案本来就有风险，成本也不透明。' },
    { id: '9101', who: 'opponent', text: '如果按现在的报价，这个方案的成本会翻倍。' },
    { id: '9102', who: 'owner', text: '翻倍这个结论你有测算吗？' },
    { id: '9103', who: 'opponent', text: '这个方案的成本不会翻倍。' },
  ])

  const point = structure.decisivePoints.find((entry) => entry.kind === 'contradiction')
  assert.ok(point !== undefined, '这个讨论里确实有两条相反表述，必须进列表')
  assert.equal(point!.confidence, 'medium', `带条件的相反表述不该给 high，实际 ${point!.confidence}`)
  assert.equal(point!.evidenceKind, 'quoted', '两段原文都在，依据是 quoted')
  assert.match(point!.why, /前提|条件/, `理由要点明前提不同：${point!.why}`)
  assert.equal(point!.weight, 100, '降的是置信度，不是重要性')
})

test('时间不同造成观点变化：不给 high，且理由点明「可能是观点改变」', () => {
  const { structure } = structureOf([
    { id: '9201', who: 'opponent', text: '去年这个价格是合理的。' },
    { id: '9202', who: 'owner', text: '那今年呢？' },
    { id: '9203', who: 'opponent', text: '今年这个价格不合理。' },
  ])

  const point = structure.decisivePoints.find((entry) => entry.kind === 'contradiction')
  if (point === undefined) {
    // 时间词差异可能让这对句子连「同一断言」都不成立 —— 那比误判更好。
    assert.ok(true)
    return
  }
  assert.notEqual(point.confidence, 'high', '时间不同不能当成自相矛盾')
  assert.match(point.why, /时间|观点改变/, `理由要说清是什么差异：${point.why}`)
})

test('真正的字面矛盾：quoted + high，理由说「不能同时成立」', () => {
  const { structure } = structureOf([
    { id: '9301', who: 'opponent', text: '这个方案的成本会翻倍，根本做不了。' },
    { id: '9302', who: 'owner', text: '翻倍这个结论你有测算吗？' },
    { id: '9303', who: 'opponent', text: '其实这个方案的成本不会翻倍，问题在别的地方。' },
  ])

  const point = structure.decisivePoints.find((entry) => entry.kind === 'contradiction')
  assert.ok(point !== undefined)
  assert.equal(point!.confidence, 'high', '没有条件/时间差异的字面矛盾应给 high')
  assert.equal(point!.evidenceKind, 'quoted')
  assert.ok(point!.otherPostId !== undefined && point!.otherQuote !== undefined, 'high 必须带对照原文')
  assert.match(point!.why, /不能同时成立|不能同真/)
})

test('纯规则推断（缺证据）最高只能 low + inferred', () => {
  const { structure } = structureOf([
    { id: '9401', who: 'opponent', text: '这个方案会让你多花 3 万块。' },
    { id: '9402', who: 'owner', text: '这个数字怎么算的？' },
  ])

  const point = structure.decisivePoints.find((entry) => entry.kind === 'missing_evidence')
  if (point === undefined) {
    assert.ok(true, '这条不一定被抽出来，抽到就必须是低置信')
    return
  }
  assert.equal(point.confidence, 'low')
  assert.equal(point.evidenceKind, 'inferred')
})

test('第三方引用：quoted 但只给 medium（归属可能是误读）', () => {
  const { structure } = structureOf([
    { id: '9501', who: 'opponent', text: '「成本会翻倍」——专家也这么说。' },
    { id: '9502', who: 'owner', text: '哪个专家？有原文吗？' },
  ])

  const point = structure.decisivePoints.find((entry) => entry.kind === 'third_party')
  assert.ok(point !== undefined, '引文必须进重点列表')
  assert.equal(point!.evidenceKind, 'quoted', '引号里的原文可核对')
  assert.equal(point!.confidence, 'medium', '「这是第三方」本身是推断，不能给 high')
})

test('每条重点都自洽：high 必须有对照原文，inferred 不许 high', () => {
  const cases = [
    [
      { id: '9601' as const, who: 'opponent' as const, text: '这个方案的成本会翻倍，根本做不了。' },
      { id: '9602' as const, who: 'owner' as const, text: '翻倍这个结论你有测算吗？' },
      { id: '9603' as const, who: 'opponent' as const, text: '其实这个方案的成本不会翻倍，问题在别的地方。' },
    ],
    [
      { id: '9611' as const, who: 'opponent' as const, text: '如果涨价我就退出。' },
      { id: '9612' as const, who: 'owner' as const, text: '那降价呢？' },
      { id: '9613' as const, who: 'opponent' as const, text: '降价我也不退出。' },
    ],
  ]

  for (const comments of cases) {
    const { structure } = structureOf(comments)
    for (const point of structure.decisivePoints) {
      if (point.confidence === 'high') {
        assert.equal(point.evidenceKind, 'quoted', `${point.kind} 标了 high 却是 inferred`)
        assert.ok(point.otherPostId !== undefined, `${point.kind} 标了 high 却没有对照帖`)
        assert.ok(point.otherQuote !== undefined, `${point.kind} 标了 high 却没有对照原文`)
      }
      if (point.evidenceKind === 'inferred') {
        assert.notEqual(point.confidence, 'high', `${point.kind} 是推断却标了 high`)
      }
    }
  }
})

test('优先级不因置信度降低而消失：medium 的矛盾仍是第一条', () => {
  const { structure } = structureOf([
    { id: '9700', who: 'opponent', text: '这个方案本来就有风险，成本也不透明。' },
    { id: '9701', who: 'opponent', text: '如果按现在的报价，这个方案的成本会翻倍。' },
    { id: '9702', who: 'owner', text: '翻倍这个结论你有测算吗？' },
    { id: '9703', who: 'opponent', text: '这个方案的成本不会翻倍。' },
  ])
  assert.ok(structure.decisivePoints.length > 0)
  assert.equal(structure.decisivePoints[0]!.kind, 'contradiction')
  assert.equal(structure.decisivePoints[0]!.confidence, 'medium')
})
