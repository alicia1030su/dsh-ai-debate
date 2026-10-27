/**
 * Shared, platform-neutral data model.
 *
 * Nothing in this module may know about Tieba: HTML selectors, WAP URLs and
 * forum-specific quirks belong to `src/platforms/tieba/`. Everything here is
 * the vocabulary the agent core (analysis, generation, sessions, publishing)
 * speaks, so a second platform can be added without touching it.
 */
/**
 * A platform identifier.
 *
 * A plain `string` since v0.2.0, not a closed union: the whole point of the
 * platform registry is that a new platform can be added without editing this
 * file. Concrete ids are still constants, declared next to their adapter, and the
 * registry refuses duplicates.
 */
export type PlatformId = string;
/**
 * Capability flags a platform may or may not support.
 *
 * @deprecated Superseded by `PlatformCapabilityMatrix` in
 *   `src/platforms/contracts.ts`, which carries a state, a reason and a
 *   verification date per capability instead of one boolean. Kept because
 *   `PlatformAdapter.getCapabilities` still returns it and the health report
 *   still shows it; the registry's richer matrix is derived from it.
 */
export interface PlatformCapabilities {
    /** Can read the thread body (title, content, author, time). */
    readonly thread: boolean;
    /** Can page through first-level floors. */
    readonly replies: boolean;
    /** Can read nested (楼中楼) replies under a floor. */
    readonly nestedReplies: boolean;
    /** Can resolve a public user profile. */
    readonly userProfile: boolean;
    /** Can list @-mentions for the bound account. */
    readonly mentions: boolean;
    /** Can publish a reply with the bound account. */
    readonly publish: boolean;
    /** Can verify login state without side effects. */
    readonly authCheck: boolean;
    /** Human-readable notes about why a capability is missing. */
    readonly notes?: Readonly<Record<string, string>>;
}
/** A forum (贴吧) identity. */
export interface ForumRef {
    readonly platform: PlatformId;
    /** Stable platform id of the forum, when known. */
    readonly id?: string;
    /** Display name. */
    readonly name: string;
}
/** The thread (主题帖) under discussion. */
export interface Thread {
    readonly platform: PlatformId;
    readonly forum: ForumRef;
    /** Thread id (贴吧的 kz/tid). */
    readonly id: string;
    readonly title: string;
    /** Plain-text body of the first post. */
    readonly content: string;
    /** Author's stable platform user id, when the platform exposes one. */
    readonly authorId?: string;
    readonly authorName?: string;
    readonly createdAt?: string;
    readonly url: string;
    /** Total floor count the platform declares, if it reports one. */
    readonly declaredReplyCount?: number;
    /** Image URLs found in the body; never described unless actually seen. */
    readonly images: readonly string[];
}
/** One first-level floor (楼层). */
export interface Floor {
    readonly platform: PlatformId;
    /** The floor number as displayed (1-based). Not the post id. */
    readonly floorNumber: number;
    /** Stable post id of this floor. */
    readonly postId: string;
    readonly authorId?: string;
    readonly authorName?: string;
    readonly content: string;
    readonly createdAt?: string;
    readonly images: readonly string[];
    /** Number of nested replies the platform claims exist for this floor. */
    readonly nestedCount?: number;
    /**
     * Nested replies the floor page inlined, when it inlined any.
     *
     * This is a degraded copy: the WAP page carries a subset. It exists so a
     * caller can still read the conversation when the paginated nested endpoint is
     * rate-limited, and must never be presented as the complete set.
     */
    readonly inlineNested?: readonly NestedReply[];
}
/** One nested reply (楼中楼). */
export interface NestedReply {
    readonly platform: PlatformId;
    readonly postId: string;
    /** The floor this reply hangs under. */
    readonly parentPostId: string;
    /** The nested reply being answered, when the platform states it. */
    readonly replyToPostId?: string;
    readonly authorId?: string;
    readonly authorName?: string;
    /** Display name of the user being answered, as the platform renders it. */
    readonly replyToName?: string;
    readonly content: string;
    readonly createdAt?: string;
    /** True when the platform did not state an explicit parent relation. */
    readonly relationUncertain?: boolean;
}
/** A public user profile, limited to what the platform exposes. */
export interface UserProfile {
    readonly platform: PlatformId;
    readonly userId?: string;
    readonly userName: string;
    readonly displayName?: string;
    readonly avatarUrl?: string;
}
/** One @-mention notification for the bound account. */
export interface Mention {
    readonly platform: PlatformId;
    /** Stable id of the notification event, for deduplication. */
    readonly eventId: string;
    readonly threadId: string;
    /** The post that contains the @. */
    readonly postId?: string;
    /** The floor this post belongs to. */
    readonly floorPostId?: string;
    readonly fromUserId?: string;
    readonly fromUserName?: string;
    readonly content: string;
    readonly createdAt?: string;
}
/** A page of first-level floors. */
export interface ReplyPage {
    readonly floors: readonly Floor[];
    /** 1-based page number that produced this page. */
    readonly page: number;
    /** True when the platform reported at least one more page. */
    readonly hasMore: boolean;
    /** Total pages the platform declared, when known. */
    readonly declaredTotalPages?: number;
    /**
     * Total floors the platform declares for the whole thread, when it says.
     *
     * This is what lets a reader notice that a thread with 240 declared floors
     * only yielded 219 of them: deleted floors leave permanent gaps, and a caller
     * must be able to report that instead of claiming a complete read.
     */
    readonly declaredTotal?: number;
}
/** A page of nested replies. */
export interface NestedPage {
    readonly replies: readonly NestedReply[];
    readonly page: number;
    readonly hasMore: boolean;
    readonly declaredTotalPages?: number;
    readonly declaredTotal?: number;
    /**
     * True when this page is known to be missing replies the platform declared.
     *
     * A degraded source (a floor page's inlined copy) sets this so the collector
     * reports the floor as partially read rather than silently complete.
     */
    readonly incomplete?: boolean;
}
/** Login/auth state of the bound account. */
export interface AuthState {
    readonly authenticated: boolean;
    /** Stable user id of the logged-in account, when known. */
    readonly userId?: string;
    readonly userName?: string;
    /** Why the check failed, in user-facing words. */
    readonly reason?: string;
    /** True when the platform demands a human challenge (captcha etc.). */
    readonly blocked?: boolean;
}
/** What `publishReply` actually observed. */
export interface PublishOutcome {
    /** `confirmed` only when the platform or a read-back proved the reply. */
    readonly status: 'confirmed' | 'uncertain' | 'failed';
    /** The new post id, when the platform returned or a read-back proved it. */
    readonly postId?: string;
    /** The floor number the new reply landed on, when read back. */
    readonly floorNumber?: number;
    /** Platform error text, only when `status` is `failed`. */
    readonly error?: string;
    /** Machine-readable error class for retry decisions. */
    readonly errorCode?: PlatformErrorCode;
}
/**
 * Which reply a publish should target.
 *
 * This is built by the platform layer from data it has re-read and verified —
 * never from an id the model produced. The distinction matters: a model writing
 * `response_target_id: "12345"` is a suggestion about *who to answer*, while
 * `floorPostId` / `nestedReplyId` decide *where the bytes land*. Letting the
 * model fill the second pair is how a reply ends up under the wrong post.
 */
