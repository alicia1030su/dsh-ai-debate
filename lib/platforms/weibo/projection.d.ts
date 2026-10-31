/**
 * Turn the official CLI's payloads into `Thread` / `Floor` / `NestedReply`.
 *
 * ## Why this is a separate module from the invocation layer
 *
 * `cli.ts` knows how to run a command and validate its argument shape. It deliberately
 * knows **nothing** about what a Weibo status body looks like. Keeping the projection
 * apart means:
 *
 * - it is testable against captured shapes without a CLI at all;
 * - a change in Weibo's field names touches one file;
 * - the mapping decisions (what is `stated` vs `inferred`, what counts as complete) are
 *   visible in one place instead of scattered through request code.
 *
 * ## The core rule
 *
 * A field that was not present stays absent. This module never invents a floor number, a
 * title, an author id, or an image list. Where the platform genuinely has no such concept
 * (Weibo has no 楼层), the field is omitted rather than filled with a placeholder — that
 * is exactly the mistake v0.2.1 had to undo.
 */
import type { Floor, NestedReply, Thread } from '../../types.js';
/** The numeric id the CLI uses for a status. */
export interface WeiboStatusPayload {
    readonly id?: unknown;
    readonly idstr?: unknown;
    readonly mid?: unknown;
    readonly text?: unknown;
    readonly created_at?: unknown;
    readonly user?: unknown;
    readonly pic_urls?: unknown;
    readonly pic_ids?: unknown;
    readonly comments_count?: unknown;
    readonly reposts_count?: unknown;
    readonly retweeted_status?: unknown;
    readonly long_text?: unknown;
    readonly is_long_text?: unknown;
}
/** The numeric id the CLI uses for a comment. */
export interface WeiboCommentPayload {
    readonly id?: unknown;
    readonly idstr?: unknown;
    readonly text?: unknown;
    readonly created_at?: unknown;
    readonly user?: unknown;
    readonly reply_comment?: unknown;
    readonly reply_comment_total?: unknown;
    readonly like_counts?: unknown;
}
/**
 * The status id, preferring the string form.
 *
 * `idstr` is a string and `id` may be a number that has already lost precision by the time
 * it reaches JavaScript. Preferring the string is what keeps a 16-digit mid exact.
 */
export declare function statusIdOf(payload: WeiboStatusPayload): string | undefined;
/** The author, split into the two shapes the core expects. */
export declare function authorOf(user: unknown): {
    readonly id?: string;
    readonly name?: string;
};
/**
 * Image URLs, only when the payload actually carried them.
 *
 * Weibo returns either `pic_urls: [{thumbnail_pic}]` or `pic_ids: [string]`. A bare
 * `pic_ids` entry is not a URL, so it is only used to build the documented large-image
 * URL when it looks like an id; anything else is dropped rather than guessed.
 */
export declare function imagesOf(payload: WeiboStatusPayload | WeiboCommentPayload): string[];
/** Whether the payload carries a long-text body we should prefer over the truncated one. */
export declare function longTextOf(payload: WeiboStatusPayload): string | undefined;
/**
 * Project one status into a `Thread`.
 *
 * The forum is `undefined`-shaped because a microblog has no 吧; `ForumRef` allows a
 * missing `id`, and inventing a forum name would be a claim about the platform.
 */
export declare function projectThread(payload: WeiboStatusPayload, threadId: string, url: string): Thread;
/**
 * Project one comment into a `Floor`.
 *
 * A comment is a first-level "floor" in the core's model even though Weibo does not number
 * it. `floorNumber` is therefore absent — the core addresses by `postId`.
 */
export declare function projectCommentAsFloor(payload: WeiboCommentPayload): Floor | undefined;
/**
 * Project one comment as a nested reply under a floor.
 *
 * Used for `reply_comment` (the comment this one answers) and for comment-level replies
 * when a read returns them nested rather than as top-level comments.
 */
export declare function projectCommentAsNested(payload: WeiboCommentPayload, parentPostId: string): NestedReply | undefined;
/**
 * Pull the status payload out of whatever envelope the CLI wraps it in.
 *
 * ## Validity now means "id *and* body" (v0.2.12 audit)
 *
 * v0.2.11 accepted anything carrying an id. `{"idstr": "5012345678901234"}` therefore projected
 * into a `Thread` with an empty body and no author, and the failure only surfaced much later
 * in `analyzeDispute` as "the owner never spoke here" — a message that points at the wrong
 * problem. Requiring a body moves the failure to the place that can name it: the adapter
 * reports `malformed_response`.
 *
 * The author is still optional: a deleted or privacy-restricted account legitimately has none,
 * and the core already treats a nameless author as `name_only`.
 */
export declare function unwrapStatus(raw: unknown): WeiboStatusPayload | undefined;
/**
 * Pull a comment list out of whatever envelope the CLI wraps it in, plus its paging state.
 *
 * ## Three fixes from the v0.2.12 audit
 *
 * 1. **`{"data": [...]}`** — `typeof [] === 'object'`, so the old container selection picked
 *    the array itself, then every `Array.isArray(container.comments)` missed and the list came
 *    back empty. A perfectly sensible response was read as "zero comments", and the collector
 *    reported "the thread may have been deleted" — a diagnosis pointing at the wrong problem.
 *
 * 2. **Unknown paging state** — the old fallback was `cursor !== undefined`, which is `false`
 *    when neither field is present. The comment above it promised the opposite. That made a
 *    one-page read look like "the platform confirmed the end", so pages 2..N were never
 *    requested and the read claimed to be complete.
 *
 * 3. **`total_number` is not a completeness proof** — the manual says it does not equal the
 *    number of distinct comments after de-duplication. It is returned for comparison only.
 */
export declare function unwrapComments(raw: unknown): {
    readonly comments: readonly WeiboCommentPayload[];
    readonly declaredTotal?: number;
    readonly nextCursor?: string;
    readonly hasMore: boolean;
    /**
     * `more` / `done` / `unknown`.
     *
     * `unknown` is the state the old code silently collapsed into `done`. Callers that must not
     * claim completeness can branch on it; `hasMore` stays a boolean for the existing contract,
     * and is `true` for `unknown` so a read never stops early on a guess.
     */
    readonly pagingState: 'more' | 'done' | 'unknown';
};
//# sourceMappingURL=projection.d.ts.map