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
import type { NestedReply } from './types.js';
import type { CollectedThread, TimelineEntry } from './collector.js';
/** How the owner was identified. */
export type OwnerMatchKind = 'id' | 'name';
/** A person in the conversation. */
export interface Participant {
    /** Display name; also the merge key for identity across mixed handles. */
    readonly key: string;
    readonly userId?: string;
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
    /** True when the opponent could not be identified with confidence. */
    readonly needsConfirmation: boolean;
    /** Human-readable reasons for `needsConfirmation`, or for the choice made. */
    readonly notes: readonly string[];
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
    /** Stable platform id; preferred. */
    readonly userId?: string;
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
/** True when the text reads as a question in Chinese or English. */
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
 */
export declare function extractClaims(statements: readonly Statement[], limit?: number): readonly string[];
/** Summarize a floor's participants, for the UI and the compressor. */
export declare function describeParticipants(collected: CollectedThread, floor: string | number): readonly Participant[];
/** All nested replies under a floor, addressed by post id or displayed number. */
export declare function nestedOf(collected: CollectedThread, floor: string | number): readonly NestedReply[];
//# sourceMappingURL=analyzer.d.ts.map