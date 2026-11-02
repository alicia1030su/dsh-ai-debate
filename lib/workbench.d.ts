/**
 * The publish workbench: what step the owner is on, and what is stopping the next one
 * (v0.2.22 §一/§二/§五/§八).
 *
 * ## Why this is a derivation and not a stored field
 *
 * A `step` column would be a second source of truth: sessions already record a `TaskState`, the
 * candidates record their own version/hash/approval, and the approval ledger records what was
 * authorized for what. A stored step could disagree with all three after a crash, a refresh, or a
 * second plugin instance — and the disagreement would be invisible, because the page would render
 * the stale step as fact.
 *
 * So the step is **computed** from the durable facts every time it is asked for. That is also
 * what makes "refresh the page and continue" correct by construction instead of by extra code:
 * reloading produces the same answer, because the answer was never stored.
 *
 * ## The five result states are not one ladder
 *
 * §五 requires the interface to distinguish "request went out", "read-back verified", "platform
 * refused", "unknown", and "capability not verified". Those are not levels of success — they are
 * different claims, and collapsing any two of them is how "we sent something" gets read as "it
 * worked". `PublishOutcomeView` keeps them separate all the way to the render.
 */
import type { StoredCandidate, StoredSession } from './store.js';
/** Which step of the flow the owner is on. */
export type WorkbenchStep = 
/** Nothing collected yet: the owner pastes a discussion link. */
'link'
/** A session exists; the owner picks which post to rebut. */
 | 'target'
/** A target is fixed; generate candidates. */
 | 'generate'
/** Candidates exist; the owner reads and edits. */
 | 'review'
/** A candidate is approved and unchanged since. */
 | 'approve'
/** Approved, not yet sent. */
 | 'publish'
/** Sent; read-back result below. */
 | 'readback'
/** Terminal: published and confirmed, or stopped. */
 | 'done';
/** How a publish attempt actually ended. Deliberately five, deliberately distinct. */
export type PublishOutcomeView = 
/** No attempt has been made. */
'not_attempted'
/** The request left this process, but no evidence of the result exists yet. */
 | 'sent_unconfirmed'
/** All four read-back facts held. */
 | 'confirmed'
/** The platform refused it, with a reason. */
 | 'refused'
/** An attempt exists whose outcome is unknown. Never retried automatically. */
 | 'unknown';
/** One step's presentation. */
export interface WorkbenchStepView {
    readonly id: WorkbenchStep;
    readonly title: string;
    /** `current` is the one the owner should act on; `done` and `blocked` are informational. */
    readonly status: 'done' | 'current' | 'blocked' | 'pending';
    /** Why this step is blocked, when it is. */
    readonly blockedBy?: string;
}
/**
 * How far the *target's author* has been checked.
 *
 * Kept separate from the approval on purpose. An approval record binds bytes — text,
 * version, target post id, publishing account — and says nothing about who is sitting
 * on the target post right now. The publish path re-reads the platform and checks the
 * author there (`resolveTarget` + `snapshotStillValid`); until that read happens, all
 * this page can honestly claim is "not re-checked".
 *
 * The two states that are `blocking` are not predictions, they are the same facts the
 * publish gate reads before it touches the network: no snapshot, or no stable author
 * id. `publishCandidate` refuses both with a dedicated error code, so offering a
 * publish button here would be offering a button that cannot work.
 *
 * The four states:
 *
 * - `not_approved` — nothing to check yet: no candidate, or no approval binding it.
 * - `not_rechecked` — a stable author id is recorded; the platform has not been
 *   re-read since, and this page cannot claim otherwise.
 * - `unverifiable` — only a display name is recorded; publishing will be refused.
 * - `no_snapshot` — the candidate has no target snapshot; publishing will be refused.
 */
