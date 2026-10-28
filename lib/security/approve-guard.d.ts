/**
 * The rules for *creating* an approval, kept out of the route and out of `index.ts`.
 *
 * ## Why a separate module
 *
 * The route is a transport concern (parse JSON, answer with a status) and `index.ts`
 * is wiring. Both are bad places for the question "may this candidate be approved at
 * all", because that question is a security decision with several refusal modes and it
 * needs to be testable without an HTTP server or a Cordis context.
 *
 * ## The one rule that matters most
 *
 * An approval may not exist for a candidate the security gate blocked, and it may not
 * exist for one that was never assessed. Both would create a record that later gets
 * refused for a *different* reason than the real one, and a stored-but-unusable
 * approval is how an owner comes to believe they approved something the plugin then
 * silently ignored.
 *
 * ## Why it re-checks the assessment freshness
 *
 * `assessmentFingerprint` is baked into the binding, so an approval for assessment A
 * cannot authorise a send under assessment B. That covers the case where the candidate
 * is re-assessed *after* approval. It does not cover a caller asking to approve against
 * a fingerprint that is already stale, which would mint a record that can never match
 * anything — so that is refused here rather than at publish time, where the message
 * would be about "no approval" and hide the real cause.
 */
import type { StoredCandidate } from '../store.js';
/** What this module needs to know about a candidate to judge approvability. */
export interface ApprovableCandidate {
    readonly replyId: string;
    readonly text: string;
    readonly targetPostId: string;
    readonly candidateVersion?: number;
    readonly security?: {
        readonly decision: 'allow' | 'review' | 'block';
        readonly fingerprint: string;
        readonly reasons: readonly string[];
    } | undefined;
}
/** Why a candidate may not be approved. */
export type ApprovalRefusal = {
    readonly ok: false;
    readonly code: 'unassessed';
    readonly reason: string;
} | {
    readonly ok: false;
    readonly code: 'blocked';
    readonly reason: string;
} | {
    readonly ok: false;
    readonly code: 'fingerprint_stale';
    readonly reason: string;
};
/** The verdict on whether an approval may be created. */
export type Approvable = {
    readonly ok: true;
    readonly fingerprint: string;
} | ApprovalRefusal;
/**
 * Whether this candidate may receive an approval at all.
 *
 * `allow` and `review` are both approvable — the difference between them is what
 * happens *without* an approval (`review` is never allowed to spend an automatic
 * slot), not whether an owner may say yes. `block` is not, and neither is a candidate
 * with no assessment: there is nothing to approve.
 */
export declare function isApprovable(candidate: ApprovableCandidate): Approvable;
/**
 * Whether the fingerprint a caller wants to approve against is still current.
 *
 * A caller that does not send one is asking to approve *now*, against whatever the
 * stored assessment is — the common case, and safe: the binding records that exact
 * fingerprint, so a later re-assessment invalidates the record normally.
 *
 * A caller that does send one is asserting which assessment they are looking at. If
 * that is not the stored one, their page is stale and the approval they are about to
 * create describes a candidate that no longer exists.
 */
export declare function checkReassessment(candidate: ApprovableCandidate, requested: string | undefined): {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly code: 'fingerprint_stale';
    readonly reason: string;
};
/** Narrow a stored candidate to the fields {@link isApprovable} reads. */
export declare function approvableOf(candidate: StoredCandidate): ApprovableCandidate;
//# sourceMappingURL=approve-guard.d.ts.map