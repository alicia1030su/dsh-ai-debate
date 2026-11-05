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

export type { EvalCase } from './corpus.ts'

export const ALL_CASES: readonly EvalCase[] = [...BASELINE_CASES, ...EXTRA_CASES, ...WEIBO_CASES]

/** Group prefix of a case id, for reporting per-group pass rates. */
export function groupOf(id: string): string {
  return id.split('/')[0] ?? 'unknown'
}
