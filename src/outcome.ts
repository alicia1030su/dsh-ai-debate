/**
 * 一次生成的**结果分类**（v0.2.39 §3.1）。
 *
 * ## 为什么需要第五种状态
 *
 * v0.2.38 及以前，一次生成只有两种下场：落了一条候选，或者报了个错。这两件事都说不清
 * 真实发生了什么：
 *
 * - 模型认真回答「材料不够，我需要你补上对方那条被删的评论」—— 这是一次**正确**的行为，
 *   却被记成失败，页面上一行红字，采集器里一条空正文。
 * - 模型明明有六条对方论据可打，却回了一句「信息不足无法回应」—— 这是**错误**的拒绝，
 *   却和上一种长得一模一样，于是没人能统计「它到底在偷懒还是在守规矩」。
 * - 模型给了正文，但里面有一个追不回原文的数字 —— 这是**不合格**的草稿，不是故障。
 * - 接口超时、返回被截断、JSON 解析不了 —— 这才是**故障**，和模型的判断无关。
 *
 * 四种不同的事实，混在「成功/失败」两个桶里，于是「这一版比上一版好吗」这个问题在数据上
 * 无法回答：两版的失败率一样，可能一版是拒绝得对，另一版是编造得多。
 *
 * ## 分类的边界
 *
 * 这里**不判断**「拒绝是否合理」之外的任何质量维度。一条 `valid_draft` 只是说「它产出了
 * 一条可用的候选」，不代表论证好 —— 那是盲评的事（`scripts/blind-review.mjs`）。
 * 把这两件事混在一起，就会得到「没有违规 = 质量高」这种没人能验证的结论。
 */

/** 一次生成的结果。五选一，互斥。 */
export type GenerationOutcome =
  /** 产出了一条可用候选：有正文、没有硬违规、目标对得上。 */
  | 'valid_draft'
  /** 模型判断材料不足并说明缺什么。材料确实不足时，这是**正确**结果。 */
  | 'needs_more_context'
  /** 材料够，模型仍然拒绝。这是缺陷，不是谨慎。 */
  | 'unjustified_refusal'
  /** 产出了正文，但违反事实、目标或安全要求。 */
  | 'invalid_draft'
  /** 超时、异常、输出截断、解析失败等技术故障。与模型判断无关。 */
  | 'technical_failure'

/**
 * 哪些违规码属于「技术故障」而不是「草稿不合格」。
 *
 * 这两类必须分开：`truncated` 的正确处理是「把最大输出 token 调高」，而
 * `fabricated_number` 的正确处理是「这条不能用，重写」。把它们都叫「失败」，用户就只能
 * 两个都试一遍。
 */
const TECHNICAL_CODES = new Set(['truncated', 'unparseable', 'timeout', 'network'])

/** 一条违规是不是技术故障。 */
function isTechnical(code: string): boolean {
  return TECHNICAL_CODES.has(code)
}

/** 判断材料是否「足够到可以要求它写一条回复」。 */
export interface EvidenceSufficiency {
  /**
   * 简报里可引用的对方论据条数。
   *
   * 这是「够不够」的主要依据：有一条明确论据，就有东西可回应；一条都没有，追问才是对的。
   */
  readonly opponentArgumentCount: number
  /** 对方提出、主人尚未回答的问题数。有的话也是可打的材料。 */
  readonly unansweredByOpponent: number
  /** 是否已确认回应对象。目标不明时，拒绝是合理的。 */
  readonly targetConfirmed: boolean
}

/**
 * 材料是否足以支撑一条有信息量的回复。
 *
 * ## 这个判据是有意保守的
 *
 * 只要求「有一条可引用的论据」或「有一个未答问题」，并且目标已确认。它不评价这些材料
 * 好不好打 —— 问「这个论据值不值得回应」需要语义判断，那是模型该做的，不是分类器该做的。
 *
 * 保守的方向很重要：判「材料够」而模型拒绝 → 记为缺陷；判「材料不够」而模型拒绝 →
 * 记为正确。如果判据过于宽松，就会把大量合理的拒绝记成缺陷，于是这个指标再也说明不了
 * 问题。所以宁可漏判，不可错判。
 */
export function evidenceIsSufficient(sufficiency: EvidenceSufficiency): boolean {
  if (!sufficiency.targetConfirmed) return false
  return sufficiency.opponentArgumentCount > 0 || sufficiency.unansweredByOpponent > 0
}

