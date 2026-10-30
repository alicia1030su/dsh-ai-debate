/**
 * The single authority for "what argv do we send".
 *
 * ## The three defects this replaces (v0.2.14, all independently reproduced)
 *
 * ### 1. Pagination was invented from the wrong evidence
 *
 * `provider.ts` decided whether to send `--page` with:
 *
 *     if (commentCommand.flags?.includes('page') === true || resolved.countFlag !== undefined)
 *
 * The `|| countFlag !== undefined` is a non-sequitur: a command that declares `count` says
 * nothing about whether it accepts `page`. Reproduced both ways:
 *
 * | command declares | we sent | correct |
 * | --- | --- | --- |
 * | `id`, `count` | `--id … --page 2 --count 20` | no `--page` (undeclared → CLI hard-errors) |
 * | `id`, `page` | `--id …` | `--page 2` (declared, and we dropped it) |
 *
 * The second row is the worse one: we silently read page 1 again while the collector believed it
 * had page 2, so a truncated conversation could be reported as complete.
 *
 * ### 2. Two sources of truth drifted apart
 *
 * `commands list` carries a `flags` array, and `commands show` carries a richer one. The adapter
 * read *some* flags from the listing and *some* from the inspected schema, so a flag present in
 * one and absent in the other produced a request neither source would have allowed.
 *
 * ### 3. Nested-reply capability was inferred from the wrong thing
 *
 * `getCapabilities()` said `nestedReplies: resolved.comment !== undefined` — "we can list
 * comments, therefore we can list replies to one comment". Reproduced: with a comment command
 * that declares **no** parent-scoping flag, capabilities said `true` while `getNestedReplies()`
 * refused. The page advertised a capability the code knew it did not have.
 *
 * ## What this module is
 *
 * One `CommandInvocationPlan` per command, built **only** from the `commands show` schema that
 * `inspectCommand` verified. It answers two questions and nothing else:
 *
 * - "what argv do I send for this read?" — `argsFor()`
 * - "can I claim this capability?" — the plan's own `capabilities`
 *
 * Every parameter that is sent is in `parameters`; every parameter in `parameters` was in the
 * verified schema. There is no other path from a name to an argv token, so "we sent a flag the
 * command does not declare" becomes unrepresentable rather than merely forbidden.
 */
/** One parameter, as the verified schema described it. */
export interface PlanParameter {
    /** The name to send, exactly as the schema spells it (lowercased). */
    readonly name: string;
    /** The type the schema declared, when it declared one. */
    readonly type?: string;
    /** Whether the command requires it. */
    readonly required: boolean;
}
/**
 * Why a capability is or is not claimed.
 *
 * Every answer carries its evidence, because the platform page renders this: a badge without a
 * reason is indistinguishable from a guess.
 */
export interface CapabilityClaim {
    readonly available: boolean;
    /** `verified` = the schema supports it; `unavailable` = the schema says no; `unverified` = unknown. */
    readonly state: 'verified' | 'unavailable' | 'unverified';
    /** Plain-language reason, shown in the diagnostic panel. */
    readonly reason: string;
}
/** What a read needs from a command. */
export interface ReadIntent {
    /** The post id this read is about. */
    readonly threadId: string;
    /**
     * The parent comment id, for a nested read.
     *
     * Present means "this is a nested read" and the plan must send the parent flag; absent means
     * the plan must not.
     */
    readonly parentCommentId?: string;
    /** 1-based page number. Sent only when the plan knows how to page. */
    readonly page: number;
    /** Requested page size. Clamped and sent only when `count` is declared. */
    readonly pageSize?: number;
}
/** A resolved argv plus the record of what was omitted and why. */
export interface PlanInvocation {
    /** The flag/value pairs to append after `group action`. */
    readonly args: readonly string[];
    /**
     * True when the caller asked for a page this command cannot express.
     *
     * The caller must then treat the read as page 1 and report truncation, never claim it advanced.
     */
    readonly pagingUnsupported: boolean;
    /** Parameters the read wanted but the command does not declare, with the reason. */
    readonly omitted: readonly {
        readonly name: string;
        readonly reason: string;
    }[];
}
/** Everything one verified command can do. */
export interface CommandInvocationPlan {
    readonly group: string;
    readonly action: string;
    /** `group action`, for logs and diagnostics. */
    readonly name: string;
    readonly parameters: readonly PlanParameter[];
    /** Whether the schema was readable at all. An unreadable schema grants nothing. */
    readonly schemaVerified: boolean;
    /** How the id is passed, when the command declares an id-shaped flag. */
    readonly idFlag?: PlanParameter;
    /** How a page number is passed, when declared. */
    readonly pageFlag?: PlanParameter;
    /** How a page size is passed, when declared. */
    readonly countFlag?: PlanParameter;
    /** How a parent comment id is passed, when declared. */
    readonly parentFlag?: PlanParameter;
    readonly capabilities: {
        readonly readThread: CapabilityClaim;
        readonly readComments: CapabilityClaim;
        readonly readNested: CapabilityClaim;
    };
    /** Build the argv for one read. Throws nothing; reports what it could not do. */
    readonly argsFor: (intent: ReadIntent) => PlanInvocation;
}
/**
 * Flag names that plausibly carry a post id.
 *
 * Kept as data; the plan uses a declared name, never a guessed one. Order matters only for
 * resolving ambiguity when a command declares several, and the plural form comes first because
 * the official batch read uses `--ids`.
 */
export declare const ID_FLAG_NAMES: readonly string[];
/**
 * Flag names that plausibly carry a parent comment id.
 *
 * ## Why this list alone is not enough (v0.2.14 §四)
 *
 * A name match is *candidate evidence*, not proof: `cid` could equally mean a client id, and
 * `reply_to` could be a boolean. The task book is explicit that the meaning must be confirmed
 * before the capability is claimed, so `parentFlag` is reported as `unverified` unless the
 * command also declares something that makes the parent-scoping reading coherent — see
 * `nestedClaimOf`.
 */
export declare const PARENT_FLAG_NAMES: readonly string[];
/** Flag names that plausibly carry a page number. */
export declare const PAGE_FLAG_NAMES: readonly string[];
/** Flag names that plausibly carry a page size. */
export declare const COUNT_FLAG_NAMES: readonly string[];
/**
 * Page sizes above this are refused by the server with `COUNT_EXCEEDS_MAX`.
 *
 * Documented for the read commands that declare a cap; when a command does not, this still
 * bounds the request so a mistake cannot ask for the whole timeline.
 */
export declare const MAX_PAGE_SIZE = 20;
/** Build a plan from a verified schema. */
export declare function buildInvocationPlan(input: {
    readonly group: string;
    readonly action: string;
    readonly name: string;
    readonly schemaVerified: boolean;
    readonly parameters: readonly PlanParameter[];
    /** Whether this command reads a thread (vs. comments). Decides the capability labels. */
    readonly kind: 'thread' | 'comments';
}): CommandInvocationPlan;
//# sourceMappingURL=invocation-plan.d.ts.map