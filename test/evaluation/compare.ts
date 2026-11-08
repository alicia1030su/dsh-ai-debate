/**
 * Comparing two runs honestly.
 *
 * ## The three things this refuses to do
 *
 * 1. **Fill in a number when there is no data.** A comparison between "no baseline" and
 *    "new run" produces no deltas, and says so. The alternative — reporting +12% because
 *    the new version has more cases — is the kind of number that survives in a slide deck
 *    long after everyone forgot how it was computed.
 * 2. **Average a hard failure into a good score.** A case that invents a number scores 1 on
 *    nine dimensions and 0 on credibility; its mean is 0.9. Any case with a deterministic
 *    zero is therefore listed by name as a hard failure, separately from the means.
 * 3. **Compare across models.** Different models on the same corpus answer differently for
 *    reasons that have nothing to do with the version. The report refuses and says why.
 *
 * ## What "improved" means here
 *
 * Per case, per metric: higher is better, and a change smaller than `EPSILON` is reported as
 * unchanged so that floating-point noise does not fill the regression list.
 */

import type { CaseResult, MetricId, RunRecord } from './metrics.ts'
import { meanByMetric, metricKindOf } from './metrics.ts'

/** Below this, a metric difference is noise rather than a change. */
const EPSILON = 0.01

/** A metric's aggregate change between two runs. */
export interface MetricDelta {
  readonly id: MetricId
  readonly kind: 'deterministic' | 'proxy'
  readonly baseline: number
  readonly candidate: number
  readonly delta: number
  /** True when the delta is smaller than noise. */
  readonly unchanged: boolean
}

/** One case whose score moved. */
export interface CaseDelta {
  readonly caseId: string
  readonly improved: readonly MetricId[]
  readonly regressed: readonly MetricId[]
}

/** The whole comparison. */
export interface ComparisonReport {
  readonly comparable: boolean
  /** Why it is not comparable, when it is not. */
  readonly reason?: string
  readonly deltas: readonly MetricDelta[]
  readonly cases: readonly CaseDelta[]
  /** Cases with a deterministic zero in the candidate run — always reported, never averaged. */
  readonly hardFailures: readonly { readonly caseId: string; readonly metric: MetricId; readonly basis: string }[]
  readonly baselineModel?: string
  readonly candidateModel?: string
  readonly baselineReal: boolean
  readonly candidateReal: boolean
  /** Token and time totals, when the run recorded them. */
  readonly cost: {
    readonly baselineTokens?: { input: number; output: number }
    readonly candidateTokens?: { input: number; output: number }
    readonly baselineMs?: number
    readonly candidateMs?: number
  }
}

/** Sum token usage, when every case reported it. */
function tokensOf(cases: readonly CaseResult[]): { input: number; output: number } | undefined {
  let input = 0
  let output = 0
  let seen = false
  for (const item of cases) {
    if (item.inputTokens === undefined && item.outputTokens === undefined) continue
    seen = true
    input += item.inputTokens ?? 0
    output += item.outputTokens ?? 0
  }
  return seen ? { input, output } : undefined
}

/** Sum elapsed time, when every case reported it. */
function elapsedOf(cases: readonly CaseResult[]): number | undefined {
  let total = 0
  let seen = false
  for (const item of cases) {
    if (item.elapsedMs === undefined) continue
    seen = true
    total += item.elapsedMs
  }
  return seen ? total : undefined
}

/**
 * Compare a baseline run against a candidate run.
 *
 * Returns `comparable: false` with a reason rather than an empty but cheerful table when
 * the two runs cannot be meaningfully compared.
 */