/** 分类所需的事实。全部来自已经算出来的东西，不额外读任何状态。 */
export interface OutcomeInput {
  /** 模型是否主动要求补充信息。 */
  readonly needsInput: boolean
  /** 候选正文。空串表示没有产出。 */
  readonly reply: string
  readonly violations: readonly { readonly code: string }[]
  readonly evidence: EvidenceSufficiency
  /**
   * 模型拒绝时给出的理由里是否点到**具体缺的东西**。
   *
   * 只说「信息不足」而不说缺什么，不构成一次合格的追问 —— 用户没法照做。这条判据来自
   * 产品要求本身（「缺失的事实应追问」），不是文风偏好。
   */
  readonly needsInputReason?: string
  /**
   * 用户是否已明确要求「就按现有材料写一条」。
   *
   * 为真时，模型说「材料不足」不再被判成缺陷 —— 它已经被告知要试，拒绝时给出的
   * 具体缺口仍然是给用户的信息，但「材料够却不肯写」这个判断需要语义能力，
   * 计数规则做不到。
   *
   * 缺省为假：自动链路（例如后台批量生成）没有用户意图，保守判成缺陷可以接受。
   */
  readonly forceAttempt?: boolean
}

/** 拒绝理由里是否点名了具体缺口。空话不算。 */
const CONCRETE_GAP =
  /(缺|没有|未见|找不到|未提供|未给出|需要|请补|原文|截图|链接|哪一|具体|出处|来源|时间|数字|金额|比例|上下文)/

/**
 * 模型是否点明了它缺什么。
 *
 * 与分类无关（分类看材料够不够），但与**用户能不能照做**有关：一条 `needs_more_context`
 * 的界面上如果只有「信息不足」四个字，用户能做的只有放弃。这个判定让页面可以说
 * 「它说缺 X，去补 X」或者「它只说信息不足，没说是哪里」。
 */
export function reasonNamesGap(reason: string | undefined): boolean {
  const text = (reason ?? '').trim()
  if (text === '') return false
  return CONCRETE_GAP.test(text)
}

export function classifyOutcome(input: OutcomeInput): GenerationOutcome {
  const codes = input.violations.map((violation) => violation.code)

  // 1. 技术故障优先：它解释「为什么没有结果」，与模型判断无关。
  if (codes.some(isTechnical)) return 'technical_failure'

  // 2. 模型拒绝。分成「该拒绝」与「不该拒绝」两种，判据只有一条：材料够不够。
  //
  //    不按「理由写得具体不具体」判：写得具体但材料明明够，仍然是该答而不答；写得含糊
  //    但材料确实缺，仍然是正确的追问。把措辞当成判据会让这个指标变成文风评分。
  if (input.needsInput) {
    /**
     * 用户已经明确要求「先写一条」时，不把拒绝判成缺陷。
     *
     * ## 这条判断为什么必须存在
     *
     * 「材料够不够」是一个语义问题：简报里有一条论据，不等于那条论据能支撑任何具体主张。
     * 第一次真实采集里，q06（对方只说「方案我贴了」）被判 `unjustified_refusal`，
     * 而模型的拒绝理由完全站得住 —— 那条「论据」只是一个指路，没有内容。
     *
     * 计数规则看不出这个区别，所以它在**用户没有表态**时保守判缺陷（宁可漏判），
     * 在用户明确要求尝试时让位给模型。判据的分界是「谁在做决定」，不是「谁更聪明」。
     */
    if (input.forceAttempt === true) return 'needs_more_context'
    return evidenceIsSufficient(input.evidence) ? 'unjustified_refusal' : 'needs_more_context'
  }

  // 3. 有正文但违规：草稿不合格。这里不再区分违规严重程度 —— 任何一条硬违规都意味着
  //    「这条不能用」，而能不能用是唯一的判定。
  if (codes.length > 0) return 'invalid_draft'

  // 4. 没有正文也没有违规：链路给了个空结果。当作故障，因为它既不是候选也不是判断。
  if (input.reply.trim() === '') return 'technical_failure'

  return 'valid_draft'
}

/**
 * 每种结果在界面上的一句话。
 *
 * 写在这里而不是散在页面里，是因为「同一个状态在三个地方说法不同」比没有状态更坏：
 * 用户会以为是三件不同的事。
 */
export const OUTCOME_LABELS: Readonly<Record<GenerationOutcome, string>> = {
  valid_draft: '已生成候选',
  needs_more_context: '材料不足，模型要求补充',
  unjustified_refusal: '材料够，但模型拒绝回应',
  invalid_draft: '生成了，但未通过检查',
  technical_failure: '技术故障，没有生成结果',
}

/**
 * 这个结果是否需要用户做点什么。
 *
 * `valid_draft` 之外都需要，但原因不同 —— 页面据此决定显示「去补材料」还是「重试」还是
 * 「换个目标」。
 */
export function outcomeNeedsAction(outcome: GenerationOutcome): boolean {
  return outcome !== 'valid_draft'
}
