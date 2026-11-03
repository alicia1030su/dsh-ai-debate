/**
 * Argument reconstruction.
 *
 * This module answers three questions with **rules, not vibes**:
 *
 * 1. Who is the owner in this thread? (stable id, falling back to the username
 *    only when the platform gives no id)
 * 2. Who is the owner actually arguing with? (reply edges and interaction
 *    counts — never "whoever spoke last")
 * 3. What is the dispute? (owner's claims, opponent's claims, open questions)
 *
 * Everything it produces is evidence-linked: every claim carries the post id it
 * came from, so the generator can quote rather than invent, and the validator
 * can check that the reply target exists.
 */

import type { NestedReply, PlatformId } from './types.js'
import type { CollectedThread, TimelineEntry } from './collector.js'
import { buildTimeline, floorOf } from './collector.js'
import type { IdentitySource, OwnerIdentityEvidence } from './identity.js'

/** How the owner was identified. */
export type OwnerMatchKind = 'id' | 'name'

/** A person in the conversation. */
export interface Participant {
  /** Display name; also the merge key for identity across mixed handles. */
  readonly key: string
  /**
   * Numeric platform account id, **only** when a surface stated one (v0.2.23).
   *
   * Before v0.2.23 this field held the login name (`un`), because Tieba's WAP
   * page is the only surface most reads use and it exposes nothing numeric. That
   * made `participant.userId === owner.userId` a comparison between a handle and
   * a uid: always false, and — worse — it made `anyIdsExposed` true, so the
   * owner check took the "the id is wrong" branch and never said "this surface
   * cannot prove ids at all".
   */
  readonly userId?: string
  /** Login name (`un` / `username`), the strongest identity a WAP read offers. */
  readonly handle?: string
  /**
   * A pre-v0.2.23 account string whose namespace was never recorded (v0.2.23).
   *
   * On Tieba, v0.2.22 documented `authorId` as the `un` login name, so this is
   * read as a handle for display purposes. It is kept in its own field because a
   * historical record cannot prove it was a handle any more than it can prove it
   * was a uid — and an owner match that relies on it must say so rather than
   * present itself as a uid match.
   */
  readonly legacyAccountId?: string
  /**
   * Which namespace the numeric uid belongs to, as *observed* (v0.2.23 patch 4).
   *
   * This must come from the record that carried the number, never from the owner's
   * configuration. Deriving it from the config is what let a `tieba_uid: 12345`
   * owner match a `user_id: 12345` post: the numbers were equal, the namespaces were
   * not, and the evidence then recorded the *configured* namespace — producing a
   * record that looked consistent with a match that never happened.
   */
  readonly userIdNamespace?: 'user_id' | 'tieba_uid'
  /** The platform the numeric uid was read from, for the same reason. */
  readonly platform?: string
  /**
   * Which surface this participant's records came from (v0.2.23).
   *
   * Carried onto the evidence so a handle match can say *where* the login name was
   * seen. Absent for all-legacy participants, which is precisely why they cannot
   * be verified.
   */
  readonly source?: IdentitySource
  /**
   * True when at least one of this participant's records declared which surface it
   * came from (v0.2.23).
   *
   * A participant built entirely from legacy rows can be *displayed* and
   * *analysed*, but cannot be called verified: we never learned what kind of
   * account string those rows held. Without this flag, a legacy row whose
   * `authorId` happened to equal a configured handle would have resolved as
   * `verified` — the exact up-grade rule 2 of the compatibility contract forbids.
   */
  readonly hasDeclaredSource?: boolean
  readonly displayName: string
  /** How the key was derived, so the UI can explain a name-based match. */
  readonly matchKind: OwnerMatchKind
  readonly postCount: number
  readonly lastPostId?: string
  readonly lastSpokeIndex: number
  /**
   * How many distinct account handles appeared under this display name.
   *
   * The platform is inconsistent about exposing a handle, so one person can show
   * up with and without one. This counter lets the owner check refuse a name
   * that genuinely maps to several accounts, without splitting one person in two.
   */
  readonly distinctHandles?: number
}

/** One statement attributed to a participant. */
export interface Statement {
  readonly postId: string
  readonly floorNumber?: number
  readonly authorKey: string
  readonly authorName?: string
  readonly content: string
  readonly createdAt?: string
  /** The name this statement answers, when the platform stated one. */
  readonly replyToName?: string
}

/** Why the analyzer picked a particular opponent. */
export interface OpponentEvidence {
  /** Direct reply edges from owner to this participant, and back. */
  readonly exchanges: number
  /** Owner posts that explicitly answered this participant. */
  readonly ownerRepliesTo: number
  /** Posts from this participant that answered the owner. */
  readonly repliesToOwner: number
  /** Index of the participant's latest post, for recency comparison. */
  readonly lastSpokeIndex: number
  /** Other participants who were still talking, for transparency. */
  readonly otherActiveParticipants: readonly string[]
}

/** The reconstructed dispute. */
export interface Dispute {
  readonly floorNumber?: number
  readonly floorPostId: string
  readonly owner: Participant
  readonly opponent?: Participant
  readonly opponentEvidence?: OpponentEvidence
  /** Ordered exchange between owner and opponent, oldest first. */
  readonly exchange: readonly Statement[]
  /** Every statement the owner made in this thread, oldest first. */
  readonly ownerStatements: readonly Statement[]
  /** Questions from the opponent the owner has not answered. */
  readonly openQuestions: readonly Statement[]
  /**
   * Everyone else who spoke in this floor (v0.2.11).
   *
   * ## Why this is a first-class field rather than a note
   *
   * The exchange is deliberately narrowed to two participants, and that narrowing is what
   * makes the reconstruction readable. The cost was invisible: a third party who said
   * "actually he's right about the price" was dropped from the picture entirely, so an
   * analysis could describe a two-person argument that in fact had a chorus — and the
   * generated reply would then answer one person while ignoring that others had already
   * taken sides.
   *
   * These entries are *not* part of the dispute. They are context the analyzer must show
   * so the owner (and the model) can tell "the opponent is alone" from "the opponent has
   * support", which are different situations calling for different replies.
   *
   * Ordered by how much they said, descending — the loudest bystander first, because that
   * is the one most likely to matter.
   */
  readonly bystanders: readonly Participant[]
  /** True when the opponent could not be identified with confidence. */
  readonly needsConfirmation: boolean
  /** Human-readable reasons for `needsConfirmation`, or for the choice made. */
  readonly notes: readonly string[]
  /**
   * How strongly the owner's identity was established (v0.2.23).
   *
   * - `verified` — a numeric uid matched, or a login handle matched under a
   *   surface that states one.
   * - `unverified` — the owner was resolved (for reading) from a legacy record or
   *   a nickname. The analysis is useful; a publish is not authorised by it.
   *
   * Kept separate from `notes` because prose cannot be enforced. The publish gate
   * reads this field; a note would only be read by a human who happened to look.
   */
  readonly ownerIdentityAssurance: 'verified' | 'unverified'
  /**
   * What backed that assurance (v0.2.23).
   *
   * Carried so the publish gate can *recompute* the verdict instead of trusting a
   * stored string. See `OwnerIdentityEvidence` for why a bare label was not enough.
   */
  readonly ownerIdentityEvidence: OwnerIdentityEvidence
}

