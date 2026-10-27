/**
 * Publishing: the only path that can write to the platform on the owner's
 * behalf, and therefore the most conservative file in the project.
 *
 * The design decisions worth stating:
 *
 * - **The dedupe record is written before the request.** If the process dies
 *   between "wrote a record" and "learned the outcome", the next run sees a
 *   `pending` publish and refuses to retry automatically. Losing that ordering
 *   is how bots double-post.
 * - **An unprovable result is `uncertain`, never `success`.** A 200 with an
 *   unexpected body, a timeout after send, a response with no post id — all
 *   produce `uncertain`, which requires a human read-back.
 * - **Verification is a separate read.** After a confirmed publish the returned
 *   post id is looked up again; a reply that the platform claimed but that
 *   cannot be read back is reported as unverified rather than assumed.
 */
import { type PlatformAdapter } from './types.js';
import { DebateStore } from './store.js';
import { type InteractionPolicy } from './safety.js';
/** What a caller must supply to publish. */
export interface PublishRequest {
    readonly sessionId: string;
    readonly candidateId: string;
    /** The exact text the human saw and approved. */
    readonly approvedText: string;
    readonly humanApproved: boolean;
    readonly signal?: AbortSignal;
}
/** The detailed result of a publish attempt. */
export interface PublishReport {
    readonly ok: boolean;
    readonly status: 'published' | 'uncertain' | 'refused' | 'failed';
    /** Human-facing summary; always safe to show. */
    readonly message: string;
    readonly postId?: string;
    /** True when the reply was found by reading the thread back. */
    readonly verified?: boolean;
    readonly errorCode?: string;
    /** Set when the session was paused as a consequence. */
    readonly paused?: boolean;
}
/** Inputs the publisher needs from the surrounding plugin. */
export interface PublisherDeps {
    /**
     * The platform adapter.
     *
     * Typed as the generic interface since v0.2.0: the publisher must work for any
     * platform, and naming `TiebaAdapter` here is what made it impossible. Everything
     * this module calls is part of the contract.
     */
    readonly adapter: PlatformAdapter;
    readonly store: DebateStore;
    readonly policy: InteractionPolicy;
    /**
     * Live configuration, read at publish time.
     *
     * A function rather than a snapshot so a changed `aiAccountUserId` takes effect
     * without rebuilding the plugin — and so the identity check uses the value the
     * user is looking at right now, not the one from when the session started.
     */
    readonly config?: () => {
        readonly aiAccountUserId?: string;
        readonly aiAccountName?: string;
    };
    /**
     * Whether a session has been cancelled.
     *
     * Consulted immediately before the network call, so a `stop_session` that lands
     * while the publisher is still validating prevents the send. It cannot undo a
     * request that already left.
     */
    readonly isCancelled?: (sessionId: string) => boolean;
    /**
     * The credential state, consulted before anything irreversible.
     *
     * Absent means "this caller has no credential seam and takes responsibility
     * for the cookie" — the shape every pre-v0.1.12 test double already has, and
     * the shape a deployment without `ctx.credentials` genuinely has.
     */
    readonly credentialState?: () => {
        readonly phase: string;
        readonly canPublish: boolean;
        readonly error?: string;
    };
    /** Suggested wait between publishes; exposed for tests. */
    readonly now?: () => number;
}
/** Test seam: how many keys are currently claimed. */
export declare function inFlightCount(): number;
/** Test seam: clear claims left behind by a failed test. */
export declare function resetInFlight(): void;
/**
 * Publish one approved candidate.
 *
 * Every check runs in the order that fails cheapest first, and each refusal is
 * specific: "the text you approved differs from the stored candidate" is far
 * more useful than a generic "refused".
 *
 * Concurrency: the whole check-and-send sequence runs under a per-dedupe-key
 * claim (see {@link inFlight}). A second call for the same trigger while the
 * first is still working is refused outright rather than queued, because the
 * honest answer to "is this already being sent?" is yes.
 */
export declare function publishCandidate(deps: PublisherDeps, request: PublishRequest): Promise<PublishReport>;
/**
/**
 * What a post-hoc read of the platform actually proved about a publish.
 *
 * `verified` means every check that the platform made possible passed. It does *not*
 * mean "the reply exists somewhere": a post id that resolves to the right thread but
 * the wrong author, or to a different body, is a failure of the same kind as a missing
 * reply, and reporting it as a success is how a user is told a reply landed when what
 * actually landed was something else.
 */
export interface PublishVerification {
    /** Every check the platform allowed passed. */
    readonly verified: boolean;
    /** Checks that could not even be attempted, with the reason. */
    readonly unconfirmed: readonly string[];
    /** Checks that ran and failed. Empty means nothing contradicted the publish. */
    readonly mismatches: readonly string[];
}
/**
 * Re-exported so callers of the publisher keep working; the ledger rules
 * themselves live in `store.ts`, where both the analysis and publish paths read
 * them, so the two cannot disagree about what a record means.
 */
export { upsertDedupe } from './store.js';
//# sourceMappingURL=publisher.d.ts.map