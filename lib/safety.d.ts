/**
 * The session state machine and its guard rails.
 *
 * A task moves through a fixed lifecycle. Transitions are validated rather than
 * assigned, because the expensive failures here are not typos — they are a
 * *retry after an ambiguous publish* and a *second publish for one trigger*.
 * Both are prevented structurally: the machine refuses the transition, and the
 * publisher consults the store instead of trusting its own memory.
 */
import type { TaskState } from './store.js';
/** True when a transition is legal. */
export declare function canTransition(from: TaskState, to: TaskState): boolean;
/** Apply a transition, throwing when it is illegal. */
export declare function assertTransition(from: TaskState, to: TaskState): void;
/**
 * A refused transition, reported instead of thrown.
 *
 * Callers in the pipeline want to stop and tell the user *what* was refused, not
 * crash; they use {@link transition} and surface `reason`. Callers that are
 * asserting an invariant use `assertTransition`.
 */
export interface TransitionResult {
    readonly ok: boolean;
    readonly state: TaskState;
    readonly reason?: string;
}
/**
 * Compute the next state, refusing an illegal move.
 *
 * This exists because every module used to assign `state:` directly, which made
 * `assertTransition` dead code: the machine documented what it forbade while
 * nothing consulted it. Routing transitions through here makes the rules real —
 * a `PUBLISHED` session cannot go back to `PUBLISHING`, and `CANCELLED` cannot be
 * resurrected, no matter which module is asking.
 *
 * @param from current state
 * @param to desired state
 * @returns the new state, or the unchanged state plus a reason
 */
export declare function transition(from: TaskState, to: TaskState): TransitionResult;
/** States that must never publish, whatever else is true. */
export declare function isPublishable(state: TaskState): boolean;
/** True when the task can still make automatic progress. */
export declare function isActive(state: TaskState): boolean;
/** A policy limiting how much the plugin may do on its own. */
export interface InteractionPolicy {
    /** `manual` never publishes without an explicit approval call. */
    readonly mode: 'manual' | 'single_shot' | 'limited_auto';
    /** Maximum automatic publishes per session. */
    readonly maxAutoPublishesPerSession: number;
    /** Minimum gap between two automatic publishes, in milliseconds. */
    readonly cooldownMs: number;
    /** Maximum publishes per thread across all sessions. */
    readonly maxPublishesPerThread: number;
    /** Stop everything when the platform reports a challenge. */
    readonly stopOnChallenge: boolean;
}
/** Conservative defaults: nothing is sent without a human click. */
export declare const DEFAULT_POLICY: InteractionPolicy;
/** The observed state a policy decision is made against. */
export interface PublishAttempt {
    readonly sessionId: string;
    readonly threadId: string;
    /** Publishes already confirmed in this session. */
    readonly sessionPublishes: number;
    /** Publishes already confirmed in this thread. */
    readonly threadPublishes: number;
    /** Epoch ms of the last publish anywhere, when known. */
    readonly lastPublishAt?: number;
    /** True when the caller is a human approving a specific candidate. */
    readonly humanApproved: boolean;
    readonly now: number;
}
/** The outcome of a policy check. */
export type PolicyDecision = {
    readonly allowed: true;
    readonly reasons: readonly string[];
} | {
    readonly allowed: false;
    readonly code: string;
    readonly reason: string;
};
/**
 * Decide whether a publish may proceed.
 *
 * The `humanApproved` flag is what separates the modes: in `manual` mode it is
 * the only thing that can authorise a send, so a bug that loses the approval
 * fails closed instead of posting.
 */
export declare function checkPublishPolicy(policy: InteractionPolicy, attempt: PublishAttempt): PolicyDecision;
/** Which platform failures must stop everything until a human intervenes. */
export declare function mustPauseOn(error: unknown): {
    pause: boolean;
    reason?: string;
};
/** Reject content that is empty after trimming. */
export declare function assertPublishableText(text: string, maxLength: number): void;
/**
 * Detect prompt-injection attempts inside user content.
 *
 * This never blocks anything by itself: the point is to *report* that a post
 * contains instruction-like text, so the pipeline treats it as data. The real
 * defence is architectural — user content is only ever interpolated into the
 * user message, never into the system prompt, and the schema has no field that
 * could carry an instruction.
 */
export declare function detectInjection(text: string): readonly string[];
//# sourceMappingURL=safety.d.ts.map