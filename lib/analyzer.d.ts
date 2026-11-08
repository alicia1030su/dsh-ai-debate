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
import type { NestedReply, PlatformId } from './types.js';
import type { CollectedThread, TimelineEntry } from './collector.js';
import type { IdentitySource, NumericUidNamespace, OwnerIdentityEvidence } from './identity.js';
/** How the owner was identified. */
export type OwnerMatchKind = 'id' | 'name';
/** A person in the conversation. */
export interface Participant {
    /** Display name; also the merge key for identity across mixed handles. */
    readonly key: string;
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
    readonly userId?: string;
    /** Login name (`un` / `username`), the strongest identity a WAP read offers. */
    readonly handle?: string; /**
     * A pre-v0.2.23 account string whose namespace was never recorded (v0.2.23).
     *
     * On Tieba, v0.2.22 documented `authorId` as the `un` login name, so this is
     * read as a handle for display purposes. It is kept in its own field because a
     * historical record cannot prove it was a handle any more than it can prove it
     * was a uid — and an owner match that relies on it must say so rather than
     * present itself as a uid match.
     */
    readonly legacyAccountId?: string;
    /**
     * Which namespace the numeric uid belongs to, as *observed* (v0.2.23 patch 4).
     *
     * This must come from the record that carried the number, never from the owner's
     * configuration. Deriving it from the config is what let a `tieba_uid: 12345`
     * owner match a `user_id: 12345` post: the numbers were equal, the namespaces were
     * not, and the evidence then recorded the *configured* namespace — producing a
     * record that looked consistent with a match that never happened.
     */
    readonly userIdNamespace?: NumericUidNamespace;
    /** The platform the numeric uid was read from, for the same reason. */
    readonly platform?: string;
    /**
     * Which surface this participant's records came from (v0.2.23).
     *
     * Carried onto the evidence so a handle match can say *where* the login name was
     * seen. Absent for all-legacy participants, which is precisely why they cannot
     * be verified.
     */
    readonly source?: IdentitySource;
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
    readonly hasDeclaredSource?: boolean;
    readonly displayName: string;
    /** How the key was derived, so the UI can explain a name-based match. */
    readonly matchKind: OwnerMatchKind;
    readonly postCount: number;
    readonly lastPostId?: string;
    readonly lastSpokeIndex: number;
    /**
     * How many distinct account handles appeared under this display name.
     *
     * The platform is inconsistent about exposing a handle, so one person can show
     * up with and without one. This counter lets the owner check refuse a name
     * that genuinely maps to several accounts, without splitting one person in two.
     */
    readonly distinctHandles?: number;
}
/** One statement attributed to a participant. */
export interface Statement {
    readonly postId: string;
    readonly floorNumber?: number;
    readonly authorKey: string;
    readonly authorName?: string;
    readonly content: string;
    readonly createdAt?: string;
    /** The name this statement answers, when the platform stated one. */
    readonly replyToName?: string;
}
/** Why the analyzer picked a particular opponent. */
export interface OpponentEvidence {
    /** Direct reply edges from owner to this participant, and back. */
    readonly exchanges: number;
    /** Owner posts that explicitly answered this participant. */
    readonly ownerRepliesTo: number;
    /** Posts from this participant that answered the owner. */
    readonly repliesToOwner: number;
    /** Index of the participant's latest post, for recency comparison. */
    readonly lastSpokeIndex: number;
    /** Other participants who were still talking, for transparency. */
    readonly otherActiveParticipants: readonly string[];
}
/** The reconstructed dispute. */
export interface Dispute {
    readonly floorNumber?: number;
    readonly floorPostId: string;
    readonly owner: Participant;
    readonly opponent?: Participant;
    readonly opponentEvidence?: OpponentEvidence;
    /** Ordered exchange between owner and opponent, oldest first. */
    readonly exchange: readonly Statement[];
    /** Every statement the owner made in this thread, oldest first. */
    readonly ownerStatements: readonly Statement[];
    /** Questions from the opponent the owner has not answered. */
    readonly openQuestions: readonly Statement[];
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
    readonly bystanders: readonly Participant[];
    /** True when the opponent could not be identified with confidence. */
    readonly needsConfirmation: boolean;
    /** Human-readable reasons for `needsConfirmation`, or for the choice made. */
    readonly notes: readonly string[];
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
    readonly ownerIdentityAssurance: 'verified' | 'unverified';
    /**
     * What backed that assurance (v0.2.23).
     *
     * Carried so the publish gate can *recompute* the verdict instead of trusting a
     * stored string. See `OwnerIdentityEvidence` for why a bare label was not enough.
     */
    readonly ownerIdentityEvidence: OwnerIdentityEvidence;
}
/** The trigger that started this task. */
export interface TriggerRef {
    readonly postId: string;
    /** Content of the trigger post, already plain text. */
    readonly content?: string;
    /** When known, the account that was summoned. */
    readonly aiAccountName?: string;
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
    readonly platform?: PlatformId;
    /** Stable platform id; preferred. */
    readonly userId?: string;
    /**
     * Which namespace `userId` belongs to (v0.2.23).
     *
     * A bare number is not an identity: Tieba publishes both a `user_id` and a
     * `tieba_uid`, in unrelated namespaces. Recording which one the config meant
     * lets the gate refuse a numeric claim that cannot be placed.
     *
     * v0.2.28: widened to accept `platform:<id>`, which is the *only* namespace a
     * single-id platform has. Keeping the narrower type here is what made the
     * derived value (`platform:weibo`) fail to satisfy it in the first place.
     */
    readonly userIdNamespace?: NumericUidNamespace;
    /**
     * Login name (`un`) as published by the platform (v0.2.23).
     *
     * This is the only owner field that can match a WAP floor: that surface
     * publishes `un` and no numeric uid. It is matched against `authorId`, which
     * v0.2.23 defines as the handle — never against a numeric uid, and never
     * merged with `userName`, because a login name is not a nickname.
     */
    readonly handle?: string;
    /** Display name; used only when no id is configured or matched. */
    readonly userName?: string;
}
/**
 * Rebuild the dispute around one trigger post.
 *
 * @param collected the collected thread
 * @param owner the bound owner identity
 * @param trigger the post that summoned the AI
 * @returns the dispute, with `needsConfirmation` set when the target is unclear
 */
