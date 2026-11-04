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
/**
 * The five states the workbench must let a reader tell apart.
 *
 * | state | what it means | can publish |
 * | --- | --- | --- |
 * | `verified` | evidence supports the owner's identity | yes |
 * | `unverified` | readable, but nothing proves who it is | no |
 * | `conflict` | two surfaces proved *different* accounts | no, must be resolved |
 * | `legacy_unknown` | a pre-v0.2.23 record; provenance was never recorded | no |
 * | `recheck_required` | identity is fine; the *target* is re-read at publish | proceed, with warning |
 *
 * The last one is not a defect. Target authorship is deliberately re-verified at
 * send time, so "this still needs a check" is the normal state of a ready page,
 * not a failure — and saying so is what keeps the other four believable.
 */
export type OwnerIdentityViewState = 'verified' | 'unverified' | 'conflict' | 'legacy_unknown' | 'recheck_required' | 'unknown';
export interface OwnerIdentityView {
    readonly state: OwnerIdentityViewState;
    /** One line a person can act on. Never "unknown error". */
    readonly detail: string;
    /** True when the publish button must not be offered. */
    readonly blocking: boolean;
    /** The evidence, in words, for the reader who wants to check. */
    readonly evidence?: string;
}
import type { StoredComment } from './store.js';
/** What the read actually achieved, versus what the platform claimed. */
export interface ReadQualityView {
    /** Floors the read produced. */
    readonly floorsRead: number;
    /** Floors the platform said the thread has, when it said so. */
    readonly floorsDeclared?: number;
    readonly nestedRead: number;
    /** Nested replies the floors declared, when they did. */
    readonly nestedDeclared?: number;
    /** True when the collector flagged the read as incomplete. */
    readonly truncated: boolean;
    /** Plain-language reasons, already deduplicated by the collector. */
    readonly reasons: readonly string[];
    /** Post ids whose observation list hit the retention cap. */
    readonly observationOverflow: readonly string[];
    /** Whether the owner's own identity still needs re-checking before publishing. */
    readonly ownerNeedsRecheck: boolean;
}
export interface WorkbenchState {
    readonly step: WorkbenchStep;
    readonly steps: readonly WorkbenchStepView[];
    /** Ordered reasons the *next* irreversible action cannot happen yet. */
    readonly blockers: readonly string[];
    /**
     * What is known about the *owner's* identity, and whether it is enough.
     *
     * v0.2.23 surfaced a bare "cannot publish" with no reason. A grey button that
     * says nothing teaches the reader to guess, and the guess is usually "the tool is
     * broken". This carries the five states the page must distinguish, all derived
     * from the session plus the evidence the gate itself uses — never inferred by the
     * client, which cannot see the session at all.
     */
    readonly ownerIdentity: OwnerIdentityView;
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
    /**
     * The session this view describes (v0.2.26).
     *
     * The client has always posted `wb.sessionId` back with 「用这条」,
     * 「生成候选」 and the publish button, and the view never carried it — so the button's
     * `disabled` test (`wb.sessionId === undefined`) was permanently true. The control
     * rendered as enabled, took the click, and did nothing. That is why the whole second
     * half of the workbench was unreachable in a browser while the server routes worked
     * fine when called directly.
     */
    readonly sessionId?: string;
    /**
     * The comments this session actually read, so the owner can pick the one to answer
     * (v0.2.24).
     *
     * Absent means the session predates this release and carries no list — which the
     * page must render as "this session has no comment list", never as "the thread had
     * no comments". The two are different facts and only one of them is true.
     */
    readonly comments?: readonly StoredComment[];
    /** True when the stored list was capped and does not cover the whole read. */
    readonly commentsCapped?: boolean;
    /**
     * Why the read stopped early, when it did.
     *
     * Carried so the page can say "the platform said 240 floors and we got 219" instead
     * of showing a number with no provenance. Every field here is a fact the collector
     * observed; nothing is computed to fill a gap.
     */
    readonly readQuality?: ReadQualityView;
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
    /** True when the stored comment list was capped. */
    readonly commentsCapped?: boolean;
    /** What the read achieved, versus what the platform claimed. */
    readonly readQuality?: ReadQualityView;
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
/**
 * Describe what is known about the owner's identity.
 *
 * ## Derived, not stored
 *
 * This reads the session's evidence and recomputes with the *same* function the
 * publish gate uses (`assuranceFromEvidence`). A page that invented its own idea of
 * "verified" would sooner or later disagree with the gate, and the disagreement
 * would show up as a button that lies.
 *
 * The order of checks matters: a conflict is reported before "unverified", because
 * "we proved these are different people" is more informative — and more alarming —
 * than "we could not prove anything".
 */
export declare function describeOwnerIdentity(session: StoredSession | undefined): OwnerIdentityView;
export declare function describeTargetIdentity(candidate: Pick<StoredCandidate, 'targetSnapshot'> | undefined, contentApproved: boolean): TargetIdentityView;
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