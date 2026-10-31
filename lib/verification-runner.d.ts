/**
 * The one-off verification runner: the part of `verification.ts` that touches the world.
 *
 * ## Why this file is separate from `verification.ts`
 *
 * `verification.ts` holds the **rules** (may this run start? did the read-back prove it?) and is
 * pure. This file holds the **order of operations**: read the live identity, write a `pending`
 * record, call the platform, read the reply back, write the outcome. Keeping them apart is what
 * lets the rules be tested against combinations that are expensive or impossible to produce for
 * real, while the order stays in exactly one place.
 *
 * ## The order is the safety property
 *
 * Every step below exists because of a specific way this could go wrong:
 *
 * 1. **Refuse before the network.** All authorization checks run first, so a refusal costs
 *    nothing and cannot half-publish.
 * 2. **Re-read the live identity.** The authorization names an account; a session logged in as
 *    somebody else must not publish as them. Checked *here*, not at authorization time, because
 *    the session can change between the two.
 * 3. **Write `pending` before the call.** If the process dies mid-publish the reply may already
 *    be on the platform. A record saying "attempted, outcome unknown" is the only honest state,
 *    and it is what stops an automatic retry from double-posting.
 * 4. **Never retry.** 403, 429, a captcha, a timeout — all leave the capability `unverified`,
 *    because "the platform refused" does not mean "publishing does not work".
 * 5. **Read back and demand all four facts.** A returned post id proves something was written
 *    somewhere; the author, the text and the parent are what prove it was *this* reply.
 * 6. **Decide the upgrade from the persisted record.** Not from the in-memory result, so a crash
 *    between the two loses the upgrade rather than inventing one.
 *
 * ## What it deliberately does not do
 *
 * - It does not publish without an authorization. There is no "verify against whatever is
 *   configured" path.
 * - It does not write capability declarations. Evidence is recorded, and
 *   `capability-evidence.ts` joins it with the static ceiling; nothing here flips a declaration.
 * - It does not loop. One authorization, one publish, ever.
 */
import type { CapabilityState } from './platforms/contracts.js';
import type { PlatformAdapter, PublishTarget, ThreadRef } from './types.js';
import { type VerificationAuthorization, type VerificationDecision, type VerificationReadBack, type VerificationRecord } from './verification.js';
/** What the runner is allowed to touch. Narrow on purpose: no store, no config, no LLM. */
export interface VerificationRunnerDeps {
    /** The adapter for the platform being verified. */
    readonly adapter: PlatformAdapter;
    /** The declaration to check the current state against, straight from the provider. */
    readonly capabilityState: () => CapabilityState;
    /** The account the live session belongs to, or `undefined` when it cannot be determined. */
    readonly liveAccountId: () => Promise<string | undefined>;
    /** Durable storage for records. Implemented by the store; in-memory in tests. */
    readonly records: VerificationRecordStore;
    /** Clock, injected so the tests can pin timestamps. */
    readonly now: () => string;
    /**
     * The adapter build identity, stamped into every record.
     *
     * Defaults to nothing, which means "unknown build" — and an unknown build never promotes a
     * capability (see `capability-evidence.ts`). Callers that want promotion must supply it.
     */
    readonly adapterVersion?: string;
    /** Cancellation. */
    readonly signal?: AbortSignal;
}
/** The persistence the runner needs. Deliberately tiny — it is not the general store API. */
export interface VerificationRecordStore {
    /** Every record, oldest first. */
    all(): readonly VerificationRecord[];
    /**
     * Write one record.
     *
     * Called **twice** per attempt: once with `outcome: 'pending'` before the network call, once
     * with the final outcome. An implementation must upsert by `key` so the second write replaces
     * the first rather than appending a contradicting row.
     */
    put(record: VerificationRecord): Promise<void>;
    /**
     * Re-read the records from durable storage, when the store can do that at all.
     *
     * Optional because a test double has nothing to re-read. The real store provides it: the
     * runner's pre-checks read `all()`, and with two plugin instances over one directory that
     * answer comes from this instance's copy, which only changes when *this* instance writes.
     * Refreshing first means the pre-check sees a claim made by the other process.
     */
    refresh?(): Promise<readonly VerificationRecord[]>;
    /**
     * Atomically claim an authorization, or report that it is already spent (v0.2.21 P0-1).
     *
     * This is the operation that makes "one authorization, one publish" true under concurrency.
     * Reading the record list and then writing `pending` are two separate observations, and two
     * requests can interleave between them — both seeing "unused". Claiming must therefore be one
     * indivisible step: check the key and write the `pending` row inside a single lock hold.
     *
     * Implementations must:
     * - return `{ claimed: false, existing }` when the key is already present, without writing;
     * - throw when the write fails, so the caller knows not to publish.
     */
    claim?(record: VerificationRecord): Promise<{
        claimed: boolean;
        existing?: VerificationRecord;
    }>;
}
/** The result of one verification attempt, as reported to the owner and to the diagnostics page. */
export interface VerificationRunResult {
    readonly ok: boolean;
    /** Why it did not run, when it did not. */
    readonly refusal?: VerificationDecision['refusal'];
    readonly message: string;
    /** The record that was written, when the run reached the write step. */
    readonly record?: VerificationRecord;
    /** Whether the capability may be treated as verified for this account afterwards. */
    readonly upgraded: boolean;
}
/**
 * Turn the authorization into the platform's own vocabulary.
 *
 * Kept separate so the runner has no opinion about URL shapes: the caller passes the ids the
 * owner authorized. `PublishTarget` is built here from **the authorization**, never from a
 * model-supplied id — that is the rule `types.ts` documents for the normal publish path, and it
 * matters just as much for a verification publish.
 */
export declare function targetFor(authorization: VerificationAuthorization): {
    ref: ThreadRef;
    target: PublishTarget;
};
/**
 * Run one verification attempt.
 *
 * Returns rather than throws for every expected refusal: a caller that has to distinguish
 * "refused" from "crashed" ends up treating both as failure, and the owner loses the reason.
 */
export declare function runVerification(authorization: VerificationAuthorization, deps: VerificationRunnerDeps): Promise<VerificationRunResult>;
/** What the read-back could and could not establish. */
export interface ReadBackEvidence {
    readonly facts: VerificationReadBack;
    /** The post id the platform returned, echoed for the caller's report. */
    readonly postId: string;
}
/**
 * Re-read the published reply and map it onto the four facts.
 *
 * Every "cannot check" is `false` plus a note, never an optimistic `true`: the upgrade decision
 * requires all four, so an unreadable field must not be able to look like agreement.
 *
 * Absent author and absent body are the two shapes that matter. Reading an absent body as a
 * *mismatch* claims the reply is wrong when nothing was read; reading it as a *match* claims it
 * is right when nothing was read. Both are lies about the same missing fact, so both become
 * `false` with a note.
 */
export declare function readBackVerification(adapter: PlatformAdapter, ref: ThreadRef, postId: string, authorization: VerificationAuthorization, signal?: AbortSignal): Promise<ReadBackEvidence>;
//# sourceMappingURL=verification-runner.d.ts.map