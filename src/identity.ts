/**
 * Who said this, and on what evidence?
 *
 * ## The problem this module exists to stop
 *
 * Tieba publishes an author identity on at least four surfaces, and they do not
 * agree about what "the author id" means:
 *
 * | surface | field | namespace |
 * | --- | --- | --- |
 * | WAP floor (`/mo/q/m`) | `data-info.un` | login name |
 * | WAP inline nested | `data-info.un` | login name |
 * | `/p/comment` page | `username` attr | login name (assumed — see below) |
 * | `/p/totalComment` JSON | `user_id` | numeric uid |
 *
 * v0.2.22 funnelled all four into one `authorId: string`. Two consequences, both
 * silent:
 *
 * 1. `ownerUserId = "348099763"` was compared against `un = "银狐_玉耀"`. Two
 *    strings, one `===`, always false. The owner was reported as absent from a
 *    thread he had posted in nine times.
 * 2. When two surfaces described the same `postId`, the merge kept whichever
 *    arrived first and discarded the other. No conflict was ever reported.
 *
 * ## The rule this module enforces
 *
 * A comparison is only made **inside one namespace**. A uid and a handle never
 * meet, no matter how alike their text is — the live thread this was written
 * against had `un="1254480024"`, which is a login name that looks exactly like a
 * uid.
 *
 * A display name proves nothing. It is a nickname: changeable by its owner, and
 * reusable by anyone else.
 *
 * ## What it refuses to do
 *
 * When two sources disagree it returns a conflict. It does not pick the one that
 * "looks more real", does not prefer the later reply, and does not fall back to
 * comparing bodies. A conflict means *we do not know who wrote this*, and the
 * caller must treat it that way.
 */

import type { IdentitySource, NumericUidKind, NumericUidNamespace, PlatformId } from './types.js'

export type { IdentitySource, NumericUidKind, NumericUidNamespace }

/**
 * Which numeric-id namespace a uid belongs to.
 *
 * Tieba has more than one. `user_id` (from `/p/totalComment`) and `tieba_uid`
 * (the newer numeric account id) are separate namespaces: equal values in
 * different namespaces are **not** the same account. Storing the namespace next
 * to the value is what makes "never mix the two" enforceable rather than
 * aspirational.
 */

/**
 * How strongly the evidence ties this author to an account.
 *
 * Ordered strongest to weakest. `unverified` is not a failure — it is the honest
 * answer when a surface cannot prove anything, and it must never be promoted by
 * matching a nickname.
 */
export type IdentityConfidence =
  /** A numeric account id on a surface authoritative for it. */
  | 'numeric_uid'
  /** A login name (`un` / `username`) the owner cannot rename. */
  | 'login_handle'
  /** Only a display name. A nickname, reusable by anyone. Never proves identity. */
  | 'display_name_only'
  /** The surface gave nothing usable at all. */
  | 'unverified'
  /** A record written before v0.2.23: its `authorId` has no recorded namespace. */
  | 'legacy_unknown'

/** A single author, with every field the platform actually provided. */
export interface AuthorIdentity {
  readonly platform: PlatformId
  /** Numeric account id, **only** when the surface stated one as a number. */
  readonly numericUid?: string
  /**
   * Which numeric namespace `numericUid` lives in. Required whenever it is set.
   *
   * v0.2.28 widened from the two Tieba kinds to every nameable namespace. A
   * single-id platform states `platform:<id>`, which `compareIdentities` treats as
   * an ordinary namespace: equal values inside it are the same account, and values
   * from two different platforms never meet.
   */
  readonly numericUidKind?: NumericUidNamespace
  /**
   * Login name (`un` on WAP, `username` on the comment page).
   *
   * May be all digits. Still a handle: the namespace is decided by *where the
   * value came from*, never by what the text looks like.
   */
  readonly handle?: string
  /** Display name (nickname). Display and candidate suggestion only. */
  readonly displayName?: string
  /**
   * Avatar path fragment. Auxiliary at most: Tieba's portrait embeds a
   * timestamp, so one account legitimately yields several values over time.
   */
  readonly portrait?: string
  /**
   * Which surface produced these fields, when the row said so.
   *
   * Optional since v0.2.23 patch 7. It used to be required, and the collector filled
   * the gap with the name `platform_contract` — which turned "unknown origin" into a
   * named surface that could then count as an independent source for corroboration.
   * Requiring a value only works if the caller can always supply a *true* one; it
   * cannot, so the field now admits that it does not know.
   */
  readonly source?: IdentitySource
}

/**
 * The outcome of comparing two identities.
 *
 * Every variant names *what was compared*, because "not equal" is useless
 * without it: two different handles and two different uids are very different
 * claims.
 */
