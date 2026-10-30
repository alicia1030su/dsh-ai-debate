/**
 * Approval records: the thing that makes "the owner approved" checkable.
 *
 * ## The problem this replaces
 *
 * v0.2.4 and earlier decided whether a human had approved by reading a boolean:
 * `debate_publish_reply` accepts `confirm: true` **from the model's own arguments**
 * and passes it straight through as `humanApproved: true`. That is not evidence. A
 * model that has been talked into publishing by a comment can set `confirm: true`
 * itself, and nothing in the system can tell the difference between that and a
 * person clicking approve.
 *
 * The task book's acceptance criterion is exactly this case, so the fix cannot be
 * "validate the boolean harder". Approval has to become a **record** created by
 * something the model cannot reach.
 *
 * ## What a record is
 *
 * One approval binds a human decision to one exact publish attempt:
 *
 *   session + candidate + platform + target post + publishing account
 *   + body hash + candidate version
 *
 * Change any of those and the record no longer describes what would be sent, so it
 * stops authorising anything. That is deliberate: "approve this reply" must not
 * survive the reply being edited, the target moving, or the account changing.
 *
 * ## The three properties that make it evidence
 *
 * 1. **Single use.** `consumedAt` is set when the send is claimed. A replay finds a
 *    consumed record and is refused; two concurrent sends race on the same compare
 *    and the loser is refused.
 * 2. **Expiry.** A record is valid for a bounded window. An approval granted hours
 *    ago is an approval of a different situation.
 * 3. **It cannot be forged by the agent.** There is no tool that writes a record.
 *    The only writer is the authenticated settings route (`security/approvals.ts`
 *    is pure; the route owns persistence), and the record's id is random, never
 *    placed in a tool result, and never in the model's context.
 *
 * ## Why the id is not a capability
 *
 * It would be natural to hand the model an approval id it could pass back. That is
 * rejected on purpose: an id in the model's context is an id a persuasive comment
 * can ask it to use. The publish path therefore takes no approval token at all — it
 * looks up the record by the *candidate*, which the model already cannot forge.
 */
/** How long an approval stays usable. */
export declare const APPROVAL_TTL_MS: number;
/**
 * What an approval is bound to.
 *
 * Every field participates in the comparison. A design that only checked
 * `candidateId` would let a record created for "reply to rival A" authorise "reply to
 * rival B" after the target moved, because the candidate is the same row.
 */
export interface ApprovalBinding {
    readonly sessionId: string;
    readonly candidateId: string;
    readonly platform: string;
    /** The post this reply answers. */
    readonly targetPostId: string;
    /** The account that would post it, so a switched account cannot inherit it. */
    readonly publishingAccount: string;
    /** The exact body the owner read. */
    readonly textHash: string;
    /** Which candidate revision, so a regenerated reply is a different thing. */
    readonly candidateVersion: number;
    /** Which assessment was in force, so a re-assessed candidate is a different thing. */
    readonly assessmentFingerprint: string;
}
/** A stored approval. */
export interface ApprovalRecord extends ApprovalBinding {
    readonly id: string;
    /** Who granted it, for the audit trail. Never a secret. */
    readonly grantedBy: string;
    readonly grantedAt: string;
    /** Set when a publish claims it. A consumed record authorises nothing further. */
    readonly consumedAt?: string;
    /** Set when the owner revokes it before use. */
    readonly revokedAt?: string;
}
/** Why an approval was refused. Every case is a distinct code so tests can pin it. */
export type ApprovalRejection = 'missing' | 'expired' | 'revoked' | 'consumed' | 'session_mismatch' | 'candidate_mismatch' | 'platform_mismatch' | 'target_mismatch' | 'account_mismatch' | 'text_mismatch' | 'version_mismatch' | 'assessment_mismatch';
/** The result of looking for a usable approval. */
export type ApprovalLookup = {
    readonly ok: true;
    readonly record: ApprovalRecord;
} | {
    readonly ok: false;
    readonly code: ApprovalRejection;
    readonly reason: string;
};
/**
 * Compare one record against the attempt it is supposed to authorise.
 *
 * Pure, and deliberately exhaustive: every mismatch has its own code, because a
 * single "invalid approval" makes it impossible to tell "the owner approved a
 * different reply" from "the record was tampered with".
 */
export declare function checkApproval(record: ApprovalRecord | undefined, expected: ApprovalBinding, now: () => number): ApprovalLookup;
/**
 * Find the approval for one attempt.
 *
 * Newest first: if the owner approved twice, the second approval is the one they
 * meant. An older unconsumed record is not resurrected.
 */
export declare function findApproval(records: readonly ApprovalRecord[], binding: Pick<ApprovalBinding, 'sessionId' | 'candidateId'>): ApprovalRecord | undefined;
/** Build a fresh approval. The id is random and is never given to the agent. */
export declare function createApproval(binding: ApprovalBinding, grantedBy: string, now: () => number): ApprovalRecord;
/**
 * Mark one record consumed.
 *
 * Returns a new array; the caller persists it inside the same store mutation that
 * claims the publish, so a crash between "claimed" and "sent" leaves the record
 * consumed rather than reusable. That is the safe direction: an unused approval can
 * be re-granted, a double post cannot be undone.
 */
export declare function consumeApproval(records: readonly ApprovalRecord[], id: string, now: () => number): readonly ApprovalRecord[];
/** Revoke one record. */
export declare function revokeApproval(records: readonly ApprovalRecord[], id: string, now: () => number): readonly ApprovalRecord[];
/**
 * Drop approvals that can no longer matter.
 *
 * Keeps the state file bounded without losing an audit trail inside the window: a
 * record is only removed once it is both expired and older than twice the TTL, so a
 * reviewer can still see what was approved recently.
 */
export declare function pruneApprovals(records: readonly ApprovalRecord[], now: () => number): readonly ApprovalRecord[];
/**
 * The binding derived from what is about to be sent.
 *
 * Kept here rather than in the publisher so the settings route (which creates
 * records) and the publish path (which checks them) compute it exactly the same way.
 * Two implementations of "which text is this" would drift, and the drift would look
 * like a legitimate approval.
 */
export declare function bindingOf(input: {
    sessionId: string;
    candidateId: string;
    platform: string;
    targetPostId: string;
    publishingAccount: string;
    text: string;
    candidateVersion: number;
    assessmentFingerprint: string;
}): ApprovalBinding;
/**
 * A digest of the body.
 *
 * This is an equality check, not a signature: it proves "the text is the one the
 * owner read", and it is explicitly **not** used as an authorisation credential.
 * The authorisation is the presence of a record created by an authenticated
 * request; the hash only decides whether that record still applies.
 */
export declare function hashText(text: string): string;
//# sourceMappingURL=approvals.d.ts.map