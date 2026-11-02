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
    /** True when the caller holds a verified human approval for this candidate. */
    readonly humanApproved: boolean;
    /**
     * The candidate's security verdict.
     *
     * Added in v0.2.5 because its absence was the v0.2.4 defect: without it the policy
     * could not tell a `review` candidate from an `allow` one, so `limited_auto`
     * granted automatic slots to candidates that were supposed to wait for a human.
     *
     * `optional` only so an existing caller keeps compiling; the publisher always
     * passes it, and `undefined` is treated as the strictest reading (see below).
     */
    readonly securityDecision?: 'allow' | 'review' | 'block';
    /**
     * Whether the debate analysis itself is settled (v0.2.14 §6.4).
     *
     * ## Why this is separate from `securityDecision`
     *
     * `securityDecision` answers "is this text safe to send" — prompt injection, owner identity,
     * credential leaks. It says nothing about whether we *understood the argument*. A candidate can
     * be perfectly safe and still be a reply to a disagreement that does not exist (the v0.2.13
     * `A方案 / B方案` false contradiction), or to a target we could not identify (the `这个方案`
     * case).
     *
     * Those are different failures and need different handling:
     *
     * | situation | what the owner should get |
     * | --- | --- |
     * | unsafe text | refusal, no candidate |
     * | safe text about an unresolved dispute | a candidate to review, never an automatic post |
     *
     * So this field does not block the publish outright — it **removes the automatic slots**. In
     * `manual` mode the owner still approves by hand, which is the point: they are the one who can
     * tell whether the argument is real.
     *
     * `undefined` is read as unsettled: a caller that did not compute the semantic verdict has not
     * shown the dispute is understood, and defaulting the other way would turn a missing argument
     * into a permission. Same reasoning as `securityDecision` above.
     */
    readonly semanticSettled?: boolean;
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
 * ## 互动模式只做减法（v0.2.21 §二）
 *
 * v0.2.20 及以前，`single_shot` 与 `limited_auto` 都能在**没有人工批准**的情况下把一条
 * `allow` 候选发出去 —— `single_shot` 把一次授权当成授权本身，`limited_auto` 则消耗自动额度。
 * 那和 `AGENTS.md`「人工发帖确认不能关」是矛盾的：文档说不能关，代码里有一个模式可以关。
 *
 * 这一版把关系定死：**模式只决定「除了人工批准之外还要不要额外的限制」，不再决定「要不要
 * 人工批准」。** 于是：
 *
 * | 模式 | 人工批准 | 额外限制 |
 * | --- | --- | --- |
 * | `manual` | 必须 | 无 |
 * | `single_shot` | 必须 | 无（一次性授权只影响候选生成，不替代批准） |
 * | `limited_auto` | 必须 | 本会话条数上限 + 冷却时间（**实验能力**） |
 *
 * `limited_auto` 因此不再有「绕过」的含义，只剩下「更严格」的含义。它被标成实验能力：
 * 保留它是因为限制本身有价值，而不是因为它能少点一次确认。
 */
export declare const STRICT_APPROVAL_NOTE = "\u4EFB\u4F55\u6A21\u5F0F\u4E0B\u7684\u771F\u5B9E\u53D1\u8868\u90FD\u5FC5\u987B\u6709\u8BE5\u5019\u9009\u7684\u4EBA\u5DE5\u6279\u51C6\u8BB0\u5F55\uFF1B\u6A21\u5F0F\u53EA\u80FD\u589E\u52A0\u9650\u5236\uFF0C\u4E0D\u80FD\u51CF\u5C11";
/**
 * Decide whether a publish may proceed.
 *
 * ## The policy matrix (v0.2.21)
 *
 * | verdict | mode | approval | outcome |
 * | --- | --- | --- | --- |
 * | `block` | any | any | refuse — enforced earlier, before this function |
 * | `review` | any | none | refuse — no automatic slot for a flagged candidate |
 * | `review` | any | valid | continue to the rest of the checks |
 * | `allow` | `manual` | required | refuse without it |
 * | `allow` | `single_shot` | **required** | refuse without it |
 * | `allow` | `limited_auto` | **required** | refuse without it; with it, still needs budget and cooldown |
 *
 * The `review` row is the one v0.2.5 added. It is checked here *and* in the
 * publisher: here so every caller gets the same answer, there so a caller that
 * bypassed this function still cannot send.
 *
 * The `single_shot` / `limited_auto` rows are what v0.2.21 changed: they used to say
 * "approval optional", and that is how a flagged-but-safe candidate could be posted
 * without anyone looking at it. Now every row requires approval, and the modes only
 * add restrictions on top.
 *
 * `securityDecision` being `undefined` is read as `review`, not as `allow`: a caller
 * that forgot to pass the verdict has not proven the candidate is clean, and
 * defaulting the other way would turn a missing argument into a permission.
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