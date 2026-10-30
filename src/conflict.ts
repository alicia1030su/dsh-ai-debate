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

/** How two stated positions relate. */
import { compareArgumentObjects } from './argument-object.js'

export type PositionRelation =
  /** Incompatible claims about the same subject: a real dispute. */
  | 'contradiction'
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
  | 'unknown'

/** The verdict, with the reason a reviewer can check. */
export interface ConflictVerdict {
  readonly relation: PositionRelation
  /** True only for `contradiction`. Everything else must not be rendered as a disagreement. */
  readonly isContradiction: boolean
  /** Plain-language reason, shown in the brief so the reviewer can judge it. */
  readonly reason: string
  /** The specific shared subject when one was found, for traceability. */
  readonly subject?: string
  /**
   * True when a human should look at this before a reply goes out.
   *
   * Set for `unknown` and for any contradiction found by a weak signal, because a machine
   * verdict about meaning deserves a second pair of eyes even when it looks clear.
   */
  readonly requiresReview: boolean
  /** How strong the signal was. `weak` verdicts never suppress the review flag. */
  readonly confidence: 'strong' | 'weak'
}

/**
 * Words that mark a statement as a matter of taste rather than a claim about the world.
 *
 * When both sides are in this register, a difference is not a contradiction: "I like apples"
 * and "I like oolong" are simultaneously true. This is the apple/oolong case, and it is the
 * single most common shape of a non-disagreement.
 */
const PREFERENCE_MARKERS = /(我喜欢|我不喜欢|我更(喜欢|倾向)|我偏好|我爱|我讨厌|我觉得.{0,6}好|我认为.{0,6}不错|对我来说)/

/**
 * Negation markers.
 *
 * Kept as documentation of what was tried and rejected: the first version compared "does this
 * sentence contain a negation word" and got the price case backwards, because "不算贵" and
 * "太贵" both contain 不 while taking opposite sides. Polarity is now read from pole words
 * (`polarityOf`), and no branch uses this. It is retained because the comment above each
 * removed use explains the failure, and deleting the definition would make those references
 * dangle.
 */
const NEGATION = /(不|没|别|非|无|未)/
void NEGATION

/** A number with an optional unit — the most checkable shared subject there is. */
const NUMBER = /\d+(?:\.\d+)?%?/g

/**
 * Value judgments that mark one pole of an opinion.
 *
 * ## Two bugs this pattern set had to survive (v0.2.13)
 *
 * **1. Negation alone is not polarity.** The first version compared "does this sentence
 * contain a negation word" and got the price case backwards:
 *
 *     owner:    "12 万不算贵。"      ← contains 不, but affirms cheapness
 *     opponent: "12 万太贵了，不值。"  ← contains 不, and negates value
 *
 * Both have a marker, so the comparison said "same polarity" and returned `agreement` for
 * a textbook disagreement.
 *
 * **2. A positive phrase inside a negative word.** The fix then broke the other direction:
 * `可行` is a substring of `不可行`, so a sentence saying "不可行" matched **both** patterns,
 * `polarityOf` returned `undefined`, and a clear disagreement became `unknown`.
 *
 * The pairs are therefore listed **negative-first** and checked in that order, so the longer
 * negated form wins over the positive substring it contains.
 */
const NEGATIVE_POLE = /(不值|太贵|贵了|浪费|不可行|不行|反对|不同意|有问题|站不住|离谱|瞎说|没必要|不划算|不合理)/
const POSITIVE_POLE = /(值得|划算|便宜|不贵|不算贵|合理|可行|认同|支持|同意|没问题|挺好的|不错)/
void POSITIVE_POLE

/**
 * Which pole a statement sits on, if it clearly sits on one.
 *
 * ## Negative checked first, deliberately
 *
 * `可行` is a substring of `不可行`. If the positive pattern were tested first, a sentence
 * saying "不可行" would match it as well as the negative pattern, both flags would be true, and
 * the function would return `undefined` — turning a clear disagreement into `unknown`.
 *
 * Testing the negative form first and returning immediately means the longer negated phrase
 * wins over the positive substring inside it. That is the correct precedence: in Chinese the
 * negation is a prefix on the affirmative word, not a separate word.
 *
 * `undefined` means "no clear pole" — which must not be treated as either side agreeing or
 * disagreeing. Returning a default here is how a guess becomes a claim.
 */
function polarityOf(text: string): 'positive' | 'negative' | undefined {
  if (NEGATIVE_POLE.test(text)) return 'negative'
  if (POSITIVE_POLE.test(text)) return 'positive'
  return undefined
}

/**
 * Extract the "subject" of a statement: the noun-ish thing it is about.
 *
 * ## Why this is crude on purpose
 *
 * A real parser would be better and is not available here. What matters is that the result is
 * **conservative**: when it extracts nothing, the caller must not conclude "no shared subject,
 * therefore no conflict". It concludes `unknown` instead. A crude extractor that is only used
 * to find *positive* evidence of a shared subject is safe; one that is used to prove absence
 * would not be.
 */
