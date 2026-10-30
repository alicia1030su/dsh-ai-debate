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

/** The subset of a status payload this module needs to compare identities. */
interface IdentifiedStatus {
  readonly id?: unknown
  readonly idstr?: unknown
  readonly mid?: unknown
}

/** The result of comparing a returned payload against the requested id. */
export type StatusMatch =
  | {
      readonly ok: true
      /** The matching status object, so the caller projects *it* rather than the envelope. */
      readonly status: Record<string, unknown>
      /** Which id field matched, for the diagnostic line. */
      readonly matchedOn: string
    }
  | {
      readonly ok: false
      /** Why it did not match, in words the settings page can show. */
      readonly reason: string
      /** What we actually saw, when we saw anything at all. */
      readonly observed: readonly string[]
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

/** Every id-shaped field a status payload may carry. */
function idsOf(status: IdentifiedStatus): string[] {
  const out: string[] = []
  for (const raw of [status.idstr, status.id, status.mid]) {
    const normalised = normaliseStatusId(raw)
    if (normalised !== undefined && !out.includes(normalised)) out.push(normalised)
  }
  return out
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
 */
export function collectStatusCandidates(raw: unknown): Record<string, unknown>[] {
  if (typeof raw !== 'object' || raw === null) return []
  const record = raw as Record<string, unknown>

  /** Keys whose value is one status object. */
  const singletonKeys = ['status', 'data', 'result']
  /** Keys whose value is a list of statuses (the batch form). */
  const listKeys = ['statuses', 'data', 'results', 'list', 'items']

  const looksLikeStatus = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const candidate = value as Record<string, unknown>
    // An id is the only thing identity work needs; a body-less status is still a status.
    return idsOf(candidate as IdentifiedStatus).length > 0
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

  // The payload may be the status itself.
  if (looksLikeStatus(record)) out.push(record)
  return out
}

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
export function matchReturnedStatus(raw: unknown, requestedId: string): StatusMatch {
  const wanted = normaliseStatusId(requestedId)
  if (wanted === undefined) {
    return {
      ok: false,
      reason: '请求的 id 不是合法的微博 mid（应为十进制数字串），无法做一致性核对。',
      observed: [],
    }
  }

  const candidates = collectStatusCandidates(raw)
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: '返回内容里没有带可识别 id 的微博对象，无法证明它是目标微博。',
      observed: [],
    }
  }

  const observed: string[] = []
  const hits: Record<string, unknown>[] = []
  for (const candidate of candidates) {
    const ids = idsOf(candidate as IdentifiedStatus)
    for (const id of ids) if (!observed.includes(id)) observed.push(id)
    if (ids.includes(wanted)) hits.push(candidate)
  }

  if (hits.length === 0) {
    return {
      ok: false,
      reason:
        observed.length === 0
          ? '返回的微博对象没有可识别的 id（id/idstr/mid 都不可用），不能当成目标微博。'
          : '返回微博的 id 与请求的不一致。',
      observed,
    }
  }

  if (hits.length === 1) {
    return { ok: true, status: hits[0]!, matchedOn: 'id' }
  }

  // More than one copy of the target. Acceptable only when they agree on the body; otherwise
  // the answer is self-contradictory and picking one is a guess.
  const bodies = hits.map((hit) => {
    const text = (hit as Record<string, unknown>).text
    return typeof text === 'string' ? text.trim() : ''
  })
  const first = bodies[0]!
  const agree = bodies.every((body) => body === first)
  if (!agree) {
    return {
      ok: false,
      reason: `返回了 ${hits.length} 条 id 相同但正文不同的微博，无法判断哪一条是真的。`,
      observed,
    }
  }
  return { ok: true, status: hits[0]!, matchedOn: 'id' }
}
