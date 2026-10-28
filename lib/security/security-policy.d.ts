/**
 * Turn evidence into a decision.
 *
 * The pieces so far only *observe*: the detector names what it saw, the integrity
 * guard judges stance. This module is the one place that decides, so that "what is
 * allowed" is a policy question with one answer rather than being re-litigated at
 * each call site.
 *
 * ## The three outcomes, and why there is no fourth
 *
 * - `allow` — nothing significant found. Still goes through manual review; safety
 *   never removes the human step.
 * - `review` — something is unclear. A human must look at a specific piece of
 *   evidence. Safer than `allow` because uncertainty is not permission.
 * - `block` — a hard rule was broken: the reply attacks the owner, impersonates a
 *   role, follows an injected instruction, or leaks a credential. This cannot be
 *   overridden by having approved an earlier version of the candidate.
 *
 * There is deliberately no "allow because the owner clicked through the warning".
 * The owner may **edit** a blocked reply and re-run every check; that is different
 * from waving a blocked text through.
 *
 * ## Fail-closed
 *
 * Every decision function here treats a *missing* answer as the pessimistic one.
 * If the semantic reviewer times out, the candidate is `review`, never `allow`.
 * That is the single most important property in this file: a security system whose
 * default on error is "fine" is worse than none, because it fails silently exactly
 * when an attacker is hammering it.
 */
import type { InjectionAssessment } from './injection-detector.js';
import type { StanceProblem, StanceVerdict, VerifiedOwner } from './owner-integrity.js';
/** The decision a security check produces. */
export type SecurityDecision = 'allow' | 'review' | 'block';
/**
 * The per-candidate security record.
 *
 * Every field is produced by program logic — never by asking the generation model
 * whether it behaved. A model's self-assessment is worthless here: the whole threat
 * is a model that has been persuaded to misbehave.
 */
export interface CandidateSecurityAssessment {
    /** An injection attempt was found in the conversation this reply came from. */
    readonly injectionDetected: boolean;
    /** The owner identity used was the platform-verified one, not a claimed one. */
    readonly ownerIdentityValid: boolean;
    /** The reply targets the post the opponent actually wrote. */
    readonly targetIdentityValid: boolean;
    readonly stanceConsistency: StanceVerdict;
    /** The reply explicitly attacks the owner rather than the argument. */
    readonly ownerDirectedAttack: boolean;
    /** The reply appears to be executing a command found in untrusted text. */
    readonly unauthorizedInstructionFollowed: boolean;
    /** Credential or privacy leakage risk. */
    readonly secretLeakRisk: boolean;
    /** Every claim in the reply traces to a collected post. */
    readonly evidenceIntegrityValid: boolean;
    readonly decision: SecurityDecision;
    readonly reasons: readonly string[];
}
/** What the checks found, before a decision is made. */
export interface SecurityFindings {
    /** Injection assessment of the conversation the reply was built from. */
    readonly input?: InjectionAssessment;
    /** Stance problems found in the generated reply. */
    readonly stance: {
        readonly verdict: StanceVerdict;
        readonly problems: readonly StanceProblem[];
    };
    /** Whether the owner identity came from the binding rather than the thread. */
    readonly ownerIdentityValid: boolean;
    /** Whether the reply's declared target is the opponent's real post. */
    readonly targetIdentityValid: boolean;
    /** Whether the reply's evidence citations all exist. */
    readonly evidenceIntegrityValid: boolean;
    /** Whether the reply text itself looks like a credential or privacy leak. */
    readonly secretLeakRisk: boolean;
}
/**
 * The strictness the owner may tune.
 *
 * Only the *semantic* thresholds move. The deterministic rules — target identity,
 * credential leakage, owner attack — are not configurable, because a setting that
 * turns those off is a setting that makes the plugin unsafe, and shipping one means
 * an attacker only has to talk the owner into flipping it.
 */
export type SecurityStrictness = 'strict' | 'standard' | 'relaxed';
/**
 * Decide what may happen to this candidate.
 *
 * Order matters: the hard blocks are evaluated first and cannot be softened by
 * strictness. Only the *uncertainty* branch consults the setting.
 */
export declare function decideSecurity(findings: SecurityFindings, strictness?: SecurityStrictness): CandidateSecurityAssessment;
/**
 * Fold in a semantic reviewer's opinion, which can only make things stricter.
 *
 * A reviewer may raise `allow` to `review` or `review` to `block`. It may never
 * lower anything: the reviewer reads attacker-controlled text, so it is itself a
 * target, and letting it grant permission would be trusting the thing under attack.
 *
 * @param current the deterministic decision
 * @param opinion what the reviewer said, or `undefined` when it failed
 */
export declare function applyReviewerOpinion(current: CandidateSecurityAssessment, opinion: {
    readonly status: 'ok';
    readonly risk: 'none' | 'some' | 'high';
    readonly note?: string;
} | {
    readonly status: 'unavailable';
    readonly reason: string;
} | {
    readonly status: 'malformed';
    readonly reason: string;
} | undefined): CandidateSecurityAssessment;
/** True when a candidate may be published without further human action. */
export declare function mayAutoPublish(assessment: CandidateSecurityAssessment): boolean;
/**
 * A key identifying which text and assessment a decision belongs to.
 *
 * The publisher re-checks before sending: the owner may have approved candidate A,
 * then the text or the target changed, and the stored assessment no longer
 * describes what would be sent. Comparing this key is how "approved" is tied to
 * the exact text rather than to a session.
 */
export declare function assessmentFingerprint(input: {
    readonly reply: string;
    readonly targetPostId: string;
    readonly decision: SecurityDecision;
}): string;
/**
 * Describe a decision for the owner.
 *
 * Phrased as an explanation rather than a verdict, because the owner needs to know
 * *what to look at* in order to decide whether to edit and retry.
 */
export declare function describeAssessment(assessment: CandidateSecurityAssessment): string;
/** The owner identity a check must be run against, derived from the binding only. */
export declare function ownerFromBinding(input: {
    readonly platform: string;
    readonly accountId?: string;
    readonly displayName?: string;
}): VerifiedOwner;
//# sourceMappingURL=security-policy.d.ts.map