export interface PublishTarget {
    readonly platform: PlatformId;
    readonly threadId: string;
    /** Floor post id the reply will be attached under. */
    readonly floorPostId?: string;
    /** Nested reply id being answered, when replying inside a floor. */
    readonly nestedReplyId?: string;
    /** The post being answered, floor or nested. */
    readonly targetPostId?: string;
    /** Author of the post being answered. */
    readonly targetAuthorId?: string;
    /** Whether the target is a first-level floor or a reply inside one. */
    readonly targetKind?: 'floor' | 'nested';
    /** User id being answered, so the platform can build the @ prefix. */
    readonly replyToUserId?: string;
}
/**
 * A verified snapshot of where a reply will go, captured when the candidate was
 * generated and re-checked immediately before sending.
 *
 * The generated text and the publish target must describe the same reality. If
 * the target moved, was deleted, or its author changed between review and send,
 * the snapshot no longer matches and the publish must stop for a fresh review.
 */
export interface TargetSnapshot {
    readonly platform: PlatformId;
    readonly threadId: string;
    readonly floorPostId: string;
    readonly floorNumber: number;
    /** Absent when the target is the floor itself. */
    readonly nestedReplyId?: string;
    readonly targetPostId: string;
    readonly targetKind: 'floor' | 'nested';
    readonly targetAuthorId?: string;
    readonly targetAuthorName?: string;
    /** Fingerprint of the target's text, to notice an edit. */
    readonly contentHash: string;
    readonly capturedAt: string;
}
/** A normalized platform error class, used by retry and pause logic. */
export type PlatformErrorCode = 'network' | 'timeout' | 'dns' | 'rate_limited' | 'forbidden' | 'captcha' | 'not_found' | 'auth_required' | 'permission_denied' | 'malformed_response' | 'unknown';
/** An error carrying a normalized platform code. */
export declare class PlatformError extends Error {
    readonly code: PlatformErrorCode;
    readonly status?: number;
    readonly retryAfterMs?: number;
    constructor(message: string, code: PlatformErrorCode, options?: {
        status?: number;
        retryAfterMs?: number;
        cause?: unknown;
    });
    /** True when retrying the same request could plausibly succeed. */
    get retryable(): boolean;
}
/** A parsed reference to one thread on a platform. */
export interface ThreadRef {
    readonly platform: PlatformId;
    readonly threadId: string;
    readonly forumName?: string;
    readonly url: string;
    /** The floor/nested reply the owner pointed at, when the URL named one. */
    readonly postId?: string;
}
/**
 * The contract every platform adapter implements.
 *
 * Implementations must never silently degrade: a capability they cannot honor
 * is reported `false` by {@link PlatformAdapter.getCapabilities}, and the
 * corresponding method throws a {@link PlatformError} with code
 * `permission_denied` instead of returning invented data.
 */
