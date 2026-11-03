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
import type { IdentitySource, PlatformId } from './types.js';
export type { IdentitySource };
/**
 * Which numeric-id namespace a uid belongs to.
 *
 * Tieba has more than one. `user_id` (from `/p/totalComment`) and `tieba_uid`
 * (the newer numeric account id) are separate namespaces: equal values in
 * different namespaces are **not** the same account. Storing the namespace next
 * to the value is what makes "never mix the two" enforceable rather than
 * aspirational.
 */
export type NumericUidKind = 'user_id' | 'tieba_uid';
/**
 * How strongly the evidence ties this author to an account.
 *
 * Ordered strongest to weakest. `unverified` is not a failure — it is the honest
 * answer when a surface cannot prove anything, and it must never be promoted by
 * matching a nickname.
 */
export type IdentityConfidence = 
/** A numeric account id on a surface authoritative for it. */
'numeric_uid'
/** A login name (`un` / `username`) the owner cannot rename. */
 | 'login_handle'
/** Only a display name. A nickname, reusable by anyone. Never proves identity. */
 | 'display_name_only'
/** The surface gave nothing usable at all. */
 | 'unverified'
/** A record written before v0.2.23: its `authorId` has no recorded namespace. */
 | 'legacy_unknown';
/** A single author, with every field the platform actually provided. */
export interface AuthorIdentity {
    readonly platform: PlatformId;
    /** Numeric account id, **only** when the surface stated one as a number. */
    readonly numericUid?: string;
    /** Which numeric namespace `numericUid` lives in. Required whenever it is set. */
    readonly numericUidKind?: NumericUidKind;
    /**
     * Login name (`un` on WAP, `username` on the comment page).
     *
     * May be all digits. Still a handle: the namespace is decided by *where the
     * value came from*, never by what the text looks like.
     */
    readonly handle?: string;
    /** Display name (nickname). Display and candidate suggestion only. */
    readonly displayName?: string;
    /**
     * Avatar path fragment. Auxiliary at most: Tieba's portrait embeds a
     * timestamp, so one account legitimately yields several values over time.
     */
    readonly portrait?: string;
    /** Which surface produced these fields. */
    readonly source: IdentitySource;
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
{
    readonly kind: 'same_numeric_uid';
    readonly namespace: NumericUidKind;
}
/** Same numeric namespace, different values. Two accounts, proven. */
 | {
    readonly kind: 'different_numeric_uid';
    readonly namespace: NumericUidKind;
}
/** Same login name. Same handle *now* — not proof of the same permanent uid. */
 | {
    readonly kind: 'same_handle';
}
/** Different login names. Two accounts (a handle cannot be re-registered). */
 | {
    readonly kind: 'different_handle';
}
/** Only display names agreed. Never proof of identity. */
 | {
    readonly kind: 'display_name_match_only';
    readonly name: string;
}
/** Display names disagreed and nothing stronger existed. Says nothing either way. */
 | {
    readonly kind: 'insufficient_evidence';
}
/** The two sides only hold different namespaces; no reliable mapping exists. */
 | {
    readonly kind: 'unknown_namespace_mismatch';
    readonly detail: string;
}
/** One side is a pre-v0.2.23 record with no recorded namespace. */
 | {
    readonly kind: 'unknown_legacy_record';
};
/** True only for comparisons that positively establish the same account. */
export declare function isSameAccount(comparison: IdentityComparison): boolean;
/**
 * True when the comparison positively establishes *different* accounts.
 *
 * Kept separate from "not same": `insufficient_evidence` is neither, and callers
 * that treat it as a disagreement will refuse work that is merely unproven.
 */
export declare function isDifferentAccount(comparison: IdentityComparison): boolean;
/** True when the two sides cannot be compared at all. */
export declare function isUnknown(comparison: IdentityComparison): boolean;
/**
 * True when the verdict is strong enough for an automatic owner decision.
 *
 * `display_name_match_only` is deliberately excluded: it records a coincidence
 * for a human to look at, not a fact to act on.
 */
export declare function isProvable(comparison: IdentityComparison): boolean;
/** The strongest confidence an identity can support, derived from its fields. */
export declare function confidenceOf(identity: AuthorIdentity): IdentityConfidence;
/**
 * Whether a string is all digits.
 *
 * **This does not classify identity.** It exists for validating input such as a
 * configured uid, and for nothing else: a `un` of `1254480024` is all digits and
 * is still a login name. The namespace of a value is decided by `source` and
 * `numericUidKind`, never by `looksNumeric`.
 */
export declare function looksNumeric(value: string | undefined): boolean;
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
export declare function compareIdentities(a: AuthorIdentity, b: AuthorIdentity): IdentityComparison;
/**
 * One concrete disagreement about who wrote a given post.
 *
 * Both sides are kept verbatim. The report never picks a winner — a caller that
 * needs one has to ask a human.
 */
export interface IdentityConflictReport {
    readonly code: 'identity_conflict';
    readonly platform: PlatformId;
    readonly postId: string;
    readonly first: AuthorIdentity;
    readonly second: AuthorIdentity;
    /** Why the two cannot both be true, in the comparison's own terms. */
    readonly comparison: IdentityComparison;
    /** One sentence a person can act on. */
    readonly summary: string;
}
/**
 * Turn a proven disagreement into a report, or `undefined` when there is none.
 *
 * Only `different_numeric_uid` and `different_handle` produce a conflict.
 * `unknown_*` results do **not**: two surfaces that merely speak different
 * languages have not contradicted each other, and manufacturing a conflict there
 * would block reads that are perfectly sound.
 */
export declare function conflictBetween(input: {
    readonly platform: PlatformId;
    readonly postId: string;
    readonly first: AuthorIdentity;
    readonly second: AuthorIdentity;
}): IdentityConflictReport | undefined;
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
export type IdentityAssurance = 'identity_verified' | 'identity_unknown' | 'identity_conflict';
/** A per-post record of every surface that described it. */
export interface IdentitySightings {
    /** The numeric uid, when some surface stated one. */
    readonly numericUid?: string;
    /**
     * Which namespace that number belongs to (v0.2.23 patch 3).
     *
     * Required for the uid to count as proof. A bare number is not an identity —
     * Tieba's `un` can itself be all digits — so an unplaced number is treated as an
     * unverified claim, exactly like a handle with no recorded source.
     */
    readonly namespace?: NumericUidNamespace;
    /** The handle, when some surface stated one. */
    readonly handle?: string;
    /** Every source that has described this post id. */
    readonly sources: readonly IdentitySource[];
    /** True when two sightings were compared and proven different. */
    readonly conflicted: boolean;
}
/**
 * Decide the assurance level for one post from its sightings.
 *
 * `identity_verified` needs **positive** evidence: either a numeric uid (the only
 * non-spoofable id Tieba publishes) or two distinct sources that agree. A single
 * handle-only sighting is `identity_unknown` — it is not a failure, it is an
 * unverified claim, and the wording at every call site must match that.
 */
export declare function assuranceOf(sighting: IdentitySightings): IdentityAssurance;
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
export declare function corroborationOf(sighting: IdentitySightings): 'corroborated' | 'single_source';
/** Whether an assurance level may be used for an automatic owner decision. */
export declare function allowsAutomaticIdentityDecision(assurance: IdentityAssurance): boolean;
/** A short, honest phrase for each level, suitable for a UI badge or a log. */
export declare function describeAssurance(assurance: IdentityAssurance): string;
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
export type NumericUidNamespace = NumericUidKind | `platform:${string}`;
export interface OwnerIdentityEvidence {
    /**
     * What kind of identifier backed the resolution.
     *
     * `none` and `legacy` both yield `unverified` — they are recorded rather than
     * omitted so the UI can say *why* instead of showing a blank.
     */
    readonly kind: 'numeric_uid' | 'handle' | 'nickname' | 'legacy' | 'none';
    /**
     * The namespace a numeric identifier belongs to.
     *
     * Required for `numeric_uid`: a bare number is not an identity (Tieba's `un`
     * can itself be all digits), so a numeric claim without a namespace is treated
     * as unproven.
     */
    readonly namespace?: NumericUidNamespace;
    /** The identifier value that matched, for the audit trail and the UI. */
    readonly value?: string;
    /**
     * Which surface declared the identifier.
     *
     * A handle only counts when a source actually said "this row's author field is
     * a login name". Rows with no recorded surface are legacy and cannot verify.
     */
    readonly source?: IdentitySource;
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
export declare function assuranceFromEvidence(evidence: OwnerIdentityEvidence | undefined): IdentityAssurance;
/**
 * Explain an assurance in terms of the evidence, for a UI badge or a log line.
 *
 * The wording is the difference between "we checked" and "we guessed", and a user
 * who cannot tell those apart cannot decide whether to trust a reply.
 */
export declare function describeEvidence(evidence: OwnerIdentityEvidence | undefined): string;
/**
 * Explain why a configured owner could not be established.
 *
 * Worded for the person who configured it: what is missing, and what would fix
 * it. It never suggests "just use the nickname" as a silent fallback.
 */
export declare function describeUnverifiableOwner(input: {
    readonly configuredNumericUid?: string;
    readonly configuredHandle?: string;
    readonly observed: readonly AuthorIdentity[];
}): string;
/**
 * Build an identity from the flat fields a record carries.
 *
 * `authorSource` absent means a pre-v0.2.23 record. Its `authorId` has no
 * recorded namespace, so it comes back as a **legacy** identity rather than being
 * silently promoted to a uid: rule 4 of the compatibility contract.
 */
export declare function identityOfEntry(entry: {
    readonly authorId?: string;
    readonly authorName?: string;
    readonly authorSource?: IdentitySource;
    readonly authorNumericUid?: string;
    readonly authorNumericUidKind?: NumericUidKind;
}): AuthorIdentity & {
    readonly legacy: boolean;
};
//# sourceMappingURL=identity.d.ts.map