/** The trigger that started this task. */
export interface TriggerRef {
  readonly postId: string
  /** Content of the trigger post, already plain text. */
  readonly content?: string
  /** When known, the account that was summoned. */
  readonly aiAccountName?: string
}

/** Owner identity supplied by configuration. */
export interface OwnerIdentity {
  /**
   * The platform this identity belongs to.
   *
   * v0.2.2: **required for any id-based match.** A user id is only meaningful
   * inside one platform — Tieba's `user_id` and Weibo's `uid` are both 9–10 digit
   * decimals in unrelated namespaces. Before this field existed, a single global
   * `ownerUserId` was compared against whatever platform the link happened to
   * point at (`analyzer.ts:345-348` did a bare `===`), so an id collision meant
   * the plugin would argue **on a stranger's behalf under the owner's name** —
   * the failure this module's own comment calls "the single worst outcome".
   *
   * Optional only so old callers keep compiling; `analyzeDispute` refuses an
   * id-based match when it is absent, because an id with no platform cannot be
   * proven to be this owner's.
   */
  readonly platform?: PlatformId
  /** Stable platform id; preferred. */
  readonly userId?: string
  /**
   * Which namespace `userId` belongs to (v0.2.23).
   *
   * A bare number is not an identity: Tieba publishes both a `user_id` and a
   * `tieba_uid`, in unrelated namespaces. Recording which one the config meant
   * lets the gate refuse a numeric claim that cannot be placed.
   */
  readonly userIdNamespace?: 'user_id' | 'tieba_uid'
  /**
   * Login name (`un`) as published by the platform (v0.2.23).
   *
   * This is the only owner field that can match a WAP floor: that surface
   * publishes `un` and no numeric uid. It is matched against `authorId`, which
   * v0.2.23 defines as the handle — never against a numeric uid, and never
   * merged with `userName`, because a login name is not a nickname.
   */
  readonly handle?: string
  /** Display name; used only when no id is configured or matched. */
  readonly userName?: string
}

/**
 * Rebuild the dispute around one trigger post.
 *
 * @param collected the collected thread
 * @param owner the bound owner identity
 * @param trigger the post that summoned the AI
 * @returns the dispute, with `needsConfirmation` set when the target is unclear
 */
