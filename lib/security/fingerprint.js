/**
 * The stored shape of a security assessment.
 *
 * Declared here rather than imported from `store.ts` so the security modules do not
 * depend on persistence. `store.ts` declares its own structurally identical
 * `CandidateSecurityRecord`; the two are kept in sync by assignment, which the type
 * checker enforces at the single point where the record is written.
 */
export {};
//# sourceMappingURL=fingerprint.js.map