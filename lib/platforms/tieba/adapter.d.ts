/**
 * The Tieba adapter: the only module that knows Tieba exists.
 *
 * Reading goes through three surfaces, each used for what it actually provides:
 *
 * | Surface          | Provides                              | Verified |
 * | ---------------- | ------------------------------------- | -------- |
 * | `/mo/q/m?kz=&pn=`| floors, body, author name, date, images | yes      |
 * | `/p/totalComment`| numeric user ids, nested reply counts   | yes      |
 * | `/p/comment`     | full nested replies with reply targets  | yes      |
 *
 * Publishing goes through `/f/commit/post/add`, which answers structured JSON.
 * It is implemented and its unauthenticated response is verified, but the
 * authenticated happy path **has not been tested against a real logged-in
 * account** in this environment; `checkAuthentication` therefore reports the
 * truth rather than assuming a session, and the publish path refuses to run
 * without one.
 */
import { type AuthState, type Floor, type Mention, type NestedPage, type NestedReply, type PlatformAdapter, type PlatformCapabilities, type PublishOutcome, type PublishTarget, type ReplyContext, type ReplyPage, type Thread, type ThreadRef, type UserProfile } from '../../types.js';
import { type ParsedFloor } from './parse.js';
/** Options for the adapter; every one has a working default. */
export interface TiebaAdapterOptions {
    /** Cookie header value copied from a logged-in browser, if the user has one. */
    readonly cookie?: string;
    /** Milliseconds before one HTTP attempt is abandoned. */
    readonly timeoutMs?: number;
    /** Extra attempts for transport failures. */
    readonly retries?: number;
    /** Milliseconds to pace pagination, to stay polite. */
    readonly pageDelayMs?: number;
    /** Hard cap on pages walked for one thread; guards runaway loops. */
    readonly maxPages?: number;
    /**
     * How long to stay off the `/p/*` nested channels after a block, in ms.
     *
     * They are path-scoped rate limited independently of the rest of the site, so
     * a cool-off plus the inlined fallback keeps a run productive without
     * deepening the block. Defaults to ten minutes.
     */
    readonly nestedCooldownMs?: number;
    /**
     * How long the thread-structure cache stays valid, in ms.
     *
     * It records only *where* posts are, never their text, and every publish still
     * re-reads its target. Kept short (five minutes by default) so a moved post is
     * re-derived quickly rather than served from a stale map.
     */
    readonly structureCacheMs?: number;
    /**
     * A thread to read the login banner from when the real target is not available.
     *
     * Optional, and **not** how login is normally checked: `checkAuthentication` prefers
     * the thread being published into, because the banner is rendered on any post page
     * the cookie can see. This exists only as a fallback for a caller that has no thread
     * at hand, and for tests.
     */
    readonly authProbeThreadId?: string;
    /**
     * Further threads to try if the primary probe is unreadable.
     *
     * A deleted or rate-limited probe thread must not be able to report a healthy login
     * as broken, which is what a single hard-coded id did.
     */
    readonly authProbeFallbacks?: readonly string[];
    /** Optional logger; receives already-redacted messages. */
    readonly log?: (message: string) => void;
}
/**
 * The Tieba platform adapter.
 *
 * Capabilities are declared honestly: mentions are unavailable because no
 * verified public endpoint exists for them without a logged-in session, and
 * that is reported as `false` rather than faked.
 */
