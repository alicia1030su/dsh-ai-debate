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
const HOSTS = new Set(['weibo.com', 'www.weibo.com', 'm.weibo.cn', 'weibo.cn', 'www.weibo.cn']);
/** Base-62 alphabet Weibo uses for its ids. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
/**
 * Whether this link belongs to Weibo.
 *
 * Never throws: `canHandleUrl` is asked about arbitrary text, including pasted prose.
 */
export function weiboCanHandleUrl(input) {
    const host = hostOf(input);
    return host !== undefined && HOSTS.has(host);
}
/**
 * Parse a Weibo link.
 *
 * @throws when the link is not Weibo, or carries no post id. A guessed id means
 *   reading the wrong argument, so there is deliberately no fallback.
 */
export function parseWeiboUrl(input) {
    const host = hostOf(input);
    if (host === undefined || !HOSTS.has(host)) {
        throw new Error(`不是可以识别的微博链接：${input}`);
    }
    const parsed = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
    // `m.weibo.cn/detail/<mid>`, `/status/<mid>`, and the `statuses/show?id=…` form.
    const mobile = /^\/(?:detail|status)\/([0-9A-Za-z]+)\/?$/.exec(parsed.pathname);
    if (mobile !== null) {
        return finish(mobile[1], undefined);
    }
    if (/^\/(?:statuses|detail)\/show\/?$/.test(parsed.pathname)) {
        const id = parsed.searchParams.get('id') ?? parsed.searchParams.get('mid');
        if (id !== null && /^[0-9A-Za-z]+$/.test(id))
            return finish(id, undefined);
    }
    // `weibo.com/<uid>/<mid>` and `weibo.com/<mid>`.
    const segments = parsed.pathname.split('/').filter((part) => part !== '');
    if (segments.length === 2 && /^\d+$/.test(segments[0]) && /^[0-9A-Za-z]+$/.test(segments[1])) {
        return finish(segments[1], segments[0]);
    }
    if (segments.length === 1 && /^[0-9A-Za-z]{6,}$/.test(segments[0]) && /[A-Za-z]/.test(segments[0])) {
        // A bare base62 mid.
        //
        // The letter requirement is the whole point (v0.2.8). `weibo.com/<digits>` is
        // *also* the shape of a user profile: Weibo serves `weibo.com/1234567890` as
        // uid 1234567890's homepage, and the same string is a perfectly valid numeric
        // mid. Nothing in the URL distinguishes them, so a numeric single segment is
        // not "probably a post" — it is genuinely ambiguous, and reading it as a post
        // points the whole analysis at whatever post happens to carry that id.
        //
        // A base62 id always contains at least one letter in practice, while a uid is
        // always purely decimal, so requiring a letter turns "guess" into "know". The
        // forms that *do* state their intent (`/detail/<mid>`, `/status/<mid>`,
        // `?id=<mid>`) still accept a numeric mid, because there the path says "post".
        return finish(segments[0], undefined);
    }
    if (segments.length === 1 && /^\d{6,}$/.test(segments[0])) {
        throw new Error(`无法判断 ${input} 是微博用户主页还是单条微博：纯数字的短链接两种都可能。` +
            '请粘贴带帖子的链接（形如 weibo.com/<uid>/<mid>、weibo.com/<base62 mid> 或 ' +
            'm.weibo.cn/detail/<mid>），不要用个人主页链接。');
    }
    // `weibo.com/u/<uid>` is a profile, not a post — refuse rather than guess.
    throw new Error(`微博链接里没有帖子 id：${input}。请粘贴单条微博的链接（形如 weibo.com/<uid>/<mid> 或 m.weibo.cn/detail/<mid>），` +
        '不要用个人主页链接。');
}
const finish = (rawId, uid) => {
    const mid = toNumericMid(rawId);
    if (mid === undefined) {
        throw new Error(`无法把「${rawId}」规范化成微博的 numeric mid：它既不是纯数字，也不是合法的 base62 微博 id。`);
    }
    // ## The canonical link must parse back into the same thread (v0.2.11)
    //
    // v0.2.10 always built `https://weibo.com/<mid>`, using the *numeric* mid. Its own
    // parser rejects a bare numeric segment on purpose — `weibo.com/1234567890` is also a
    // user profile, so that shape is ambiguous and refusing it is right. The bug was
    // producing that shape, not refusing it: `parseWeiboUrl(parseWeiboUrl(x).url)` failed
    // for every mobile link, which means the field that exists so "a human can open what
    // was stored" pointed at something the plugin itself would not accept.
    //
    // Two unambiguous shapes, chosen by what the input actually told us:
    //
    // - **uid known**: `weibo.com/<uid>/<base62>` — a real desktop permalink. The mid is
    //   rendered in base62 so the path is a post, not a numeric profile id.
    // - **uid unknown**: `m.weibo.cn/detail/<mid>` — the mobile detail URL. It states its
    //   own intent in the path, so a purely numeric mid is unambiguous there.
    //
    // Neither invents a uid: when the link did not carry one, the canonical URL has none.
    const url = uid === undefined
        ? `https://m.weibo.cn/detail/${mid}`
        : `https://weibo.com/${uid}/${toBase62(mid) ?? mid}`;
    return {
        platform: 'weibo',
        threadId: mid,
        url,
        ...(uid === undefined ? {} : { uid }),
        rawId,
    };
};
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
export function toNumericMid(raw) {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed))
        return trimmed;
    if (!/^[0-9A-Za-z]+$/.test(trimmed))
        return undefined;
    // Right-to-left in groups of four.
    const groups = [];
    for (let end = trimmed.length; end > 0; end -= 4) {
        groups.unshift(trimmed.slice(Math.max(0, end - 4), end));
    }
    const parts = [];
    for (let index = 0; index < groups.length; index += 1) {
        let value = 0n;
        for (const character of groups[index]) {
            const digit = ALPHABET.indexOf(character);
            if (digit < 0)
                return undefined;
            value = value * 62n + BigInt(digit);
        }
        const decimal = value.toString();
        if (index === 0) {
            // The leftmost group is the most significant one and carries no padding.
            parts.push(decimal);
        }
        else {
            // Every other group is a full seven-digit block. A longer value means the input
            // was not produced by this scheme, so refusing beats emitting a nonsense mid.
            if (decimal.length > 7)
                return undefined;
            parts.push(decimal.padStart(7, '0'));
        }
    }
    return parts.join('');
}
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
export function toBase62(mid) {
    if (!/^\d+$/.test(mid))
        return undefined;
    // Right-to-left in groups of seven digits.
    const groups = [];
    for (let end = mid.length; end > 0; end -= 7) {
        groups.unshift(mid.slice(Math.max(0, end - 7), end));
    }
    const parts = [];
    for (let index = 0; index < groups.length; index += 1) {
        let remaining = BigInt(groups[index]);
        if (remaining === 0n) {
            parts.push(index === 0 ? '0' : '0000');
            continue;
        }
        let text = '';
        while (remaining > 0n) {
            text = ALPHABET[Number(remaining % 62n)] + text;
            remaining /= 62n;
        }
        if (index === 0) {
            // The leftmost group carries no padding.
            parts.push(text);
        }
        else {
            // Every other group is a four-character block. A wider value cannot occur: a
            // seven-digit number is below 62⁴, so this is a guarantee, not a guess.
            if (text.length > 4)
                return undefined;
            parts.push(text.padStart(4, '0'));
        }
    }
    return parts.join('');
}
/** Extract the lowercase host, or `undefined` for anything that is not a URL-ish string. */
function hostOf(input) {
    // The contract says `canHandleUrl` is asked about arbitrary text — including
    // pasted prose, an empty field, and (from a JSON payload) `null`. A `.trim()` on a
    // non-string turns a routine "is this mine?" probe into a crash the registry
    // reports as a rejected provider, so the type is widened on purpose.
    if (typeof input !== 'string')
        return undefined;
    const text = input.trim();
    if (text === '')
        return undefined;
    try {
        return new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`).host.toLowerCase();
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=url.js.map