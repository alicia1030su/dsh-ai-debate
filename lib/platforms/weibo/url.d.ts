/**
 * Weibo link parsing and id normalisation.
 *
 * ## Scope, stated honestly
 *
 * This file answers one question: "does this link belong to Weibo, and which post is
 * it?" It performs no network access, holds no credential and invents no API. The
 * Weibo Open Platform requires a registered application, developer qualification and
 * a scope grant before a single comment may be read; none of that can be assumed, and
 * writing plausible-looking endpoint calls would be exactly the "pretend it works"
 * failure the platform matrix exists to prevent.
 *
 * What *is* verifiable offline is the id scheme, and it is the part that goes wrong
 * most expensively: a mid read as a uid, or a `m.weibo.cn` detail id compared against
 * a `weibo.com` display id, silently points the analysis at a different post.
 *
 * ## The id shapes this handles
 *
 * | Form | Example | What it carries |
 * | --- | --- | --- |
 * | Desktop permalink | `weibo.com/1234567890/AbCdEf123` | uid + base62 mid |
 * | Desktop short | `weibo.com/AbCdEf123` | base62 mid only |
 * | Mobile detail | `m.weibo.cn/detail/5012345678901234` | numeric mid |
 * | Mobile status | `m.weibo.cn/status/5012345678901234` | numeric mid |
 * | Query form | `m.weibo.cn/statuses/show?id=…` | numeric or base62 mid |
 *
 * The two id families are **not interchangeable**: `weibo.com` permalinks carry a
 * base62 id, while `m.weibo.cn` and the API use the numeric mid. Converting between
 * them is a well-defined base-62 ↔ decimal operation (Weibo splits the numeric mid
 * into 4-character base-62 chunks from the right), and it is implemented below
 * because comparing one family against the other is otherwise a silent mismatch.
 */
/** One parsed Weibo post reference. */
export interface WeiboRef {
    readonly platform: 'weibo';
    /** Canonical thread id: always the numeric mid, never the base62 form. */
    readonly threadId: string;
    /** The normalised permalink, so what is stored can be opened by a human. */
    readonly url: string;
    /** The author's numeric uid when the link carried one. */
    readonly uid?: string;
    /**
     * The id exactly as it appeared in the link.
     *
     * Kept so a mismatch can be *explained* ("you pasted the base62 form") instead of
     * looking like a completely different post.
     */
    readonly rawId: string;
}
/**
 * Whether this link belongs to Weibo.
 *
 * Never throws: `canHandleUrl` is asked about arbitrary text, including pasted prose.
 */
export declare function weiboCanHandleUrl(input: string): boolean;
/**
 * Parse a Weibo link.
 *
 * @throws when the link is not Weibo, or carries no post id. A guessed id means
 *   reading the wrong argument, so there is deliberately no fallback.
 */
export declare function parseWeiboUrl(input: string): WeiboRef;
/**
 * Convert a Weibo id to its numeric mid.
 *
 * Pure decimal ids pass through. A base62 id is decoded the way Weibo builds it: the
 * numeric mid is split into 4-character base-62 groups counted from the right, so
 * decoding walks the string from the right in groups of four, each contributing
 * `value × 62^(4k)`.
 *
 * @returns the numeric mid, or `undefined` when the input cannot be one
 */
export declare function toNumericMid(raw: string): string | undefined;
/**
 * Convert a numeric mid to Weibo's base62 display id.
 *
 * The inverse of {@link toNumericMid}, used only for building human-facing links and
 * for asserting round-trip stability in tests.
 */
export declare function toBase62(mid: string): string | undefined;
//# sourceMappingURL=url.d.ts.map