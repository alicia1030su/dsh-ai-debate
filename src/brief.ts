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

import type { PlatformId } from './types.js'

/** One side's position on the dispute. */
export interface BriefPosition {
  /** Who holds it: the owner's account, or the opponent's. */
  readonly side: 'owner' | 'opponent'
  /** The position in one sentence, as the brief's author understands it. */
  readonly summary: string
  /**
   * The post ids this position is drawn from.
   *
   * Never empty: a position with no citation is an assertion about what someone
   * said without showing where. `validateBrief` rejects those.
   */
  readonly evidence: readonly string[]
}

/** A fact both sides stated or accepted. */
export interface BriefAgreedFact {
  readonly statement: string
  /** Posts where this was stated. At least one must be the owner's, at least one the opponent's. */
  readonly evidence: readonly string[]
}

/** One of the owner's arguments. */
export interface BriefArgument {
  readonly claim: string
  readonly evidence: readonly string[]
}

/** A challenge from the opponent the owner has not answered. */
export interface BriefChallenge {
  /** The opponent's own words. */
  readonly quote: string
  /** The opponent's post id. */
  readonly evidence: string
  /**
   * Why it is unanswered: whether the owner never replied, or replied without
   * addressing it. Distinguished because "he ignored it" and "he answered badly"
   * call for different replies.
   */
  readonly unanswered: 'no_reply' | 'reply_did_not_address'
}

/** A point the reply must not assert as fact. */
export interface BriefUncertainty {
  readonly point: string
  /** Why it is uncertain: platform gap, conflicting statements, no evidence read. */
  readonly reason: string
}

/** What kind of reply this brief suggests. */
export type BriefDirection = 'rebut' | 'analyse' | 'humour'

/** A third party who spoke inside the argument's floor (v0.2.11). */
export interface BriefBystander {
  /** Display name as the platform rendered it. Not an identity. */
  readonly displayName: string
  /** How many times they spoke in this floor. */
  readonly postCount: number
  /**
   * Which side they appear to back, if their words make it explicit.
   *
   * `undefined` is the common case and the honest one: most third parties say something
   * without endorsing anyone. Filling this in from tone would be an inference dressed as
   * a fact, so it is only set when the collected text contains an explicit alignment and
   * a post id can be cited for it.
   */
  readonly leaning?: 'owner' | 'opponent'
  /** Post ids backing the leaning, when one was determined. */
  readonly evidence?: readonly string[]
}

/** The whole brief. */
export interface DebateBrief {
  readonly platform: PlatformId
  readonly threadId: string
  /** The post the reply will answer. Decided by the trigger, not by the model. */
  readonly targetPostId: string
  readonly owner: BriefPosition
  readonly opponent: BriefPosition
  /** Where the two actually disagree, in one sentence each. */
  readonly disagreements: readonly string[]
  readonly agreedFacts: readonly BriefAgreedFact[]
  readonly arguments: readonly BriefArgument[]
  readonly challenges: readonly BriefChallenge[]
  /** Questions the owner asked that the opponent left unanswered. */
  readonly openQuestions: readonly string[]
  readonly uncertainties: readonly BriefUncertainty[]
  /** Which reply shapes would fit, most suitable first. */
  readonly directions: readonly BriefDirection[]
  /** Risks a human should know before approving, in plain language. */
  readonly risks: readonly string[]
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
  readonly bystanders?: readonly BriefBystander[]
}

/**
 * Everything a brief is allowed to cite.
 *
 * Passed in rather than looked up, so building a brief cannot accidentally reach
 * for a post that was not collected in this run.
 */
export interface BriefSources {
  readonly ownerPostIds: ReadonlySet<string>
  readonly opponentPostIds: ReadonlySet<string>
  /** Every post id present in the collected conversation. */
  readonly allPostIds: ReadonlySet<string>
}