export function compareRuns(baseline: RunRecord, candidate: RunRecord): ComparisonReport {
  const baselineIds = baseline.cases.map((item) => item.caseId).sort()
  const candidateIds = candidate.cases.map((item) => item.caseId).sort()
  const sameSet =
    baselineIds.length === candidateIds.length &&
    baselineIds.every((id, index) => id === candidateIds[index])

  if (!sameSet) {
    return {
      comparable: false,
      reason: `两次运行的案例集不同（基线 ${baselineIds.length} 个，新版本 ${candidateIds.length} 个）：逐条比较会得出误导性的结论`,
      deltas: [],
      cases: [],
      hardFailures: [],
      baselineReal: baseline.realModel,
      candidateReal: candidate.realModel,
      cost: {},
    }
  }
  if (baseline.model !== candidate.model) {
    return {
      comparable: false,
      reason: `两次运行用的不是同一个模型（基线 ${baseline.model}，新版本 ${candidate.model}）：差异不能归给版本`,
      deltas: [],
      cases: [],
      hardFailures: [],
      baselineModel: baseline.model,
      candidateModel: candidate.model,
      baselineReal: baseline.realModel,
      candidateReal: candidate.realModel,
      cost: {},
    }
  }

  const baseMean = meanByMetric(baseline.cases)
  const candMean = meanByMetric(candidate.cases)
  const ids = [...new Set([...baseMean.keys(), ...candMean.keys()])].sort()

  const deltas: MetricDelta[] = ids.map((id) => {
    const before = baseMean.get(id) ?? 0
    const after = candMean.get(id) ?? 0
    const delta = after - before
    return {
      id,
      kind: metricKindOf(id),
      baseline: before,
      candidate: after,
      delta,
      unchanged: Math.abs(delta) < EPSILON,
    }
  })

  const byCase = new Map<string, CaseResult>(candidate.cases.map((item) => [item.caseId, item]))
  const cases: CaseDelta[] = []
  for (const before of baseline.cases) {
    const after = byCase.get(before.caseId)
    if (after === undefined) continue
    const beforeScores = new Map(before.scores.map((score) => [score.id, score.score]))
    const improved: MetricId[] = []
    const regressed: MetricId[] = []
    for (const score of after.scores) {
      const previous = beforeScores.get(score.id)
      if (previous === undefined) continue
      const delta = score.score - previous
      if (delta > EPSILON) improved.push(score.id)
      else if (delta < -EPSILON) regressed.push(score.id)
    }
    if (improved.length > 0 || regressed.length > 0) cases.push({ caseId: before.caseId, improved, regressed })
  }

  const hardFailures: { caseId: string; metric: MetricId; basis: string }[] = []
  for (const item of candidate.cases) {
    for (const score of item.scores) {
      if (score.kind !== 'deterministic' || score.score > 0) continue
      hardFailures.push({ caseId: item.caseId, metric: score.id, basis: score.basis })
    }
  }

  const baseTokens = tokensOf(baseline.cases)
  const candTokens = tokensOf(candidate.cases)
  const baseMs = elapsedOf(baseline.cases)
  const candMs = elapsedOf(candidate.cases)

  return {
    comparable: true,
    deltas,
    cases,
    hardFailures,
    baselineModel: baseline.model,
    candidateModel: candidate.model,
    baselineReal: baseline.realModel,
    candidateReal: candidate.realModel,
    cost: {
      ...(baseTokens === undefined ? {} : { baselineTokens: baseTokens }),
      ...(candTokens === undefined ? {} : { candidateTokens: candTokens }),
      ...(baseMs === undefined ? {} : { baselineMs: baseMs }),
      ...(candMs === undefined ? {} : { candidateMs: candMs }),
    },
  }
}

/** Percent, with one decimal, and an explicit sign. */
function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`
}

/** Render a comparison as a table a human can read. */
export function formatComparison(report: ComparisonReport): string {
  if (!report.comparable) {
    return `无法比较：${report.reason ?? '原因未知'}\n`
  }
  const lines: string[] = []
  lines.push('# 版本对比')
  lines.push('')
  lines.push(`基线模型：${report.baselineModel ?? '未知'}（${report.baselineReal ? '真实模型' : '脚本模型'}）`)
  lines.push(`新版本模型：${report.candidateModel ?? '未知'}（${report.candidateReal ? '真实模型' : '脚本模型'}）`)
  lines.push('')
  lines.push('| 维度 | 类型 | 基线 | 新版本 | 变化 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const delta of report.deltas) {
    lines.push(
      `| ${delta.id} | ${delta.kind === 'deterministic' ? '确定性' : '代理' } | ` +
        `${delta.baseline.toFixed(2)} | ${delta.candidate.toFixed(2)} | ` +
        `${delta.unchanged ? '无变化' : pct(delta.delta)} |`,
    )
  }
  lines.push('')
  if (report.hardFailures.length > 0) {
    lines.push(`## 硬性失败（${report.hardFailures.length}）`)
    for (const failure of report.hardFailures) {
      lines.push(`- ${failure.caseId} / ${failure.metric}：${failure.basis}`)
    }
    lines.push('')
  }
  if (report.cases.length === 0) {
    lines.push('逐条对比：没有任何一条案例的评分发生变化。')
  } else {
    lines.push('## 逐条变化')
    for (const item of report.cases) {
      const parts: string[] = []
      if (item.improved.length > 0) parts.push(`改善：${item.improved.join('、')}`)
      if (item.regressed.length > 0) parts.push(`退步：${item.regressed.join('、')}`)
      lines.push(`- ${item.caseId}：${parts.join('；')}`)
    }
  }
  lines.push('')
  const cost = report.cost
  if (cost.candidateTokens !== undefined) {
    const before = cost.baselineTokens
    lines.push(
      `Token：${before === undefined ? '基线未记录' : `${before.input} 输入 / ${before.output} 输出`}` +
        ` → ${cost.candidateTokens.input} 输入 / ${cost.candidateTokens.output} 输出`,
    )
  }
  if (cost.candidateMs !== undefined) {
    lines.push(`耗时：${cost.baselineMs ?? '未记录'} ms → ${cost.candidateMs} ms`)
  }
  return lines.join('\n')
}
