/**
 * The output gate: judge a generated reply before it may be published.
 *
 * This is the piece that makes the whole system's guarantee real. The task book's
 * acceptance condition is precise: **even if an injection succeeds in making the
 * generation model produce a reply that attacks the owner, the independent output
 * check and the pre-publish gate must still stop it.** So this module must not ask
 * the generation model anything, must not rely on the prompt having said "don't do
 * that", and must not depend on the input detector having fired.
 *
 * ## Two layers, deliberately unequal
 *
 * - **Deterministic** checks (target identity, credential shapes, stance rules,
 *   evidence citations) are cheap, reproducible, and cannot be argued with. They
 *   produce `block` on their own.
 * - **Semantic** review may *only* make the verdict stricter. It runs on attacker-
 *   controlled text, so treating its `ok` as permission would be trusting the
 *   target of the attack. A reviewer that fails, times out, or returns junk raises
 *   the verdict to `review` — never leaves it at `allow`.
 *
 * ## Where the check runs
 *
 * Twice: once at generation (so the reviewer sees the verdict alongside the text)
 * and again immediately before the network call. The second run is the one that
 * matters, because between the two the owner may have edited the text, the
 * opponent may have posted again, and the stored assessment may describe prose
 * that is no longer what would be sent.
 */
import type { StoredCandidate } from '../store.js';
import type { AssessmentFingerprint } from './fingerprint.js';
import { type VerifiedOwner } from './owner-integrity.js';
import { type CandidateSecurityAssessment, type SecurityStrictness } from './security-policy.js';
/** One post the reply might be drawing on. */
export interface ConversationPost {
    readonly postId: string;
    readonly authorKey: string;
    readonly text: string;
}
/** Everything the gate needs. */
export interface OutputGuardInput {
    /** The generated reply text, exactly as it would be published. */
    readonly reply: string;
    /** The post the reply claims to answer. */
    readonly targetPostId: string;
    /** The opponent's verified latest post id, from the dispute. */
    readonly expectedTargetPostId?: string;
    /** The verified owner, from the platform account binding. */
    readonly owner: VerifiedOwner;
    readonly opponentName?: string;
    /** Every post in the collected conversation, for evidence checks. */
    readonly posts?: readonly ConversationPost[];
    /** Which posts belong to the owner and which to the opponent. */
    readonly ownerPostIds?: ReadonlySet<string>;
    readonly opponentPostIds?: ReadonlySet<string>;
    /** The conversation text the reply was generated from, for input assessment. */
    readonly conversationText?: readonly string[];
    readonly strictness?: SecurityStrictness;
    /**
     * Whether the debate brief is settled (v0.2.14 §6.4).
     *
     * Comes from the `ConflictVerdict` the brief was built with. It does **not** affect
     * `decision`: a reply to a misunderstanding is safe prose, so it must not be blocked — but it
     * must lose the automatic slots, which `checkPublishPolicy` enforces from this field.
     *
     * Absent means "not computed". That is treated as unsettled everywhere downstream, because
     * "we never checked" is not "it is fine".
     */
    readonly semanticSettled?: boolean;
}
/**
 * True when the reply text itself contains anything credential-shaped.
 *
 * Separate from the stance guard because it is a pure text property: a reply
 * leaking a key is dangerous regardless of who it was aimed at.
 */
export declare function textLooksLikeSecretLeak(reply: string): {
    readonly leak: boolean;
    readonly labels: readonly string[];
};
/**
 * Check that a reply's factual claims trace back to posts that were read.
 *
 * Only checks the *shape* of a citation claim, not truth — deciding whether a
 * sentence is true is not something this layer can do. What it can do is notice a
 * reply asserting that someone said something when no collected post contains it.
 *
 * Deliberately conservative: a quote must match a real post's text (normalised) to
 * within a short window. Requiring exact equality would make every paraphrase a
 * violation, which would block legitimate replies.
 */
export declare function checkEvidenceIntegrity(input: {
    readonly reply: string;
    readonly posts: readonly ConversationPost[];
}): {
    readonly valid: boolean;
    readonly problem?: string;
};
/**
 * Run every check and produce the assessment.
 *
 * @returns the assessment, plus a fingerprint that binds it to this exact text
 */
export declare function guardOutput(input: OutputGuardInput): {
    readonly assessment: CandidateSecurityAssessment;
    readonly fingerprint: string;
};
/**
 * Re-verify a stored candidate immediately before publishing.
 *
 * This is the gate the acceptance criterion talks about, and it is intentionally
 * **stricter than the generation-time check**:
 *
 * - A candidate with no stored assessment is refused. It was produced by an older
 *   version, which means it never faced this check at all.
 * - The stored decision must not be `block`.
 * - The stored fingerprint must still match the text about to be sent. Editing the
 *   text after approval invalidates the approval.
 *
 * @returns `undefined` when the send may proceed, otherwise the refusal reason
 */
export declare function recheckBeforePublish(input: {
    readonly candidate: StoredCandidate;
    readonly textToSend: string;
}): {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** The assessment as it is persisted on the candidate. */
export declare function toStorageRecord(assessment: CandidateSecurityAssessment, fingerprint: string): AssessmentFingerprint;
//# sourceMappingURL=output-guard.d.ts.map