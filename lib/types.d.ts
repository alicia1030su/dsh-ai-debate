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
/**
 * Which of Tieba's two numeric id spaces a value came from.
 *
 * `user_id` (published by `/p/totalComment`) and `tieba_uid` (the newer numeric
 * account id) are separate namespaces: equal values in different namespaces are
 * **not** the same account.
 *
 * Lives in `types.ts` from v0.2.28 because the *data* shape needs it — a record
 * has to carry the namespace next to the number, and a data type that depends on
 * the comparison module would make a cycle.
 */
export type NumericUidKind = 'user_id' | 'tieba_uid';
/**
 * Every numeric-id namespace this build can name.
 *
 * Tieba's two are spelled explicitly. A platform with exactly one numeric account
 * id uses `platform:<id>`, which is what keeps a Weibo uid from being described as
 * either Tieba space — and what makes a configured uid comparable at all.
 */
export type NumericUidNamespace = NumericUidKind | `platform:${string}`;
/**
 * Which platform surface an author field came from.
 *
 * v0.2.23: kept in `types.ts` rather than `identity.ts` so the data shape does
 * not depend on the comparison module, and so an old session that predates the
 * field can be read as `platform_contract` without importing anything new.
 */
export type IdentitySource = 'wap_floor' | 'wap_inline' | 'comment_page' | 'total_comment' | 'platform_contract';
/**
 * The author fields every author-bearing record may carry from v0.2.23 on.
 *
 * These are **additive**: `authorId` and `authorName` keep their v0.2.22 names
 * and meanings so历史会话 still read. What changed is that a caller can now tell
 * *what kind of thing* `authorId` is, instead of having to guess from its text.
 */
export interface AuthorFields {
    /**
     * Numeric account id, present **only** when the surface stated one numerically
     * (`/p/totalComment`'s `user_id` is the only such surface today).
     *
     * A handle that happens to be all digits is not copied here — that is the
     * collision this field exists to end.
     */
    readonly authorNumericUid?: string;
    /**
     * Which numeric namespace `authorNumericUid` belongs to (v0.2.23).
     *
     * `user_id` (from `/p/totalComment`) and `tieba_uid` are separate id spaces;
     * equal numbers in different spaces are different accounts. Without this tag a
     * uid cannot be compared against anything.
     *
     * v0.2.28 widened this from the two Tieba kinds to every nameable namespace: a
     * single-id platform records `platform:<id>`, and the narrower type was what
     * forced its projection to leave the field out altogether.
     */
    readonly authorNumericUidKind?: NumericUidNamespace;
    /** Which surface produced the author fields above. */
    readonly authorSource?: IdentitySource;
    /**
     * A proven cross-source disagreement about who wrote this record (v0.2.23).
     *
     * Present only when two surfaces described the same post id with identities
     * that cannot both be true. Downstream owner resolution must refuse rather
     * than choose.
     */
    readonly identityConflict?: {
        readonly code: 'identity_conflict';
        readonly summary: string;
        /**
         * Which surface supplied each side of the disagreement.
         *
         * `'unknown'` when the row never declared one. It is deliberately not folded into
         * a pretend source name: a reader who sees a surface name will believe a surface
         * was consulted.
         */
        readonly firstSource: IdentitySource | 'unknown';
        readonly secondSource: IdentitySource | 'unknown';
    };
}
/**
 * How a platform represents the opening post relative to its reply list.
 *
 * ## Why the core has to be told this (v0.2.28)
 *
 * The core used to assume one shape: `Thread.content` is a copy of the first
 * reply's text, so the opening post is already on the timeline and nothing more is
 * needed. That is true of a forum (Tieba's 1 楼 *is* the 主题帖) and false of a
 * microblog (a Weibo 微博 is a post of its own; the comments hang under it and
 * none of them carries its text).
 *
 * Under the old assumption a microblog thread had two silent faults:
 *
 * - the opening post never entered the timeline, so its author was not a
 *   participant — a thread the owner had clearly spoken in was reported as
 *   「在帖子里没有找到主人的发言」;
 * - the body could not be addressed at all, because `floorOf()` only looked at
 *   replies, so pointing at it produced 「不属于任何已采集楼层」.
 *
 * Neither is a Weibo quirk to patch; both are consequences of an unstated
 * assumption in the core. Stating it lets each adapter answer for its own shape
 * without the analyzer naming a platform.
 */
