/**
 * v0.2.14 §二：核对平台返回的微博是不是请求的那一条。
 *
 * ## 这个函数存在的理由
 *
 * v0.2.13 的 `getThread` 把 `ref.threadId` 直接贴在投影结果上，**从不读返回对象自己的
 * id**。用发布产物复现：请求 `4331051486294436`，CLI 返回 `9999999999999999` 的一条完整
 * 微博，`getThread` 照样把它标成请求的 MID，分析器随后写出一份关于陌生人微博的争论简报，
 * 并挂上主人给的链接。
 *
 * 这是**目标身份完整性**问题：后面的注入防护、立场保护、人工审核全都建立在「这条正文就是
 * 主人指的那条」之上。这一步错了，后面每一步的结论都不可信。
 *
 * ## 为什么不能只检查「有 id」
 *
 * 四种情况都必须分开对待：
 *
 * 1. 返回对象根本没有 id → 我们无法证明它是目标，不是目标。
 * 2. 返回 id 与请求不同 → 明确不匹配。
 * 3. 返回多条（批量接口）→ 必须**精确挑出**对应 MID 的那一条，不能取第一条。
 * 4. 返回里有多条相同 MID → 内容不一致时无法判断哪条是真的，不猜。
 *
 * ## id 一律当字符串
 *
 * 微博的 mid 是 64 位十进制数，超过 `Number.MAX_SAFE_INTEGER`（9007199254740991）。
 * 任何一次 `Number(...)` 都会悄悄改掉末几位，于是「不匹配」会被算成「匹配」——
 * 这正是最危险的方向。所以比较全程用字符串，且只在两边都能规范化时才认定相等。
 */
/** The result of comparing a returned payload against the requested id. */
export type StatusMatch = {
    readonly ok: true;
    /** The matching status object, so the caller projects *it* rather than the envelope. */
    readonly status: Record<string, unknown>;
    /** Which id field matched, for the diagnostic line. */
    readonly matchedOn: string;
} | {
    readonly ok: false;
    /** Why it did not match, in words the settings page can show. */
    readonly reason: string;
    /** What we actually saw, when we saw anything at all. */
    readonly observed: readonly string[];
};
/**
 * Normalise an id to a comparable string.
 *
 * ## Why `String()` and not `Number()`
 *
 * A 64-bit mid cannot survive `Number()`. `Number('4331051486294436')` happens to round-trip,
 * but `Number('9999999999999999')` is `10000000000000000` — so a comparison done in numbers can
 * turn two different posts into a match. Every path here stays in strings.
 *
 * Numbers are still accepted as *input* because a JSON parser may have already produced one; they
 * are converted with `String()`, which for an integer above the safe range yields the rounded
 * value — and that is exactly why such a value can never be treated as proof. The caller sees a
 * mismatch rather than a silent match.
 */
export declare function normaliseStatusId(value: unknown): string | undefined;
/**
 * Collect candidate status objects out of whatever envelope the CLI wrapped the answer in.
 *
 * ## Why this is separate from `unwrapStatus`
 *
 * `unwrapStatus` answers "is there a projectable status here" and returns the first one it can
 * read. That is the right question for projection but the wrong one for identity: a batch answer
 * contains several statuses and the target may not be first. This function returns **all** the
 * plausible candidates so the caller can pick by id, and reports the envelope key each came from.
 */
export declare function collectStatusCandidates(raw: unknown): Record<string, unknown>[];
/**
 * Decide whether a returned payload is the post we asked for.
 *
 * ## The exact rule
 *
 * A payload matches only when **exactly one** candidate carries an id equal to the requested one.
 * Every other outcome is a refusal with its own reason:
 *
 * | situation | reason |
 * | --- | --- |
 * | no candidates | the answer carries no identifiable post |
 * | candidates but none matches | the answer is a different post |
 * | the target appears twice with different content | cannot tell which is real |
 *
 * "The target appears twice" is worth spelling out: batch endpoints sometimes echo a post both
 * as a standalone object and inside the list. If both copies are the same object shape we accept
 * the first — but if their bodies differ, the platform has given contradictory answers and
 * choosing one would be a guess.
 */
export declare function matchReturnedStatus(raw: unknown, requestedId: string): StatusMatch;
//# sourceMappingURL=target-match.d.ts.map