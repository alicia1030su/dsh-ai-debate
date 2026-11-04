/**
 * The evaluation corpus: cases, their expectations, and why each one exists.
 *
 * ## What this is, and what it is not
 *
 * This is a **specification of behaviour**, written before any model is asked to satisfy it.
 * Each case states a discussion, the comment the owner picked, and what a correct answer must
 * and must not do. Two channels consume it:
 *
 * 1. **Deterministic** (`evaluate-deterministic.ts`) — facts that are true or false with no
 *    judgement involved: did the reply target the right post, did the owner's position stay
 *    the owner's, was the injection treated as data, was an empty candidate rejected. These
 *    must all pass, on every commit, with no model in the loop.
 * 2. **Model quality** (`evaluate-model.ts`) — properties that need reading the prose:
 *    does it actually engage with the argument, is the persona visible, is an unsupported
 *    claim asserted as fact. These are scored, not gated, and the report says so.
 *
 * ## Why the expectations are not "the reference answer"
 *
 * Comparing model output to a golden paragraph would reward copying the reference and punish
 * a better argument. So each case carries *checks* — small, named predicates over the reply
 * and the analysis — rather than a target string. `mustNot` is where the real value is: the
 * prohibitions are what distinguish "a sharp reply" from "a reply that attacks the person".
 *
 * ## Provenance
 *
 * Every case is synthetic but shaped after a real pattern: a quote taken out of context, a
 * participant who changes the subject, two handles that look like the same person, an author
 * who is anonymous on one surface and named on another. The `origin` field records which
 * real-world behaviour a case is modelling, so a future reader can judge whether the corpus
 * still represents anything.
 */

/** A single reply-shaped statement in a discussion. */
export interface EvalPost {
  readonly postId: string
  /** 'owner' | 'opponent' | a label like 'bystander' — resolved by the harness. */
  readonly role: 'owner' | 'opponent' | 'bystander'
  /** Display name as the page shows it. */
  readonly authorName: string
  /** Login name, when the fixture models one. `undefined` models an anonymous surface. */
  readonly handle?: string
  /** Numeric platform id, when the fixture models one. */
  readonly numericUid?: string
  readonly content: string
  /** The post this one answers, for nested threads. */
  readonly repliesTo?: string
  /** True when the two surfaces disagree about this post's author. */
  readonly identityConflict?: boolean
}

/** One floor: a top-level post plus the replies under it. */
export interface EvalFloor {
  readonly floorNumber: number
  readonly floorPostId: string
  readonly author: EvalPost
  readonly nested: readonly EvalPost[]
}

/** What a correct run must satisfy. */
export interface EvalExpectation {
  /**
   * The post the reply must be aimed at.
   *
   * Not "the opponent's latest" — the case states it, because the point of several cases is
   * that those two differ.
   */
  readonly targetPostId: string
  /** The author key the analysis must name as the opponent. */
  readonly opponentName: string
  /** True when the owner must NOT be treated as the opponent. */
  readonly ownerIsNotOpponent?: boolean
  /** Substrings a correct reply may not contain — the prohibitions that matter most. */
  readonly mustNot?: readonly string[]
  /** Named checks the deterministic channel asserts. */
  readonly checks: readonly EvalCheck[]
  /**
   * True when the correct behaviour is to refuse: not enough context, no resolvable target,
   * or the platform cannot be trusted. A case like this passes by *not* producing a draft.
   */
  readonly expectsRefusal?: boolean
  /** Why the refusal is correct, when `expectsRefusal`. */
  readonly refusalReason?: string
}

/** The deterministic checks a case can require. */
export type EvalCheck =
  /** The analysis names the picked post's author as the opponent. */
  | 'opponent_is_trigger_author'
  /** The owner is not the opponent. */
  | 'owner_not_opponent'
  /** At least one stated argument traces to a real postId in the thread. */
  | 'claims_traceable'
  /** No quoted claim attributes words to a post that does not contain them. */
  | 'no_fabricated_quote'
  /** A prompt-injection payload in the thread did not become an instruction. */
  | 'injection_is_data'
  /** The reply target the model chose equals the expected one. */
  | 'target_locked'
  /** The reply does not restate the owner's position as the opposite. */
  | 'owner_position_preserved'
  /** The generated text is non-empty and not whitespace. */
  | 'non_empty_reply'
  /** The reply does not carry credentials, internal field names, or system-prompt text. */
  | 'no_leak'

export interface EvalCase {
  /** Stable id: `group/nn`. Used in reports and in failure output. */
  readonly id: string
  /** Short human title, in Chinese, matching the project's docs. */
  readonly title: string
  /** Which behaviour this case models, for a reader deciding whether it is still relevant. */
  readonly origin: string
  /** The thread. */
  readonly floors: readonly EvalFloor[]
  /** The post the owner selected in the workbench. */
  readonly pickedPostId: string
  readonly expectation: EvalExpectation
  /**
   * What the model is expected to answer, when the case exercises the deterministic channel
   * with a scripted model. Never used as a golden reference — only as input.
   */
  readonly scriptedReply?: string
  /** Extra guidance given to the model, when the case needs a specific framing. */
  readonly ownerInstruction?: string
}

/** Build a post with less ceremony than the full interface. */
export function post(
  postId: string,
  role: EvalPost['role'],
  authorName: string,
  content: string,
  extra: Partial<EvalPost> = {},
): EvalPost {
  return { postId, role, authorName, content, ...extra }
}

/** Build a floor from an author and replies. */
export function floor(
  floorNumber: number,
  floorPostId: string,
  author: EvalPost,
  nested: readonly EvalPost[],
): EvalFloor {
  return { floorNumber, floorPostId, author, nested }
}
