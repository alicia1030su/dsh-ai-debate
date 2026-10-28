/**
 * Per-platform account bindings.
 *
 * ## The problem
 *
 * v0.2.1 kept one global set of account fields — `ownerUserId`, `ownerUserName`,
 * `aiAccountUserId`, `aiAccountName`, `allowedOwnerIds` — and used them for
 * whatever platform a link happened to resolve to. That was survivable while
 * Tieba was the only platform. With a registry that can hold several, it is not:
 * a user id only identifies someone *inside* one platform, and Tieba's `user_id`
 * and Weibo's `uid` are both 9–10 digit decimals in unrelated namespaces.
 *
 * The concrete failure, which is the worst this project can produce: an owner id
 * that exists on both platforms makes the plugin treat a stranger on platform B
 * as the owner, pick an opponent for them, generate a reply, and publish it under
 * the owner's name. `analyzer.ts` already documents refusing the in-platform
 * version of this; before this module there was no cross-platform defence at all.
 *
 * ## The model
 *
 * A binding is a plain data structure keyed by platform, so "who is the owner
 * here" is answered by lookup rather than by a global variable. Absence is
 * meaningful: a platform with no binding has no owner, and the plugin offers
 * read-only features there instead of borrowing another platform's identity.
 *
 * ## Compatibility
 *
 * `resolveBindings` reads the legacy global fields as **Tieba's**, because that
 * is what they always described (`config.ts` documents them as "Tieba user id").
 * This is the same assumption `store.ts` already makes for pre-0.2.0 records, so
 * it is a precedent rather than a new invention. Users on Tieba see no change;
 * every other platform now reports "not bound" instead of silently reusing Tieba.
 *
 * The migration is a *derivation*, never a rewrite: nothing writes the new shape
 * back into the user's profile. A settings page can offer that explicitly later,
 * but silently rewriting someone's account configuration is not something a
 * plugin should do on its own.
 */

import type { PlatformId } from '../types.js'

/**
 * How much a given platform's account id can be trusted as an identity.
 *
 * - `stable` — platform-assigned, immutable (Tieba `user_id`, Weibo `uid`).
 * - `slug` — user-editable short name (Zhihu `url_token`); can be renamed, so a
 *   match is strong evidence but not proof.
 * - `opaque` — long opaque string (Douyin `sec_uid`); stable but unreadable, so
 *   it must never be shown to a human as if it were a name.
 * - `name_only` — the platform exposed no id at all; matching is by nickname and
 *   is therefore the weakest claim the plugin can make.
 */
export type AccountIdStrength = 'stable' | 'slug' | 'opaque' | 'name_only'

/** One account on one platform. */
export interface PlatformAccount {
  readonly platform: PlatformId
  /** Platform-native stable id. Absent when only a display name is known. */
  readonly accountId?: string
  /** Display name. For humans and logs only — never a matching key. */
  readonly displayName?: string
  /** How strong `accountId` is; decides whether it may be the sole match. */
  readonly idStrength?: AccountIdStrength
}

/** The owner side: who may summon, per platform. */
export interface OwnerBinding {
  readonly platform: PlatformId
  readonly primary: PlatformAccount
  /** Additional accounts allowed to summon on this platform. */
  readonly additional?: readonly PlatformAccount[]
}

/** The AI side: the single identity this plugin posts as, per platform. */
export interface AiAccountBinding {
  readonly platform: PlatformId
  readonly account: PlatformAccount
}

/** All bindings, keyed by platform at lookup time. */
export interface PlatformAccountBinding {
  readonly owners: readonly OwnerBinding[]
  readonly aiAccounts: readonly AiAccountBinding[]
}

/** An empty binding: no platform has an owner and none may post. */
export const EMPTY_BINDING: PlatformAccountBinding = Object.freeze({
  owners: Object.freeze([]),
  aiAccounts: Object.freeze([]),
})

/**
 * Build the binding table from configuration.
 *
 * `structured` wins when present; the legacy globals are only consulted on
 * platforms the structured form says nothing about. That ordering matters: a
 * user who has migrated should not be surprised by an old field still taking
 * effect on Tieba.
 *
 * @param input.legacy the five global account fields
 * @param input.structured bindings already expressed per platform, if any
 */
export function resolveBindings(input: {
  legacy: {
    ownerUserId: string
    ownerUserName: string
    aiAccountUserId: string
    aiAccountName: string
    allowedOwnerIds: string
  }
  structured?: PlatformAccountBinding
}): PlatformAccountBinding {
  const owners: OwnerBinding[] = []
  const aiAccounts: AiAccountBinding[] = []

  const structuredOwners = new Map<string, OwnerBinding>()
  for (const owner of input.structured?.owners ?? []) {
    structuredOwners.set(owner.platform, owner)
  }
  const structuredAi = new Map<string, AiAccountBinding>()
  for (const account of input.structured?.aiAccounts ?? []) {
    structuredAi.set(account.platform, account)
  }

  // Legacy globals describe Tieba and nothing else.
  //
  // `LEGACY_PLATFORM` is deliberately a single constant rather than a list: the
  // moment two platforms share "the legacy fields", the collision this module
  // exists to prevent is back.
  const legacy = LEGACY_PLATFORM
  if (!structuredOwners.has(legacy)) {
    const legacyOwner = legacyOwnerBinding(input.legacy)
    if (legacyOwner !== undefined) owners.push(legacyOwner)
  }
  if (!structuredAi.has(legacy)) {
    const legacyAi = legacyAiBinding(input.legacy)
    if (legacyAi !== undefined) aiAccounts.push(legacyAi)
  }

  for (const owner of structuredOwners.values()) owners.push(owner)
  for (const account of structuredAi.values()) aiAccounts.push(account)

  return {
    owners: owners.sort((a, b) => a.platform.localeCompare(b.platform)),
    aiAccounts: aiAccounts.sort((a, b) => a.platform.localeCompare(b.platform)),
  }
}