export function analyzeDispute(
  collected: CollectedThread,
  owner: OwnerIdentity,
  trigger: TriggerRef,
): Dispute {
  // Refuse to reason about a thread on a platform other than the one the owner
  // identity was configured for.
  //
  // This is the cross-platform half of the impostor defence. The in-platform half
  // (below, in `resolveOwnerKey`) already refuses to degrade an id to a nickname;
  // it could not, however, notice that the id came from a *different* platform,
  // because a bare `===` between two 9-digit decimals cannot tell Tieba's
  // `user_id` from Weibo's `uid`. An owner id that happens to collide would have
  // been accepted as the owner, and the plugin would argue on a stranger's behalf
  // under the owner's name.
  //
  // Only enforced when the caller states a platform. An identity with no platform
  // predates v0.2.2; it is widened to the thread's platform below, which is the
  // same assumption the old code made implicitly — and is safe *within* one
  // platform. The cross-platform boundary proper is `ownerIdentity()` in
  // `runtime.ts`, which refuses to hand one platform's id to another at all.
  const threadPlatform = collected.thread.platform
  const effectiveOwner: OwnerIdentity =
    owner.platform === undefined ? { ...owner, platform: threadPlatform } : owner
  if (effectiveOwner.platform !== threadPlatform) {
    throw new Error(
      `主人的账号绑定在「${effectiveOwner.platform}」，但这篇帖子属于「${threadPlatform}」。` +
        '同一个用户 ID 在不同平台上指向不同的人，插件不会跨平台复用身份。' +
        `请为「${threadPlatform}」单独配置主人账号（或在该平台没有绑定前台使用只读功能）。`,
    )
  }

  const timeline = buildTimeline(collected)
  const target = timeline.find((entry) => entry.postId === trigger.postId)
  if (!target) {
    throw new Error(`触发回复 ${trigger.postId} 不在已采集的对话中，无法分析`)
  }
  const container = floorOf(collected, trigger.postId)
  if (!container) {
    throw new Error(`触发回复 ${trigger.postId} 不属于任何已采集楼层`)
  }

  const notes: string[] = []
  // Identity is resolved once, up front: the platform mixes name-shaped and
  // numeric handles across surfaces, so every later comparison must use the
  // same recovery table or two functions can disagree about who is speaking.
  const nameByHandle = buildHandleDirectory(timeline)
  const keyOf = (entry: TimelineEntry): string => resolveKey(entry, nameByHandle)

  // ## Cross-source authorship conflict (v0.2.23)
  //
  // Two surfaces described at least one post id with identities that cannot both
  // be true. There is no correct owner to resolve: if the conflicting post is the
  // trigger, or belongs to the candidate owner, then "who the owner is here" is
  // exactly the question the data just refused to answer.
  //
  // This runs before anything is attributed, and it refuses rather than picking a
  // side. The alternative — keeping the first copy, as v0.2.22 did — makes the
  // plugin argue on behalf of whoever happened to answer first.
  const conflicts = collected.identityConflicts ?? []
  if (conflicts.length > 0) {
    const triggerConflict = conflicts.find((entry) => entry.postId === trigger.postId)
    if (triggerConflict !== undefined) {
      throw new Error(
        `无法确认这条发言的作者：${triggerConflict.summary} ` +
          '触发回复本身存在身份冲突，插件不会替你选择其中一个作者。',
      )
    }
    const affected = new Set(
      conflicts.flatMap((entry) => {
        const ids = [entry.postId]
        return ids
      }),
    )
    const ownerTouchesConflict = timeline.some((entry) => affected.has(entry.postId))
    if (ownerTouchesConflict) {
      const sample = conflicts[0] as (typeof conflicts)[number]
      throw new Error(
        `本次读取存在 ${conflicts.length} 处作者身份冲突，无法确认主人身份。` +
          `例如：${sample.summary} ` +
          '在冲突解决之前，插件不会给出主人的立场，也不会生成可发表的候选。',
      )
    }
  }

  const participants = indexParticipants(timeline, nameByHandle)
  const resolvedOwner = resolveOwnerKey(participants, effectiveOwner, notes)
  const ownerKey = resolvedOwner.key

  // ## Say how well the owner's identity is backed, in words
  //
  // `corroborationOf` was previously exported and called from nowhere, so the
  // "cross-checked" distinction existed only in comments. Surfacing it here is what
  // makes it a fact the reader can act on — and what stops a single-source match from
  // being described as verified-by-two-parties.
  const ownerCorroboration = collected.corroboration?.get(
    // The owner's identity is only corroborated if the *post* that established it was.
    // `ownerKey` is the participant key; the post is the first statement by them.
    timeline.find((entry) => keyOf(entry) === ownerKey)?.postId ?? '',
  )
  if (ownerCorroboration === 'corroborated') {
    notes.push('主人身份由两个独立来源相互印证。')
  } else if (ownerCorroboration === 'contested') {
    notes.push('两个来源对主人的身份给出了不同结论，需要人工核对。')
  } else if (ownerCorroboration !== undefined && resolvedOwner.assurance === 'verified') {
    notes.push('主人身份来源单一，未经第二个来源印证（这不是错误，只是尚未交叉核对）。')
  }
  const ownerParticipant = participants.get(ownerKey)
  if (!ownerParticipant) {
    throw new Error(
      `在帖子里没有找到主人（配置：${owner.userId ?? owner.userName ?? '未配置'}）的发言，` +
        '请确认主人 ID 或昵称是否正确，或该主人在本贴尚未发言',
    )
  }

  const ownerStatements = timeline
    .filter((entry) => keyOf(entry) === ownerKey)
    .map((entry) => toStatement(entry, nameByHandle, keyOf))

  const floorTimeline = timeline.filter((entry) => entry.floorPostId === container.floor.postId)
  const opponentPick = pickOpponent(floorTimeline, ownerKey, target, participants, notes, keyOf)

  const exchange = opponentPick.opponentKey
    ? floorTimeline
        .filter((entry) => {
          const key = keyOf(entry)
          return key === ownerKey || key === opponentPick.opponentKey
        })
        .map((entry) => toStatement(entry, nameByHandle, keyOf))
    : []

  const openQuestions = findOpenQuestions(floorTimeline, ownerKey, opponentPick.opponentKey, keyOf)

  // Everyone in this floor who is neither the owner nor the chosen opponent (v0.2.11).
  //
  // Built from the *floor* timeline, not the whole thread: an argument happens inside the
  // floor it started in, and pulling in speakers from other floors would make a reply to
  // one exchange look like it owed an answer to strangers.
  //
  // `participants` holds the identity-resolved view (display name → account, mixed handles
  // merged), so grouping by `keyOf(entry)` and then looking the key up keeps one person as
  // one bystander even when the platform omitted their handle on some posts.
  const bystanderKeys = new Set<string>()
  for (const entry of floorTimeline) {
    const key = keyOf(entry)
    if (key === ownerKey || key === opponentPick.opponentKey) continue
    // `resolveKey` falls back to the literal `'未知'` for a post with no author name and
    // no id, which is not a participant — it is an absence. Counting it as a bystander
    // would report "an unnamed third party joined the argument", a claim about the thread
    // that the data does not support.
    if (key === '' || key === '未知') continue
    bystanderKeys.add(key)
  }
  const bystanders = [...bystanderKeys]
    .map((key) => participants.get(key))
    .filter((entry): entry is Participant => entry !== undefined)
    .sort((a, b) => b.postCount - a.postCount || a.lastSpokeIndex - b.lastSpokeIndex)

  return {
    floorNumber: container.floor.floorNumber,
    floorPostId: container.floor.postId,
    owner: ownerParticipant,
    opponent: opponentPick.opponentKey ? participants.get(opponentPick.opponentKey) : undefined,
    opponentEvidence: opponentPick.evidence,
    exchange,
    ownerStatements,
    openQuestions,
    bystanders,
    needsConfirmation: opponentPick.ambiguous,
    notes,
    ownerIdentityAssurance: resolvedOwner.assurance,
    ownerIdentityEvidence: resolvedOwner.evidence,
  }
}

/**
 * True when a post's handle carries information the display name does not already.
 *
 * ## What this does — and what the old comment claimed
 *
 * The comment here used to say "only numeric handles are account ids", while the body
 * accepted anything that merely *differed* from the display name. Both cannot be true,
 * and the code was the correct half:
 *
 * Real WAP data does not provide a numeric uid. Scanning a 190 KB page from a live
 * thread (`data-uid="<digits>"`) matched **zero** times; `un` is a login name, not a
 * number. A "numeric only" rule would therefore classify every Tieba identity as
 * unknown — the most permissive possible outcome, produced by a rule meant to be the
 * strictest.
 *
 * `un` and `name_show` are genuinely different things and often differ in practice: on
 * the sampled thread, 13 of 30 floors had `un !== name_show`
 * (`fn=4 永恒的鸟笼 / 时空的流转♂`), and 4 floors had no `un` at all.
 *
 * So a handle counts as an account handle when it is **numeric** (some surfaces do
 * expose `un` as a uid) **or** when it differs from the display name (it is then a
 * login name, which cannot be renamed, rather than a nickname echo). A handle that just
 * repeats the name adds nothing and is not counted — counting it would report one
 * person as several accounts.
 *
 * ## What it is used for
 *
 * Only `distinctHandles`, which `resolveOwnerKey` consults to refuse a "same nickname,
 * possibly different people" owner match. It is **not** on the publish path: author
 * comparison there uses `TargetSnapshot.targetAuthorId`, and never this function.
 *
 * @param handle the `un` value, when present
 * @param displayName the name rendered for the post
 */
function isAccountHandle(
  handle: string | undefined,
  displayName: string | undefined,
  /**
   * Which surface declared this field, when it declared one (v0.2.23 patch 5).
   *
   * A declared source is a statement about *meaning*: `wap_floor` and `wap_inline`
   * publish the `un`, so the value is a login name regardless of what it looks like.
   * Without this the function had to guess from the string, and the guess fails on a
   * real and common case — Tieba users whose nickname equals their login name (4 of
   * the 29 floors in the shipped capture). Those rows lost their identity and fell
   * back to a display-name key.
   */
  source?: IdentitySource,
): handle is string {
  if (handle === undefined || handle === '') return false
  // Known provenance: the contract already said what this field is.
  if (source !== undefined) return true
  // Unknown provenance (a legacy row): the best available guess, kept unchanged so
  // historical sessions read exactly as they did before.
  if (/^\d{4,}$/.test(handle)) return true
  return displayName !== undefined && handle !== displayName
}