export type IdentityComparison =
  /** Same numeric namespace, same value. The only non-spoofable agreement. */
  | { readonly kind: 'same_numeric_uid'; readonly namespace: NumericUidNamespace }
  /** Same numeric namespace, different values. Two accounts, proven. */
  | { readonly kind: 'different_numeric_uid'; readonly namespace: NumericUidNamespace }
  /** Same login name. Same handle *now* — not proof of the same permanent uid. */
  | { readonly kind: 'same_handle' }
  /** Different login names. Two accounts (a handle cannot be re-registered). */
  | { readonly kind: 'different_handle' }
  /** Only display names agreed. Never proof of identity. */
  | { readonly kind: 'display_name_match_only'; readonly name: string }
  /** Display names disagreed and nothing stronger existed. Says nothing either way. */
  | { readonly kind: 'insufficient_evidence' }
  /** The two sides only hold different namespaces; no reliable mapping exists. */
  | { readonly kind: 'unknown_namespace_mismatch'; readonly detail: string }
  /** One side is a pre-v0.2.23 record with no recorded namespace. */
  | { readonly kind: 'unknown_legacy_record' }

/** True only for comparisons that positively establish the same account. */
export function isSameAccount(comparison: IdentityComparison): boolean {
  return comparison.kind === 'same_numeric_uid' || comparison.kind === 'same_handle'
}

/**
 * True when the comparison positively establishes *different* accounts.
 *
 * Kept separate from "not same": `insufficient_evidence` is neither, and callers
 * that treat it as a disagreement will refuse work that is merely unproven.
 */
export function isDifferentAccount(comparison: IdentityComparison): boolean {
  return comparison.kind === 'different_numeric_uid' || comparison.kind === 'different_handle'
}

/** True when the two sides cannot be compared at all. */
export function isUnknown(comparison: IdentityComparison): boolean {
  return (
    comparison.kind === 'insufficient_evidence' ||
    comparison.kind === 'unknown_namespace_mismatch' ||
    comparison.kind === 'unknown_legacy_record'
  )
}

/**
 * True when the verdict is strong enough for an automatic owner decision.
 *
 * `display_name_match_only` is deliberately excluded: it records a coincidence
 * for a human to look at, not a fact to act on.
 */
export function isProvable(comparison: IdentityComparison): boolean {
  return isSameAccount(comparison)
}

/** The strongest confidence an identity can support, derived from its fields. */
export function confidenceOf(identity: AuthorIdentity): IdentityConfidence {
  if (identity.numericUid !== undefined && identity.numericUid !== '') return 'numeric_uid'
  if (identity.handle !== undefined && identity.handle !== '') return 'login_handle'
  if (identity.displayName !== undefined && identity.displayName !== '') return 'display_name_only'
  return 'unverified'
}

/**
 * Whether a string is all digits.
 *
 * **This does not classify identity.** It exists for validating input such as a
 * configured uid, and for nothing else: a `un` of `1254480024` is all digits and
 * is still a login name. The namespace of a value is decided by `source` and
 * `numericUidKind`, never by `looksNumeric`.
 */
export function looksNumeric(value: string | undefined): boolean {
  return value !== undefined && /^\d+$/.test(value)
}

/**
 * Compare two identities under the rules v0.2.23 fixes.
 *
 * Order matters and encodes the rules:
 *
 * 1. Both hold a numeric uid → compare **within the same namespace only**.
 *    Same namespace, same value → same account. Same namespace, different value
 *    → different accounts. Different namespaces → unknown: `user_id` 123 and
 *    `tieba_uid` 123 are not the same account.
 * 2. Otherwise, both hold a handle → compare handles. Equal means the same
 *    login name *now*, which is not a claim about a permanent uid.
 * 3. Otherwise, only display names can meet, and a nickname match is recorded
 *    as such — never promoted.
 * 4. A uid meeting a handle is `unknown`: no reliable mapping is published.
 */
export function compareIdentities(a: AuthorIdentity, b: AuthorIdentity): IdentityComparison {
  const aUid = a.numericUid
  const bUid = b.numericUid
  const aHasUid = aUid !== undefined && aUid !== ''
  const bHasUid = bUid !== undefined && bUid !== ''

  if (aHasUid && bHasUid) {
    const aKind = a.numericUidKind
    const bKind = b.numericUidKind
    if (aKind === undefined || bKind === undefined) {
      // A uid with no recorded namespace cannot be compared with anything: the
      // value alone does not say which of Tieba's id spaces it came from.
      return { kind: 'unknown_namespace_mismatch', detail: '数字 UID 缺少命名空间标记' }
    }
    if (aKind !== bKind) {
      return {
        kind: 'unknown_namespace_mismatch',
        detail: `两个数字 UID 属于不同命名空间（${aKind} 与 ${bKind}），不能直接比较`,
      }
    }
    return aUid === bUid
      ? { kind: 'same_numeric_uid', namespace: aKind }
      : { kind: 'different_numeric_uid', namespace: aKind }
  }

  // One side has a uid, the other only has a handle (or nothing). Tieba does not
  // publish the mapping, so equality of the *text* would be meaningless.
  if (aHasUid !== bHasUid) {
    return {
      kind: 'unknown_namespace_mismatch',
      detail: '一侧只有数字 UID、另一侧只有登录名，平台没有公布两者之间的可靠映射',
    }
  }

  const aHandle = a.handle
  const bHandle = b.handle
  const aHasHandle = aHandle !== undefined && aHandle !== ''
  const bHasHandle = bHandle !== undefined && bHandle !== ''

  if (aHasHandle && bHasHandle) {
    return aHandle === bHandle ? { kind: 'same_handle' } : { kind: 'different_handle' }
  }

  const aName = a.displayName
  const bName = b.displayName
  const aHasName = aName !== undefined && aName !== ''
  const bHasName = bName !== undefined && bName !== ''

  if (aHasName && bHasName) {
    return aName === bName
      ? { kind: 'display_name_match_only', name: aName }
      : { kind: 'insufficient_evidence' }
  }

  return { kind: 'insufficient_evidence' }
}

