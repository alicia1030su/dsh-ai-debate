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

/** The subset of a status payload this module needs to compare identities. */
interface IdentifiedStatus {
  readonly id?: unknown
  readonly idstr?: unknown
  readonly mid?: unknown
}

/**
 * The status-id identity group.
 *
 * `id` and `idstr` are two encodings of **one** value. If a payload carries both and they differ,
 * the payload contradicts itself and neither can be trusted.
 */
const STATUS_ID_FIELDS = ['idstr', 'id'] as const

/**
 * The mid identity group.
 *
 * Weibo's `mid` is what appears in `weibo.com/<uid>/<mid>` — a different numbering from `id`, so
 * its value legitimately differs. Grouping it separately is what stops a correct response from
 * being rejected for "not matching" a field that was never meant to match.
 */
const MID_FIELDS = ['mid'] as const

/** The result of comparing a returned payload against the requested id. */
export type StatusMatch =
  | {
      readonly ok: true
      /** The matching status object, so the caller projects *it* rather than the envelope. */
      readonly status: Record<string, unknown>
      /** Which identity group matched, for the diagnostic line: `id` or `mid`. */
      readonly matchedOn: string
    }
  | {
      readonly ok: false
      /** Why it did not match, in words the settings page can show. */
      readonly reason: string
      /** What we actually saw, when we saw anything at all. */
      readonly observed: readonly string[]
      /**
       * A machine-readable cause.
       *
       * `identity_conflict` is the v0.2.15 addition: the object named itself twice with two
       * different values. That is not "a different post" — it is a payload we cannot reason
       * about, and the caller may want to say so differently.
       */
      readonly code?: 'no_candidates' | 'no_match' | 'identity_conflict' | 'duplicate_conflict'
    }

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
export function normaliseStatusId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    // A mid is decimal digits. Anything else is not an id we can compare.
    return /^\d+$/.test(trimmed) ? trimmed : undefined
  }
  if (typeof value === 'number') {
    // Reject rather than round: a number this large has already lost precision, so treating it
    // as an id would be inventing one.
    if (!Number.isSafeInteger(value)) return undefined
    return String(value)
  }
  return undefined
}

/** What one object claims about its own identity, grouped by semantics. */
interface IdentityClaim {
  /** Distinct values seen in the status-id group (`idstr` + `id`). */
  readonly statusIds: readonly string[]
  /** Distinct values seen in the mid group. */
  readonly mids: readonly string[]
}

/**
 * Read an object's identity claims, keeping the semantic groups apart.
 *
 * Returning two lists rather than one flat list is the whole fix: a caller can now ask "does the
 * status-id group contradict itself" separately from "does the mid match".
 */
function identityOf(status: IdentifiedStatus): IdentityClaim {
  const collect = (fields: readonly string[]): string[] => {
    const out: string[] = []
    for (const field of fields) {
      const normalised = normaliseStatusId((status as Record<string, unknown>)[field])
      if (normalised !== undefined && !out.includes(normalised)) out.push(normalised)
    }
    return out
  }
  return { statusIds: collect(STATUS_ID_FIELDS), mids: collect(MID_FIELDS) }
}

/** Every comparable id an object carries, in either group. Used for diagnostics only. */
function allIdsOf(claim: IdentityClaim): string[] {
  return [...claim.statusIds, ...claim.mids]
}

/**
 * True when the object's own identity fields disagree with each other.
 *
 * Only **within** a semantic group. A status-id that differs from a mid is normal and must not
 * be flagged here — that conflation is what produced v0.2.14's false acceptances.
 */
