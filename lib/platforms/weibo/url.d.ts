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
 * ## The segmented scheme (v0.2.11)
 *
 * A Weibo base62 id is **not** one big base62 integer. The numeric mid is split into
 * seven-digit groups counted from the right, each group is encoded to base62
 * independently, and every group except the leftmost is padded to four base62
 * characters. Decoding is the mirror image: four characters at a time from the right,
 * each turned into decimal, every group except the leftmost padded to seven digits.
 *
 * v0.2.10 treated the whole string as a single base62 number. That is wrong in a way
 * that looks plausible — it round-trips against itself, so self-encoding tests passed —
 * and it only shows up against an id somebody else computed. Verified against external
 * samples (they disagree with the old code in the high digits, which is exactly where a
 * positional error lives):
 *
 *   `Hd1N2qpta` ↔ `4331051486294436`
 *   `I1IGF4Ud1` ↔ `4404101091169383`
 *
 * Pure decimal ids pass through unchanged.
 *
 * @returns the numeric mid, or `undefined` when the input cannot be one
 */
export declare function toNumericMid(raw: string): string | undefined;
/**
 * Convert a numeric mid to Weibo's base62 display id.
 *
 * The inverse of {@link toNumericMid}. The digits are split into seven-digit groups
 * counted from the right, each group is encoded to base62 on its own, and every group
 * except the leftmost is padded to four characters.
 *
 * v0.2.10 divided the whole number by 62⁴ repeatedly, which is the general base62
 * encoding — a different function. It happened to invert the old (also wrong) decoder,
 * so round-trip tests passed while both directions were wrong. `Hd1N2qpta` and
 * `4331051486294436` are the external check that pins both.
 */
export declare function toBase62(mid: string): string | undefined;
//# sourceMappingURL=url.d.ts.map