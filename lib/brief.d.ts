/**
 * The structured brief a reply is generated from.
 *
 * ## Why a separate structure
 *
 * The generator currently receives a compressed pile of statements and a persona,
 * and is asked for a reply. That works, but it leaves the *reasoning* implicit:
 * nothing records which of the opponent's claims the reply is answering, which
 * facts both sides agree on, or which questions are still open. The result is a
 * reply that reads plausibly and occasionally answers something nobody said.
 *
 * A brief makes those things explicit and, crucially, **citable**: every claim
 * points at the post id it came from. That turns "the model said the opponent
 * claimed X" into "the opponent's post 12345 says X", which a human reviewer can
 * check in one click — and which the generator can be held to.
 *
 * ## The three rules that keep it honest
 *
 * 1. **Every cited id must exist in the collected conversation.** A brief whose
 *    evidence points at a post that was never read is a fabrication, and
 *    `validateBrief` rejects it rather than letting it reach the model.
 * 2. **The opponent's positions are quotations, not summaries.** `quote` is the
 *    opponent's own text, so a reviewer can see whether it was characterised
 *    fairly. `paraphrase` is clearly labelled as an inference.
 * 3. **The brief cannot name a publish target.** The target is decided by the
 *    trigger and the capability gate, never by the model's own reading of the
 *    argument; a brief that could choose where to post would bypass both.
 *
 * ## Persona boundary
 *
 * `PersonaConfig` changes tone and length. It must not change `facts`,
 * `disagreements` or `evidence` — those are what the argument is *about*, and
 * letting a "幽默" persona alter them would be the model rewriting reality to fit
 * a voice. `validateBrief` therefore has no persona parameter at all.
 */
import type { PlatformId } from './types.js';
/** One side's position on the dispute. */
export interface BriefPosition {
    /** Who holds it: the owner's account, or the opponent's. */
    readonly side: 'owner' | 'opponent';
    /** The position in one sentence, as the brief's author understands it. */
    readonly summary: string;
    /**
     * The post ids this position is drawn from.
     *
     * Never empty: a position with no citation is an assertion about what someone
     * said without showing where. `validateBrief` rejects those.
     */
    readonly evidence: readonly string[];
}
/** A fact both sides stated or accepted. */
export interface BriefAgreedFact {
    readonly statement: string;
    /** Posts where this was stated. At least one must be the owner's, at least one the opponent's. */
    readonly evidence: readonly string[];
}
/** One of the owner's arguments. */
export interface BriefArgument {
    readonly claim: string;
    readonly evidence: readonly string[];
}
/** A challenge from the opponent the owner has not answered. */
export interface BriefChallenge {
    /** The opponent's own words. */
    readonly quote: string;
    /** The opponent's post id. */
    readonly evidence: string;
    /**
     * Why it is unanswered: whether the owner never replied, or replied without
     * addressing it. Distinguished because "he ignored it" and "he answered badly"
     * call for different replies.
     */
    readonly unanswered: 'no_reply' | 'reply_did_not_address';
}
/** A point the reply must not assert as fact. */
export interface BriefUncertainty {
    readonly point: string;
    /** Why it is uncertain: platform gap, conflicting statements, no evidence read. */
    readonly reason: string;
}
/** What kind of reply this brief suggests. */
export type BriefDirection = 'rebut' | 'analyse' | 'humour';
/** A third party who spoke inside the argument's floor (v0.2.11). */
export interface BriefBystander {
    /** Display name as the platform rendered it. Not an identity. */
    readonly displayName: string;
    /** How many times they spoke in this floor. */
    readonly postCount: number;
    /**
     * Which side they appear to back, if their words make it explicit.
     *
     * `undefined` is the common case and the honest one: most third parties say something
     * without endorsing anyone. Filling this in from tone would be an inference dressed as
     * a fact, so it is only set when the collected text contains an explicit alignment and
     * a post id can be cited for it.
     */
    readonly leaning?: 'owner' | 'opponent';
    /** Post ids backing the leaning, when one was determined. */
    readonly evidence?: readonly string[];
}
/** The whole brief. */
export interface DebateBrief {
    readonly platform: PlatformId;
    readonly threadId: string;
    /** The post the reply will answer. Decided by the trigger, not by the model. */
    readonly targetPostId: string;
    readonly owner: BriefPosition;
    readonly opponent: BriefPosition;
    /** Where the two actually disagree, in one sentence each. */
    readonly disagreements: readonly string[];
    readonly agreedFacts: readonly BriefAgreedFact[];
    readonly arguments: readonly BriefArgument[];
    readonly challenges: readonly BriefChallenge[];
    /** Questions the owner asked that the opponent left unanswered. */
    readonly openQuestions: readonly string[];
    readonly uncertainties: readonly BriefUncertainty[];
    /** Which reply shapes would fit, most suitable first. */
    readonly directions: readonly BriefDirection[];
    /** Risks a human should know before approving, in plain language. */
    readonly risks: readonly string[];
    /**
     * Third parties who spoke in the same floor (v0.2.11).
     *
     * Not part of the dispute — deliberately. They are here because "the opponent is alone"
     * and "three people already agreed with the opponent" call for different replies, and
     * the exchange list alone cannot tell those apart: it is narrowed to two participants by
     * design.
     *
     * ## Optional, and the two ways it can be empty mean different things
     *
     * - **absent** — this brief was assembled by a path that did not collect bystanders
     *   (an older caller, or a platform whose floor model has no such notion). Nothing is
     *   claimed about who else spoke.
     * - **`[]`** — collected, and nobody else spoke.
     *
     * Collapsing the two would let "we did not look" render as "the opponent stands alone",
     * which is exactly the kind of quiet falsehood this project keeps having to remove. The
     * renderer therefore prints the section only when the array is present *and* non-empty.
     */
    readonly bystanders?: readonly BriefBystander[];
}
/**
 * Everything a brief is allowed to cite.
 *
 * Passed in rather than looked up, so building a brief cannot accidentally reach
 * for a post that was not collected in this run.
 */