/**
 * Build the participant index.
 *
 * Three rules, each forced by observed platform behaviour:
 *
 * 1. **Merge by display name.** A floor gives `un` while the same person's
 *    nested reply may give a shown name, so keying on whichever handle a post
 *    carries split one human into two and made the owner look ambiguous.
 * 2. **A handle counts when it is numeric or differs from the display name.** A
 *    name-shaped `un` that merely repeats the nickname carries no identity and is
 *    not counted (see {@link isAccountHandle}); a `un` that differs is a login
 *    name and is. The old wording here said "only numeric", which contradicted the
 *    code and, if implemented literally, would classify every Tieba identity as
 *    unknown — real WAP pages expose no numeric uid at all.
 * 3. **Backfill missing names from the handle.** Nine of a live thread's nested
 *    replies arrived with a handle but no name at all; the name is recoverable from
 *    another post by the same handle, and doing so keeps the argument readable
 *    instead of inventing an "unknown user".
 *
 * The merge is conservative in the direction that matters: two people who share
 * a display name become one participant, which
 * {@link resolveOwnerKey} refuses for the owner rather than guessing.
 */
function indexParticipants(
  timeline: readonly TimelineEntry[],
  nameByHandle: ReadonlyMap<string, string>,
): Map<string, Participant> {
  // Merge into participants, resolving nameless posts through the directory.
  const byKey = new Map<string, Participant>()
  /**
   * Distinct *identities* seen under each display name.
   *
   * This is the ambiguity detector: two accounts may share a nickname, and when
   * they do, "the user called 小财神" no longer points at one person. It is keyed by
   * the nickname (not by the identity key) precisely so that it can answer that
   * question, and it stores identity keys so the count is about accounts rather
   * than about spellings.
   */
  const identitiesByName = new Map<string, Set<string>>()

  timeline.forEach((entry, index) => {
    if (!entry.authorName && !entry.authorId) return
    const handle = isAccountHandle(entry.authorId, entry.authorName, entry.authorSource)
      ? entry.authorId
      : undefined
    // The grouping key is an identity; the display name is only a label.
    const name = resolveKey(entry, nameByHandle)
    const display = entry.authorName ?? nameByHandle.get(entry.authorId ?? '') ?? name

    {
      // Only *account-backed* keys count. A `name:` key means the record carried no
      // account identifier at all, so counting it would make every nickname-only
      // thread look ambiguous — and, worse, would hide the genuine two-accounts-one-
      // nickname case behind a number that measures something else.
      if (name.startsWith('uid:') || name.startsWith('handle:')) {
        const set = identitiesByName.get(display) ?? new Set<string>()
        set.add(name)
        identitiesByName.set(display, set)
      }
    }
    // Named `distinctHandles` for continuity with the published field, but it counts
    // distinct *identities* under one display name.
    const distinctHandles = identitiesByName.get(display)?.size ?? 0

    const existing = byKey.get(name)
    /**
     * Whether this record predates the identity split, and what that means.
     *
     * v0.2.23 rule, revised after review: the discriminator is the **platform
     * contract**, not whether the string happens to be all digits. A digit test
     * was wrong in both directions — Tieba's `un` can be `1254480024` (so a
     * numeric-looking handle would be mis-promoted to a uid), and a non-numeric
     * Tieba handle was being trusted as a stable account id (so an unverified
     * record could still authorise a publish).
     *
     * - **Tieba**: `authorId` is documented as `un`, a login name. A record that
     *   does not say which surface produced it is `legacy_unknown`: still
     *   readable and still analysed, but it may not grant a stable-identity
     *   permission.
     * - **Other platforms** (Weibo et al.): their projection puts the platform's
     *   own account id in `authorId` under a stated contract. Those keep the old
     *   behaviour; refusing them would orphan every historical Weibo session for
     *   no safety gain.
     */
    const legacyShape = entry.authorSource === undefined
    const legacyIsTieba = legacyShape && entry.platform !== undefined && entry.platform === 'tieba'
    const legacyAccountId = legacyIsTieba ? entry.authorId : undefined
    const numericForThisEntry = legacyShape
      ? entry.platform !== undefined && entry.platform === 'tieba'
        ? undefined
        : entry.authorId
      : entry.authorNumericUid
    // A legacy Tieba `authorId` IS an `un`, so it still counts as a handle for
    // display and duplicate-name detection — it is documented as one. What it
    // must not do is satisfy a *numeric uid* match, which `numericForThisEntry`
    // above already prevents.
    const handleForThisEntry = handle
    if (existing) {
      byKey.set(name, {
        ...existing,
        // v0.2.23: a real uid only comes from `authorNumericUid`; the handle stays
        // in its own field. Merging them is what made an owner configured with a
        // numeric id unmatchable against a WAP read.
        userId: existing.userId ?? numericForThisEntry,
        // Kept from the first record that stated it. A later row cannot re-label an
        // identifier it did not produce; if it disagrees, its own key differs and it
        // is a separate participant already.
        ...(existing.userIdNamespace === undefined && entry.authorNumericUidNamespace !== undefined
          ? { userIdNamespace: entry.authorNumericUidNamespace }
          : {}),
        handle: existing.handle ?? handleForThisEntry,
        legacyAccountId: existing.legacyAccountId ?? legacyAccountId,
        hasDeclaredSource: existing.hasDeclaredSource === true || !legacyShape,
        ...(existing.source === undefined && entry.authorSource !== undefined
          ? { source: entry.authorSource }
          : {}),
        matchKind: existing.userId ?? numericForThisEntry ?? existing.handle ?? handleForThisEntry ? 'id' : 'name',
        postCount: existing.postCount + 1,
        lastPostId: entry.postId,
        lastSpokeIndex: index,
        distinctHandles,
      })
      return
    }
    byKey.set(name, {
      key: name,
      userId: numericForThisEntry,
      ...(entry.authorNumericUidNamespace === undefined
        ? {}
        : { userIdNamespace: entry.authorNumericUidNamespace }),
      platform: entry.platform,
      handle: handleForThisEntry,
      legacyAccountId,
      hasDeclaredSource: !legacyShape,
      // A platform whose contract states the account id in `authorId` needs no
      // per-row source label: the adapter's promise *is* the provenance. Tieba is
      // the exception, because its `authorId` is a login name, not an account id.
      ...(entry.authorSource !== undefined
        ? { source: entry.authorSource }
        : entry.platform !== undefined && entry.platform !== 'tieba'
          ? { source: 'platform_contract' as IdentitySource }
          : {}),
      displayName: display,
      matchKind: numericForThisEntry ?? handleForThisEntry ? 'id' : 'name',
      postCount: 1,
      lastPostId: entry.postId,
      lastSpokeIndex: index,
      distinctHandles,
    })
  })

  return byKey
}