export type ThreadBodyNode = 
/** The body **is** the first reply (Tieba's 1 楼). Nothing extra to add. */
'first_floor'
/** The body is a node of its own; replies are separate posts under it. */
 | 'standalone';
/** The thread (主题帖) under discussion. */
export interface Thread extends AuthorFields {
    readonly platform: PlatformId;
    readonly forum: ForumRef;
    /** Thread id (贴吧的 kz/tid). */
    readonly id: string;
    readonly title: string;
    /** Plain-text body of the first post. */
    readonly content: string;
    /**
     * Whether `content` is also the first reply's text (v0.2.28).
     *
     * Absent means `'first_floor'` — the shape every adapter produced before this
     * field existed, so leaving it out keeps historical behaviour byte for byte.
     * A platform whose body is its own post states `'standalone'` and
     * {@link buildTimeline} then emits it as a `root` entry.
     */
    readonly bodyNode?: ThreadBodyNode;
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
export interface Floor extends AuthorFields {
    readonly platform: PlatformId;
    /**
     * The floor number as displayed (1-based), when the platform displays one.
     *
     * v0.2.1 made this optional. It is a *label*: a microblog post has no 楼层, and
     * requiring a number here only made such platforms invent one. Nothing in the
     * core groups or addresses by this value any more — `postId` does that.
     */
    readonly floorNumber?: number;
    /** Stable post id of this floor. */
    readonly postId: string;
    /**
     * The author's account handle, when the platform exposes one.
     *
     * Deliberately **one** field, not five. On Tieba this is `un`: the login name,
     * which cannot be renamed by its owner, and which may look like a nickname
     * (`永恒的鸟笼`) or like a number (`6631433126`) depending on the surface. It is
     * *not* `name_show` — see `authorName`.
     *
     * v0.2.22 evaluated splitting this into `authorHandle` / `authorDisplayName` /
     * `authorNumericId` / `authorIdentitySource` / `authorIdentityConfidence` and
     * deferred it: real WAP pages carry no numeric uid (`data-uid="<digits>"` matched
     * 0 times on a 190 KB live page), so `authorNumericId` would be `undefined`
     * everywhere and `authorIdentityConfidence` would have no evidence behind it.
     * Adding five fields to carry one bit of information — "is there a `un`?" — would
     * make every reader believe there is more to compare than there is. The publish
     * path needs "is there an id", and `hasAuthorIdentifier` answers exactly that.
     */
    readonly authorId?: string;
    /**
     * The name the platform displays for the author.
     *
     * On Tieba this is the rendered `user_name`, falling back to `name_show`. It is a
     * **nickname**: changeable at will, reusable by someone else, and therefore not an
     * identity. Comparing it is a last resort, never proof.
     */
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
export interface NestedReply extends AuthorFields {
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
    /**
     * Where the `replyToPostId` came from, in the words of whoever produced it.
     *
     * ## Why this is carried rather than assumed
     *
     * The graph bridge used to hard-code "the platform returned the replied post
     * id" on every `replies_to` edge. That is true for a platform adapter and
     * false for a manual import, where the id came from the owner reading a
     * pasted transcript — or from them picking the target in the correction UI.
     * The edge is the same shape either way, so without this field the graph
     * states a provenance it cannot know.
     *
     * Absent means "the producer did not say"; the bridge then keeps its
     * platform wording, which is the pre-existing behaviour for adapters.
     */
    readonly replyBasis?: string;
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
    readonly floorNumber?: number;
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