export interface BriefSources {
    readonly ownerPostIds: ReadonlySet<string>;
    readonly opponentPostIds: ReadonlySet<string>;
    /** Every post id present in the collected conversation. */
    readonly allPostIds: ReadonlySet<string>;
}
/** A problem found while validating a brief. */
export interface BriefProblem {
    /** Which field the problem is in, for a precise error message. */
    readonly field: string;
    readonly reason: string;
}
/**
 * Check that a brief only asserts what it can cite.
 *
 * Returns every problem rather than the first, because a brief with three
 * fabricated citations should be reported as such in one pass.
 *
 * The checks, and what each prevents:
 *
 * - **citation exists** — a cited post must be in the conversation. Prevents the
 *   model inventing a source.
 * - **side attribution** — the owner's position may only cite the owner's posts,
 *   and the opponent's only the opponent's. Prevents putting words in the wrong
 *   mouth, which is the failure this project treats as worst.
 * - **no empty citation list** — a position or argument with no evidence is an
 *   unsupported claim.
 * - **at least one disagreement** — a brief about a dispute that names no
 *   disagreement is describing something else.
 * - **target is in the conversation** — the reply must answer a real post.
 * - **uncertainties are stated, not empty when they exist** — enforced by the
 *   builder rather than here, since only the builder knows what was not read.
 */
export declare function validateBrief(brief: DebateBrief, sources: BriefSources): readonly BriefProblem[];
/**
 * Human-readable brief, for the review step.
 *
 * Deliberately includes every citation: the reviewer's job is to check that the
 * characterisation matches the posts, so hiding the ids would make the review
 * performative.
 */
export declare function renderBrief(brief: DebateBrief): string;
//# sourceMappingURL=brief.d.ts.map