/**
 * Build the account-handle → display-name directory for one timeline.
 *
 * The platform sometimes renders a post with a numeric user id and no name (nine
 * of a live thread's nested replies did). Another post by the same id usually
 * carries the name, so recovering it keeps the conversation readable instead of
 * showing "unknown user" for a real participant.
 */
export function buildHandleDirectory(
  timeline: readonly TimelineEntry[],
): ReadonlyMap<string, string> {
  const directory = new Map<string, string>()
  for (const entry of timeline) {
    if (entry.authorName && entry.authorId !== undefined) {
      directory.set(entry.authorId, entry.authorName)
    }
  }
  return directory
}

/**
 * Resolve one entry to its participant key (the display name it belongs to).
 *
 * Exported so callers outside the analyzer can group posts consistently; passing
 * the directory from {@link buildHandleDirectory} is what keeps a nameless post
 * attributed to the right person.
 */
export function resolveKey(
  entry: TimelineEntry,
  nameByHandle: ReadonlyMap<string, string>,
): string {
  return identityKeyOf(entry, nameByHandle)
}

/**
 * The grouping key for one record: an *identity*, not a label.
 *
 * ## The P0 this replaces
 *
 * Until v0.2.23 patch 2 this returned `entry.authorName` first. Since a display
 * name is a label anyone may take, two different accounts that chose the same
 * nickname collapsed into one participant — so the owner's `ownerStatements`
 * contained the other account's words, and the AI argued using a stranger's
 * opinion as if it were the owner's. Reproduced end to end in
 * `test/same-nickname-two-accounts.test.ts`.
 *
 * ## The rule now
 *
 * - A numeric uid keys on `uid:<namespace>:<value>`. The namespace is part of the
 *   key because Tieba's `user_id` and `tieba_uid` are unrelated namespaces.
 * - A login name keys on `handle:<name>`.
 * - A record with **no account identifier** keys on `name:<display>`. It is kept
 *   readable — a thread can be analysed from names alone — but that key can never
 *   equal a `handle:` or `uid:` key, so a nickname-only record is never silently
 *   attributed to a real account.
 *
 * The prefixes are load-bearing. Without them a display name of `handle:x` (or of
 * `uid:user_id:1`) would collide with a real identity key.
 */
function identityKeyOf(
  entry: TimelineEntry,
  nameByHandle: ReadonlyMap<string, string>,
): string {
  if (entry.authorNumericUid !== undefined && entry.authorNumericUid !== '') {
    // A uid with no declared namespace cannot be placed, so it keys on the platform
    // alone rather than pretending to be either Tieba namespace.
    const namespace = entry.authorNumericUidNamespace ?? 'unstated'
    return `uid:${entry.platform ?? 'unknown'}:${namespace}:${entry.authorNumericUid}`
  }
  if (isAccountHandle(entry.authorId, entry.authorName, entry.authorSource)) {
    return `handle:${entry.platform ?? 'unknown'}:${entry.authorId}`
  }
  // No account identifier. Fall back to the display name, resolved through the
  // directory when this row only carried a handle-like token.
  const byDirectory =
    entry.authorId === undefined ? undefined : nameByHandle.get(entry.authorId)
  const display = entry.authorName ?? byDirectory ?? entry.authorId
  return display === undefined ? 'name:未知' : `name:${display}`
}

/**
 * Resolve which participant the configured owner actually is.
 *
 * Matching order, and why:
 *
 * 1. A configured **user id** is matched against each participant's known
 *    handle. This is the only unspoofable handle the platform gives.
 * 2. Otherwise the configured **name** must match exactly one participant.
 *    Because the index merges by display name, one match means one human.
 * 3. A name that is missing, or that appears with several distinct account
 *    handles, is an error rather than a guess — attributing someone else's
 *    words to the owner is the most damaging failure this plugin can have.
 */
/**
 * Decide which participant is the owner.
 *
 * The critical rule: **a configured stable id is authoritative, and never degrades
 * to a nickname match.**
 *
 * Consider the failure this prevents: the owner is configured as id 99999 with
 * nickname "Alice", but the post is by uid 12345 who also calls themselves
 * "Alice". The old code tried the id, failed, then matched by name and happily
 * used the impostor's words as the owner's — the single worst outcome this plugin
 * can produce, because it argues on a stranger's behalf under the owner's name.
 *
 * So:
 * - id configured and matched → that participant, done;
 * - id configured and the platform shows ids → refuse (a different id is present);
 * - id configured but no ids at all on this platform → ambiguous, needs a human;
 * - no id configured → a nickname match is allowed, flagged in `notes`.
 */
