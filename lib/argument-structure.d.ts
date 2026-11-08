/**
 * The argument structure: what the two sides actually said, and what is missing.
 *
 * ## Why this is a separate pass rather than more prompt text
 *
 * v0.2.34 added `opponentArguments` to the brief and that fixed one thing: the model could
 * finally see the opponent's claims one by one. It did not fix the other nine. A reply could
 * still demand evidence the opponent had already given, re-answer a question the owner had
 * already answered, or treat a quoted third party as the opponent's own position — because
 * none of those relationships were *computed*, and a model asked to "be careful" about
 * them is being asked to do bookkeeping it cannot verify.
 *
 * So this module computes them from the collected text, and every finding carries the exact
 * substring and post id it came from. `validateBrief` then checks that every quote really
 * occurs in the post it names. A finding that cannot quote its source does not exist.
 *
 * ## What this is not
 *
 * It is not a second debate engine. It reads the same `Dispute` the analyzer built and the
 * same `CollectedThread` the collector read; it adds no new notion of who is arguing with
 * whom, no new identity resolution, and no model call. Its output is a set of *cited
 * observations* whose only consumers are the brief renderer and the reviewer.
 *
 * ## The rule that keeps the fallacy list honest
 *
 * "The opponent is wrong, therefore the opponent committed a fallacy" is the failure mode
 * this file is most likely to have. Two rules prevent it:
 *
 * 1. **Every detector requires a textual marker**, not a stance. `hasty_generalization`
 *    needs a universal quantifier *and* a single-case marker in the same sentence;
 *    `self_contradiction` needs two sentences that survive negation-stripping into the same
 *    predicate. Disagreeing with the owner is never a marker.
 * 2. **Confidence is reported, and low confidence is the common case.** The prompt tells the
 *    model these are leads, not verdicts, and that naming a fallacy is usually worse than
 *    answering the point.
 */
import { type Dispute } from './analyzer.js';
import type { BriefContradiction, BriefDecisivePoint, BriefFallacy, BriefFallacyCode, BriefQuestion, BriefThirdPartyCitation, BriefTopicShift } from './brief.js';
import type { CollectedThread } from './collector.js';
/** Everything this pass is allowed to read. */
export interface ArgumentInput {
    readonly collected: CollectedThread;
    readonly dispute: Dispute;
}
/** The computed structure handed to the brief builder. */
export interface ArgumentStructure {
    /**
     * Questions the **owner** asked that the opponent never answered (§3.1 item 4).
     *
     * Direction is the whole point: `dispute.openQuestions` is the mirror image (the
     * opponent asked, the owner did not answer). Mixing them up produces a reply that
     * demands an answer from the person who already asked the question.
     */
    readonly unansweredByOpponent: readonly BriefQuestion[];
    /** Questions the **opponent** asked that the owner did answer (§3.1 item 5). */
    readonly answeredByOwner: readonly BriefQuestion[];
    /** Places the opponent left the subject (§3.1 item 6). */
    readonly topicShifts: readonly BriefTopicShift[];
    /** Pairs of the opponent's own statements that cannot both hold (§3.1 item 7). */
    readonly contradictions: readonly BriefContradiction[];
    /** Quoted third parties inside the opponent's posts (§3.1 item 8). */
    readonly thirdPartyCitations: readonly BriefThirdPartyCitation[];
    /** Context this read is missing, beyond what the brief already lists (§3.1 item 9). */
    readonly missingContext: readonly string[];
    /** Cited observations about flawed argument forms (§3.3). */
    readonly fallacies: readonly BriefFallacy[];
    /**
     * 最值得先回应的一到三条（v0.2.36 §5.2）。
     *
     * ## 为什么需要它
     *
     * v0.2.35 的简报把「对方说了什么」列全了，但没有回答「先打哪一点」。模型面对
     * 十条材料时，倾向于挑**最好反驳**的那条，而不是**最影响结论**的那条 ——
     * 于是回复读起来像在挑软柿子。
     *
     * 这里按「改变了结论没有」排序，而不是按「好不好反驳」：
     *
     * 1. 前后矛盾（high）：两句话不能同真，直接决定对方立场是否成立；
     * 2. 主人问过、对方回避（带 evasion 引用）：回避本身就是结论性的；
     * 3. 第三方引用被当成自己的论据：立场归属错了，反驳会打错人；
     * 4. 有数量结论但同一帖里没有来源：这是事实层面的缺口；
     * 5. 转移话题：重要，但通常是因为前一点答不上来，排在后面。
     *
     * 每一条都带 postId + 原文，{@link validateBrief} 会照常校验。
     */
    readonly decisivePoints: readonly BriefDecisivePoint[];
}
/**
 * Sentences of a post, trimmed, **with their terminator kept**.
 *
 * ## Why the punctuation stays
 *
 * The first version split on `[。！？!?]` and threw the delimiter away, which made every
 * question invisible to `looksLikeQuestion`: 「那你算过三年期的总成本吗？」 became
 * 「…总成本吗」 with no `？`, and the keyword list does not contain 「吗」 because a
 * statement can end in it too. The result was a ledger that never recorded a single
 * question — and the tests that only counted *contradictions* still passed.
 *
 * Keeping the terminator makes the question mark the signal it is, and costs nothing
 * anywhere else: the quotes stored in the brief are still substrings of the post.
 */
export declare function sentencesOf(content: string): string[];
/** Content tokens used to compare two sentences' subjects. */
export declare function subjectTokens(text: string): Set<string>;
/** Quote spans a post uses: 「…」, “…” and "…". */
export declare function quotedSpans(text: string): string[];
/**
 * Compute the structure.
 *
 * Bounded work: the contradiction scan is quadratic in the opponent's sentences and capped
 * at 60 of them, so a long thread costs a few milliseconds rather than a few seconds. The
 * scale baseline in the test suite measures this path.
 */
export declare function analyzeArguments(input: ArgumentInput): ArgumentStructure;
/** Every fallacy code, for the UI legend and the tests. */
export declare const FALLACY_CODES: readonly BriefFallacyCode[];
/** Human labels, in one place so the renderer and the report cannot drift. */
export declare const FALLACY_LABELS: Readonly<Record<BriefFallacyCode, string>>;
/**
 * True when `quote` really occurs in `content`.
 *
 * Whitespace is normalised on both sides: the quote is taken from a sentence that was
 * trimmed, and a post's line breaks must not turn a real citation into a fabricated one.
 */
export declare function quoteOccursIn(quote: string, content: string): boolean;
//# sourceMappingURL=argument-structure.d.ts.map