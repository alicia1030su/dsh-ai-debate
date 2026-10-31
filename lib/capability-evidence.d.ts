/**
 * Capability evidence: what turns "the code exists" into "somebody proved it here".
 *
 * ## The problem
 *
 * v0.2.21 §三 requires that a one-off publish verification actually be reachable, and §三.9
 * requires that it never be possible to promote one account's success into "works for
 * everyone". Those two requirements pull in opposite directions:
 *
 * - The capability matrix must be able to say `supported` for **this deployment, this account**,
 *   otherwise the gate can never open and the verification flow is decoration.
 * - The matrix must **not** be edited by hand, because that is exactly the lie the capability
 *   model exists to prevent (`src/platforms/contracts.ts`).
 *
 * ## The resolution: evidence is data, declaration is code
 *
 * A provider's `describeCapabilities()` stays static and stays the **ceiling**: it says what
 * this integration could do. A verification record is **evidence**: it says what was observed,
 * where, by whom, and against which adapter version. This module is the pure function that
 * joins them.
 *
 * The rules are deliberately narrow — each one closes a way of over-reading a single success:
 *
 * 1. **Same platform.** A Tieba success says nothing about Weibo.
 * 2. **Same capability.** Publishing a new comment is not replying to one; the platform may
 *    allow one and refuse the other.
 * 3. **Same account.** "The owner's test account can reply" is not "any account can reply".
 *    A record without an account id is never evidence for a specific account.
 * 4. **Same adapter version.** A success recorded against `0.2.19+abcdef0` does not carry over
 *    to a rewritten adapter: the bytes that succeeded were different bytes.
 * 5. **Complete read-back.** The four facts in `verification.ts` (`decideCapabilityUpgrade`)
 *    must all be present. A publish that returned an id but whose text was not confirmed is
 *    evidence that something was written somewhere, not that publishing works.
 * 6. **Only upward.** Evidence may lift `unverified` to `supported`. It may never lift
 *    `permission_required` (a grant is missing) or `unavailable` (the platform does not offer
 *    it) — those are statements about the world, not about evidence we have collected.
 *
 * Nothing here touches the network, the store, or the clock: it takes records and returns a
 * decision, so the tests can feed it the combinations that are expensive to produce for real.
 */
import type { CapabilityName, CapabilityState } from './platforms/contracts.js';
/** One piece of evidence, as persisted. Keys are the identity of the observation. */
export interface CapabilityEvidenceRecord {
    readonly platform: string;
    readonly capability: CapabilityName;
    /** The account the observation was made with. Never "the account that happened to be logged in". */
    readonly accountId: string;
    /**
     * The adapter build the observation was made against.
     *
     * Deliberately a string the caller derives from the compiled artefact, not a hand-written
     * "1.0": two different adapters must not share a version, or replacing the publish method
     * would silently inherit the old evidence.
     */
    readonly adapterVersion: string;
    /** ISO timestamp of the observation. */
    readonly verifiedAt: string;
    /** How it was observed. `live` is the only kind that can promote a capability. */
    readonly method: 'live' | 'fixture' | 'mock';
    /** Whether the four read-back facts were complete. */
    readonly readBackComplete: boolean;
}
/** What the caller is asking about: one capability, on one platform, for one account. */
export interface CapabilityQuery {
    readonly platform: string;
    readonly capability: CapabilityName;
    readonly accountId: string;
    readonly adapterVersion: string;
}
/** The decision, with the reason a human can act on. */
export interface CapabilityEvidenceDecision {
    /** The state the gate should use. Equals the declared state when evidence does not apply. */
    readonly effective: CapabilityState;
    /** Whether evidence was what changed the answer. */
    readonly promotedByEvidence: boolean;
    /** Why. Always populated — "no evidence" is a reason too. */
    readonly reason: string;
    /** The record that was used, when one was. */
    readonly usedRecord?: CapabilityEvidenceRecord;
}
/**
 * Compute the state the publish gate should use.
 *
 * @param declared the provider's static declaration — the ceiling, never edited by evidence
 * @param query what this publish is about
 * @param records every record the store holds, newest first
 */
export declare function effectiveCapability(declared: CapabilityState, query: CapabilityQuery, records: readonly CapabilityEvidenceRecord[]): CapabilityEvidenceDecision;
/**
 * Whether a fresh record should be written for this authorization.
 *
 * A verification that failed must not erase the fact that it was attempted: §三.5 requires the
 * `pending` row **before** the network call, so a crash leaves evidence of the attempt rather
 * than silence. This helper only answers "is this run allowed to start", which is the
 * once-per-authorization rule from `verification.ts` expressed over persisted records.
 */
export declare function hasUsedAuthorization(records: readonly CapabilityEvidenceRecord[], key: {
    platform: string;
    capability: CapabilityName;
    accountId: string;
    threadId: string;
}, usedKeys: ReadonlySet<string>): boolean;
/**
 * A short, stable adapter version for evidence binding.
 *
 * Two properties matter and both are deliberate:
 *
 * - It must change when the adapter changes. A hard-coded `"1"` would let a rewritten publish
 *   method inherit the previous evidence.
 * - It must be reproducible. Hashing the source bytes is; `Date.now()` is not.
 *
 * The caller passes the bytes it considers the adapter (typically the compiled module file), so
 * this function stays pure and testable.
 */
export declare function adapterVersionOf(bytes: string | Uint8Array): string;
/**
 * The adapter identity, derived from the two methods that actually publish and read back.
 *
 * Hashing the function sources is deliberately narrow: a change anywhere else in the adapter
 * (a parser, a header) does not invalidate the evidence, because it did not change the bytes
 * that were sent or the way the reply is read back. A change to either of these two does.
 *
 * Function source is stable for a given compiled artefact, so the value is reproducible across
 * machines — which `node:vm`-independent, no-I/O and therefore testable.
 */
export declare function adapterVersionOfAdapter(adapter: {
    readonly publishReply: (...args: never[]) => unknown;
    readonly getReplyContext: (...args: never[]) => unknown;
}): string;
//# sourceMappingURL=capability-evidence.d.ts.map