function resolveOwnerKey(
  participants: ReadonlyMap<string, Participant>,
  owner: OwnerIdentity,
  notes: string[],
): {
  readonly key: string
  readonly assurance: 'verified' | 'unverified'
  /**
   * What backed the resolution. Derived, never asserted: the publish gate recomputes
   * the assurance from this record instead of trusting the string above.
   */
  readonly evidence: OwnerIdentityEvidence
} {
  if (owner.userId) {    // Cross-platform refusal comes first, before any id comparison.
    //
    // A user id is scoped to one platform: Tieba's `user_id` and Weibo's `uid`
    // are both 9–10 digit decimals in unrelated namespaces, so `===` alone would
    // let a thread on platform B match the owner's platform-A id and argue on
    // some stranger's behalf. When the caller did not say which platform the id
    // came from, there is no way to prove the match is the owner's, so it is
    // refused rather than guessed.
    if (owner.platform === undefined) {
      throw new Error(
        `主人身份配置了用户 ID ${owner.userId}，但没有说明它属于哪个平台。` +
          '用户 ID 只在所属平台内有意义，不同平台的数字 ID 可能相同但不是同一个人，' +
          '因此无法确认帖子里哪个账号是主人。请指定平台后再重试。',
      )
    }

    /**
     * What the owner's configuration claims, resolved once.
     *
     * Tieba has two numeric namespaces and requires an explicit choice. Every other
     * platform has exactly one, and there the platform *is* the namespace. When the
     * caller named neither, there is nothing to compare against and the comparison
     * below refuses rather than assuming.
     */
    // ## Only a *numeric* id has a namespace
    //
    // `ownerUserId` historically carried whatever the user pasted, and on Tieba that
    // was frequently a login name (`un`). A login name has no numeric namespace; it
    // is compared as a handle below, exactly as before. Requiring a namespace for it
    // would refuse every historical configuration for no safety gain — and would
    // "fix" the namespace bug by breaking the feature.
    //
    // A numeric id is the case this patch is about: it is meaningless without knowing
    // which of Tieba's two numeric spaces produced it.
    const numericOwnerId = /^\d+$/.test(owner.userId.trim())
    const ownerNamespace = numericOwnerId
      ? (owner.userIdNamespace ??
        (owner.platform !== undefined && owner.platform !== 'tieba'
          ? (`platform:${owner.platform}` as const)
          : undefined))
      : undefined

    if (numericOwnerId && ownerNamespace === undefined) {
      throw new Error(
        `主人身份配置了数字 ID ${owner.userId}，但没有说明它属于哪个命名空间。` +
          '贴吧同时提供 user_id 与 tieba_uid 两套互不相关的数字 ID，' +
          '数字相同不代表同一个人，因此无法确认哪条发言属于主人。' +
          '请在配置里指定命名空间后重试。',
      )
    }

    for (const participant of participants.values()) {
      // Three things must agree for a *numeric* id, and the namespace is observed —
      // never taken from the configuration. Comparing the number alone is the bug this
      // loop fixes: the same digits in two namespaces are two different accounts.
      //
      // A non-numeric `ownerUserId` is a login name, so it matches `participant.handle`
      // (the `un` field) and needs no namespace.
      const sameValue = numericOwnerId
        ? participant.userId === owner.userId
        : participant.handle === owner.userId
      const sameNamespace = numericOwnerId
        ? participant.userIdNamespace === ownerNamespace
        : true
      const samePlatform = participant.platform === undefined || participant.platform === owner.platform
      if (sameValue && sameNamespace && samePlatform) {
        return {
          key: participant.key,
          assurance: 'verified',
          evidence: numericOwnerId
            ? {
                kind: 'numeric_uid',
                ...(ownerNamespace === undefined ? {} : { namespace: ownerNamespace }),
                value: owner.userId,
                ...(participant.source === undefined ? {} : { source: participant.source }),
              }
            : {
                kind: 'handle',
                value: owner.userId,
                ...(participant.source === undefined ? {} : { source: participant.source }),
              },
        }
      }
    }

    // v0.2.23: a handle is the next-strongest proof and must be tried before the
    // "the id is wrong" verdict. It is a lot stronger than a nickname: the owner
    // cannot rename it, and it is what the WAP surface actually publishes. Not
    // trying it is why a configured numeric uid could never match anything.
    if (owner.handle !== undefined && owner.handle !== '') {
      for (const participant of participants.values()) {
        if (participant.handle !== owner.handle) continue
        // A handle match is proof only when some surface actually declared this
        // row's provenance. All-legacy rows may equal the configured handle by
        // coincidence, and promoting that would grant a stable-identity permission
        // to data that never carried one.
        if (participant.hasDeclaredSource === true) {
          return {
            key: participant.key,
            assurance: 'verified',
            evidence: {
              kind: 'handle',
              value: owner.handle,
              ...(participant.source === undefined ? {} : { source: participant.source }),
            },
          }
        }
        notes.push(
          `登录名「${owner.handle}」匹配到一条旧格式记录（没有记录标识来源）：` +
            '身份未核验，只用于读取，不能据此发表。',
        )
        return {
          key: participant.key,
          assurance: 'unverified',
          evidence: { kind: 'legacy', value: owner.handle },
        }
      }
    }

    // ## Pre-v0.2.23 records (rule: legacy_unknown)
    //
    // A historical record has an `authorId` whose namespace was never written
    // down. If its text equals the configured id we *can* resolve the participant
    // for reading — otherwise every old session becomes unusable — but the match
    // proves nothing about the id namespace, so it is recorded as unverified and
    // flagged in `notes` for every downstream decision.
    //
    // The rule is platform-scoped, not shape-scoped. A legacy Tieba `authorId` is
    // an `un`, which may be all digits or a name; either way it is not proof of a
    // numeric account id, so the match is allowed **for reading only** and is
    // recorded as unverified. Legacy records from other platforms never reach
    // here — their `authorId` is their contract's account id and already matched
    // `participant.userId` above.
    const legacyMatch = [...participants.values()].find(
      (participant) =>
        participant.legacyAccountId !== undefined &&
        participant.legacyAccountId === owner.userId,
    )
    if (legacyMatch !== undefined) {
      notes.push(
        `主人是通过一条旧格式记录匹配的（账号字段「${legacyMatch.legacyAccountId}」，` +
          '写入时没有记录标识类型）：身份未核验，只用于读取，不能据此发表。',
      )
      return {
        key: legacyMatch.key,
        assurance: 'unverified',
        evidence: {
          kind: 'legacy',
          ...(legacyMatch.legacyAccountId === undefined ? {} : { value: legacyMatch.legacyAccountId }),
        },
      }
    }

    // The id did not match. Whether a nickname fallback is even conceivable
    // depends on whether the platform exposed ids at all.
    //
    // v0.2.23: `anyIdsExposed` now means *numeric* ids. It used to be true as
    // soon as a WAP read produced a `un`, so the branch below claimed "the post
    // has this id, but not yours" on a surface that has no ids at all.
    const anyIdsExposed = [...participants.values()].some((participant) => participant.userId)
    if (anyIdsExposed) {
      const nameMatch = owner.userName ? participants.get(owner.userName) : undefined
      const conflicting = nameMatch?.userId ? `，而帖子里同名账号的 ID 是 ${nameMatch.userId}` : ''
      throw new Error(
        `配置的主人用户 ID 是 ${owner.userId}，但帖子里没有这个 ID 的发言${conflicting}。` +
          '为避免把别人的话当成主人的，插件不会退回去按昵称匹配。' +
          '请核对 ownerUserId，或确认该主人是否在本帖发过言。',
      )
    }

    // No ids anywhere: a nickname match cannot be confirmed against the configured
    // id, so this is "needs a human", not "assume it is them".
    if (owner.userName && participants.get(owner.userName)) {
      throw new Error(
        `配置了主人 ID ${owner.userId}，但本次读取到的发言没有暴露任何数字用户 ID，` +
          `无法确认昵称「${owner.userName}」是否就是该 ID 对应的账号。` +
          '请用 debate_analyze_reply 指定主人自己那条回复的 postId，或在配置里填写可核验的贴吧登录名（un）。' +
          '（仅填昵称可以用于只读分析，但不足以授权发表。）',
      )
    }
    throw new Error(
      `配置的主人用户 ID ${owner.userId} 在本次对话中没有出现（发言里没有暴露 ID）。` +
        '请核对 ownerUserId，或确认该主人是否在本帖发过言。',
    )
  }

  if (owner.handle !== undefined && owner.handle !== '') {
    for (const participant of participants.values()) {
      if (participant.handle !== owner.handle) continue
      if (participant.hasDeclaredSource === true) {
        return {
          key: participant.key,
          assurance: 'verified',
          evidence: {
            kind: 'handle',
            value: owner.handle,
            ...(participant.source === undefined ? {} : { source: participant.source }),
          },
        }
      }
      notes.push(
        `登录名「${owner.handle}」匹配到一条旧格式记录（没有记录标识来源）：` +
          '身份未核验，只用于读取，不能据此发表。',
      )
      return {
        key: participant.key,
        assurance: 'unverified',
        evidence: { kind: 'legacy', value: owner.handle },
      }
    }
    throw new Error(
      `帖子里没有登录名「${owner.handle}」的发言：` +
        '请确认这是贴吧的登录名（un，个人主页 URL 里的 un=），而不是昵称；' +
        '或确认该主人是否在本帖发过言。',
    )
  }

  if (owner.userName) {
    // Keys are identities now, so a nickname is not a key. Collect every participant
    // *displayed* under that name and require exactly one.
    const matches = [...participants.values()].filter(
      (participant) => participant.displayName === owner.userName,
    )
    const match = matches[0]
    if (match) {
      // Two accounts sharing the nickname is precisely the case where "the user
      // called X" stops naming one person, so the count that matters is how many
      // *identities* the label covers.
      const handles = matches.length
      if (handles > 1) {
        throw new Error(
          `昵称「${owner.userName}」在帖子里出现了 ${handles} 个不同的账号，无法确定哪一个是主人。` +
            '请为主人配置稳定的用户 ID。',
        )
      }
      notes.push(`主人是通过昵称「${owner.userName}」匹配的，建议改为配置稳定的用户 ID`)
      return {
        key: match.key,
        assurance: 'unverified',
        evidence: { kind: 'nickname', value: owner.userName },
      }
    }
    throw new Error(
      `在帖子里没有找到主人（昵称 ${owner.userName}）的发言：` +
        '请确认昵称是否正确，或该主人在本贴尚未发言',
    )
  }

  throw new Error('没有配置主人身份：请先设置主人的数字 ID、贴吧登录名（un）或昵称')
}