/** A problem found while validating a brief. */
export interface BriefProblem {
  /** Which field the problem is in, for a precise error message. */
  readonly field: string
  readonly reason: string
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
export function validateBrief(
  brief: DebateBrief,
  sources: BriefSources,
): readonly BriefProblem[] {
  const problems: BriefProblem[] = []

  const checkCitation = (field: string, postId: string): void => {
    if (!sources.allPostIds.has(postId)) {
      problems.push({
        field,
        reason: `引用了未读取的帖子 ${postId}：不能把没看到的内容当作证据`,
      })
    }
  }

  const checkSide = (field: string, side: 'owner' | 'opponent', postIds: readonly string[]): void => {
    if (postIds.length === 0) {
      problems.push({ field, reason: '没有任何证据引用' })
      return
    }
    const allowed = side === 'owner' ? sources.ownerPostIds : sources.opponentPostIds
    for (const postId of postIds) {
      checkCitation(field, postId)
      if (sources.allPostIds.has(postId) && !allowed.has(postId)) {
        problems.push({
          field,
          reason:
            side === 'owner'
              ? `把 ${postId} 当作主人的发言，但那不是主人发的`
              : `把 ${postId} 当作对方的发言，但那不是对方发的`,
        })
      }
    }
  }

  checkSide('owner', 'owner', brief.owner.evidence)
  checkSide('opponent', 'opponent', brief.opponent.evidence)

  if (brief.disagreements.length === 0) {
    problems.push({ field: 'disagreements', reason: '没有指出任何具体分歧，这不构成一场争论' })
  }

  if (!sources.allPostIds.has(brief.targetPostId)) {
    problems.push({
      field: 'targetPostId',
      reason: `回复目标 ${brief.targetPostId} 不在本次读取的对话里`,
    })
  }

  for (const [index, fact] of brief.agreedFacts.entries()) {
    if (fact.evidence.length === 0) {
      problems.push({ field: `agreedFacts[${index}]`, reason: '没有证据引用' })
      continue
    }
    for (const postId of fact.evidence) checkCitation(`agreedFacts[${index}]`, postId)
    // A "fact both sides agreed on" citing only one side is just one side's claim.
    const fromOwner = fact.evidence.some((postId) => sources.ownerPostIds.has(postId))
    const fromOpponent = fact.evidence.some((postId) => sources.opponentPostIds.has(postId))
    if (!fromOwner || !fromOpponent) {
      problems.push({
        field: `agreedFacts[${index}]`,
        reason: '被称为「双方确认的事实」，但证据只来自一方',
      })
    }
  }

  for (const [index, argument] of brief.arguments.entries()) {
    if (argument.evidence.length === 0) {
      problems.push({ field: `arguments[${index}]`, reason: '没有证据引用' })
      continue
    }
    for (const postId of argument.evidence) {
      checkCitation(`arguments[${index}]`, postId)
      if (sources.allPostIds.has(postId) && !sources.ownerPostIds.has(postId)) {
        problems.push({
          field: `arguments[${index}]`,
          reason: `把 ${postId} 当作主人的论据，但那不是主人发的`,
        })
      }
    }
  }

  for (const [index, challenge] of brief.challenges.entries()) {
    checkCitation(`challenges[${index}].evidence`, challenge.evidence)
    if (
      sources.allPostIds.has(challenge.evidence) &&
      !sources.opponentPostIds.has(challenge.evidence)
    ) {
      problems.push({
        field: `challenges[${index}].evidence`,
        reason: '把这条质疑归给对方，但那条发言不是对方发的',
      })
    }
    if (challenge.quote.trim() === '') {
      problems.push({
        field: `challenges[${index}].quote`,
        reason: '质疑必须引用对方原话，不能只写概括',
      })
    }
  }

  // Bystanders (v0.2.11).
  //
  // Two rules, both about not promoting a third party into a side:
  //
  // 1. A `leaning` must be backed by a post that was actually read — same citation rule
  //    as every other claim here.
  // 2. That post must belong to **neither** the owner nor the chosen opponent. A
  //    bystander whose "evidence" is one of the opponent's own posts is not a third party
  //    agreeing with them; it is the opponent, double-counted. Catching this keeps the
  //    supporter count from being inflated by the participant the reply is aimed at.
  for (const [index, bystander] of (brief.bystanders ?? []).entries()) {
    if (bystander.leaning === undefined) {
      if (bystander.evidence !== undefined && bystander.evidence.length > 0) {
        problems.push({
          field: `bystanders[${index}]`,
          reason: '没有说明站队却给了证据：要么说明站哪边，要么不要把证据挂在不站队的人身上',
        })
      }
      continue
    }
    const evidence = bystander.evidence ?? []
    if (evidence.length === 0) {
      problems.push({
        field: `bystanders[${index}]`,
        reason: '声称某个路人有明确立场，却没有引用任何一条发言',
      })
      continue
    }
    for (const postId of evidence) {
      checkCitation(`bystanders[${index}]`, postId)
      if (
        sources.ownerPostIds.has(postId) ||
        sources.opponentPostIds.has(postId)
      ) {
        problems.push({
          field: `bystanders[${index}]`,
          reason: `把 ${postId} 当作路人的话，但那一条属于争论的一方（主人或对手）`,
        })
      }
    }
  }

  if (brief.directions.length === 0) {
    problems.push({ field: 'directions', reason: '没有给出任何推荐回应方向' })
  }

  return problems
}

/**
 * Human-readable brief, for the review step.
 *
 * Deliberately includes every citation: the reviewer's job is to check that the
 * characterisation matches the posts, so hiding the ids would make the review
 * performative.
 */
export function renderBrief(brief: DebateBrief): string {
  const lines: string[] = []
  lines.push(`# 争论简述（${brief.platform} / ${brief.threadId}）`)
  lines.push('')
  lines.push(`回复目标：${brief.targetPostId}`)
  lines.push('')
  lines.push(`## 主人立场`)
  lines.push(brief.owner.summary)
  lines.push(`引用：${brief.owner.evidence.join('、')}`)
  lines.push('')
  lines.push(`## 对方立场`)
  lines.push(brief.opponent.summary)
  lines.push(`引用：${brief.opponent.evidence.join('、')}`)
  lines.push('')

  if (brief.disagreements.length > 0) {
    lines.push('## 核心分歧')
    for (const item of brief.disagreements) lines.push(`- ${item}`)
    lines.push('')
  }

  if (brief.agreedFacts.length > 0) {
    lines.push('## 双方确认的事实')
    for (const fact of brief.agreedFacts) {
      lines.push(`- ${fact.statement}（${fact.evidence.join('、')}）`)
    }
    lines.push('')
  }

  if (brief.arguments.length > 0) {
    lines.push('## 主人的主要论据')
    for (const argument of brief.arguments) {
      lines.push(`- ${argument.claim}（${argument.evidence.join('、')}）`)
    }
    lines.push('')
  }

  if (brief.challenges.length > 0) {
    lines.push('## 对方尚未被回应的质疑')
    for (const challenge of brief.challenges) {
      const why = challenge.unanswered === 'no_reply' ? '主人没有回复' : '主人回复了但没有正面回应'
      lines.push(`- 对方原话：「${challenge.quote}」（${challenge.evidence}，${why}）`)
    }
    lines.push('')
  }

  if (brief.openQuestions.length > 0) {
    lines.push('## 对方没有回答的问题')
    for (const question of brief.openQuestions) lines.push(`- ${question}`)
    lines.push('')
  }

  if (brief.uncertainties.length > 0) {
    lines.push('## 不能断言为事实的部分')
    for (const item of brief.uncertainties) {
      lines.push(`- ${item.point}：${item.reason}`)
    }
    lines.push('')
  }

  lines.push(`推荐方向：${brief.directions.join(' / ')}`)

  // Third parties who spoke in the same floor (v0.2.11).
  //
  // This block exists so the model can tell "the opponent stands alone" from "several
  // people backed the opponent". Left out when empty rather than printed as "无", because
  // a heading followed by "none" reads like a finding.
  if (brief.bystanders !== undefined && brief.bystanders.length > 0) {
    lines.push('')
    lines.push('## 同一层里的其他参与者')
    lines.push('这些人不是争论的任何一方，只是也在这一层发过言。不要把他们的话当成交锋对象，也不要把他们当成对手。')
    for (const bystander of brief.bystanders) {
      const leaning =
        bystander.leaning === undefined
          ? '不站队'
          : bystander.leaning === 'owner'
            ? '明确支持主人'
            : '明确支持对方'
      const cite =
        bystander.evidence === undefined || bystander.evidence.length === 0
          ? ''
          : `（${bystander.evidence.join('、')}）`
      lines.push(`- ${bystander.displayName}：发言 ${bystander.postCount} 次，${leaning}${cite}`)
    }
  }

  if (brief.risks.length > 0) {
    lines.push('')
    lines.push('## 发表前的风险提示')
    for (const risk of brief.risks) lines.push(`- ${risk}`)
  }
  return lines.join('\n')
}
