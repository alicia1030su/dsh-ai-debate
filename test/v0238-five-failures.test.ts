/**
 * v0.2.38 §2：五项既有硬性失败，逐条钉住「旧行为 → 新行为」。
 *
 * ## 这一组的写法
 *
 * 每一个 `test` 对应评测报告里的一条失败。注释里写清三件事：旧代码在这一条上做了
 * 什么、为什么那是错的、现在由什么机制保证不再发生。断言直接打在**导致失败的那个
 * 判断**上（问句识别、claim 抽取、对手推断、数字追溯），而不是打在「分数是 1」上 ——
 * 分数会随语料变化，判断不会。
 *
 * ## 为什么没有一条是「放宽标准」
 *
 * 五条里有三条是**识别漏了**（材料里有证据，代码没看见），修法是让代码看见；
 * 一条是**算错了**（把一次正确的除法当成编造），修法是区分「原文有」「可复算」
 * 「追不回去」；最后一条是**案例本身没有证据**，修法是让产品承认这一点并追问，
 * 而不是逼它编一个立场。没有一条是删除断言或降低阈值。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute, extractClaims, looksLikeQuestion, type OwnerIdentity } from '../lib/analyzer.js'
import { buildBrief } from '../lib/brief-builder.js'
import { traceNumbers, untraceableQuantityClaims } from '../lib/number-trace.js'
import type { CollectedThread } from '../lib/collector.js'
import { ALL_CASES } from './evaluation/index.ts'
import { caseThread } from './evaluation/evaluate-deterministic.ts'
import type { EvalCase } from './evaluation/corpus.ts'

/** 案例里「主人」的账号，规则与评测通道一致。 */
function ownerOf(c: EvalCase): OwnerIdentity {
  const ownerPost =
    c.body?.role === 'owner'
      ? c.body
      : c.floors.flatMap((floor) => [floor.author, ...floor.nested]).find((post) => post.role === 'owner')
  if (ownerPost?.numericUid !== undefined) {
    return { userId: ownerPost.numericUid, ...(c.platform === undefined ? {} : { platform: c.platform }) }
  }
  if (ownerPost?.handle !== undefined) return { userId: ownerPost.handle }
  return { userId: 'owner_un' }
}

/** 跑一遍某个案例的简报，返回结构计数。 */
function structureOf(id: string): {
  readonly arguments: number
  readonly unanswered: number
  readonly contradictions: number
} {
  const c = ALL_CASES.find((item) => item.id === id)
  assert.ok(c !== undefined, `语料里没有 ${id}`)
  const collected = caseThread(c)
  const dispute = analyzeDispute(collected, ownerOf(c), { postId: c.pickedPostId })
  const brief = buildBrief({
    collected,
    dispute,
    platform: c.platform ?? 'tieba',
    threadId: collected.thread.id,
    targetPostId: c.pickedPostId,
  }).brief
  return {
    arguments: (brief.opponentArguments ?? []).length,
    unanswered: (brief.unansweredByOpponent ?? []).length,
    contradictions: (brief.contradictions ?? []).length,
  }
}

// ---------------------------------------------------------------------------
// 失败 1/5：baseline/03 —— 目标选中的是主人自己的楼层，对手要从往来里推断
// ---------------------------------------------------------------------------

test('baseline/03：选中一层开头帖时，对手从下面的回复里推断，而不是报「没有参与者」', () => {
  const c = ALL_CASES.find((item) => item.id === 'baseline/03')
  assert.ok(c !== undefined)
  const collected: CollectedThread = caseThread(c)
  const dispute = analyzeDispute(collected, ownerOf(c), { postId: c.pickedPostId })

  // 旧行为：窗口取 `slice(0, triggerIndex)`，触发帖是这一层的第 0 条，窗口为空，
  // 于是 `opponent` 为 undefined，整条生成链路停在这里。
  assert.equal(dispute.opponent?.displayName, '对手A', '必须从下面的回复里认出对手')
  assert.equal(dispute.exchange.length, 4, '主人在这一层说过的和对手说过的都要在往来里')

  // 而且结论要写明这是回落判断，人能看到依据。
  assert.ok(
    dispute.notes.some((note) => note.includes('开头帖')),
    `notes 里要说明这次是从下面的回复推的，实际：${dispute.notes.join('｜')}`,
  )
  const structure = structureOf('baseline/03')
  assert.ok(structure.arguments > 0, '对方的两条论据都要被抽出来')
})

// ---------------------------------------------------------------------------
// 失败 2/5：context/01 —— 「依据我前面贴过了」不是提问
// ---------------------------------------------------------------------------

test('context/01：陈述句里的「依据」不再被当成疑问标记', () => {
  // 旧行为：关键词表里有「依据」，于是这句被当成提问 —— 一边丢掉一条论据，
  // 一边在问题台账里多出一条没问过的问题。
  assert.equal(looksLikeQuestion('依据我前面贴过了。'), false)
  // 真正在问的时候仍然要认出来，否则修法就变成了「把疑问也一起关掉」。
  assert.equal(looksLikeQuestion('你有什么依据吗？'), true)
  assert.equal(looksLikeQuestion('依据呢'), true)
  assert.equal(looksLikeQuestion('依据在哪'), true)
  assert.equal(looksLikeQuestion('你的证据呢'), true)
  // 明确的疑问词不受影响。
  assert.equal(looksLikeQuestion('你为什么这么说'), true)
  assert.equal(looksLikeQuestion('这个方案不行。'), false)

  const structure = structureOf('context/01')
  assert.equal(structure.arguments, 1, '对手那句陈述要成为一条可引用的论据')
})

