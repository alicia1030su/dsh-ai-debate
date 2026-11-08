/**
 * The evaluation corpus, assembled.
 *
 * Kept as one export so the two channels (deterministic, model quality) consume exactly the
 * same set — a case that only one channel knows about is a case nobody checks.
 */

import type { EvalCase } from './corpus.ts'
import { BASELINE_CASES } from './cases-core.ts'
import { EXTRA_CASES } from './cases-extended.ts'
import { WEIBO_CASES } from './cases-weibo.ts'
import { QUALITY_CASES } from './cases-quality.ts'

export type { EvalCase } from './corpus.ts'

export const ALL_CASES: readonly EvalCase[] = [
  ...BASELINE_CASES,
  ...EXTRA_CASES,
  ...WEIBO_CASES,
  // v0.2.34 §4：论证质量（转移话题、自相矛盾、已答过、多人混合）。
  // 这四条此前没有任何案例覆盖 —— 它们不属于安全边界，也不属于结构约束，
  // 而正是「回复读起来像不像人」的那一层。
  ...QUALITY_CASES,
]

/** Group prefix of a case id, for reporting per-group pass rates. */
export function groupOf(id: string): string {
  return id.split('/')[0] ?? 'unknown'
}
