/**
 * Platform credential namespaces.
 *
 * ## The bug this file exists to fix
 *
 * v0.2.1 derived a credential reference by stripping every character that was not
 * `[A-Za-z0-9]` and uppercasing the rest:
 *
 * ```ts
 * `DSH_AI_DEBATE_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${what}`
 * ```
 *
 * and then decided ownership with `ref.startsWith(prefix + '_')`. Both halves are
 * wrong, in ways that let one platform read another's secret:
 *
 * - `credentialRefFor('foo_bar', 'cookie')` → `DSH_AI_DEBATE_FOO_BAR_COOKIE`,
 *   which `refBelongsToPlatform(..., 'foo')` accepts, because
 *   `DSH_AI_DEBATE_FOO_` is a prefix of it.
 * - `a-b` and `a_b` both normalise to `A_B`, so two distinct platforms share one
 *   namespace — whichever mounts first wins and the other silently reads it.
 * - `tieba`, `Tieba`, `tie ba`, `tie.ba`, `tie/ba` all collapse to `TIE_BA`.
 *
 * ## The fix
 *
 * Two independent changes, because either alone is insufficient:
 *
 * 1. **The encoding is injective.** A platform id is escaped before it enters a
 *    reference: `_` becomes `__`, and any other character outside `[a-z0-9]`
 *    becomes `_<hex>_`. Because `_` itself is escaped first, `a_b` → `a__b` and
 *    `a-b` → `a_2d_b` can never collide, and the mapping can be reversed.
 * 2. **Ownership is decided by re-deriving, not by prefix matching.** Given a
 *    reference and a platform, the reference is rebuilt from that platform's id
 *    and compared for exact equality. A prefix can be a prefix of something else;
 *    an exact string can only match itself.
 *
 * ## Compatibility
 *
 * The real `tieba` platform's live reference is `DSH_AI_DEBATE_TIEBA_COOKIE`
 * (see `COOKIE_REF` in `secrets.ts`), and profiles in the field already have that
 * exact key stored in the Host credential store. Renaming it would orphan every
 * existing deployment's Cookie, so `tieba` keeps its **legacy** reference as the
 * canonical one. The legacy mapping is a closed, explicit table — never a
 * normalisation rule — so it grants nothing to any other id: `tie_ba` does not
 * inherit `tieba`'s reference merely by looking similar.
 */
/** Everything a reference is built from. */
export interface CredentialRefParts {
    readonly platform: string;
    /** What the secret is for, e.g. `cookie` or `token`. */
    readonly what: string;
}
/**
 * Check that a platform id is usable in a credential namespace.
 *
 * Constraints, and why each exists:
 *
 * - lowercase `[a-z0-9_-]`, starting with an alphanumeric: uppercase and
 *   punctuation are exactly the characters the old normaliser collapsed, so
 *   admitting them reopens the collision. Callers that have a mixed-case id must
 *   normalise it before registering.
 * - no leading/trailing separator: `-foo` and `foo-` produce references that read
 *   like malformed words and are easy to mistype into another platform's slot.
 * - at most 32 characters: a reference is stored in a credential key, and a
 *   runaway id should be rejected at registration, not at use.
 *
 * @returns `undefined` when valid, otherwise the reason in Chinese for the UI.
 */
export declare function validatePlatformId(id: string): string | undefined;
/**
 * Encode a platform id into the injective form used inside a reference.
 *
 * Output is **uppercase**, because the reference convention shipped as
 * `DSH_AI_DEBATE_<PLATFORM>_<WHAT>` with an uppercase platform stem, and
 * deployments in the field have keys stored under that exact spelling. Switching
 * the stem to lowercase would orphan them, so the fix for the collision is the
 * escaping, not the case.
 *
 * `_` is escaped first so the escape character cannot be confused with a
 * separator that came from the original id. Hex digits are uppercase to match:
 *
 * | id      | encoded  |
 * | ------- | -------- |
 * | `tieba` | `TIEBA`  |
 * | `a_b`   | `A__B`   |
 * | `a-b`   | `A_2D_B` |
 * | `a.b`   | `A_2E_B` |
 *
 * Because this is injective, two distinct platform ids can never encode to the
 * same stem, which is what closes the `a-b` / `a_b` collision.
 *
 * Encoding is only applied to ids that passed {@link validatePlatformId}; this
 * function does not validate, so that it stays cheap enough to call per lookup.
 */
export declare function encodePlatformId(id: string): string;
/**
 * Build the credential reference for one platform's secret.
 *
 * Deterministic and injective, so two different platforms can never produce the
 * same reference. Throws on an invalid platform id rather than encoding it
 * anyway: a caller with a bad id has a bug, and silently producing a reference
 * for it is how the collision bug stayed invisible.
 */
export declare function credentialRefFor(platform: string, what: string): string;
/**
 * True when a reference belongs to the given platform's namespace.
 *
 * **Exact encoding, not lossy prefix matching.** The check is: the reference must
 * begin with *this platform's exact encoded id* followed by a separator, and the
 * remainder must be a well-formed purpose (`[A-Z0-9][A-Z0-9_]*`).
 *
 * Why that is now airtight, when `startsWith` was not:
 *
 * - Encoded ids are built by an injective escape (see {@link encodePlatformId}),
 *   so two different platform ids never share an encoding.
 * - Encoded ids are **lowercase** (the only uppercase stem is the legacy
 *   `TIEBA`, which belongs to exactly one id), while purposes are **uppercase**.
 *   So if platform A's encoding is a proper prefix of platform B's reference, the
 *   character after A's separator is lowercase and the remainder fails the
 *   uppercase purpose test — `a` cannot read `a_b`'s `a__b_COOKIE`, because the
 *   remainder `_b_COOKIE` is not a valid purpose.
 * - An unparseable or invalid platform id yields `false`, never a loose match:
 *   when ownership cannot be established the answer is "no".
 *
 * Legacy compatibility is preserved by the same path: {@link encodePlatformId}
 * maps `tieba` to the literal stem `TIEBA`, so the real deployment's stored
 * `DSH_AI_DEBATE_TIEBA_COOKIE` still resolves — and `tie_ba` does not, because
 * that is a different id, not a spelling of `tieba`.
 */
export declare function refBelongsToPlatform(ref: string, platform: string): boolean;
/**
 * Every reference this plugin would accept for a platform, for migration.
 *
 * Returns the current form first, then any legacy form still in use. A caller
 * migrating a stored secret walks this list and moves the first hit.
 */
export declare function candidateRefs(platform: string, what: string): readonly string[];
//# sourceMappingURL=credentials.d.ts.map