/** The outcome of opponent selection. */
interface OpponentPick {
  readonly opponentKey?: string
  readonly evidence?: OpponentEvidence
  readonly ambiguous: boolean
}

/**
 * Decide who the owner is arguing with inside one floor.
 *
 * The rule is: score candidates by *evidence of an argument*, not by position
 * in the list. A participant earns points for having been answered by the
 * owner, for answering the owner, and for interacting more than once. The
 * most-recently-active stranger therefore cannot win on recency alone — which
 * is exactly the failure mode a naive "reply to the last speaker" heuristic
 * has, and which the acceptance test for a three-person argument targets.
 */
function pickOpponent(
  floorTimeline: readonly TimelineEntry[],
  ownerKey: string,
  trigger: TimelineEntry,
  // Kept in the signature for call-site stability; the mapping is now derived from
  // the timeline itself because a display name may belong to more than one identity.
  _participants: ReadonlyMap<string, Participant>,
  notes: string[],
  keyOf: (entry: TimelineEntry) => string,
): OpponentPick {
  const triggerIndex = floorTimeline.findIndex((entry) => entry.postId === trigger.postId)
  const before = triggerIndex >= 0 ? floorTimeline.slice(0, triggerIndex) : floorTimeline

  const stats = new Map<
    string,
    { ownerRepliesTo: number; repliesToOwner: number; lastSpokeIndex: number; spoken: number }
  >()
  // Reply edges are named, not keyed: the platform renders the answered user as a
  // display name, so the edge is resolved by matching that name against the
  // participant index. Matching on handles instead would silently miss every edge
  // whose target happened to be rendered without one.
  const ownerNames = new Set(
    floorTimeline
      .filter((entry) => keyOf(entry) === ownerKey)
      .map((entry) => entry.authorName)
      .filter((name): name is string => Boolean(name)),
  )

  /**
   * Display name → identity key, and the ambiguity that makes the mapping useless.
   *
   * `replyToName` is always a display name, so it has to be translated before it can
   * be compared with an identity key. When two accounts share the nickname, the
   * translation is *not* unique — and guessing one of them would recreate exactly
   * the confusion this release removes. Such a name is dropped from the map, so a
   * reply edge pointing at it counts for nobody instead of for the wrong account.
   */
  const nameToKey = new Map<string, string>()
  const ambiguousNames = new Set<string>()
  for (const entry of floorTimeline) {
    const display = entry.authorName
    if (display === undefined) continue
    const key = keyOf(entry)
    const previous = nameToKey.get(display)
    if (previous !== undefined && previous !== key) {
      ambiguousNames.add(display)
      continue
    }
    nameToKey.set(display, key)
  }
  for (const name of ambiguousNames) nameToKey.delete(name)
  const isOwnerName = (name: string | undefined): boolean => name !== undefined && ownerNames.has(name)

  before.forEach((entry, index) => {
    const key = keyOf(entry)
    if (key === ownerKey) {
      // An owner post naming someone is a direct reply edge.
      // `replyToName` is a display name, so it must be mapped to an identity key
      // before it can be compared with `ownerKey` — which is now an identity, not a
      // label. Comparing the two directly was always false after the key change,
      // which would have let "the owner replied to themselves" register as an
      // opponent edge.
      const targetName = entry.replyToName
      const targetKey =
        targetName === undefined ? undefined : nameToKey.get(targetName)
      if (targetName !== undefined && targetKey !== undefined && targetKey !== ownerKey) {
        const target = targetKey
        {
          const current = stats.get(target) ?? {
            ownerRepliesTo: 0,
            repliesToOwner: 0,
            lastSpokeIndex: -1,
            spoken: 0,
          }
          current.ownerRepliesTo += 1
          stats.set(target, current)
        }
      }
      return
    }
    const current = stats.get(key) ?? {
      ownerRepliesTo: 0,
      repliesToOwner: 0,
      lastSpokeIndex: -1,
      spoken: 0,
    }
    current.spoken += 1
    current.lastSpokeIndex = index
    if (isOwnerName(entry.replyToName)) current.repliesToOwner += 1
    stats.set(key, current)
  })

  const candidates = [...stats.entries()]
    .map(([key, value]) => ({
      key,
      ...value,
      // Interaction evidence dominates; recency only breaks ties.
      score: value.ownerRepliesTo * 3 + value.repliesToOwner * 3 + Math.min(value.spoken, 3),
    }))
    .sort((a, b) => (b.score - a.score) || (b.lastSpokeIndex - a.lastSpokeIndex))

  const top = candidates[0]
  if (!top) {
    notes.push('该楼层里在主人发言之前没有其他参与者，无法确定争论对象')
    return { ambiguous: true }
  }

  const runnerUp = candidates[1]
  const ambiguous = runnerUp !== undefined && runnerUp.score === top.score
  if (ambiguous) {
    notes.push(
      `有两位参与者的互动证据相同（${top.key} 与 ${runnerUp.key}），无法可靠判断主人在跟谁争论，需要确认`,
    )
  }

  const activeOthers = candidates
    .slice(1)
    .filter((candidate) => candidate.spoken > 0)
    .map((candidate) => candidates.find((entry) => entry.key === candidate.key)?.key ?? candidate.key)

  return {
    opponentKey: top.key,
    ambiguous,
    evidence: {
      exchanges: top.ownerRepliesTo + top.repliesToOwner,
      ownerRepliesTo: top.ownerRepliesTo,
      repliesToOwner: top.repliesToOwner,
      lastSpokeIndex: top.lastSpokeIndex,
      otherActiveParticipants: activeOthers,
    },
  }
}