export declare function analyzeDispute(collected: CollectedThread, owner: OwnerIdentity, trigger: TriggerRef): Dispute;
/**
 * Build the account-handle → display-name directory for one timeline.
 *
 * The platform sometimes renders a post with a numeric user id and no name (nine
 * of a live thread's nested replies did). Another post by the same id usually
 * carries the name, so recovering it keeps the conversation readable instead of
 * showing "unknown user" for a real participant.
 */
export declare function buildHandleDirectory(timeline: readonly TimelineEntry[]): ReadonlyMap<string, string>;
/**
 * Resolve one entry to its participant key (the display name it belongs to).
 *
 * Exported so callers outside the analyzer can group posts consistently; passing
 * the directory from {@link buildHandleDirectory} is what keeps a nameless post
 * attributed to the right person.
 */
export declare function resolveKey(entry: TimelineEntry, nameByHandle: ReadonlyMap<string, string>): string;
/**
 * True when the text reads as a question in Chinese or English.
 *
 * ## 为什么不能只看关键词（v0.2.38）
 *
 * 旧实现把「依据」「证据」当成疑问标记，于是「依据我前面贴过了。」被读成一句提问。
 * 这两个词是**名词**，在陈述句里同样常见：对手在说「我已经贴过依据了」，而分析器
 * 把它记成「对手在追问依据」—— 同一句话，一边丢掉一条论据，一边多出一条没问过的
 * 问题。评测语料 `context/01` 的零结构就是这么来的。
 *
 * 现在的规则是三档，只有前两档能单独定性：
 *
 * 1. 问号 —— 明确。
 * 2. 疑问代词/疑问副词（为什么/凭什么/怎么/是否/多少……）—— 明确。
 * 3. 名词性词（依据/证据/数据/理由）—— **只在疑问框架里**才算：要么前面有
 *    「有/没有/什么/哪」引出，要么后面接「呢/吗/是什么/在哪」。孤立的「依据」
 *    不再改变句子的语气。
 */
export declare function looksLikeQuestion(content: string): boolean;
/**
 * True when a post actually argues something, rather than only summoning.
 *
 * Stripping @-mentions and whitespace and then requiring a few characters is a
 * cheap, honest test: "@吵架小号 过来帮我说两句" reduces to "过来帮我说两句"
 * which still counts, while "@吵架小号 上。" reduces to "上。" and does not.
 */
export declare function isSubstantive(content: string): boolean;
/**
 * Extract the owner's most load-bearing claims.
 *
 * A claim is a sentence the owner stated as fact or opinion. Interrogatives are
 * excluded, because the owner asking a question is not the owner asserting.
 *
 * ## 为什么先按逗号切（v0.2.38）
 *
 * 「你那个方案忽略了迁移成本，这一块谁来付？」是一句**又有主张又有追问**的话。
 * 旧实现整句送给 `looksLikeQuestion`，判成问句就整句丢掉 —— 于是对手唯一一条
 * 实质论断消失了，简报里连一条对方论据都没有，回复只能空转（`quality/long-01`）。
 *
 * 现在先按分句切，再逐句判断：陈述分句留下，疑问分句丢掉。这样「忽略了迁移成本」
 * 成为可引用的论据，「谁来付」仍然不被当成论据。丢的是语气，不是内容。
 */
export declare function extractClaims(statements: readonly Statement[], limit?: number): readonly string[];
/** Summarize a floor's participants, for the UI and the compressor. */
export declare function describeParticipants(collected: CollectedThread, floor: string | number): readonly Participant[];
/** All nested replies under a floor, addressed by post id or displayed number. */
export declare function nestedOf(collected: CollectedThread, floor: string | number): readonly NestedReply[];
//# sourceMappingURL=analyzer.d.ts.map