function subjectsOf(text: string): string[] {
  const out: string[] = []
  // Content words of two or more Han characters, minus the most common function words. This
  // is a stop-word filter, not a tokenizer.
  const STOP = /^(我们|你们|他们|这个|那个|这样|那样|什么|怎么|为什么|因为|所以|但是|而且|就是|还是|可以|应该|一个|没有|不是|觉得|认为|知道|时候|问题|事情)/
  for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    if (STOP.test(run)) continue
    // Long runs are split into two-character bigrams: "红富士苹果" yields 红富/富士/士苹/苹果.
    for (let index = 0; index + 2 <= run.length; index += 1) {
      out.push(run.slice(index, index + 2))
    }
  }
  return out
}

/** Numbers mentioned, as trimmed strings. */
function numbersOf(text: string): string[] {
  return [...(text.match(NUMBER) ?? [])].map((value) => value.trim())
}

/**
 * Judge how two statements relate.
 *
 * The order of the checks is the logic — each earlier category is more specific than the ones
 * after it, and the last fallback is `unknown` rather than a guess.
 */
export function judgeRelation(input: {
  readonly ownerText: string
  readonly opponentText: string
}): ConflictVerdict {
  const owner = input.ownerText.trim()
  const opponent = input.opponentText.trim()

  if (owner === '' || opponent === '') {
    return {
      relation: 'unknown',
      isContradiction: false,
      reason: '有一方没有可引用的发言，无法判断两者关系。',
      requiresReview: true,
      confidence: 'weak',
    }
  }

  // --- 0. Are they even talking about the same object? (v0.2.14 §六) --------
  //
  // This branch exists because word overlap is not object identity. Reproduced against v0.2.13:
  //
  //     owner: "A 方案可行。"        / opponent: "B 方案不可行。"      → contradiction (wrong)
  //     owner: "我支持张三的建议。"   / opponent: "我反对李四的建议。"   → contradiction (wrong)
  //     owner: "这个方案可行。"       / opponent: "这个方案不可行。"     → unknown (wrong, too timid)
  //
  // The first two are two different objects, which can both be true. The third is one object
  // referred to by a pointer: a reader knows it is a real argument, and this code cannot prove
  // it. Each gets its own answer, and none of them defaults to "cannot both hold".
  const objects = compareArgumentObjects(owner, opponent)
  if (objects.relation === 'different_objects') {
    return {
      relation: 'different_topics',
      isContradiction: false,
      reason: objects.reason,
      requiresReview: false,
      confidence: 'strong',
    }
  }
  if (objects.relation === 'same_reference') {
    // ## The same pointer on both sides
    //
    // `这个方案可行` vs `这个方案不可行`: both sides use the *identical* pointer, so whatever it
    // refers to, they refer to the same thing. That is enough to call it a disagreement — the
    // referent cancels out of the comparison.
    //
    // What it does not establish is *what* they are arguing about, so a weak contradiction still
    // carries `requiresReview`. The task book is explicit that a machine reading of meaning
    // deserves a second pair of eyes even when it looks clear.
    const ownerPointers = new Set(
      objects.owner.filter((entry) => entry.deictic).map((entry) => entry.phrase),
    )
    const identical = objects.opponent.some(
      (entry) => entry.deictic && ownerPointers.has(entry.phrase),
    )
    const ownerPole = polarityOf(owner)
    const opponentPole = polarityOf(opponent)
    const opposite =
      ownerPole !== undefined && opponentPole !== undefined && ownerPole !== opponentPole

    if (identical && opposite) {
      return {
        relation: 'contradiction',
        isContradiction: true,
        subject: [...ownerPointers][0],
        reason: '双方用同一个指代指向同一个对象，并且一方肯定、一方否定，构成实际分歧。',
        requiresReview: true,
        confidence: 'weak',
      }
    }

    return {
      relation: 'clarification_needed',
      isContradiction: false,
      reason:
        objects.reason +
        '如果这个指代确实指向同一个对象，那么这就是明确的分歧；请人工确认后再决定回应方向。',
      requiresReview: true,
      confidence: 'weak',
    }
  }

  // --- 1. Same number, opposite framing ------------------------------------
  //
  // The most checkable contradiction there is: both cite the same figure and one disputes it.
  // "12 万不算贵" vs "12 万太贵了" share the number AND carry opposite polarity on it.
  const ownerNumbers = numbersOf(owner)
  const opponentNumbers = numbersOf(opponent)
  const sharedNumbers = ownerNumbers.filter((value) => opponentNumbers.includes(value))
  if (sharedNumbers.length > 0) {
    const subject = sharedNumbers[0]!
    // Polarity comes from the pole words, not from counting negation markers. See
    // `polarityOf` for the case that made this necessary: "12 万不算贵" and "12 万太贵了"
    // both contain 不, yet they take opposite sides.
    const ownerPole = polarityOf(owner)
    const opponentPole = polarityOf(opponent)

    if (ownerPole !== undefined && opponentPole !== undefined && ownerPole !== opponentPole) {
      return {
        relation: 'contradiction',
        isContradiction: true,
        reason: `双方都提到「${subject}」，但一方认为值得、另一方认为不值，构成实际冲突。`,
        subject,
        // A pole-word match is stronger evidence than a stray negation, but it is still a
        // lexical judgment about meaning, so a human confirms it.
        requiresReview: true,
        confidence: 'weak',
      }
    }

    // ## Shared number is not shared *agreement* (v0.2.13, second pass)
    //
    // Only call it shared ground when **both** sides are in the same (or no) register. The
    // case that broke the first version:
    //
    //     owner:    "去年报价是 12 万。"      ← stating a figure, no evaluation
    //     opponent: "12 万不算贵。"          ← exactly one side is evaluating it
    //
    // Returning `agreement` there says the two agree about the price, when in fact one is
    // citing it and the other is judging it — and their real disagreement ("成本翻倍值不值")
    // never got examined. When the registers differ, the number match proves only that they are
    // talking about the same figure, so this branch falls through and lets the subject-based
    // checks look for the actual dispute.
    const sameRegister =
      (ownerPole === undefined && opponentPole === undefined) || ownerPole === opponentPole
    if (sameRegister) {
      return {
        relation: 'agreement',
        isContradiction: false,
        reason: `双方都提到「${subject}」且没有相反表态，这更像共同前提，不能据此认定冲突。`,
        subject,
        requiresReview: false,
        confidence: 'weak',
      }
    }
    // Mixed registers: fall through. The number alone decides nothing.
  }

  // --- 2. Both statements of preference ------------------------------------
  //
  // The apple/oolong case. Two people can like different things; that is not a contradiction
  // and must never be reported as one.
  const ownerPrefers = PREFERENCE_MARKERS.test(owner)
  const opponentPrefers = PREFERENCE_MARKERS.test(opponent)
  if (ownerPrefers && opponentPrefers) {
    return {
      relation: 'different_preference',
      isContradiction: false,
      reason: '双方都在陈述自己的喜好，不同的喜好可以同时成立，这不是矛盾。',
      requiresReview: false,
      confidence: 'strong',
    }
  }

  // --- 3. No shared subject -------------------------------------------------
  //
  // Note the asymmetry: finding subjects lets us claim `different_topics`; failing to find them
  // does NOT let us claim anything. Two disjoint subject sets is real evidence of talking past
  // each other.
  const ownerSubjects = subjectsOf(owner)
  const opponentSubjects = subjectsOf(opponent)
  const shared = ownerSubjects.filter((value) => opponentSubjects.includes(value))
  if (ownerSubjects.length > 0 && opponentSubjects.length > 0 && shared.length === 0) {
    return {
      relation: 'different_topics',
      isContradiction: false,
      reason: '两段发言讨论的对象没有交集，属于各说各的，不能据此认定观点冲突。',
      requiresReview: false,
      confidence: 'weak',
    }
  }

  // --- 4. Same subject, opposite pole ---------------------------------------
  //
  // A shared subject plus opposite pole words is the shape of a real dispute. Still `weak`: a
  // pole word somewhere in a sentence is not proof that it targets the shared subject, so a
  // human checks it. Negation markers are deliberately NOT used here — the same reason they
  // were removed from the number branch: "不可行" and "可行" disagree, but they both contain 不
  // only on one side while "不可行"/"没什么不可行" would flip it.
  if (shared.length > 0) {
    const subject = shared[0]!
    const ownerPole = polarityOf(owner)
    const opponentPole = polarityOf(opponent)
    if (ownerPole !== undefined && opponentPole !== undefined && ownerPole !== opponentPole) {
      return {
        relation: 'contradiction',
        isContradiction: true,
        reason: `双方都谈到「${subject}」，但一方肯定一方否定，可能构成实际分歧；具体含义需人工确认。`,
        subject,
        requiresReview: true,
        confidence: 'weak',
      }
    }
    return {
      relation: 'unknown',
      isContradiction: false,
      reason: `双方都谈到「${subject}」，但看不出是否冲突；不做判断。`,
      subject,
      requiresReview: true,
      confidence: 'weak',
    }
  }

  // --- 5. Everything else ---------------------------------------------------
  //
  // The honest answer. v0.2.12 jumped from "no signal" to "cannot both be true"; this returns
  // uncertainty and requires a human to look.
  return {
    relation: 'unknown',
    isContradiction: false,
    reason: '无法从文本可靠判断双方是否冲突，需人工确认。',
    requiresReview: true,
    confidence: 'weak',
  }
}

/** A short, renderable description of the relation, for the brief's prose. */
export function describeRelation(verdict: ConflictVerdict): string {
  switch (verdict.relation) {
    case 'contradiction':
      return `存在实际分歧：${verdict.reason}`
    case 'agreement':
      return `双方在这一意见上一致：${verdict.reason}`
    case 'different_preference':
      return `双方喜好不同，但可以同时成立：${verdict.reason}`
    case 'different_topics':
      return `双方讨论的不是同一件事：${verdict.reason}`
    case 'clarification_needed':
      return `双方是否在谈同一件事需要确认：${verdict.reason}`
    case 'unknown':
      return `分歧是否存在尚不确定：${verdict.reason}`
  }
}
