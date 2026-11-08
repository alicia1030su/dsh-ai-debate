/**
 * v0.2.35 §5：质量评分与版本对比本身的测试。
 *
 * ## 为什么评分器也要被测
 *
 * 一个悄悄出错的评分器比没有评分器更糟：它会给出看起来精确的数字，而数字背后是
 * 一条错的规则。这里逐条钉住三件最容易被写错的事：
 *
 * 1. **分数与依据必须同时存在** —— 一个没有 `basis` 的 0 分没人能核对。
 * 2. **确定性维度只出 0 或 1** —— 允许 0.7 就等于允许「差不多对了」。
 * 3. **不可比的两次运行必须报错，而不是给一张空表**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { compareRuns, formatComparison } from '../test/evaluation/compare.ts'
import { meanByMetric, scoreReply, type CaseResult, type RunRecord } from '../test/evaluation/metrics.ts'

const baseInput = {
  caseId: 'demo/01',
  reply: '你说的「翻倍」是按去年两次采购价算的，那两次都赶上了涨价。',
  targetPostId: 'p2',
  expectedTargetPostId: 'p2',
  ownerPosition: '成本不会翻倍',
  contextText: '主人：成本不会翻倍。\n对方：翻倍是暂时的，你不懂。',
  threadText: '主人：成本不会翻倍。\n对方：翻倍是暂时的，你不懂。',
  structure: { arguments: 1, unanswered: 0, contradictions: 1 },
  missingContext: false,
  persona: 'tieba_veteran',
}

test('每一项评分都带依据，确定性维度只有 0 或 1', () => {
  const scores = scoreReply(baseInput)
  assert.equal(scores.length, 10, `应有 10 项，实际 ${scores.length}`)
  for (const score of scores) {
    assert.ok(score.basis.trim() !== '', `${score.id} 没有依据`)
    if (score.kind === 'deterministic') {
      assert.equal([0, 1].includes(score.score), true, `${score.id} 是确定性维度，却给了 ${score.score}`)
    }
  }
})

test('目标错位直接判 0，并说出两个 id', () => {
  const scores = scoreReply({ ...baseInput, targetPostId: 'p9' })
  const target = scores.find((item) => item.id === 'target_accuracy')!
  assert.equal(target.score, 0)
  assert.match(target.basis, /p9/)
  assert.match(target.basis, /p2/)
})

test('回复里出现上下文没有的数字，事实可信度判 0', () => {
  const scores = scoreReply({ ...baseInput, reply: '这个方案的成本会涨 44%，你算漏了。' })
  const credibility = scores.find((item) => item.id === 'factual_credibility')!
  assert.equal(credibility.score, 0)
  assert.match(credibility.basis, /44%/)
})

test('作文式连接词会拉低自然度，但不影响事实维度', () => {
  const scores = scoreReply({
    ...baseInput,
    reply: '首先，你这个说法没有依据。其次，成本不会翻倍。最后，请不要臆测。',
  })
  const naturalness = scores.find((item) => item.id === 'naturalness')!
  assert.equal(naturalness.score, 0)
  assert.match(naturalness.basis, /首先/)
  const credibility = scores.find((item) => item.id === 'factual_credibility')!
  assert.equal(credibility.score, 1, '文风问题不该连带把事实维度也判红')
})

test('拒绝类案例不参与论点识别评分', () => {
  const scores = scoreReply({
    ...baseInput,
    refusalCase: true,
    structure: { arguments: 0, unanswered: 0, contradictions: 0 },
  })
  const recognition = scores.find((item) => item.id === 'argument_recognition')!
  assert.equal(recognition.score, 1)
  assert.match(recognition.basis, /按设计不生成/)
})

test('两次运行的案例集不同：拒绝比较并说明原因', () => {
  const baseline: RunRecord = {
    version: '0.2.34',
    model: 'm',
    protocol: 'chat',
    generatedAt: '2026-01-01T00:00:00Z',
    realModel: false,
    cases: [caseOf('a/01', 1)],
  }
  const candidate: RunRecord = { ...baseline, version: '0.2.35', cases: [caseOf('a/01', 1), caseOf('a/02', 1)] }
  const report = compareRuns(baseline, candidate)
  assert.equal(report.comparable, false)
  assert.match(report.reason ?? '', /案例集不同/)
  assert.match(formatComparison(report), /无法比较/)
})

test('两次运行用了不同模型：拒绝比较，因为差异不能归给版本', () => {
  const baseline: RunRecord = {
    version: '0.2.34',
    model: 'model-a',
    protocol: 'chat',
    generatedAt: '2026-01-01T00:00:00Z',
    realModel: true,
    cases: [caseOf('a/01', 1)],
  }
  const candidate: RunRecord = { ...baseline, version: '0.2.35', model: 'model-b' }
  const report = compareRuns(baseline, candidate)
  assert.equal(report.comparable, false)
  assert.match(report.reason ?? '', /不是同一个模型/)
})

test('可比时给出逐项变化与逐条变化，并单独列出硬性失败', () => {
  const baseline: RunRecord = {
    version: '0.2.34',
    model: 'm',
    protocol: 'chat',
    generatedAt: '2026-01-01T00:00:00Z',
    realModel: false,
    cases: [caseOf('a/01', 0)],
  }
  const candidate: RunRecord = { ...baseline, version: '0.2.35', cases: [caseOf('a/01', 1)] }
  const report = compareRuns(baseline, candidate)
  assert.equal(report.comparable, true)
  assert.ok(report.cases.some((item) => item.caseId === 'a/01' && item.improved.length > 0))
  assert.equal(report.hardFailures.length, 0)
  assert.match(formatComparison(report), /版本对比/)
})

test('没有记录 token 时不编造成本数字', () => {
  const record: RunRecord = {
    version: '0.2.35',
    model: 'm',
    protocol: 'chat',
    generatedAt: '2026-01-01T00:00:00Z',
    realModel: false,
    cases: [{ caseId: 'a/01', reply: 'x', scores: scoreReply(baseInput) }],
  }
  const report = compareRuns(record, record)
  assert.equal(report.cost.candidateTokens, undefined)
  assert.equal(report.cost.candidateMs, undefined)
  assert.doesNotMatch(formatComparison(report), /Token：/)
})

/** A case result whose only varying metric is `argument_recognition`. */
function caseOf(caseId: string, value: number): CaseResult {
  const scores = scoreReply(baseInput).map((score) =>
    score.id === 'argument_recognition' ? { ...score, score: value } : score,
  )
  return { caseId, reply: baseInput.reply, scores }
}

test('均值按维度算，不把十项压成一个总分', () => {
  const means = meanByMetric([
    caseOf('a/01', 1),
    caseOf('a/02', 0),
  ])
  assert.equal(means.get('argument_recognition'), 0.5)
  assert.equal(means.get('factual_credibility'), 1)
})
