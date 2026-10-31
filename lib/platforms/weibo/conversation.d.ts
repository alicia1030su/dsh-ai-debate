/**
 * Project Weibo's own shapes onto the conversation graph.
 *
 * ## Why this module exists separately from any API client
 *
 * Weibo's structure is *not* a forum thread. A post has comments, a comment has
 * replies, and a **repost is not a reply** — it is a new timeline entry that points
 * at the original. Folding a repost into the reply tree is how an argument gets
 * reconstructed backwards: the reposter's words become an answer to the original
 * author, when in fact they are a broadcast to a different audience.
 *
 * This file maps that structure to `ConversationGraph` with no network access, so it
 * is testable against fixtures today and usable by an adapter later. The API client
 * itself is deliberately absent: Weibo requires a registered application, developer
 * qualification and a scope grant, none of which this build can assume, and writing
 * plausible endpoint calls would be exactly the "pretend it works" failure the
 * capability matrix exists to prevent.
 *
 * ## What is stated, what is inferred, what is refused
 *
 * - `contains`: stated. Weibo tells you a comment belongs to a post.
 * - `replies_to`: stated when the reply carries a `replyToId`, otherwise **inferred
 *   from the display name** and marked as such — a name can be changed, and the
 *   graph must not later treat a guess as a fact.
 * - `reposts`: stated. The repost carries the original's id.
 * - `quotes`: stated when the payload carries a quoted id.
 * - `displayIndex`: never populated. Weibo has no floor numbers, and inventing them
 *   is what made a Weibo post described as "第 undefined 楼".
 */
import type { ConversationGraph } from '../../conversation.js';
/** A Weibo user, as the payload describes them. */
export interface WeiboUser {
    /** Numeric uid. Absent for deleted or privacy-restricted accounts. */
    readonly uid?: string;
    readonly screenName: string;
}
/** One Weibo post: a status update, a repost, or a comment. */
export interface WeiboPost {
    /** Numeric mid. */
    readonly mid: string;
    readonly user: WeiboUser;
    readonly text: string;
    readonly createdAt?: string;
    readonly images?: readonly string[];
    /** Present on a repost: the original it forwards. */
    readonly retweeted?: WeiboPost;
    /** Present when the text quoted another post. */
    readonly quotedMid?: string;
    /** How many comments the API reported. */
    readonly commentsCount?: number;
}
/** One comment under a post. */
export interface WeiboComment {
    readonly id: string;
    readonly user: WeiboUser;
    readonly text: string;
    readonly createdAt?: string;
    readonly images?: readonly string[];
    /** The comment this one answers, when Weibo says so. */
    readonly replyToCommentId?: string;
    /**
     * The *display name* this comment answers, when Weibo gives no id.
     *
     * Kept apart from `replyToCommentId` precisely because it is weaker: an edge built
     * from this is `inferred`, and the analysis must be able to tell.
     */
    readonly replyToScreenName?: string;
    readonly repliesCount?: number;
}
/** Everything one read produced. */
export interface WeiboThreadPayload {
    readonly post: WeiboPost;
    readonly comments: readonly WeiboComment[];
    /**
     * Whether the caller believes the comment list is complete.
     *
     * Set by whoever did the reading. This module never infers completeness from a
     * short list — an empty page and a truncated page look identical.
     */
    readonly sourceComplete: boolean;
    readonly stopReason: string;
    readonly missingComments?: number;
    readonly issues?: readonly string[];
}
/**
 * Build the graph for one Weibo post.
 *
 * Node ids are namespaced by `threadId` inside the node (the graph's identity is
 * `(threadId, id)`), so a comment id that happens to collide with the post's mid in
 * a different thread cannot alias.
 */
export declare function projectWeiboThread(payload: WeiboThreadPayload): ConversationGraph;
/**
 * Author ids the graph says participated, strongest first.
 *
 * Exposed because the analyzer needs "who is here" and the graph is the only place
 * that knows after projection. Name-only authors are returned separately so a caller
 * can decide to refuse rather than match on a nickname.
 */
export declare function weiboParticipants(graph: ConversationGraph): {
    readonly stable: readonly string[];
    readonly nameOnly: readonly string[];
};
//# sourceMappingURL=conversation.d.ts.map