export type TargetIdentityState = 'not_approved' | 'not_rechecked' | 'unverifiable' | 'no_snapshot';
/** What the page may say about the target's author. */
export interface TargetIdentityView {
    readonly state: TargetIdentityState;
    /** True when `publishCandidate` is certain to refuse on identity grounds. */
    readonly blocking: boolean;
    /** One sentence a reader can act on. Never a claim of verification. */
    readonly detail: string;
    readonly authorId?: string;
    readonly authorName?: string;
}
/** A fact the collection could not establish. Rendered as a caveat, never as content. */
export interface MissingEvidence {
    readonly what: string;
    readonly detail: string;
}
/** Everything the workbench page needs, in one shape. */
export interface WorkbenchState {
    readonly step: WorkbenchStep;
    readonly steps: readonly WorkbenchStepView[];
    /** Ordered reasons the *next* irreversible action cannot happen yet. */
    readonly blockers: readonly string[];
    /**
     * Facts the reader must know but that do not block anything.
     *
     * Separate from `blockers` because "you cannot proceed" and "proceeding will also
     * re-check something" are different messages, and merging them teaches the reader
     * to skim both. `blockers` is what stops the button; this is what the button will
     * still do after it is pressed.
     */
    readonly notices: readonly string[];
    /**
     * The two things an approval does and does not cover, stated side by side.
     *
     * This exists because v0.2.22's页面 showed a bare `已批准` next to a publish button,
     * which reads as "everything is authorized". The approval covers bytes; the author
     * of the target is re-checked by the publish path, and the page must not borrow that
     * check's authority for itself.
     */
    readonly approval: {
        /** What the approval record authorizes: the text, version and target post. */
        readonly content: {
            readonly applies: boolean;
            readonly detail: string;
        };
        /** What it does not: who is on the other end. */
        readonly target: TargetIdentityView;
    };
    /** Facts the reader must know are missing before trusting the picture. */
    readonly missingEvidence: readonly MissingEvidence[];
    readonly outcome: PublishOutcomeView;
    /** Counts, so the owner can see how much was actually read (not how much was claimed). */
    readonly counts: {
        readonly floors: number;
        readonly nested: number;
        readonly candidates: number;
    };
    /** The target the current candidate would land on, when one is fixed. */
    readonly target?: {
        readonly threadId: string;
        readonly postId: string;
        readonly kind: 'floor' | 'nested';
        readonly authorName?: string;
    };
    /** Capability state for the platform, as the gate would read it. */
    readonly capability?: {
        readonly declared: string;
        readonly effective: string;
        readonly reason: string;
    };
    /**
     * The read-back facts behind `outcome`, when a read-back ran.
     *
     * §五 requires the interface to *separately* verify existence, author, body and parent. A
     * single "confirmed" boolean is a summary of those four, and showing only the summary hides
     * which one disagreed — the exact information needed to decide whether the reply is wrong or
     * the check is.
     */
    readonly readBack?: {
        readonly postFound: boolean;
        readonly authorMatched: boolean;
        readonly textMatched: boolean;
        readonly parentMatched: boolean;
        readonly notes: readonly string[];
    };
}
/** What the caller must supply. Kept narrow so this stays a pure function of durable facts. */
export interface WorkbenchInput {
    /** The session, or `undefined` before anything has been collected. */
    readonly session?: StoredSession;
    /** Whether an approval exists that still binds the candidate as it is now. */
    readonly approvalApplies: boolean;
    /** Capability state from the same evidence rules the publish gate uses. */
    readonly capability?: {
        declared: string;
        effective: string;
        reason: string;
    };
    /** Number of nested replies read, when known. */
    readonly nestedCount?: number;
    /** Number of first-level floors read, when known. */
    readonly floorCount?: number;
    /** Facts the collector reported as unavailable. */
    readonly gaps?: readonly MissingEvidence[];
    /** The last publish attempt for the current candidate, when one exists. */
    readonly lastAttempt?: {
        readonly status: 'confirmed' | 'uncertain' | 'failed';
        readonly reason?: string;
        /** The four read-back facts, when a read-back ran and reported them. */
        readonly readBack?: {
            readonly postFound: boolean;
            readonly authorMatched: boolean;
            readonly textMatched: boolean;
            readonly parentMatched: boolean;
            readonly notes: readonly string[];
        };
    };
}
/**
 * Derive the workbench state.
 *
 * The ordering below is the entire product rule: you cannot approve before there is text, you
 * cannot publish before the approval matches the bytes, and you cannot call it done before the
 * platform was read back.
 */
export declare function deriveWorkbenchState(input: WorkbenchInput): WorkbenchState;
/**
 * Say what is known about the *author* of the target — and, just as important, what is not.
 *
 * ## Why this is not a second identity check
 *
 * `approvalStillApplies` compares bytes; `publishCandidate` compares authors, but only
 * after re-reading the platform. Re-reading here would be a network call inside a
 * read-only page render, and duplicating the comparison would create a second place
 * that decides whether publishing may happen.
 *
 * So this function does neither. It reads the two facts the publish gate reads *before*
 * it touches the network — is there a snapshot, does it carry a stable author id — and
 * reports them. Everything else is reported as `not_rechecked`, which is the literal
 * truth: this page has not re-read the platform, and no boolean stored here could make
 * it have done so.
 */
export declare function describeTargetIdentity(candidate: Pick<StoredCandidate, 'targetSnapshot'> | undefined, contentApproved: boolean): TargetIdentityView;
/**
 * Whether an approval still authorizes the candidate **as it is now**.
 *
 * ## Scope, stated once
 *
 * This function answers exactly one question: **do the bytes still match what the owner
 * approved?** It compares the candidate id, version, text hash and target post id. It
 * deliberately does **not** compare the author of the target, and adding that here would
 * be the wrong fix:
 *
 * - the approval record does not carry an author, so there is nothing to compare against
 *   without inventing a field;
 * - `snapshotStillValid` already does that comparison, against a *fresh platform read*,
 *   inside `publishCandidate`. A second comparison would be a second decider, and the two
 *   could disagree — which is how a UI ends up saying "approved" while the gate refuses.
 *
 * What the workbench needs instead is the honest statement that approval covers content
 * only; see {@link describeTargetIdentity} and `WorkbenchState.approval`.
 *
 * `undefined` approval means "nothing to compare", which is a refusal, not a pass.
 */
export declare function approvalStillApplies(input: {
    readonly candidate: Pick<StoredCandidate, 'replyId' | 'textHash' | 'candidateVersion' | 'targetPostId' | 'approved'>;
    readonly approval?: {
        readonly candidateId: string;
        readonly candidateVersion?: number;
        readonly textHash?: string;
        readonly targetPostId?: string;
    };
}): {
    applies: boolean;
    reason: string;
};
/**
 * The sanitized diagnostic payload (§八).
 *
 * Redaction is by **allow-list of field names**, not by pattern: a pattern that hunts for
 * `cookie=` will miss the header next week. Nothing that is not named below leaves this function,
 * so a new sensitive field cannot leak by being forgotten.
 */
export declare function workbenchDiagnostics(input: {
    readonly platform: string;
    readonly threadId?: string;
    readonly step: WorkbenchStep;
    readonly outcome: PublishOutcomeView;
    readonly counts: {
        floors: number;
        nested: number;
        candidates: number;
    };
    readonly faults?: readonly {
        kind: string;
        label: string;
        reason: string;
        nextStep: string;
    }[];
    readonly gaps?: readonly MissingEvidence[];
    readonly capability?: {
        declared: string;
        effective: string;
        reason: string;
    };
}): Record<string, unknown>;
//# sourceMappingURL=workbench.d.ts.map