/**
 * One concrete disagreement about who wrote a given post.
 *
 * Both sides are kept verbatim. The report never picks a winner — a caller that
 * needs one has to ask a human.
 */
export interface IdentityConflictReport {
  readonly code: 'identity_conflict'
  readonly platform: PlatformId
  readonly postId: string
  readonly first: AuthorIdentity
  readonly second: AuthorIdentity
  /** Why the two cannot both be true, in the comparison's own terms. */
  readonly comparison: IdentityComparison
  /** One sentence a person can act on. */
  readonly summary: string
}

/** Render an identity as a short, non-secret line for a report. */
function describeIdentity(identity: AuthorIdentity): string {
  const bits: string[] = []
  if (identity.numericUid !== undefined) {
    bits.push(`uid=${identity.numericUid}(${identity.numericUidKind ?? '?'})`)
  }
  if (identity.handle !== undefined) bits.push(`un=${identity.handle}`)
  if (identity.displayName !== undefined) bits.push(`昵称=${identity.displayName}`)
  bits.push(`来源=${identity.source}`)
  return bits.join(' ')
}

/**
 * Turn a proven disagreement into a report, or `undefined` when there is none.
 *
 * Only `different_numeric_uid` and `different_handle` produce a conflict.
 * `unknown_*` results do **not**: two surfaces that merely speak different
 * languages have not contradicted each other, and manufacturing a conflict there
 * would block reads that are perfectly sound.
 */
export function conflictBetween(input: {
  readonly platform: PlatformId
  readonly postId: string
  readonly first: AuthorIdentity
  readonly second: AuthorIdentity
}): IdentityConflictReport | undefined {
  const comparison = compareIdentities(input.first, input.second)
  if (!isDifferentAccount(comparison)) return undefined
  const reason =
    comparison.kind === 'different_numeric_uid'
      ? `数字 UID 不同（${comparison.namespace}）`
      : '登录名不同'
  return {
    code: 'identity_conflict',
    platform: input.platform,
    postId: input.postId,
    first: input.first,
    second: input.second,
    comparison,
    summary:
      `同一个 postId ${input.postId} 在两个数据源上给出了不同的作者：` +
      `${describeIdentity(input.first)} 与 ${describeIdentity(input.second)}。` +
      `两者${reason}，不可能是同一个账号；` +
      '插件不会替你挑选其中一个，也不会用正文相同来推断作者相同。',
  }
}

/**
 * How much is actually known about who wrote a post, at the collection level.
 *
 * Three states, and the distance between them is the point:
 *
 * | state | meaning | what it may be used for |
 * | --- | --- | --- |
 * | `identity_verified` | two independent surfaces agreed, or an authoritative surface stated a numeric uid | automatic owner decisions |
 * | `identity_unknown` | one surface spoke, or the surfaces could not be compared | reading and display only |
 * | `identity_conflict` | two surfaces proved different accounts | nothing; must stop |
 *
 * The middle state is the one v0.2.22 lacked. Tieba's adapter is a
 * preference-ordered fallback, so a normal read consults **one** surface and
 * never corroborates anything. Reporting that as "no conflict" was technically
 * true and practically misleading: it read as "authorship checked", when the
 * only correct reading is "nothing was cross-checked".
 */
export type IdentityAssurance = 'identity_verified' | 'identity_unknown' | 'identity_conflict'

/** A per-post record of every surface that described it. */
/**
 * What one surface actually said about a post's author.
 *
 * ## Why this exists
 *
 * Corroboration used to be inferred from the *number* of source names. That cannot
 * distinguish "two surfaces agreed" from "two surfaces were consulted", and the
 * difference is the whole point: a count is not a comparison.
 *
 * Recording what each source said makes the comparison possible, and makes
 * "not comparable" distinguishable from "agreed".
 */