/** The one platform the global legacy fields have ever described. */
const LEGACY_PLATFORM: PlatformId = 'tieba'

/**
 * The legacy global fields, as an owner binding.
 *
 * Every field is read through `?? ''`: a *resolved* config always has all three, but
 * this function is also reached with partial configs — a test double that supplies only
 * the AI account fields, for instance. Calling `.trim()` on a missing one threw
 * `Cannot read properties of undefined (reading 'trim')`, and because the call happens
 * inside `runPublish`'s account resolver the failure surfaced as an opaque publish
 * error naming no field at all. Absent and empty mean the same thing here ("this legacy
 * field is not configured"), so both fall through to the same branch.
 */
function legacyOwnerBinding(legacy: {
  ownerUserId: string
  ownerUserName: string
  allowedOwnerIds: string
}): OwnerBinding | undefined {
  const id = (legacy.ownerUserId ?? '').trim()
  const name = (legacy.ownerUserName ?? '').trim()
  if (id === '' && name === '') return undefined

  const additional = (legacy.allowedOwnerIds ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => ({
      platform: LEGACY_PLATFORM,
      accountId: entry,
      idStrength: 'stable' as const,
    }))

  return {
    platform: LEGACY_PLATFORM,
    primary: {
      platform: LEGACY_PLATFORM,
      ...(id !== '' ? { accountId: id } : {}),
      ...(name !== '' ? { displayName: name } : {}),
      // A configured id is platform-assigned; a name-only binding is weaker and
      // the analyzer already knows to treat it as such.
      idStrength: id !== '' ? 'stable' : 'name_only',
    },
    ...(additional.length > 0 ? { additional } : {}),
  }
}

function legacyAiBinding(legacy: {
  aiAccountUserId: string
  aiAccountName: string
}): AiAccountBinding | undefined {
  // Same `?? ''` reasoning as `legacyOwnerBinding`: a partial config is legitimate for
  // a caller that only knows the AI fields, and absent means "not configured", not
  // "crash here".
  const id = (legacy.aiAccountUserId ?? '').trim()
  const name = (legacy.aiAccountName ?? '').trim()
  if (id === '' && name === '') return undefined
  return {
    platform: LEGACY_PLATFORM,
    account: {
      platform: LEGACY_PLATFORM,
      ...(id !== '' ? { accountId: id } : {}),
      ...(name !== '' ? { displayName: name } : {}),
      idStrength: id !== '' ? 'stable' : 'name_only',
    },
  }
}

/**
 * The owner binding for one platform.
 *
 * **Never falls back to another platform.** Returning `undefined` is the whole
 * point: it means "this platform has no owner bound", which callers turn into a
 * refusal rather than into a guess.
 */
export function ownerFor(
  binding: PlatformAccountBinding,
  platform: PlatformId,
): OwnerBinding | undefined {
  return binding.owners.find((entry) => entry.platform === platform)
}

/** The AI posting identity for one platform, or `undefined` when none is bound. */
export function aiAccountFor(
  binding: PlatformAccountBinding,
  platform: PlatformId,
): AiAccountBinding | undefined {
  return binding.aiAccounts.find((entry) => entry.platform === platform)
}

/**
 * Whether an account id may summon the plugin on a given platform.
 *
 * Compares only within the platform, and only against ids configured *for* that
 * platform. A Tieba id grants nothing on Weibo even when the digits are equal.
 */
export function isAllowedOwnerOn(
  binding: PlatformAccountBinding,
  platform: PlatformId,
  accountId: string | undefined,
): boolean {
  if (accountId === undefined || accountId === '') return false
  const owner = ownerFor(binding, platform)
  if (owner === undefined) return false
  if (owner.primary.accountId === accountId) return true
  return (owner.additional ?? []).some((entry) => entry.accountId === accountId)
}

/** Platforms that have an owner bound, for the diagnostics page. */
export function boundOwnerPlatforms(binding: PlatformAccountBinding): readonly PlatformId[] {
  return binding.owners.map((entry) => entry.platform)
}

/** Platforms that may publish, for the diagnostics page. */
export function boundAiPlatforms(binding: PlatformAccountBinding): readonly PlatformId[] {
  return binding.aiAccounts.map((entry) => entry.platform)
}
