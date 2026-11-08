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
/**
 * A question, with the post that asked it (v0.2.35 §3.1 items 4 and 5).
 *
 * ## Why a question is a separate type from a challenge
 *
 * `challenges` means "the opponent asked, the owner did not answer" — it carries a
 * judgement about the reply the owner owes. A question in the ledger carries no judgement:
 * it records who asked, whether anyone answered, and which post did it. That makes the
 * mirror direction expressible, and the mirror is the one that was missing: questions the
 * **owner** asked that the **opponent** never answered are the strongest material a reply
 * has, and questions the opponent asked that the owner *did* answer must not be answered
 * again.
 */
export interface BriefQuestion {
    /** The question as it was written, quoted from the post. */
    readonly quote: string;
    /** The post that asked it. */
    readonly postId: string;
    /** The first later substantive post from the other side, when there was one. */
    readonly answerPostId?: string;
    /** What that answer said, quoted. */
    readonly answerQuote?: string;
    /**
     * The post that replied **without addressing the question**, when that is what happened.
     *
     * ## Why this is separate from `answerPostId`
     *
     * 「他答了」 and 「他回了一句，但没回答这个问题」 are different facts, and the first version
     * of this ledger collapsed them: any later substantive post counted as an answer, so
     * 「反正大家都这么说」 closed a question about where a number came from. That is precisely
     * the evasion the reply should be able to point at, and the coarse rule made it invisible.
     *
     * A reply with no subject token in common with the question is recorded here instead, so
     * the brief can say 「对方回了一句，但没回答」 — a claim with two citations behind it.
     */
    readonly evasionPostId?: string;
    readonly evasionQuote?: string;
}
/**
 * A place the opponent left the subject (v0.2.35 §3.1 item 6).
 *
 * Both ends are cited: the statement that was on topic and the one that was not. A shift
 * with only the second half would be an accusation without a baseline.
 */
export interface BriefTopicShift {
    readonly postId: string;
    readonly quote: string;
    readonly previousPostId: string;
    readonly previousQuote: string;
    /** The words that announced the change, when the text contained any. */
    readonly marker?: string;
}
/**
 * Two of the opponent's own statements that cannot both hold (v0.2.35 §3.1 item 7).
 *
 * `subject` is the phrase the two share after negation is stripped — the claim they agree
 * on — so a reviewer can see *what* is contradicted rather than being told that something
 * is.
 */
export interface BriefContradiction {
    readonly firstPostId: string;
    readonly firstQuote: string;
    readonly secondPostId: string;
    readonly secondQuote: string;
    readonly subject: string;
}
/**
 * Somebody outside the argument, quoted inside it (v0.2.35 §3.1 item 8).
 *
 * ## The distinction this type exists to preserve
 *
 * 「专家说成本会翻倍」 is not the opponent claiming costs will double; it is the opponent
 * citing a third party. A reply that answers it as the opponent's own position argues with
 * the wrong person. The citation therefore lives in its own section of the brief, and
 * `validateBrief` refuses one attributed to a post that is not the opponent's.
 */
export interface BriefThirdPartyCitation {
    readonly postId: string;
    readonly quote: string;
    /** Who the post said it came from, when it said. */
    readonly attribution?: string;
    /** What the reviewer should not conclude from it. */
    readonly note: string;
}
/** The eight argument-form problems §3.3 names. */
export type BriefFallacyCode = 'equivocation' | 'self_contradiction' | 'hasty_generalization' | 'false_cause' | 'topic_shift' | 'quote_mining' | 'evasion' | 'missing_evidence';
/**
 * One cited observation about how an argument was made (v0.2.35 §3.3).
 *
 * ## Why every field is mandatory
 *
 * A fallacy claim is the easiest thing in this codebase to get wrong and the hardest to
 * defend. Requiring `quote`, `why` and a confidence means each one can be checked against
 * the post it names; `otherQuote` carries the second half of a contradiction or the
 * original sentence behind a truncated quotation, because neither is visible from one span.
 *
 * ## What the consumer must not do with it
 *
 * These are leads for a human and for the prompt, not verdicts. The generator is told not
 * to name the fallacy unless it is the natural way to answer, and the report counts them
 * separately from the checks that gate.
 */