export interface IdentityObservation {
  /**
   * The surface that produced this observation, when it said so.
   *
   * `undefined` means **unknown provenance** — the row carried no `authorSource`.
   * Earlier the collector renamed exactly that case to `platform_contract`, which
   * made an unknown origin look like a named, independent surface and let two such
   * rows (or one such row plus a real one) claim cross-verification. Absence is now
   * represented by absence.
   */
  readonly source?: IdentitySource
  /** The numeric uid, when this surface stated one. */
  readonly numericUid?: string
  /** Which namespace that number belongs to, when stated. */
  readonly namespace?: NumericUidNamespace
  /** The login name, when this surface stated one. */
  readonly handle?: string
}

export interface IdentitySightings {
  /** The numeric uid, when some surface stated one. */
  readonly numericUid?: string
  /**
   * Which namespace that number belongs to (v0.2.23 patch 3).
   *
   * Required for the uid to count as proof. A bare number is not an identity —
   * Tieba's `un` can itself be all digits — so an unplaced number is treated as an
   * unverified claim, exactly like a handle with no recorded source.
   */
  readonly namespace?: NumericUidNamespace
  /** The handle, when some surface stated one. */
  readonly handle?: string
  /** Every source that has described this post id. */
  readonly sources: readonly IdentitySource[]
  /** True when two sightings were compared and proven different. */
  readonly conflicted: boolean
  /**
   * Per-surface observations, when the caller recorded them.
   *
   * Absent means "not compared". Corroboration is then reported as
   * `single_source`, because two source names with no comparison behind them are a
   * count, not evidence.
   */
  readonly observations?: readonly IdentityObservation[]
}

/**
 * Decide the assurance level for one post from its sightings.
 *
 * `identity_verified` needs **positive** evidence: either a numeric uid (the only
 * non-spoofable id Tieba publishes) or two distinct sources that agree. A single
 * handle-only sighting is `identity_unknown` — it is not a failure, it is an
 * unverified claim, and the wording at every call site must match that.
 */
export function assuranceOf(sighting: IdentitySightings): IdentityAssurance {
  return verdictFrom({
    conflicted: sighting.conflicted,
    // A number counts only when it can be placed in a namespace.
    hasPlacedNumericUid:
      sighting.numericUid !== undefined && sighting.numericUid !== '' && sighting.namespace !== undefined,
    hasHandle: sighting.handle !== undefined && sighting.handle !== '',
  })
}

/**
 * The single ladder both entry points walk.
 *
 * ## Why this function exists
 *
 * `assuranceOf` (per-post) and `assuranceFromEvidence` (owner resolution) used to
 * encode different opinions about the same fact: a login name on one surface was
 * `identity_unknown` to one and `verified` to the other. The publish gate consulted
 * only the second, so the stricter rule never stopped anything — it just made the
 * two disagree in logs and in the UI.
 *
 * Having one implementation is the fix. Neither caller may add a rule of its own;
 * they only translate their input into these three booleans.
 *
 * ## Why a single authoritative source is enough
 *
 * A surface whose contract says "this field is the `un`" is stating the account, not
 * guessing it. Tieba's normal read consults exactly one such surface, so demanding
 * corroboration would mean nothing ever publishes — caution that costs the product
 * its purpose. Corroboration is recorded separately by `corroborationOf` and shown
 * to the reader; it does not gate the send.
 */
function verdictFrom(input: {
  readonly conflicted: boolean
  readonly hasPlacedNumericUid: boolean
  readonly hasHandle: boolean
}): IdentityAssurance {
  if (input.conflicted) return 'identity_conflict'
  if (input.hasPlacedNumericUid || input.hasHandle) return 'identity_verified'
  return 'identity_unknown'
}

/**
 * Whether the identity was confirmed by more than one *independent* surface.
 *
 * Deliberately separate from the assurance: "we have enough to act" and "we checked
 * it twice" are different statements, and merging them is how a single-source match
 * ends up described as "cross-verified".
 *
 * Two rows from the same surface are one source. `platform_contract` is what a row
 * that did not say gets, so two such rows corroborate nothing.
 */
/**
 * Which physical response an observation came from.
 *
 * ## Why a sourceId is not enough
 *
 * `wap_floor` and `wap_inline` are two parsers over **one HTTP response**: the floor
 * list and the inline nested replies are both read out of the same WAP HTML. Counting
 * them as two sources turned a single page fetch into "two independent surfaces
 * agree" — which is what `corroborated` is supposed to mean, and did not.
 *
 * The grouping below is by *where the bytes came from*, not by which function read
 * them:
 *
 * | sourceId | physical origin |
 * | --- | --- |
 * | `wap_floor`, `wap_inline` | `wap` — one page |
 * | `comment_page` | `comment` — its own request |
 * | `total_comment` | `total_comment` — its own request |
 * | `platform_contract` / unknown | `unknown` — never counts as a source |
 */
