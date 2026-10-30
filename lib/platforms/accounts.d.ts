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
import type { PlatformId } from '../types.js';
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
export type AccountIdStrength = 'stable' | 'slug' | 'opaque' | 'name_only';
/** One account on one platform. */
export interface PlatformAccount {
    readonly platform: PlatformId;
    /** Platform-native stable id. Absent when only a display name is known. */
    readonly accountId?: string;
    /** Display name. For humans and logs only — never a matching key. */
    readonly displayName?: string;
    /** How strong `accountId` is; decides whether it may be the sole match. */
    readonly idStrength?: AccountIdStrength;
}
/** The owner side: who may summon, per platform. */
export interface OwnerBinding {
    readonly platform: PlatformId;
    readonly primary: PlatformAccount;
    /** Additional accounts allowed to summon on this platform. */
    readonly additional?: readonly PlatformAccount[];
}
/** The AI side: the single identity this plugin posts as, per platform. */
export interface AiAccountBinding {
    readonly platform: PlatformId;
    readonly account: PlatformAccount;
}
/** All bindings, keyed by platform at lookup time. */
export interface PlatformAccountBinding {
    readonly owners: readonly OwnerBinding[];
    readonly aiAccounts: readonly AiAccountBinding[];
}
/** An empty binding: no platform has an owner and none may post. */
export declare const EMPTY_BINDING: PlatformAccountBinding;
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
export declare function resolveBindings(input: {
    legacy: {
        ownerUserId: string;
        ownerUserName: string;
        aiAccountUserId: string;
        aiAccountName: string;
        allowedOwnerIds: string;
    };
    structured?: PlatformAccountBinding;
}): PlatformAccountBinding;
/**
 * The owner binding for one platform.
 *
 * **Never falls back to another platform.** Returning `undefined` is the whole
 * point: it means "this platform has no owner bound", which callers turn into a
 * refusal rather than into a guess.
 */
export declare function ownerFor(binding: PlatformAccountBinding, platform: PlatformId): OwnerBinding | undefined;
/** The AI posting identity for one platform, or `undefined` when none is bound. */
export declare function aiAccountFor(binding: PlatformAccountBinding, platform: PlatformId): AiAccountBinding | undefined;
/**
 * Whether an account id may summon the plugin on a given platform.
 *
 * Compares only within the platform, and only against ids configured *for* that
 * platform. A Tieba id grants nothing on Weibo even when the digits are equal.
 */
export declare function isAllowedOwnerOn(binding: PlatformAccountBinding, platform: PlatformId, accountId: string | undefined): boolean;
/** Platforms that have an owner bound, for the diagnostics page. */
export declare function boundOwnerPlatforms(binding: PlatformAccountBinding): readonly PlatformId[];
/** Platforms that may publish, for the diagnostics page. */
export declare function boundAiPlatforms(binding: PlatformAccountBinding): readonly PlatformId[];
//# sourceMappingURL=accounts.d.ts.map