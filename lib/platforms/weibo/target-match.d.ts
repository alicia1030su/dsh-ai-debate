/**
 * v0.2.15 §二：核对平台返回的微博是不是请求的那一条。
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
 * ## v0.2.15 修的缺陷：把不同语义的字段平铺成一个数组
 *
 * v0.2.14 的 `idsOf()` 把 `id`、`idstr`、`mid` 收进同一个数组，只要**任一**等于请求值就放行。
 * 审计复现：
 *
 * ```json
 * { "idstr": "4331051486294436", "id": "9999999999999999", "text": "测试正文" }
 * ```
 *
 * 返回 `ok: true`。可是这个对象自己说自己是两条不同的微博——它自相矛盾。
 *
 * 根因是**没有区分字段的身份语义**：
 *
 * | 字段 | 语义 | 与谁同空间 |
 * | --- | --- | --- |
 * | `id` | 微博状态 ID（十进制） | 与 `idstr` 相同 |
 * | `idstr` | 同一个状态 ID 的字符串形式 | 与 `id` 相同 |
 * | `mid` | 微博 URL 里用的 mid | **另一个编号空间** |
 *
 * 所以现在的规则是：
 *
 * 1. **同语义组内必须一致。** `id` 与 `idstr` 同时出现却不同 → 对象自相矛盾 → 拒绝。
 * 2. **不同语义组之间不强制比较。** `mid` 与 `id` 本来就不是同一个数，拿它们互相校验会把
 *    完全正常的响应判成不匹配——这是「不要错误地把不同语义的合法字段强制比较」。
 * 3. **命中任一语义组即视为身份匹配**，并报告命中的是哪一组。
 * 4. 同组内只要有一个值缺失，就不产生冲突（缺值不是矛盾）。
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
    /** Which identity group matched, for the diagnostic line: `id` or `mid`. */
    readonly matchedOn: string;
} | {
    readonly ok: false;
    /** Why it did not match, in words the settings page can show. */
    readonly reason: string;
    /** What we actually saw, when we saw anything at all. */
    readonly observed: readonly string[];
    /**
     * A machine-readable cause.
     *
     * `identity_conflict` is the v0.2.15 addition: the object named itself twice with two
     * different values. That is not "a different post" — it is a payload we cannot reason
     * about, and the caller may want to say so differently.
     */
    readonly code?: 'no_candidates' | 'no_match' | 'identity_conflict' | 'duplicate_conflict';
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
 *
 * ## Nested envelopes (v0.2.15 §二.6)
 *
 * Real answers nest: `{ data: { status: {...} } }`, `{ result: { statuses: [...] } }`. v0.2.14
 * only looked one level deep, so a nested single status was invisible — which surfaced as
 * "the answer carries no identifiable post" for a perfectly ordinary response. This now descends
 * a bounded number of wrapper levels, and stops as soon as it finds something identifiable.
 */
export declare function collectStatusCandidates(raw: unknown, depth?: number): Record<string, unknown>[];
/**
 * Decide whether a returned payload is the post we asked for.
 *
 * ## The exact rule
 *
 * A payload matches only when **exactly one** candidate carries the requested id, and that
 * candidate's own identity fields do not contradict each other. Every other outcome is a refusal
 * with its own reason:
 *
 * | situation | code | reason |
 * | --- | --- | --- |
 * | no candidates | `no_candidates` | the answer carries no identifiable post |
 * | candidates but none matches | `no_match` | the answer is a different post |
 * | a candidate names itself two different ways | `identity_conflict` | cannot trust its identity |
 * | the target appears twice with different content | `duplicate_conflict` | cannot tell which is real |
 *
 * The `identity_conflict` row is what v0.2.15 adds. An object whose `idstr` says one post and
 * whose `id` says another is not "the wrong post" — it is an answer that makes no sense, and
 * accepting either value would be picking a fact at random.
 */
export declare function matchReturnedStatus(raw: unknown, requestedId: string): StatusMatch;
//# sourceMappingURL=target-match.d.ts.map