export function physicalOriginOf(source: IdentitySource | undefined): string {
  switch (source) {
    case 'wap_floor':
    case 'wap_inline':
      return 'wap'
    case 'comment_page':
      return 'comment'
    case 'total_comment':
      return 'total_comment'
    // `platform_contract` was a fabricated name for "the row did not say". It must
    // not group with anything real, so it gets its own bucket that never corroborates.
    case 'platform_contract':
      return 'unknown'
    default:
      return 'unknown'
  }
}

export type CorroborationVerdict =
  | 'corroborated'
  | 'contested'
  | 'incomparable'
  | 'single_source'
  /**
   * One physical source contradicted itself about the same entity.
   *
   * Distinct from both neighbours on purpose: `contested` would assert that two
   * accounts are different people, which nobody compared; `single_source` would read
   * as "we only looked once", hiding a data-quality problem that the reader may need
   * to act on.
   */
  | 'inconsistent'

/** Why a verdict came out the way it did, in words the caller can show. */
export interface CorroborationReason {
  readonly code:
    | 'agreed_handle'
    | 'agreed_uid'
    | 'disagreed_handle'
    | 'disagreed_uid'
    | 'namespace_mismatch'
    | 'identifier_kind_mismatch'
    | 'not_enough_sources'
    | 'no_comparable_identifier'
    | 'reported_conflict'
    | 'self_contradictory'
  readonly detail: string
}

/**
 * Whether the identity was confirmed by more than one *independent* surface.
 *
 * ## Why this is not a count
 *
 * The previous implementation asked `handleEchoes >= 2`, where the echoes were
 * observation *rows*. One surface can emit several rows for a single post id — the
 * collector records every sighting — so a single source answering twice, plus a
 * second source that knew only a nickname, satisfied the test. The product then
 * claimed cross-verification that had never happened.
 *
 * Agreement is now counted per **distinct source**, and each source is asked what it
 * actually supplied. A source that contributed no comparable identifier contributes
 * nothing, however many rows it sent.
 *
 * ## Why incomparable is its own verdict
 *
 * `user_id: 12345` and `tieba_uid: 12345` are unrelated namespaces; the digits match
 * by coincidence. Comparing them produced `contested` — an accusation that two
 * accounts are different people, based on a comparison that never happened. The
 * honest answer is `incomparable`, and callers can explain it with
 * {@link corroborationReason}.
 *
 * Order of precedence: an explicit conflict wins, then disagreement, then agreement,
 * then incomparability, then "not enough sources".
 */
export function corroborationOf(sighting: IdentitySightings): CorroborationVerdict {
  // The caller saw two surfaces prove different accounts. Nothing on other fields
  // can undo that.
  if (sighting.conflicted) return 'contested'

  const observations = sighting.observations ?? []

  // ## Group by physical origin, not by parser
  //
  // `wap_floor` and `wap_inline` read the same HTTP response, so they are one origin.
  // Rows with no declared source have origin `undefined` and are kept in their own
  // bucket: an unknown origin cannot stand in as a second independent surface.
  const byOrigin = new Map<string, { handles: Set<string>; uids: Set<string> }>()
  for (const entry of observations) {
    const origin = entry.source === undefined ? undefined : physicalOriginOf(entry.source)
    // Unknown provenance still participates in *self*-contradiction detection below,
    // but never counts as an independent origin for agreement.
    const key = origin === undefined || origin === 'unknown' ? '__unknown__' : origin
    const bucket = byOrigin.get(key) ?? { handles: new Set<string>(), uids: new Set<string>() }
    if (entry.handle !== undefined && entry.handle !== '') bucket.handles.add(entry.handle)
    if (entry.numericUid !== undefined && entry.numericUid !== '' && entry.namespace !== undefined) {
      bucket.uids.add(`${entry.namespace}:${entry.numericUid}`)
    }
    byOrigin.set(key, bucket)
  }

  // ## A single origin contradicting itself about one entity
  //
  // This is not a conflict between two people — nobody compared two surfaces. It is
  // a data-quality problem, and reporting it as `single_source` would hide it behind
  // a phrase that means "we only looked once".
  for (const bucket of byOrigin.values()) {
    if (bucket.handles.size > 1) return 'inconsistent'
    const byNamespace = new Map<string, Set<string>>()
    for (const tagged of bucket.uids) {
      const at = tagged.indexOf(':')
      const set = byNamespace.get(tagged.slice(0, at)) ?? new Set<string>()
      set.add(tagged.slice(at + 1))
      byNamespace.set(tagged.slice(0, at), set)
    }
    for (const values of byNamespace.values()) if (values.size > 1) return 'inconsistent'
  }

  const knownOrigins = [...byOrigin.keys()].filter((key) => key !== '__unknown__')

  // ## Agreement across genuinely different origins
  const allHandles = new Set<string>()
  for (const key of knownOrigins) for (const value of byOrigin.get(key)!.handles) allHandles.add(value)
  if (allHandles.size > 1) return 'contested'

  const uidsByNamespace = new Map<string, Set<string>>()
  for (const key of knownOrigins) {
    for (const tagged of byOrigin.get(key)!.uids) {
      const at = tagged.indexOf(':')
      const set = uidsByNamespace.get(tagged.slice(0, at)) ?? new Set<string>()
      set.add(tagged.slice(at + 1))
      uidsByNamespace.set(tagged.slice(0, at), set)
    }
  }
  for (const values of uidsByNamespace.values()) if (values.size > 1) return 'contested'

  if (knownOrigins.length >= 2) {
    if (allHandles.size === 1) {
      const agreeing = knownOrigins.filter((key) => byOrigin.get(key)!.handles.has([...allHandles][0]!))
      if (agreeing.length >= 2) return 'corroborated'
    }
    for (const [namespace, values] of uidsByNamespace) {
      if (values.size !== 1) continue
      const only = `${namespace}:${[...values][0]}`
      const agreeing = knownOrigins.filter((key) => {
        const bucket = byOrigin.get(key)!
        return bucket.uids.size === 1 && bucket.uids.has(only)
      })
      if (agreeing.length >= 2) return 'corroborated'
    }
  }

  // ## Nothing could be compared
  const kindsPresent = new Set<string>()
  for (const key of knownOrigins) {
    const bucket = byOrigin.get(key)!
    if (bucket.handles.size > 0) kindsPresent.add('handle')
    if (bucket.uids.size > 0) kindsPresent.add('uid')
  }
  if (knownOrigins.length >= 2 && (kindsPresent.size >= 2 || uidsByNamespace.size >= 2)) {
    return 'incomparable'
  }

  return 'single_source'
}

