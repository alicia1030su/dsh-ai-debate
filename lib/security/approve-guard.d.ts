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
 * stored assessment is. Since v0.2.7 the approve route never takes that path — it
 * requires a snapshot — but this function keeps accepting `undefined` because it
 * answers a narrower question ("is this fingerprint current?") and other callers
 * legitimately have nothing to compare.
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
/** The snapshot a page must send back when it asks to approve one candidate. */
export interface ApprovalExpectation {
    readonly sessionId: string;
    readonly candidateId: string;
    readonly candidateVersion: number;
    readonly platform: string;
    readonly targetPostId: string;
    readonly publishingAccount: string;
    /** Hash of the body the page displayed. */
    readonly textHash: string;
    readonly assessmentFingerprint: string;
}
/** What the store actually holds for one candidate right now. */
export interface ApprovalActual {
    readonly sessionId: string;
    readonly candidateId: string;
    readonly candidateVersion: number;
    readonly platform: string;
    readonly targetPostId: string;
    readonly publishingAccount: string;
    readonly textHash: string;
    readonly assessmentFingerprint: string;
}
export type ExpectationCheck = {
    readonly ok: true;
    readonly expectation: ApprovalExpectation;
} | {
    readonly ok: false;
    readonly status: 400 | 409;
    readonly code: 'snapshot_required' | 'snapshot_incomplete' | 'stale_candidate';
    readonly reason: string;
};
/**
 * Validate the raw `expected` block from a request body.
 *
 * Split from the comparison so the two failure kinds stay distinguishable: a request
 * that never had a snapshot is a *client bug* (400), while a snapshot that no longer
 * matches is a *race the owner must see* (409). Collapsing them would let a broken
 * page look like a stale one, and the instruction to the user is different.
 *
 * @param raw the `expected` field, unvalidated, from the request body
 * @param sessionId the id the request also named at top level
 * @param candidateId the id the request also named at top level
 */
export declare function readExpectation(raw: unknown, sessionId: string, candidateId: string): ExpectationCheck;
/**
 * Compare the page's snapshot with what the store holds.
 *
 * Every field the binding uses is compared, so a change to any of them — a
 * regenerated body, a re-targeted reply, a switched account, a re-assessed
 * candidate — invalidates the approval instead of authorising something the owner
 * did not read. Reported as one code because the remedy is the same: re-read, look
 * again, approve again.
 */
export declare function checkExpectation(expectation: ApprovalExpectation, actual: ApprovalActual): {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly code: 'stale_candidate';
    readonly reason: string;
};
/** Narrow a stored candidate to the fields {@link isApprovable} reads. */
export declare function approvableOf(candidate: StoredCandidate): ApprovableCandidate;
//# sourceMappingURL=approve-guard.d.ts.map