/**
 * Find opponent posts that ask the owner something and got no reply.
 *
 * "Asks something" is detected from interrogatives plus a question mark; this
 * is a heuristic and is labelled as such downstream. It deliberately errs
 * towards listing too few rather than inventing questions.
 *
 * A later owner post only counts as an answer if it actually says something. A
 * bare summon such as "@小号 上" is the owner handing the floor to someone else,
 * not answering, so treating it as a reply would hide the open question this
 * plugin exists to close.
 */
function findOpenQuestions(
  floorTimeline: readonly TimelineEntry[],
  ownerKey: string,
  opponentKey: string | undefined,
  keyOf: (entry: TimelineEntry) => string,
  nameByHandle?: ReadonlyMap<string, string>,
): readonly Statement[] {
  if (!opponentKey) return []
  const out: Statement[] = []
  for (let index = 0; index < floorTimeline.length; index += 1) {
    const entry = floorTimeline[index] as TimelineEntry
    if (keyOf(entry) !== opponentKey) continue
    if (!looksLikeQuestion(entry.content)) continue
    const answeredLater = floorTimeline
      .slice(index + 1)
      .some((later) => keyOf(later) === ownerKey && isSubstantive(later.content))
    if (!answeredLater) out.push(toStatement(entry, nameByHandle ?? new Map(), keyOf))
  }
  return out
}

/** True when the text reads as a question in Chinese or English. */
export function looksLikeQuestion(content: string): boolean {
  if (/[?？]/.test(content)) return true
  return /(为什么|凭什么|怎么|如何|是不是|有没有|能不能|难道|依据|证据|哪里|哪个|谁)/.test(content)
}

/**
 * True when a post actually argues something, rather than only summoning.
 *
 * Stripping @-mentions and whitespace and then requiring a few characters is a
 * cheap, honest test: "@吵架小号 过来帮我说两句" reduces to "过来帮我说两句"
 * which still counts, while "@吵架小号 上。" reduces to "上。" and does not.
 */
export function isSubstantive(content: string): boolean {
  const stripped = content
    .replace(/@\S+/g, '')
    .replace(/[\s，。,.!！?？~～、]/g, '')
    .trim()
  return stripped.length >= 6
}

/** Convert a timeline entry to a statement. */
function toStatement(
  entry: TimelineEntry,
  nameByHandle: ReadonlyMap<string, string>,
  keyOf: (entry: TimelineEntry) => string,
): Statement {
  return {
    postId: entry.postId,
    floorNumber: entry.floorNumber,
    authorKey: keyOf(entry),
    // Keep the resolved name even when the post itself carried none: the output
    // should never show "unknown" for someone the thread does identify.
    authorName:
      entry.authorName ??
      (entry.authorId === undefined ? undefined : nameByHandle.get(entry.authorId)),
    content: entry.content,
    createdAt: entry.createdAt,
    replyToName: entry.replyToName,
  }
}

/**
 * Extract the owner's most load-bearing claims.
 *
 * A claim is a sentence the owner stated as fact or opinion. Interrogatives are
 * excluded, because the owner asking a question is not the owner asserting.
 */
export function extractClaims(statements: readonly Statement[], limit = 8): readonly string[] {
  const claims: string[] = []
  for (const statement of statements) {
    for (const raw of statement.content.split(/[。！？!?\n]+/)) {
      const sentence = raw.trim()
      if (sentence.length < 4) continue
      if (looksLikeQuestion(sentence)) continue
      claims.push(sentence)
      if (claims.length >= limit) return claims
    }
  }
  return claims
}

/**
 * Resolve a floor address to the floor post's stable id.
 *
 * v0.2.1 moved floor addressing from the displayed number to the post id,
 * because a microblog has no numbers. Existing callers pass a number, so both
 * are accepted here rather than breaking them — but a number that matches no
 * floor returns `undefined` instead of silently matching nothing, so a caller
 * that passed a stale number sees an empty result it can explain, not a
 * mysterious one.
 */
function floorPostIdOf(collected: CollectedThread, address: string | number): string | undefined {
  if (typeof address === 'string') {
    return collected.floors.some((entry) => entry.floor.postId === address) ? address : undefined
  }
  return collected.floors.find((entry) => entry.floor.floorNumber === address)?.floor.postId
}

/** Summarize a floor's participants, for the UI and the compressor. */
export function describeParticipants(
  collected: CollectedThread,
  floor: string | number,
): readonly Participant[] {
  const floorPostId = floorPostIdOf(collected, floor)
  if (floorPostId === undefined) return []
  const timeline = buildTimeline(collected).filter((entry) => entry.floorPostId === floorPostId)
  return [...indexParticipants(timeline, buildHandleDirectory(timeline)).values()]
}

/** All nested replies under a floor, addressed by post id or displayed number. */
export function nestedOf(
  collected: CollectedThread,
  floor: string | number,
): readonly NestedReply[] {
  const floorPostId = floorPostIdOf(collected, floor)
  if (floorPostId === undefined) return []
  return collected.floors.find((entry) => entry.floor.postId === floorPostId)?.nested ?? []
}