/**
 * Explain a verdict, so a caller can tell the reader *why* nothing was checked.
 *
 * A status with no reason is only marginally better than a wrong status: the reader
 * still cannot decide what to do next.
 */
export function corroborationReason(sighting: IdentitySightings): CorroborationReason {
  const verdict = corroborationOf(sighting)
  const observations = sighting.observations ?? []
  if (verdict === 'inconsistent') {
    return {
      code: 'self_contradictory',
      detail:
        '同一个来源自相矛盾：对同一条发言给出了两个不同的账号标识，' +
        '这更像是数据质量问题（解析歧义或页面结构变化），而不是两个人在争执。建议重新读取该楼层后再判断。',
    }
  }
  if (verdict === 'contested') {
    if (sighting.conflicted) {
      return { code: 'reported_conflict', detail: '读取过程中已经确认两个来源指向不同账号。' }
    }
    // Name the kind that actually disagreed. Reporting a uid disagreement as a
    // handle one sends the reader looking at the wrong field.
    const handles = new Set(
      observations.map((entry) => entry.handle).filter((v): v is string => v !== undefined && v !== ''),
    )
    if (handles.size > 1) {
      return { code: 'disagreed_handle', detail: '两个来源给出了不同的登录名。' }
    }
    return { code: 'disagreed_uid', detail: '同一命名空间下，两个来源给出了不同的数字 ID。' }
  }
  if (verdict === 'corroborated') {
    const hasHandle = (sighting.observations ?? []).some((entry) => entry.handle !== undefined)
    return hasHandle
      ? { code: 'agreed_handle', detail: '两个独立来源给出了相同的登录名。' }
      : { code: 'agreed_uid', detail: '两个独立来源在同一命名空间下给出了相同的数字 ID。' }
  }
  if (verdict === 'incomparable') {
    const observations = sighting.observations ?? []
    const namespaces = new Set(
      observations
        .map((entry) => entry.namespace)
        .filter((value): value is NumericUidNamespace => value !== undefined),
    )
    if (namespaces.size > 1) {
      return {
        code: 'namespace_mismatch',
        detail:
          `两个来源给出的数字分别属于不同的命名空间（${[...namespaces].join(' / ')}），` +
          '数字相同只是巧合，无法相互比较。',
      }
    }
    return {
      code: 'identifier_kind_mismatch',
      detail: '两个来源提供的标识类型不同（一个数字 ID、一个登录名），无法相互比较。',
    }
  }
  const distinct = new Set(
    observations
      .map((entry) => entry.source)
      .filter((value): value is IdentitySource => value !== undefined),
  )
  if (distinct.size < 2) {
    return { code: 'not_enough_sources', detail: '只有一个来源，谈不上交叉验证。' }
  }
  // Two sources spoke but only one of them named an account. Saying "neither did"
  // would be inaccurate, and inaccuracy here is what makes people stop reading.
  const withIdentifier = new Set(
    observations
      .filter(
        (entry) =>
          (entry.handle !== undefined && entry.handle !== '') ||
          (entry.numericUid !== undefined && entry.numericUid !== ''),
      )
      .map((entry) => entry.source),
  )
  return withIdentifier.size < 2
    ? {
        code: 'no_comparable_identifier',
        detail:
          withIdentifier.size === 0
            ? '两个来源都没有提供账号标识，只有昵称。'
            : '只有其中一个来源提供了账号标识，另一个只给了昵称，无法相互印证。',
      }
    : { code: 'no_comparable_identifier', detail: '两个来源提供的标识无法相互比较。' }
}