// ---------------------------------------------------------------------------
// 失败 3/5：quality/long-01 —— 一句话里既有主张又有追问
// ---------------------------------------------------------------------------

test('quality/long-01：断言+追问的混合句，主张部分必须留下', () => {
  const claims = extractClaims([
    {
      postId: '7601',
      floorNumber: 1,
      authorKey: 'o',
      content: '你那个方案忽略了迁移成本，这一块谁来付？',
    },
  ])
  assert.equal(claims.length, 1, `应只留下陈述分句，实际：${JSON.stringify(claims)}`)
  assert.match(claims[0] as string, /忽略了迁移成本/)
  assert.doesNotMatch(claims[0] as string, /谁来付/, '追问不该变成一条论据')

  const structure = structureOf('quality/long-01')
  assert.equal(structure.arguments, 1, '长语料里最早那条实质质疑必须被抽出来')
})

test('按逗号分句不会把纯疑问句拆成假主张', () => {
  // 「凭什么不行，有依据吗」拆开之后两段都是疑问，不能留下任何一条。
  const claims = extractClaims([
    { postId: 'q', floorNumber: 1, authorKey: 'o', content: '凭什么不行，有依据吗？' },
  ])
  assert.deepEqual(claims, [])
})

// ---------------------------------------------------------------------------
// 失败 4/5：weibo/06 —— 44% 是算出来的，不是编的
// ---------------------------------------------------------------------------

test('weibo/06：由原文两个数算出的比例算「可追溯」，不是编造', () => {
  const context = '公司楼下那家咖啡店涨价了，从 18 涨到 26。涨 8 块是因为房租吧，这条街都在涨。'
  const verdicts = traceNumbers('涨 8 块对应的是 44% 的涨幅', [context])
  const percent = verdicts.find((verdict) => verdict.value === '44%')
  assert.ok(percent !== undefined)
  assert.equal(percent.kind, 'derived', '44% 是 (26−18)÷18 的结果，必须能被追溯')
  assert.match(percent.basis, /26/)
  assert.match(percent.basis, /18/)
})

test('算不出来的数字仍然判红：换算不是免检通行证', () => {
  const context = '公司楼下那家咖啡店涨价了，从 18 涨到 26。'
  // 同样是百分数，但和 18/26 对不上。
  assert.equal(
    traceNumbers('涨了 50%', [context])[0]?.kind,
    'unknown',
    '算不出来的比例必须仍然算编造',
  )
  // 差值也同理：26−18=8，不是 9。
  const nine = traceNumbers('贵了 9 块', [context]).find((verdict) => verdict.value === '9')
  assert.equal(nine?.kind, 'unknown')
})

test('只会拦带量词或百分号的数字：编号不是事实主张', () => {
  const context = '成本从 18 涨到 26。'
  const reply = '第 3 节里你自己写了，涨了 44%'
  const flagged = untraceableQuantityClaims(reply, [context])
  assert.deepEqual(flagged, [], `44% 可复算、3 是编号，都不该拦：${JSON.stringify(flagged)}`)

  // 「第 3 节」单独出现时，即便 3 不在原文里也不拦 —— 那是编号。
  assert.deepEqual(untraceableQuantityClaims('第 3 节里写了', [context]), [])
  // 但「涨了 37%」追不回去，要拦。
  const invented = untraceableQuantityClaims('涨了 37%', [context])
  assert.equal(invented.length, 1)
  assert.equal(invented[0]?.value, '37%')
})

// ---------------------------------------------------------------------------
// 失败 5/5：refusal/04 —— 对方没有论据时，正确结果是追问
// ---------------------------------------------------------------------------

test('refusal/04：对方只有一句「不同意」时，零结构是正确结果', () => {
  const structure = structureOf('refusal/04')
  assert.deepEqual(
    structure,
    { arguments: 0, unanswered: 0, contradictions: 0 },
    '这一条本来就没有可提取的论据；硬抽出来才是编造',
  )
  const c = ALL_CASES.find((item) => item.id === 'refusal/04')
  assert.equal(c?.expectation.evidenceState, 'insufficient', '案例必须显式声明「证据不足」')
})

test('评分器：证据不足的案例零结构不判红，硬抽结构才判红', async () => {
  const { scoreReply } = await import('./evaluation/metrics.ts')
  const base = {
    caseId: 'refusal/04',
    reply: '你就说了句「不同意」，我连你反对的是成本还是时间都不知道。你具体指哪一条？',
    targetPostId: '9200000703',
    expectedTargetPostId: '9200000703',
    contextText: '回复 楼主本人 :不同意。',
    threadText: '开场。\n回复 楼主本人 :不同意。',
    missingContext: true,
    evidenceInsufficient: true,
  }
  const clean = scoreReply({ ...base, structure: { arguments: 0, unanswered: 0, contradictions: 0 } })
  assert.equal(
    clean.find((score) => score.id === 'argument_recognition')?.score,
    1,
    '零结构 + 证据不足 = 正确，不能扣分',
  )

  const invented = scoreReply({ ...base, structure: { arguments: 2, unanswered: 1, contradictions: 0 } })
  const recognition = invented.find((score) => score.id === 'argument_recognition')
  assert.equal(recognition?.score, 0, '对方只说了三个字，抽出三条结构就是编造')
  assert.match(recognition?.basis ?? '', /编造/)
})
