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
  readonly platform: 'weibo'
  /** Canonical thread id: always the numeric mid, never the base62 form. */
  readonly threadId: string
  /** The normalised permalink, so what is stored can be opened by a human. */
  readonly url: string
  /** The author's numeric uid when the link carried one. */
  readonly uid?: string
  /**
   * The id exactly as it appeared in the link.
   *
   * Kept so a mismatch can be *explained* ("you pasted the base62 form") instead of
   * looking like a completely different post.
   */
  readonly rawId: string
}

const HOSTS = new Set(['weibo.com', 'www.weibo.com', 'm.weibo.cn', 'weibo.cn', 'www.weibo.cn'])

/** Base-62 alphabet Weibo uses for its ids. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Whether this link belongs to Weibo.
 *
 * Never throws: `canHandleUrl` is asked about arbitrary text, including pasted prose.
 */
export function weiboCanHandleUrl(input: string): boolean {
  const host = hostOf(input)
  return host !== undefined && HOSTS.has(host)
}

/**
 * Parse a Weibo link.
 *
 * @throws when the link is not Weibo, or carries no post id. A guessed id means
 *   reading the wrong argument, so there is deliberately no fallback.
 */
export function parseWeiboUrl(input: string): WeiboRef {
  const host = hostOf(input)
  if (host === undefined || !HOSTS.has(host)) {
    throw new Error(`不是可以识别的微博链接：${input}`)
  }
  const parsed = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`)

  // `m.weibo.cn/detail/<mid>`, `/status/<mid>`, and the `statuses/show?id=…` form.
  const mobile = /^\/(?:detail|status)\/([0-9A-Za-z]+)\/?$/.exec(parsed.pathname)
  if (mobile !== null) {
    return finish(mobile[1]!, undefined)
  }
  if (/^\/(?:statuses|detail)\/show\/?$/.test(parsed.pathname)) {
    const id = parsed.searchParams.get('id') ?? parsed.searchParams.get('mid')
    if (id !== null && /^[0-9A-Za-z]+$/.test(id)) return finish(id, undefined)
  }

  // `weibo.com/<uid>/<mid>` and `weibo.com/<mid>`.
  const segments = parsed.pathname.split('/').filter((part) => part !== '')
  if (segments.length === 2 && /^\d+$/.test(segments[0]!) && /^[0-9A-Za-z]+$/.test(segments[1]!)) {
    return finish(segments[1]!, segments[0])
  }
  if (segments.length === 1 && /^[0-9A-Za-z]{6,}$/.test(segments[0]!) && /[A-Za-z]/.test(segments[0]!)) {
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
    return finish(segments[0]!, undefined)
  }
  if (segments.length === 1 && /^\d{6,}$/.test(segments[0]!)) {
    throw new Error(
      `无法判断 ${input} 是微博用户主页还是单条微博：纯数字的短链接两种都可能。` +
        '请粘贴带帖子的链接（形如 weibo.com/<uid>/<mid>、weibo.com/<base62 mid> 或 ' +
        'm.weibo.cn/detail/<mid>），不要用个人主页链接。',
    )
  }
  // `weibo.com/u/<uid>` is a profile, not a post — refuse rather than guess.
  throw new Error(
    `微博链接里没有帖子 id：${input}。请粘贴单条微博的链接（形如 weibo.com/<uid>/<mid> 或 m.weibo.cn/detail/<mid>），` +
      '不要用个人主页链接。',
  )
}

const finish = (rawId: string, uid: string | undefined): WeiboRef => {
  const mid = toNumericMid(rawId)
  if (mid === undefined) {
    throw new Error(
      `无法把「${rawId}」规范化成微博的 numeric mid：它既不是纯数字，也不是合法的 base62 微博 id。`,
    )
  }
  const author = uid === undefined ? '' : `${uid}/`
  return {
    platform: 'weibo',
    threadId: mid,
    url: `https://weibo.com/${author}${mid}`,
    ...(uid === undefined ? {} : { uid }),
    rawId,
  }
}

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
export function toNumericMid(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  if (!/^[0-9A-Za-z]+$/.test(trimmed)) return undefined

  let result = 0n
  // Right-to-left in groups of four; each group is a base-62 number times 62^(4k).
  let group = 0
  for (let end = trimmed.length; end > 0; end -= 4) {
    const start = Math.max(0, end - 4)
    const chunk = trimmed.slice(start, end)
    let value = 0n
    for (const character of chunk) {
      const digit = ALPHABET.indexOf(character)
      if (digit < 0) return undefined
      value = value * 62n + BigInt(digit)
    }
    result += value * 62n ** BigInt(4 * group)
    group += 1
  }
  return result.toString()
}

/**
 * Convert a numeric mid to Weibo's base62 display id.
 *
 * The inverse of {@link toNumericMid}, used only for building human-facing links and
 * for asserting round-trip stability in tests.
 */
export function toBase62(mid: string): string | undefined {
  if (!/^\d+$/.test(mid)) return undefined
  let remaining = BigInt(mid)
  if (remaining === 0n) return '0'
  const chunks: string[] = []
  const base = 62n ** 4n
  while (remaining > 0n) {
    let chunk = remaining % base
    remaining /= base
    let text = ''
    for (let index = 0; index < 4; index += 1) {
      text = ALPHABET[Number(chunk % 62n)]! + text
      chunk /= 62n
    }
    chunks.unshift(text)
  }
  // Drop the leading zero padding of the most significant group.
  const joined = chunks.join('')
  return joined.replace(/^0+/, '') || '0'
}

/** Extract the lowercase host, or `undefined` for anything that is not a URL-ish string. */
function hostOf(input: string): string | undefined {
  // The contract says `canHandleUrl` is asked about arbitrary text — including
  // pasted prose, an empty field, and (from a JSON payload) `null`. A `.trim()` on a
  // non-string turns a routine "is this mine?" probe into a crash the registry
  // reports as a rejected provider, so the type is widened on purpose.
  if (typeof input !== 'string') return undefined
  const text = input.trim()
  if (text === '') return undefined
  try {
    return new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`).host.toLowerCase()
  } catch {
    return undefined
  }
}