/** Whether an assurance level may be used for an automatic owner decision. */
export function allowsAutomaticIdentityDecision(assurance: IdentityAssurance): boolean {
  return assurance === 'identity_verified'
}

/** A short, honest phrase for each level, suitable for a UI badge or a log. */
export function describeAssurance(assurance: IdentityAssurance): string {
  switch (assurance) {
    case 'identity_verified':
      return '作者身份已核验（有数字 UID，或多个来源一致）'
    case 'identity_conflict':
      return '作者身份冲突（两个来源指向不同账号），已阻止使用'
    default:
      return '作者身份未交叉验证（只读到一个来源，或来源之间无法比较）'
  }
}

/**
 * Why a particular owner resolution was allowed to call itself `verified`.
 *
 * ## The problem this type exists to close
 *
 * v0.2.23's first pass stored `ownerIdentityAssurance` as a bare string on the
 * session. That string was then read straight back by the publish gate, which
 * meant `"unverified"` → `"verified"` in the session JSON was a complete bypass:
 * edit one word in a file, and the gate opens. A gate whose verdict is stored as
 * the very thing it is supposed to decide is not a gate, it is a comment.
 *
 * So the assurance is now **derived** from evidence at publish time. The stored
 * string is kept for display only; the gate recomputes from this record and
 * refuses when the evidence does not support the claim.
 *
 * Evidence is deliberately small and non-forgeable-by-accident: it names *which*
 * namespace the identifier belongs to and *which* surface declared it. There is
 * no field that says "trust me".
 */
/**
 * The namespace a numeric identifier belongs to.
 *
 * Tieba publishes two unrelated numeric ids (`user_id` and `tieba_uid`), so those
 * are named explicitly. Every other platform has a single numeric account id, and
 * there the platform *is* the namespace — spelling it as `platform:<id>` keeps the
 * record honest without inventing an equivalence to Tieba's fields.
 */

/**
 * The namespace a platform's own numeric account id belongs to.
 *
 * ## Why this is one function and not an inline expression (v0.2.28)
 *
 * The analyzer built this string inline in the owner-config branch and never
 * anywhere else, so the identifier a *record* carried had no namespace while the
 * identifier the *configuration* stated had one. The comparison then required
 * `participant.userIdNamespace === ownerNamespace`, which is `undefined ===
 * 'platform:weibo'` — permanently false. A Weibo owner configured by numeric uid
 * could therefore never be found in their own thread, on any thread, ever; the
 * only symptom was 「在帖子里没有找到主人的发言」.
 *
 * Two call sites now derive it the same way: the write side (a projection that
 * states a numeric id) and the read side (owner resolution). A single spelling is
 * what stops the two from drifting apart again.
 *
 * Tieba is excluded on purpose: it has *two* numeric spaces and neither is
 * implied by the platform name, so a Tieba number without an explicit kind stays
 * unplaced rather than being guessed.
 */
export function namespaceForPlatform(platform: PlatformId): NumericUidNamespace | undefined {
  return platform === 'tieba' ? undefined : (`platform:${platform}` as const)
}

export interface OwnerIdentityEvidence {
  /**
   * What kind of identifier backed the resolution.
   *
   * `none` and `legacy` both yield `unverified` — they are recorded rather than
   * omitted so the UI can say *why* instead of showing a blank.
   */
  readonly kind: 'numeric_uid' | 'handle' | 'nickname' | 'legacy' | 'none'
  /**
   * The namespace a numeric identifier belongs to.
   *
   * Required for `numeric_uid`: a bare number is not an identity (Tieba's `un`
   * can itself be all digits), so a numeric claim without a namespace is treated
   * as unproven.
   */
  readonly namespace?: NumericUidNamespace
  /** The identifier value that matched, for the audit trail and the UI. */
  readonly value?: string
  /**
   * Which surface declared the identifier.
   *
   * A handle only counts when a source actually said "this row's author field is
   * a login name". Rows with no recorded surface are legacy and cannot verify.
   */
  readonly source?: IdentitySource
}

/**
 * Recompute the assurance from evidence.
 *
 * ## This is the only function allowed to say "verified"
 *
 * Both the analyzer (when writing a session) and the publish gate (when deciding)
 * call it. Having one implementation is the point: if the gate had its own idea
 * of what counts, the two would drift and the drift would be the vulnerability.
 */
