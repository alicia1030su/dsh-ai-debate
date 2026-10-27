/**
 * Target resolution: decide *where* a reply lands, from data re-read from the
 * platform, and refuse to send when that cannot be established.
 *
 * Why this is its own module rather than a few lines in the publisher: the bug
 * this prevents is subtle. The publisher used to build a target containing only
 * `floorPostId` and `replyToUserId`, while the adapter only enters its
 * floor-reply branch when `nestedReplyId` is present. For a reply aimed at a
 * nested post, the floor id was therefore the *floor's* id and the nested id was
 * missing — a well-formed request that lands in the wrong place, with no error
 * anywhere to notice it.
 *
 * The rule here is: the target is derived from a fresh `getReplyContext` read,
 * never assembled from ids that came out of the model.
 */
import { type PublishTarget, type ReplyContext, type TargetSnapshot } from './types.js';
/** The slice of a platform adapter this module needs. */
export interface TargetResolver {
    getReplyContext(ref: {
        platform: 'tieba';
        threadId: string;
        url?: string;
    }, postId: string, signal?: AbortSignal, 
    /**
     * `forceFresh` asks the adapter to bypass any structural cache.
     *
     * Publishing always sets it: a cached body returned as if it were current would
     * defeat the whole snapshot comparison.
     */
    options?: {
        forceFresh?: boolean;
    }): Promise<ReplyContext>;
}
/** Why a target could not be confirmed. */
export type TargetProblem = 'not_found' | 'wrong_thread' | 'wrong_floor' | 'author_mismatch' | 'author_unverifiable' | 'kind_mismatch' | 'nested_mismatch' | 'context_changed' | 'no_snapshot' | 'version_mismatch';
/** Result of resolving a target. */
export type TargetResolution = {
    readonly ok: true;
    readonly snapshot: TargetSnapshot;
    readonly target: PublishTarget;
} | {
    readonly ok: false;
    readonly problem: TargetProblem;
    readonly message: string;
};
/** What the caller believes the target is, from the analysis stage. */
export interface TargetExpectation {
    readonly threadId: string;
    /** The floor the whole dispute lives under. */
    readonly floorPostId: string;
    /** The exact post being answered. */
    readonly targetPostId: string;
    readonly targetKind: 'floor' | 'nested';
    readonly targetAuthorId?: string;
    readonly targetAuthorName?: string;
}
/** Hash of a post body, to notice an edit between review and send. */
export declare function contentHash(text: string): string;
/**
 * Re-read one post and describe where a reply to it must go.
 *
 * Every check below fails closed. A rejected target is always cheaper than a
 * reply attached to the wrong person, which the owner cannot take back.
 *
 * @param resolver the platform adapter
 * @param expected what the analysis said the target is
 * @param options.signal cancellation
 * @param options.forceFresh bypass the adapter's structure cache (publishing does)
 * @returns either a verified snapshot plus the wire-level target, or the reason
 */
export declare function resolveTarget(resolver: TargetResolver, expected: TargetExpectation, options?: {
    signal?: AbortSignal;
    now?: () => number;
    forceFresh?: boolean;
}): Promise<TargetResolution>;
/**
 * Turn a verified snapshot into the request the adapter sends.
 *
 * For a nested target both ids are required: `reply_id` is the floor and
 * `comment_id` is the nested post. Sending the floor id alone is what silently
 * turned an in-floor reply into a new floor.
 */
export declare function targetFromSnapshot(snapshot: TargetSnapshot): PublishTarget;
/**
 * Decide whether a snapshot taken before review still describes reality.
 *
 * Called immediately before sending. A snapshot that no longer matches means the
 * reviewed text and the current target describe different situations, so the
 * reply must go back for review rather than be sent at whatever is there now.
 */
export declare function snapshotStillValid(before: TargetSnapshot, after: TargetSnapshot): TargetProblem | undefined;
/**
 * Whether the snapshot identifies the author by a stable id.
 *
 * A snapshot carrying only a display name cannot prove *who* wrote the post, and the
 * publish path requires proof, so this is what the publisher consults to decide
 * whether automatic publishing is allowed at all.
 */
export declare function hasStableAuthor(snapshot: TargetSnapshot): boolean;
/** Human-readable explanation for each problem. */
export declare function describeTargetProblem(problem: TargetProblem): string;
//# sourceMappingURL=target.d.ts.map