export declare class TiebaAdapter implements PlatformAdapter {
    readonly id: "tieba";
    readonly displayName = "\u767E\u5EA6\u8D34\u5427";
    private readonly http;
    private readonly options;
    /** Optional fallback probe thread for the login banner; never required. */
    private readonly authProbeThreadId?;
    /** Additional probe threads, tried when the primary is unreadable. */
    private readonly authProbeFallbacks;
    /** Forum metadata cached per thread, so paging does not re-read it. */
    private readonly threadCache;
    /**
     * Short-lived map of thread *structure*, to make reply lookups cheaper.
     *
     * Only where things are is cached — which floor holds which post id — never the
     * text. Every lookup still re-reads the target before acting on it, so a cache hit
     * saves requests without letting stale content drive a decision.
     */
    private readonly structureCache;
    /**
     * Wall-clock ms after which the `/p/*` nested channels may be tried again.
     *
     * Measured on a live thread: `/p/comment` and `/p/totalComment` start
     * answering every request with Baidu's security-verification interstitial
     * (HTTP 403, 2488 bytes) while `/mo/q/*` and `/f` keep returning 200 and a
     * cooldown does not clear it. It is path-scoped rate control, not a cookie
     * problem, so hammering the endpoint only deepens the block. Once a 403 is
     * seen the channel is skipped until this time passes, and floors fall back to
     * the replies the WAP page inlines.
     */
    private nestedChannelBlockedUntil;
    /** Why the nested channel was closed, for the health report. */
    private nestedChannelReason;
    constructor(options?: TiebaAdapterOptions);
    /** Install a cookie header supplied by the user. */
    private seedCookie;
    /** Report which cookie names are held, never their values. */
    describeCookieNames(): readonly string[];
    /**
     * Parse one of this platform's URLs into a thread reference.
     *
     * Part of the adapter contract since v0.2.1. Without it, a Runtime assembled
     * without a registry had no way to turn a pasted link into a thread id and fell
     * back to treating the whole URL as the id — which reached the platform as
     * `kz=https://tieba.baidu.com/p/123`.
     */
    parseUrl(url: string): ThreadRef;
    /** What this adapter can actually do right now. */
    getCapabilities(): PlatformCapabilities;
    /**
     * Bootstrap the cookie jar.
     *
     * Tieba answers a cold request with a security-challenge page instead of the
     * thread; visiting the Baidu homepage first yields the `BAIDUID` family that
     * makes the following request succeed. This is the platform's own session
     * bootstrap, not a bypass of any check.
     */
    private bootstrap;
    /** Fetch one WAP thread page. */
    private fetchWapPage;
    /** Check the login state from the page's own editor config. */
    /**
     * Report the login state, and — separately — whether the account behind it is
     * *identified*.
     *
     * v0.1.4 read a hard-coded thread (`6826726803`) to find the login banner. That made
     * a fixed post load-bearing for two unrelated questions: if that thread was deleted,
     * made private, or hit a rate limit, a perfectly healthy login looked broken; and if
     * tieba changed the page shape there, every publish refused with a misleading
     * "not logged in".
     *
     * The banner is not thread-specific. It is rendered on any WAP post page the cookie
     * can see, so this reads the thread it is actually about to publish into, and falls
     * back to the configured probe thread only if that one is unreadable. Nothing is
     * hard-coded as a requirement.
     *
     * The two questions stay distinct, because they are not the same thing:
     *
     * - `authenticated` — a session exists. The page exposes `is_login=1`.
     * - `userId` — the page also named the account. Only this can be compared against
     *   the configured AI account.
     *
     * A page can report a login without naming it, and tieba does exactly that on some
     * responses. The publisher treats that as "identity unverified" and refuses, rather
     * than publishing as whoever the cookie happens to belong to.
     *
     * @param signal cancellation
     * @param probeThreadId a thread to read the banner from; when omitted the adapter's
     *   configured probe is used
     * @returns the login state, with `userId` present only when the platform stated it
     */
    checkAuthentication(signal?: AbortSignal, probeThreadId?: string): Promise<AuthState>;
    /** Read the thread body and its metadata. */
    getThread(ref: ThreadRef, signal?: AbortSignal): Promise<Thread>;
    /** Read one page of floors. */
    getReplies(ref: ThreadRef, page: number, signal?: AbortSignal): Promise<ReplyPage>;
    /**
     * Walk every page of a thread.
     *
     * Kept as a convenience for callers that want a one-shot read; the generic
     * `walkFloors` in `collector.ts` is what the pipeline uses, so a second
     * platform gets the same behaviour without reimplementing it.
     */
    getAllFloors(ref: ThreadRef, options?: {
        signal?: AbortSignal;
        maxPages?: number;
        onProgress?: (progress: {
            page: number;
            totalPages?: number;
            collected: number;
        }) => void;
    }): Promise<{
        floors: readonly Floor[];
        declaredTotal?: number;
        totalPages?: number;
        complete: boolean;
        missingCount?: number;
        error?: string;
    }>;
    /** Read nested replies under one floor, one page at a time. */
    getNestedReplies(ref: ThreadRef, floor: Floor, page: number, signal?: AbortSignal): Promise<NestedPage>;
    /** True while the paginated nested channels are still worth trying. */
    private nestedChannelOpen;
    /**
     * Close the nested channel after a block, and report whether that happened.
     *
     * Only a `forbidden`/`rate_limited` answer closes it: those are the platform
     * refusing this reader, and retrying makes it worse. A timeout or a 5xx is
     * transient and is left to the HTTP layer's retry budget.
     */
    private tripNestedChannel;
    /**
     * Fall back to the nested replies the WAP page already inlined.
     *
     * This surface carries no timestamps and its `data-list-count` cannot be
     * trusted, so the page declares its own honesty: `hasMore` is left true
     * whenever the floor claims more replies than were inlined, which makes the
     * collector report the floor as partially read instead of complete.
     */
    private readNestedInline;
    /** Explain the current nested-channel state, for the health report. */
    describeNestedChannel(): {
        open: boolean;
        reason?: string;
    };
    /**
     * Try the `totalComment` JSON channel first.
     *
     * It is cheap and it is the only surface that carries a **numeric user id**,
     * which the owner/opponent binding needs. It inlines at most nine replies per
     * floor, so a floor with more falls through to the HTML channel.
     */
    private readNestedFromTotalComment;
    /** Read nested replies from the paginated HTML channel. */
    private readNestedFromCommentPage;
    /** Return every nested reply under one floor, walking all pages. */
    getAllNested(ref: ThreadRef, floor: Floor, options?: {
        signal?: AbortSignal;
        maxPages?: number;
    }): Promise<{
        replies: readonly NestedReply[];
        complete: boolean;
        error?: string;
        degraded?: boolean;
    }>;
    /** Resolve the forum id for a thread, caching the lookup. */
    private resolveForumId;
    /** Read a public profile. */
    getUserProfile(userNameOrId: string, signal?: AbortSignal): Promise<UserProfile>;
    /** List @-mentions. Unavailable without a verified endpoint. */
    getMentions(_since: string | undefined, _signal?: AbortSignal): Promise<readonly Mention[]>;
    /**
     * Resolve a post id to its floor, ancestors and siblings.
     *
     * @param options.forceFresh re-read the target from the platform and ignore the
     *   structure cache for its *content*. Publishing always passes this: the cache
     *   exists to save locating work, never to stand in for a fresh read. A cached
     *   body used as if it were current is exactly how an edited post goes unnoticed.
     */
    getReplyContext(ref: ThreadRef, postId: string, signal?: AbortSignal, options?: {
        forceFresh?: boolean;
    }): Promise<ReplyContext>;
    /**
     * Narrow a nested-reply lookup before the full sweep.
     *
     * Two hints, cheapest first:
     * 1. a previously recorded parent for this exact post id;
     * 2. the floor whose *inline* copy (already fetched with the page) contains it.
     *
     * Both re-read the reply through the normal path, so a stale hint costs one wasted
     * request and never produces a wrong answer — accuracy is not traded for speed.
     */
    private locateByHint;
    /**
     * Record the floors seen for a thread, for the floor fast path.
     *
     * Only the post ids are kept, never the floor objects: a cached body is a body
     * that can be returned as if it were fresh, and that is the defect this cache
     * caused before. Location only, content always re-read.
     */
    private rememberFloors;
    /** Record which floor a nested reply belongs to. */
    private rememberNestedParent;
    /**
     * The structure cache for a thread, expired in place.
     *
     * Entries older than `structureCacheMs` are dropped rather than served: a parent
     * recorded minutes ago may no longer be where that reply lives, and acting on a
     * stale parent is the one mistake this module must not make.
     */
    private structureEntry;
    /**
     * Publish a reply.
     *
     * The write path is implemented against the endpoint's real contract, but it
     * deliberately refuses to run when the session is not authenticated, and it
     * reports `uncertain` rather than `confirmed` when the platform's answer
     * cannot be proven.
     */
    publishReply(ref: ThreadRef, target: PublishTarget, content: string, signal?: AbortSignal): Promise<PublishOutcome>;
}
/**
 * The `reason` used when a page carried no login marker at all.
 *
 * Named so callers can distinguish "this page said nothing" from "this page said you
 * are logged out" — the first is a reason to try another page, the second is an answer.
 */
export declare const NO_MARKER_REASON = "\u9875\u9762\u91CC\u6CA1\u6709\u627E\u5230\u767B\u5F55\u72B6\u6001\u6807\u8BB0";
/** Read the login state the WAP page reports in its editor config. */
export declare function readAuthFromHtml(html: string): AuthState;
/**
 * Interpret the `/f/commit/post/add` JSON answer.
 *
 * Tieba reports success with `no: 0`; anything else is a failure, and the
 * error text is surfaced verbatim so the user sees the platform's own wording.
 */
export declare function interpretPublishResponse(raw: string): PublishOutcome;
/**
 * Walk a nested thread backwards from a target reply.
 *
 * The platform only states who each reply answers, so the chain is rebuilt by
 * looking that name up among earlier replies. When the name is ambiguous — two
 * participants sharing a display name — the chain stops rather than guessing.
 */
export declare function buildAncestors(replies: readonly NestedReply[], target: NestedReply): readonly NestedReply[];
/** Cheap text preview for logs, with newlines collapsed. */
export declare function preview(text: string, limit?: number): string;
/** A parsed floor list paired with the floor map, for callers that need both. */
export type { ParsedFloor };
//# sourceMappingURL=adapter.d.ts.map