export interface PlatformAdapter {
    readonly id: PlatformId;
    readonly displayName: string;
    /**
     * Parse one of this platform's URLs into a thread reference.
     *
     * Optional, and only a fallback: when the plugin has a `PlatformRegistry` the
     * registry's provider does the parsing (it owns the URL syntax). This exists so
     * a bare adapter — a test double, or a deployment assembled without a registry —
     * can still turn a pasted link into a thread id instead of handing the raw URL
     * to `getThread` as if it were an id.
     */
    parseUrl?(url: string): ThreadRef;
    /** Declare what this platform actually supports right now. */
    getCapabilities(): PlatformCapabilities;
    /** Check the bound account's login state without side effects. */
    checkAuthentication(signal?: AbortSignal, probeThreadId?: string): Promise<AuthState>;
    /** Read the thread body. */
    getThread(ref: ThreadRef, signal?: AbortSignal): Promise<Thread>;
    /** Read one page of first-level floors. */
    getReplies(ref: ThreadRef, page: number, signal?: AbortSignal): Promise<ReplyPage>;
    /** Read one page of nested replies under a floor. */
    getNestedReplies(ref: ThreadRef, floor: Floor, page: number, signal?: AbortSignal): Promise<NestedPage>;
    /** Read a limited public profile. */
    getUserProfile(userNameOrId: string, signal?: AbortSignal): Promise<UserProfile>;
    /** List @-mentions for the bound account. Must throw `permission_denied` if unsupported. */
    getMentions(since: string | undefined, signal?: AbortSignal): Promise<readonly Mention[]>;
    /**
     * Resolve the context (floor + ancestors + thread) of one post id.
     *
     * `options.forceFresh` asks the adapter to bypass any structural cache. Every
     * publish and every verification sets it: a cached body returned as if it were
     * current would defeat the snapshot comparison entirely, so the parameter is
     * part of the contract rather than a Tieba convenience.
     */
    getReplyContext(ref: ThreadRef, postId: string, signal?: AbortSignal, options?: {
        forceFresh?: boolean;
    }): Promise<ReplyContext>;
    /** Publish a reply. Must verify the outcome, not just the HTTP status. */
    publishReply(ref: ThreadRef, target: PublishTarget, content: string, signal?: AbortSignal): Promise<PublishOutcome>;
}
/** Parsed location of a post inside a thread. */
export interface ReplyContext {
    readonly thread: Thread;
    /** The floor that anchors the post. */
    readonly floor: Floor;
    /** The post itself when it is a nested reply; absent when it is the floor. */
    readonly nested?: NestedReply;
    /** Ancestors from the floor down to (but excluding) the post. */
    readonly ancestors: readonly NestedReply[];
    /** Siblings in the same floor, in platform display order. */
    readonly siblings: readonly NestedReply[];
}
//# sourceMappingURL=types.d.ts.map