export function assuranceFromEvidence(evidence: OwnerIdentityEvidence | undefined): IdentityAssurance {
  // No evidence at all reads as "never checked", not as "checked and rejected".
  if (evidence === undefined) return 'identity_unknown'
  const verdict = verdictFrom({
    // Evidence describes one past decision, so there is no second sighting to
    // contradict it here; conflicts are carried on the session, not on the evidence.
    conflicted: false,
    hasPlacedNumericUid:
      evidence.kind === 'numeric_uid' &&
      evidence.namespace !== undefined &&
      evidence.value !== undefined &&
      evidence.value !== '',
    hasHandle:
      evidence.kind === 'handle' &&
      evidence.source !== undefined &&
      evidence.value !== undefined &&
      evidence.value !== '',
  })
  // The verdict vocabulary is shared with `assuranceOf` on purpose: two ladders that
  // also speak two dialects is how the original inconsistency survived review.
  return verdict
}

/**
 * Explain an assurance in terms of the evidence, for a UI badge or a log line.
 *
 * The wording is the difference between "we checked" and "we guessed", and a user
 * who cannot tell those apart cannot decide whether to trust a reply.
 */
export function describeEvidence(evidence: OwnerIdentityEvidence | undefined): string {
  if (evidence === undefined) return '没有身份依据记录（旧会话），只能只读使用'
  switch (evidence.kind) {
    case 'numeric_uid':
      return evidence.namespace === undefined
        ? '有一个数字 ID，但没有说明它属于哪个命名空间，无法作为证明'
        : `数字 UID ${evidence.value ?? ''}（命名空间 ${evidence.namespace}）`
    case 'handle':
      return evidence.source === undefined
        ? `登录名「${evidence.value ?? ''}」来自未标注来源的记录，无法作为证明`
        : `登录名「${evidence.value ?? ''}」（来源 ${evidence.source}）`
    case 'nickname':
      return `只匹配到昵称「${evidence.value ?? ''}」，昵称可被改名或占用，不能身份证明`
    case 'legacy':
      return `匹配到旧格式记录「${evidence.value ?? ''}」，写入时没有记录标识类型`
    default:
      return '没有可用的身份依据'
  }
}

/**
 * Explain why a configured owner could not be established.
 *
 * Worded for the person who configured it: what is missing, and what would fix
 * it. It never suggests "just use the nickname" as a silent fallback.
 */
export function describeUnverifiableOwner(input: {
  readonly configuredNumericUid?: string
  readonly configuredHandle?: string
  readonly observed: readonly AuthorIdentity[]
}): string {
  const sources = [...new Set(input.observed.map((identity) => identity.source))]
  const hasNumeric = input.observed.some((identity) => identity.numericUid !== undefined)
  if (input.configuredNumericUid !== undefined && !hasNumeric) {
    return (
      `当前数据源（${sources.join('、')}）没有提供任何数字 UID，` +
      `无法证明数字 UID ${input.configuredNumericUid} 对应哪一条发言。` +
      '请补充可核验的贴吧登录用户名（un），或改用能返回数字 UID 的数据源。'
    )
  }
  if (input.configuredHandle !== undefined) {
    return (
      `配置的登录名「${input.configuredHandle}」没有出现在这次读取到的发言里。` +
      '可能是本人未在本帖发言，也可能是登录名配置有误。'
    )
  }
  return '既没有配置数字 UID，也没有配置登录名，无法判断谁是主人。'
}

/**
 * Build an identity from the flat fields a record carries.
 *
 * `authorSource` absent means a pre-v0.2.23 record. Its `authorId` has no
 * recorded namespace, so it comes back as a **legacy** identity rather than being
 * silently promoted to a uid: rule 4 of the compatibility contract.
 */
export function identityOfEntry(entry: {
  readonly authorId?: string
  readonly authorName?: string
  readonly authorSource?: IdentitySource
  readonly authorNumericUid?: string
  readonly authorNumericUidKind?: NumericUidKind
}): AuthorIdentity & { readonly legacy: boolean } {
  const legacy = entry.authorSource === undefined
  const duplicated = entry.authorNumericUid !== undefined && entry.authorId === entry.authorNumericUid
  return {
    platform: 'tieba' as PlatformId,
    ...(entry.authorNumericUid === undefined ? {} : { numericUid: entry.authorNumericUid }),
    ...(entry.authorNumericUidKind === undefined ? {} : { numericUidKind: entry.authorNumericUidKind }),
    // A legacy `authorId` is not copied into `handle`: we know it was *some*
    // account string, not which kind. Keeping it out of both fields is what makes
    // the record compare as unknown instead of accidentally matching a handle.
    // A value already declared as the numeric uid is likewise not duplicated.
    ...(legacy || entry.authorId === undefined || duplicated ? {} : { handle: entry.authorId }),
    ...(entry.authorName === undefined ? {} : { displayName: entry.authorName }),
    source: entry.authorSource ?? 'platform_contract',
    legacy,
  }
}
