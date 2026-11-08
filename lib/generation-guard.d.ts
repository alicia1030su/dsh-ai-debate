/**
 * One generation per session at a time, and no stale result may land.
 *
 * ## The two failures this exists to prevent
 *
 * 1. **Double click.** Two clicks a second apart start two model calls. Both finish, both
 *    append a candidate, and the owner pays twice for two drafts that differ only by
 *    sampling noise. Worse, the second one retires the first one's approval, so a person
 *    who approved one candidate while the other was still running sees the approval
 *    silently vanish.
 * 2. **A late answer to an abandoned question.** The owner switches the reply target while
 *    a call is in flight. The old call returns several seconds later and appends a
 *    candidate aimed at the *previous* target. Nothing in the store would refuse it — the
 *    candidate is internally consistent, it simply answers a question nobody is asking
 *    anymore — and the page then shows two targets' worth of drafts with no way to tell
 *    which is current.
 *
 * ## Why this is an in-memory guard and not a stored field
 *
 * The condition is "a request is in flight *in this process*". A stored field would have to
 * be cleaned up after a crash, and a crash means the request is gone anyway. Keeping it in
 * memory makes the invariant true by construction: when the process dies, so does the
 * claim.
 *
 * ## Why a new target supersedes instead of waiting
 *
 * `begin` refuses a duplicate for the *same* target, because that is a double click and the
 * right answer is "the one already running will answer you". A *different* target is a
 * decision, and a decision must take effect immediately: the new call supersedes the old
 * one, and the old one is marked stale so its result is discarded rather than stored.
 */
/** One in-flight generation. */
export interface GenerationClaim {
    /** Monotonic per guard, compared with `===` to detect supersession. */
    readonly token: number;
    readonly targetPostId: string;
    readonly startedAt: number;
}
/** Why a claim could not be started. */
export interface GenerationBusy {
    readonly ok: false;
    readonly active: GenerationClaim;
}
/** A started claim. */
export interface GenerationStarted {
    readonly ok: true;
    readonly claim: GenerationClaim;
}
/** The guard itself. One per runtime instance. */
export declare class GenerationGuard {
    private sequence;
    private readonly active;
    /**
     * The newest token ever issued for a session.
     *
     * ## Why a finished claim must not make an older one look current
     *
     * The first version answered `isStale` by comparing against the *active* claim. When the
     * newer request finished first, it released its claim — and the older request then saw
     * "no active claim", concluded it was fine, and wrote its result. Which is exactly the
     * late answer this class exists to discard.
     *
     * Keeping the highest token ever issued makes the comparison monotonic: a claim is stale
     * for the rest of the session's life once anything newer has started, whether or not that
     * newer thing is still running.
     */
    private readonly latest;
    /**
     * Claim the right to generate for this session.
     *
     * Returns `ok: false` only when the *same* target is already being generated — the
     * double-click case. A different target supersedes the previous claim.
     */
    begin(sessionId: string, targetPostId: string, now?: number): GenerationStarted | GenerationBusy;
    /** Release the claim, but only if it is still the active one. */
    finish(sessionId: string, claim: GenerationClaim): void;
    /**
     * True when a newer claim has taken over.
     *
     * Checked twice on purpose: once before composing the candidate (so an abandoned request
     * does not spend the security gate's work) and once inside the store write (so the answer
     * is about the document being written, not about a moment a few milliseconds earlier).
     */
    isStale(sessionId: string, claim: GenerationClaim): boolean;
    /** The claim currently held, for diagnostics. */
    activeClaim(sessionId: string): GenerationClaim | undefined;
    /** Drop every claim. Used when a runtime is torn down. */
    clear(): void;
}
/** The guard for this runtime, created on first use. */
export declare function generationGuardOf(owner: object): GenerationGuard;
//# sourceMappingURL=generation-guard.d.ts.map