export interface BriefFallacy {
    readonly code: BriefFallacyCode;
    /** The Chinese label, carried so no consumer has to re-derive it. */
    readonly label: string;
    readonly postId: string;
    readonly quote: string;
    readonly why: string;
    readonly confidence: 'high' | 'medium' | 'low';
    /** The other post needed to see the problem, when one is needed. */
    readonly otherPostId?: string;
    readonly otherQuote?: string;
}
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
    /**
     * The owner's substantive claims, each citing its own post.
     *
     * 注意方向：这是**主人**的论据。对方的论据在 {@link opponentArguments}，
     * 两者分开是有意的 —— 合成一个列表后，模型很容易把对方的话当成主人的立场
     * 去「坚持」，而那正好是最严重的一类错误（替主人改口）。
     */
    readonly arguments: readonly BriefArgument[];
    /**
     * 对方提出的核心论据（v0.2.34 §4.2）。
     *
     * ## 为什么必须单独列出来
     *
     * 此前简报只有「对方立场」一句摘要 + 「尚未被回应的质疑」。于是模型知道对方
     * **大概**在说什么、也知道对方问了什么，但拿不到对方**逐条**的论据 ——
     * 结果是回复只能泛泛地说「你的说法站不住」，而无法指名反驳第二条论据。
     *
     * 任务书 §4.2 把「对方提出的核心论据」列为回复前必须明确的一项，这是它。
     *
     * ## 与 `challenges` 的区别
     *
     * - `challenges` 是**没被回应**的质疑，带「主人没回」这个判断；
     * - `opponentArguments` 是对方说过的论据，不论主人回没回。
     *
     * 两者可以有重叠，但用途不同：前者用于「补上欠的回答」，后者用于「直接反驳」。
     *
     * ## 为什么可选
     *
     * 与 `bystanders` 同一条理由：**缺省**表示「这条路径没有收集对方论据」（旧调用方），
     * `[]` 表示「收集了，对方没给出可抽取的论据」。把两者合成一个空数组，会让
     * 「我们没看」和「对方没说过」变成同一句话。
     */
    readonly opponentArguments?: readonly BriefArgument[];
    /**
     * 主人问过、对方没有回答的问题（v0.2.35 §3.1 第 4 项）。
     *
     * 与 `openQuestions` 方向相反：那是对方问、主人没答；这是主人问、对方没答。
     * 两者都重要，但用途相反 —— 前者是欠的回答，后者是可以追问的把柄。混用会
     * 生成一条「你倒是回答我」的回复，而对方问的问题其实主人一直没答。
     *
     * 可选语义与 `opponentArguments` 一致：缺省＝这条路径没有收集；`[]`＝收集了，
     * 主人没问过问题或对方都答了。
     */
    readonly unansweredByOpponent?: readonly BriefQuestion[];
    /**
     * 对方问过、主人**已经回答**的问题（§3.1 第 5 项）。
     *
     * 存在的唯一目的是防止重复：模型看不到这层关系时，会把主人两轮之前答过的问题
     * 再答一遍，读起来像是忘了自己说过什么。
     */
    readonly answeredByOwner?: readonly BriefQuestion[];
    /** 对方离开话题的地方（§3.1 第 6 项）。 */
    readonly topicShifts?: readonly BriefTopicShift[];
    /** 对方前后矛盾的地方（§3.1 第 7 项）。 */
    readonly contradictions?: readonly BriefContradiction[];
    /** 对方引用的第三方观点（§3.1 第 8 项）。 */
    readonly thirdPartyCitations?: readonly BriefThirdPartyCitation[];
    /** 这次读取缺失的上下文（§3.1 第 9 项）。 */
    readonly missingContext?: readonly string[];
    /** 可引用的论证形式问题（§3.3）。 */
    readonly fallacies?: readonly BriefFallacy[];
    readonly challenges: readonly BriefChallenge[];
    /**
     * Questions the **opponent** put to the owner that the owner never answered.
     *
     * ## Direction matters, and this comment used to have it backwards (v0.2.12 audit)
     *
     * The source is `Dispute.openQuestions`, which `analyzer.ts` documents as "Questions from
     * the opponent the owner has not answered". This comment claimed the opposite, and
     * `renderBrief` printed the heading "对方没有回答的问题" — so the model was told the
     * *opponent* was evading, when in fact the owner was.
     *
     * That inverts the entire rhetorical direction: a reply built on it would demand "answer my
     * question" from someone who never dodged anything. The field, its source and its rendered
     * heading now all say the same thing.
     */
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
    /**
     * The text of each post, for quote verification (v0.2.35).
     *
     * ## Why the id set was not enough
     *
     * An id that exists proves *something* was read; it does not prove the quote attributed
     * to it is really there. Every finding in v0.2.35 carries the exact span it came from, so
     * the check has to compare against the text. Optional so callers that only have ids (and
     * tests that check attribution alone) keep working — when it is absent, quotes are
     * checked for shape but not for content, and the absence is visible at the call site.
     */
    readonly contentOf?: ReadonlyMap<string, string>;
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