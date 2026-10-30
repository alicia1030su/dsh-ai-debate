/**
 * Whether two positions actually conflict.
 *
 * ## The failure this replaces (v0.2.13 §三)
 *
 * v0.2.12's `buildBrief` produced a disagreement on one condition: both sides had evidence.
 *
 *     if (ownerPosition.evidence.length > 0 && opponentPosition.evidence.length > 0) {
 *       disagreements.push(`主人主张「…」，对方主张「…」，两者不能同时成立。`)
 *     }
 *
 * Reproduced with the shipped build:
 *
 *     owner:    "我喜欢吃苹果，尤其是红富士苹果。"
 *     opponent: "我喜欢喝乌龙茶，尤其是热乌龙茶。"
 *     → "…两者不能同时成立。"
 *     → validateBrief() returns zero problems
 *
 * Both of those statements are true at the same time. The brief asserted a logical
 * contradiction that does not exist, and the validator — which checks citations exist and
 * attributions are right — had no way to notice, because it never claimed to check meaning.
 *
 * ## What this module can and cannot do
 *
 * It is a **structural** judge, not a semantic one. It has no world model. What it can do is
 * refuse to make a claim the evidence does not support, and classify the relationship into the
 * categories that are *decidable from surface cues*:
 *
 * - **contradiction** — the two sides make incompatible claims about the *same* thing: the same
 *   number, the same subject with opposing polarity ("值" vs "不值"), or an explicit negation.
 * - **different_topics** — no shared subject at all. This is the apple/oolong case.
 * - **different_preference** — the same domain, but both are statements of taste, which coexist.
 * - **agreement** — both mention the same fact without disagreeing about it.
 * - **unknown** — everything else, including anything that might be a real disagreement this
 *   code cannot prove.
 *
 * `unknown` is a first-class answer and it must reach the human reviewer. The design rule from
 * the task book: when there is no reliable evidence of a contradiction, do not print one. An
 * "I could not tell" that a person checks is worth more than a confident sentence that is wrong,
 * because the wrong one gets approved without a second look.
 *
 * ## Deliberately absent
 *
 * No attempt to infer intent, sarcasm, or who "won". No heuristics that flatter the owner — the
 * task book is explicit that inventing an opponent's logical error to protect the owner is
 * forbidden. If this module cannot see a contradiction, it says so, even when the owner would
 * prefer it saw one.
 */
export type PositionRelation = 
/** Incompatible claims about the same subject: a real dispute. */
'contradiction'
/** Both affirm the same thing about the same object. */
 | 'agreement'
/** Same domain, both statements of preference — these coexist. */
 | 'different_preference'
/** No shared subject: two people talking past each other. */
 | 'different_topics'
/**
 * The two statements might be about the same thing, and might disagree — but establishing
 * either requires context this module does not have (v0.2.14 §6.2).
 *
 * This is the honest answer for `这个方案可行` / `这个方案不可行`: a reader knows they are
 * arguing, and the code cannot prove it. It must reach a human, not become a confident claim.
 */
 | 'clarification_needed'
/** Not decidable from the text. Must be reviewed by a human. */
 | 'unknown';
/** The verdict, with the reason a reviewer can check. */
export interface ConflictVerdict {
    readonly relation: PositionRelation;
    /** True only for `contradiction`. Everything else must not be rendered as a disagreement. */
    readonly isContradiction: boolean;
    /** Plain-language reason, shown in the brief so the reviewer can judge it. */
    readonly reason: string;
    /** The specific shared subject when one was found, for traceability. */
    readonly subject?: string;
    /**
     * True when a human should look at this before a reply goes out.
     *
     * Set for `unknown` and for any contradiction found by a weak signal, because a machine
     * verdict about meaning deserves a second pair of eyes even when it looks clear.
     */
    readonly requiresReview: boolean;
    /** How strong the signal was. `weak` verdicts never suppress the review flag. */
    readonly confidence: 'strong' | 'weak';
}
/**
 * Judge how two statements relate.
 *
 * The order of the checks is the logic — each earlier category is more specific than the ones
 * after it, and the last fallback is `unknown` rather than a guess.
 */
export declare function judgeRelation(input: {
    readonly ownerText: string;
    readonly opponentText: string;
}): ConflictVerdict;
/** A short, renderable description of the relation, for the brief's prose. */
export declare function describeRelation(verdict: ConflictVerdict): string;
//# sourceMappingURL=conflict.d.ts.map