function conflicts(claim: IdentityClaim): boolean {
  return claim.statusIds.length > 1
}

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
export function collectStatusCandidates(raw: unknown, depth = 0): Record<string, unknown>[] {
  if (typeof raw !== 'object' || raw === null) return []
  if (depth > 4) return [] // A wrapper chain this deep is not a status envelope.
  const record = raw as Record<string, unknown>

  /** Keys whose value is one status object or another envelope. */
  const singletonKeys = ['status', 'data', 'result', 'payload', 'response']
  /** Keys whose value is a list of statuses (the batch form). */
  const listKeys = ['statuses', 'data', 'results', 'list', 'items', 'records']

  const looksLikeStatus = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const candidate = value as Record<string, unknown>
    // Any id in either group is the only thing identity work needs; a body-less status is still
    // a status.
    return allIdsOf(identityOf(candidate as IdentifiedStatus)).length > 0
  }

  const out: Record<string, unknown>[] = []

  // A list wins over a singleton wrapper of the same name: `data: [...]` is a batch, and
  // treating it as "the status is at .data" would produce no id and a spurious mismatch.
  for (const key of listKeys) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (looksLikeStatus(entry)) out.push(entry)
    }
  }
  if (out.length > 0) return out

  for (const key of singletonKeys) {
    const value = record[key]
    if (looksLikeStatus(value)) out.push(value)
  }
  if (out.length > 0) return out

  // Descend into a wrapper that holds neither a status nor a list directly.
  for (const key of singletonKeys) {
    const value = record[key]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const nested = collectStatusCandidates(value, depth + 1)
    if (nested.length > 0) return nested
  }

  // The payload may be the status itself.
  if (looksLikeStatus(record)) out.push(record)
  return out
}

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
export function matchReturnedStatus(raw: unknown, requestedId: string): StatusMatch {
  const wanted = normaliseStatusId(requestedId)
  if (wanted === undefined) {
    return {
      ok: false,
      reason: '请求的 id 不是合法的微博 mid（应为十进制数字串），无法做一致性核对。',
      observed: [],
      code: 'no_candidates',
    }
  }

  const candidates = collectStatusCandidates(raw)
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: '返回内容里没有带可识别 id 的微博对象，无法证明它是目标微博。',
      observed: [],
      code: 'no_candidates',
    }
  }

  const observed: string[] = []
  const hits: { status: Record<string, unknown>; matchedOn: string }[] = []
  const conflicted: Record<string, unknown>[] = []

  for (const candidate of candidates) {
    const claim = identityOf(candidate as IdentifiedStatus)
    for (const id of allIdsOf(claim)) if (!observed.includes(id)) observed.push(id)

    // ## Self-contradiction is checked before matching (§二.3)
    //
    // Order matters. The audited payload had `idstr` equal to the request and `id` equal to
    // something else; checking "does any field match" first would let the matching field win and
    // hide the contradiction. Asking "is this object consistent with itself" first means an
    // inconsistent object is never eligible, no matter which of its fields happens to agree.
    if (conflicts(claim)) {
      conflicted.push(candidate)
      continue
    }

    if (claim.statusIds.includes(wanted)) {
      hits.push({ status: candidate, matchedOn: 'id' })
      continue
    }
    if (claim.mids.includes(wanted)) {
      hits.push({ status: candidate, matchedOn: 'mid' })
    }
  }

  if (hits.length === 0) {
    if (conflicted.length > 0) {
      const detail = conflicted
        .map((candidate) => identityOf(candidate as IdentifiedStatus).statusIds.join(' vs '))
        .join('；')
      return {
        ok: false,
        reason:
          `返回的微博对象自相矛盾（id 与 idstr 指向不同的微博：${detail}），` +
          '无法确定它的真实身份，不能当成目标微博。',
        observed,
        code: 'identity_conflict',
      }
    }
    return {
      ok: false,
      reason:
        observed.length === 0
          ? '返回的微博对象没有可识别的 id（id/idstr/mid 都不可用），不能当成目标微博。'
          : '返回微博的 id 与请求的不一致。',
      observed,
      code: 'no_match',
    }
  }

  if (hits.length === 1) {
    return { ok: true, status: hits[0]!.status, matchedOn: hits[0]!.matchedOn }
  }

  // More than one copy of the target. Acceptable only when they agree on the body *and* on the
  // author; otherwise the answer is self-contradictory and picking one is a guess.
  const signatureOf = (status: Record<string, unknown>): string => {
    const text = typeof status.text === 'string' ? status.text.trim() : ''
    const user = status.user
    const author =
      typeof user === 'object' && user !== null
        ? String((user as Record<string, unknown>).idstr ?? (user as Record<string, unknown>).id ?? '')
        : ''
    return `${text}\u0000${author}`
  }

  const signatures = hits.map((hit) => signatureOf(hit.status))
  const first = signatures[0]!
  if (!signatures.every((signature) => signature === first)) {
    return {
      ok: false,
      reason: `返回了 ${hits.length} 条 id 相同但正文或作者不同的微博，无法判断哪一条是真的。`,
      observed,
      code: 'duplicate_conflict',
    }
  }
  return { ok: true, status: hits[0]!.status, matchedOn: hits[0]!.matchedOn }
}
