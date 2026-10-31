/**
 * The one-off publish verification flow.
 *
 * ## The problem this solves
 *
 * Tieba's `comment.publish` and `comment.reply` are `unverified`, and the publish
 * gate only accepts `supported`. That is correct — the gate exists so that "code
 * was written" never means "it can post to a stranger's thread". But it also means
 * the capability can never *become* supported: verification requires publishing,
 * and publishing is refused until it is verified.
 *
 * The wrong fix is to flip the state to `supported` so one test can prove itself.
 * That is precisely the lie the capability model was introduced to stop.
 *
 * ## The fix
 *
 * A separate, explicit flow that is **not reachable from the normal publish path**
 * and cannot be turned into a general bypass:
 *
 * - it takes an *authorization record* naming the account, the target thread, and
 *   the person who authorized it — all required, so there is no "verify against
 *   whatever is configured";
 * - it publishes **exactly once** per authorization, tracked durably, so it
 *   cannot be looped into a bulk poster;
 * - it is only usable while the capability is `unverified` — an
 *   already-`supported` capability has nothing to verify, and a `permission_required`
 *   or `unavailable` one must not be probed;
 * - it records the read-back outcome, and the capability only moves to
 *   `supported` when that evidence is complete.
 *
 * ## What it deliberately does not do
 *
 * - It does not touch the ordinary `assertCapability` gate. A thread the owner
 *   wants to argue in still needs a verified capability, and this flow does not
 *   change that for anyone.
 * - It does not retry. A failed verification (403, captcha, rate limit) leaves the
 *   capability `unverified`, because the honest reading of "the platform refused"
 *   is "we still do not know whether publishing works".
 * - It does not accept a capability it cannot verify. Asking to verify
 *   `thread.read` here is a caller error, not something to accommodate.
 */
import type { PlatformId } from './types.js';
import type { CapabilityName, CapabilityState } from './platforms/contracts.js';
/** Which capabilities this flow is allowed to verify. */
export declare const VERIFIABLE_CAPABILITIES: readonly CapabilityName[];
/**
 * The owner's explicit authorization for one verification publish.
 *
 * Every field is required, and none has a default. A flow that can invent its own
 * target is a flow that can post somewhere nobody approved.
 */
export interface VerificationAuthorization {
    readonly platform: PlatformId;
    /** The account the owner says may be used. Checked against the live session. */
    readonly authorizedAccountId: string;
    /** The thread the owner says is theirs or has permission to use. */
    readonly authorizedThreadId: string;
    /** Who authorized it, for the audit record. Free text, e.g. the owner's handle. */
    readonly authorizedBy: string;
    /** Which capability this run is meant to prove. */
    readonly capability: CapabilityName;
    /**
     * For `comment.reply`: the floor the reply must be attached under.
     *
     * Required for a reply and meaningless for a new comment, because the read-back has to check
     * the **parent**, and "wherever it ended up" is not something the owner authorized. Left
     * optional at the type level so a `comment.publish` authorization does not have to invent a
     * value; `checkVerification` refuses a reply authorization that leaves it empty.
     */
    readonly authorizedFloorId?: string;
    /**
     * For `comment.reply`: the exact comment being answered (楼中楼).
     *
     * Same reasoning as `authorizedFloorId`: without it the read-back can only confirm "a reply
     * exists somewhere under the floor", which is the weaker claim this flow must not accept.
     */
    readonly replyToPostId?: string;
    /**
     * The exact reply text, pre-approved by the owner.
     *
     * Required rather than generated: the point of verification is to observe what
     * the platform does with a known payload, and a generated text would make the
     * two confounded.
     */
    readonly approvedText: string;
}
/** Why a verification request was refused before touching the network. */
export type VerificationRefusal = 
/** The capability cannot be verified by this flow at all. */
'not_verifiable'
/** The capability is not in the only state this flow may test. */
 | 'wrong_state'
/** This authorization has already been used. */
 | 'already_used'
/** A required authorization field is empty. */
 | 'incomplete_authorization'
/** The live session is not the authorized account. */
 | 'account_mismatch'
/** The target is not the authorized thread. */
 | 'thread_mismatch'
/** The text is empty or too long for the platform. */
 | 'text_rejected';
/** The outcome of asking whether a verification run may proceed. */
export interface VerificationDecision {
    readonly ok: boolean;
    readonly refusal?: VerificationRefusal;
    /** Human-readable reason, shown to the owner. */
    readonly message: string;
}
/**
 * The durable record of one verification attempt.
 *
 * Written *before* the network call and updated after, so a crash mid-publish
 * leaves a record saying "this was attempted and the outcome is unknown" rather
 * than no record at all. An unknown outcome must not be retried automatically:
 * the reply may already be on the platform.
 */
export interface VerificationRecord {
    /** Stable key: one attempt per authorization. */
    readonly key: string;
    readonly platform: PlatformId;
    readonly capability: CapabilityName;
    readonly authorizedAccountId: string;
    readonly authorizedThreadId: string;
    readonly authorizedBy: string;
    readonly approvedText: string;
    readonly startedAt: string;
    /**
     * The adapter build this attempt ran against.
     *
     * Stamped at attempt time, not looked up later: replacing the publish method must not inherit
     * the previous adapter's evidence, and the only moment that knows which build actually ran is
     * this one. Without it, `capability-evidence.ts` has nothing to compare and would either
     * over-promote (old success, new code) or refuse to promote at all.
     */
    readonly adapterVersion?: string;
    readonly outcome: 'pending' | 'succeeded' | 'failed' | 'uncertain';
    /** The post id the platform returned, when it returned one. */
    readonly publishedPostId?: string;
    /** The read-back evidence, when the publish was confirmed. */
    readonly readBack?: VerificationReadBack;
    /** Why it failed, when it did. */
    readonly failure?: string;
}
/** What the read-back observed after publishing. */
export interface VerificationReadBack {
    /** The thread re-read still contains the new post. */
    readonly postFound: boolean;
    /** The post's author matched the authorized account. */
    readonly authorMatched: boolean;
    /** The post's text matched the approved text. */
    readonly textMatched: boolean;
    /** For a reply: the parent was the authorized floor/comment. */
    readonly parentMatched: boolean;
    /** Notes about anything that could not be checked. */
    readonly notes: readonly string[];
}
/** The key for one authorization, so a second run is detectable. */
export declare function authorizationKey(auth: VerificationAuthorization): string;
/**
 * Decide whether a verification may start.
 *
 * All the checks run before the caller touches the network, so a refusal costs
 * nothing and cannot half-publish.
 *
 * @param input.authorization what the owner approved
 * @param input.capabilityState the platform's current declaration
 * @param input.liveAccountId the account the live session belongs to, if known
 * @param input.usedKeys keys of attempts already recorded
 */
export declare function checkVerification(input: {
    authorization: VerificationAuthorization;
    capabilityState: CapabilityState;
    liveAccountId?: string;
    usedKeys: ReadonlySet<string>;
}): VerificationDecision;
/**
 * Decide whether the capability may be upgraded to `supported`.
 *
 * Requires *all four* read-back facts. A publish that returned a post id but whose
 * text could not be confirmed is not evidence that publishing works correctly —
 * it is evidence that something was written somewhere.
 */
export declare function decideCapabilityUpgrade(record: VerificationRecord): {
    readonly upgrade: boolean;
    readonly reason: string;
};
/**
 * The authorization template shown to the owner.
 *
 * Written out so the required fields are visible before anything is attempted,
 * rather than being discovered one refusal at a time.
 */
export declare function describeAuthorizationRequirements(platform: string): string;
//# sourceMappingURL=verification.d.ts.map