/**
 * The stored shape of a security assessment.
 *
 * Declared here rather than imported from `store.ts` so the security modules do not
 * depend on persistence. `store.ts` declares its own structurally identical
 * `CandidateSecurityRecord`; the two are kept in sync by assignment, which the type
 * checker enforces at the single point where the record is written.
 */

import type { CandidateSecurityAssessment } from './security-policy.js'

/** An assessment plus the fingerprint binding it to one exact text and target. */
export type AssessmentFingerprint = CandidateSecurityAssessment & {
  /** Binds this decision to one exact reply text and target post. */
  readonly fingerprint: string
}
