/**
 * 论证策略：这一句要**用什么打法**，与「用什么口吻说」彻底分开。
 *
 * ## 为什么必须分开
 *
 * v0.2.37 的真实四人格对决暴露了一件事：四种人格的措辞区分得开，但四条回复在做
 * 同一件事 —— 追问对方「翻倍的参照是什么」。人格只改了语气，没改打法。
 *
 * 根因不在模型，在结构：人格配置里混进了 `approach`（「先钉住对方最虚的那一句」），
 * 而它是**唯一的**打法来源。于是「换人格」等于「换打法」，「同一个人格换打法」不可
 * 表达，四种人格自然收敛到同一条路上。
 *
 * 这一层把打法拿出来，做成独立的、有证据门槛的选择：
 *
 * | 层 | 决定 | 变化维度 |
 * | --- | --- | --- |
 * | 人格 | 怎么说 | 语气、句长、用词、攻击性 |
 * | 策略 | 说什么 | 追依据 / 答核心 / 举反例 / 澄清定义 / 指矛盾 / 讲前提 / 反问 |
 *
 * 两者正交：同一个人格可以用任何策略，同一个策略可以用任何人格表达。
 *
 * ## 证据门槛是这一层的核心，不是附加项
 *
 * 「提出有出处的反例」这种策略听起来很好，但如果材料里没有反例，硬生成一个就是编造。
 * 所以每个策略都带 `requirements`：不满足就**不出现在候选里**，而不是出现了再降级。
 * 自动选择只从满足门槛的策略里挑；手工指定的策略不满足门槛时，报错并说清缺什么 ——
 * 不允许「为了多样性」强行生成。
 *
 * ## 为什么门槛写成函数而不是标签
 *
 * 标签（「需要反例」）要靠调用方理解，而调用方迟早会理解错。函数直接读简报里已经
 * 通过校验的字段，缺什么一眼可见，也顺便让「为什么这个策略不可用」变成可渲染的句子。
 */

import type { DebateBrief } from './brief.js'

/** 八种有明确证据形状的打法。 */
export type ArgumentStrategyId =
  | 'demand_basis'
  | 'answer_core'
  | 'cite_counterexample'
  | 'clarify_definition'
  | 'point_out_contradiction'
  | 'point_out_repeated_question'
  | 'explain_premise'
  | 'ask_clarification'

/** 策略从哪个字段得到的依据。 */
export interface StrategyEvidence {
  /** 依据来自简报的哪个字段。 */
  readonly field: string
  /** 相关发言的 post id，供人核对。 */
  readonly postIds: readonly string[]
  /** 一句话说明这个依据支持什么。 */
  readonly why: string
}

/** 一个策略的定义。 */
export interface ArgumentStrategy {
  readonly id: ArgumentStrategyId
  readonly name: string
  /** 这个打法在做什么，一句话。 */
  readonly summary: string
  /** 写给模型的指令：这次只按这个打法组织论证。 */
  readonly instruction: string
  /**
   * 材料要满足什么，这个打法才成立。
   *
   * 返回 `undefined` 表示不成立，附带一句「缺什么」。
   */
  readonly requirements: (brief: DebateBrief) => StrategyEvidence | undefined
}

/** 一次策略选择的结果。 */
export interface StrategyChoice {
  readonly id: ArgumentStrategyId
  readonly name: string
  /** 自动选的，还是主人指定的。 */
  readonly source: 'auto' | 'manual'
  /** 为什么选它 —— 自动：门槛怎么满足的；手工：主人指定。 */
  readonly reason: string
  /** 依据，带 post id。手工指定时也照样记录，方便核对。 */
  readonly evidence: readonly StrategyEvidence[]
  /** 这个选择有多可靠：依据越硬越高。 */
  readonly confidence: 'high' | 'medium' | 'low'
}

/** 选择失败的原因。 */
export interface StrategyRejection {
  readonly id: ArgumentStrategyId
  /** 缺什么。 */
  readonly missing: string
}

/**
 * 策略目录。
 *
 * ## 顺序即优先级，而优先级的依据是「证据有多具体」，不是「打法有多精彩」
 *
 * 第一版把「直接回应核心论据」排在第三位，结果 80 个案例里 70 个都选它 —— 因为几乎
 * 每一层都有对方论据，这个门槛永远满足。那不是策略层，那是一个恒真的分支，四种人格
 * 照样走同一条路，等于什么都没改。
 *
 * 现在的规则是：**越具体、越少见的证据先选**。已核实的矛盾（要两段原文）比「有一句话
 * 可以回应」具体得多；「我们一起回答过这个问题」比「他有论据」具体得多。只有当这些
 * 更具体的形状都不存在时，才轮到「正面回答核心论据」这个通用打法。
 *
 * `answer_core` 因此被排到倒数第二，只比兜底高一位。这是刻意的：通用打法是**剩下**
 * 的选择，不是默认的选择。
 */
export const ARGUMENT_STRATEGIES: readonly ArgumentStrategy[] = [
  {
    id: 'point_out_contradiction',
    name: '指出已核实的前后矛盾',
    summary: '对方两句话不能同真，且两段原文都在手上。',
    instruction:
      '这次只做一件事：把对方前后不能同时成立的两句话并排摆出来，指出它们不能同真。' +
      '不要顺带评价对方的人品或动机。如果简报把这条标成「待核实」，就写成疑问而不是断言。',
    /**
     * 只有 `quoted` + `high` 才算「已核实」。
     *
     * 这正是 v0.2.37 的置信度分离要保证的事：条件不同、时间不同的两句话不是矛盾，
     * 拿它们说「你自相矛盾」是最容易被一句话打回来的错误。
     */
    requirements: (brief) => {
      const hits = (brief.decisivePoints ?? []).filter(
        (point) => point.kind === 'contradiction' && point.confidence === 'high' && point.evidenceKind === 'quoted',
      )
      if (hits.length === 0) return undefined
      const first = hits[0] as (typeof hits)[number]
      return {
        field: 'decisivePoints[kind=contradiction]',
        postIds: [first.postId, ...(first.otherPostId === undefined ? [] : [first.otherPostId])],
        why: `两段原文不能同真：${first.quote.slice(0, 30)} / ${(first.otherQuote ?? '').slice(0, 30)}`,
      }
    },
  },
  {
    id: 'point_out_repeated_question',
    name: '指出对方在重复已答的问题',
    summary: '这个问题主人已经答过，对方又问了一遍。',
    instruction:
      '这次只做一件事：指出这个问题主人已经回答过，并给出当时回答的那句话（可以概括，不要编原话）。' +
      '然后说明对方这次问的和上次有什么区别 —— 如果没有区别，就把话停在这里。不要重新答一遍。',
    requirements: (brief) => {
      const answered = brief.answeredByOwner ?? []
      const repeated = answered[0]
      if (repeated === undefined) return undefined
      return {
        field: 'answeredByOwner',
        postIds: [repeated.postId, ...(repeated.answerPostId === undefined ? [] : [repeated.answerPostId])],
        why: `对方问了主人已经答过的问题：${repeated.quote.slice(0, 30)}`,
      }
    },
  },
  {
    id: 'cite_counterexample',
    name: '提出有出处的反例',
    summary: '帖子里有第三方说过相反的具体例子，可以引。',
    instruction:
      '这次只做一件事：引用帖子里确实出现过的那个反例（第三方说的话或另一个具体事例），' +
      '用它说明对方的概括不成立。引用必须标明是谁说的，不要把它说成你自己的经历。',
    requirements: (brief) => {
      const citations = brief.thirdPartyCitations ?? []
      const first = citations[0]
      if (first === undefined) return undefined
      return {
        field: 'thirdPartyCitations',
        postIds: [first.postId],
        why: `对方帖子里引了第三方的说法，可以拿来当反例的出处：${first.quote.slice(0, 30)}`,
      }
    },
  },
  {
    id: 'demand_basis',
    name: '追问关键依据',
    summary: '对方给了结论没有给来源，追问那个来源。',
    instruction:
      '这次只做一件事：追问对方那条结论的依据 —— 具体到「哪个数 / 谁说的 / 在哪看到的」。' +
      '不要泛泛地说「拿出证据」，要指向他刚说的那句话里的具体缺口。',
    requirements: (brief) => {
      const points = (brief.decisivePoints ?? []).filter((point) => point.kind === 'missing_evidence')
      const first = points[0]
      if (first === undefined) return undefined
      return {
        field: 'decisivePoints[kind=missing_evidence]',
        postIds: [first.postId],
        why: `对方给了数量结论但没给来源：${first.quote.slice(0, 40)}`,
      }
    },
  },
  {
    id: 'clarify_definition',
    name: '澄清双方定义',
    summary: '两边在同一个词上说的不是一回事，先把词说清。',
    instruction:
      '这次只做一件事：指出双方对同一个词的理解不同，把你说的那个词具体指什么讲清楚，' +
      '再问对方是不是同一个意思。不要在这一轮里争结论。',
    requirements: (brief) => {
      const points = (brief.decisivePoints ?? []).filter((point) => point.kind === 'third_party')
      const fallacies = (brief.fallacies ?? []).filter((item) => item.code === 'equivocation')
      const first = fallacies[0] ?? points[0]
      if (first === undefined) return undefined
      return {
        field: fallacies[0] === undefined ? 'decisivePoints[kind=third_party]' : 'fallacies[code=equivocation]',
        postIds: [first.postId],
        why: `同一个词在两边指的不是一回事：${first.quote.slice(0, 40)}`,
      }
    },
  },
  {
    id: 'explain_premise',
    name: '解释争议前提',
    summary: '争的不是结论，是结论底下那个没被说出来的前提。',
    instruction:
      '这次只做一件事：把双方分歧底下那个没有明说的前提摆出来，说明你为什么接受（或不接受）它。' +
      '不要把前提当成对方的观点去反驳。',
    requirements: (brief) => {
      // 有分歧、但既没有已核实的矛盾、也没有可引用的第三方 —— 说明分歧在前提上。
      const disagreements = brief.disagreements ?? []
      const hasHardPoint = (brief.decisivePoints ?? []).some(
        (point) => point.confidence === 'high' && point.evidenceKind === 'quoted',
      )
      if (disagreements.length === 0 || hasHardPoint) return undefined
      const ownerSide = brief.owner
      return {
        field: 'disagreements',
        postIds: ownerSide.evidence,
        why: `双方分歧停在前提上，没有可核对的硬矛盾：${disagreements[0]?.slice(0, 50) ?? ''}`,
      }
    },
  },
  {
    id: 'answer_core',
    name: '直接回应核心论据',
    summary: '对方有一条明确的论据，正面回答它，不绕。',
    instruction:
      '这次只做一件事：正面回应对方那条最关键的论据。先把它说清楚（一句话），' +
      '再给出你的回应。不要追问别的，也不要把话题扯到态度上。',
    requirements: (brief) => {
      const args = brief.opponentArguments ?? []
      const first = args[0]
      if (first === undefined) return undefined
      return {
        field: 'opponentArguments',
        postIds: first.evidence,
        why: `对方有一条可引用的论据：${first.claim.slice(0, 40)}`,
      }
    },
  },
  {
    id: 'ask_clarification',
    name: '证据不足时提出澄清问题',
    summary: '材料不够，问清楚再答，不猜。',
    instruction:
      '这次只做一件事：说明对方的说法不足以让你判断（具体缺哪一块），然后提一个能问出这一块的问题。' +
      '绝对不要替对方补一个他没说过的立场再反驳它。',
    /**
     * 兜底策略：只要没有更强的依据，它就是对的。
     *
     * 这不是「什么都答不了就选它」的偷懒 —— 它是唯一一个**在材料不足时仍然诚实**的
     * 打法。前面六种都要求材料里有具体的东西，材料没有的时候硬选它们就是编造。
     */
    requirements: (brief) => ({
      field: 'missingContext',
      postIds: (brief.owner?.evidence ?? []).slice(0, 1),
      why:
        (brief.missingContext ?? []).length > 0
          ? `这次读取本身有缺口：${(brief.missingContext ?? [])[0] ?? ''}`
          : '没有足够的具体材料支撑更强的打法，追问是唯一不编造的选择',
    }),
  },
]

/** 按 id 取策略。 */
export function strategyById(id: ArgumentStrategyId): ArgumentStrategy | undefined {
  return ARGUMENT_STRATEGIES.find((strategy) => strategy.id === id)
}

/** 所有策略 id，供校验和界面列举。 */
export const STRATEGY_IDS: readonly ArgumentStrategyId[] = ARGUMENT_STRATEGIES.map(
  (strategy) => strategy.id,
)

/** 门槛可靠度：依据字段越硬，可信度越高。 */
function confidenceOf(id: ArgumentStrategyId): 'high' | 'medium' | 'low' {
  // 有原文可对的两种是 high；靠规则推断的三种是 medium；兜底与前提类是 low。
  if (id === 'point_out_contradiction' || id === 'cite_counterexample') return 'high'
  if (id === 'answer_core' || id === 'demand_basis' || id === 'clarify_definition') return 'medium'
  return 'low'
}

/** 自动选择的结果，含被排除的策略与原因。 */
export interface StrategySelection {
  /** 选中的策略；无可用策略时为 `undefined`（理论上不会，因为兜底策略恒可用）。 */
  readonly choice?: StrategyChoice
  /** 被排除的策略与缺什么，供界面和报告使用。 */
  readonly rejected: readonly StrategyRejection[]
}

/**
 * 选一个打法。
 *
 * @param brief 已通过 `validateBrief` 的简报
 * @param requested 主人手工指定的策略；不满足门槛时报错，不降级、不替换
 */
export function selectStrategy(
  brief: DebateBrief,
  requested?: ArgumentStrategyId,
): StrategySelection {
  const rejected: StrategyRejection[] = []

  if (requested !== undefined) {
    const strategy = strategyById(requested)
    if (strategy === undefined) {
      throw new Error(
        `未知的论证策略「${requested}」。可选：${STRATEGY_IDS.join('、')}`,
      )
    }
    const evidence = strategy.requirements(brief)
    if (evidence === undefined) {
      throw new Error(
        `这次的材料不足以支持「${strategy.name}」：${strategy.summary}` +
          '简报里找不到支撑它的依据。换一个策略，或先补读上下文 —— 不要为了用这个打法而编一个依据。',
      )
    }
    return {
      choice: {
        id: strategy.id,
        name: strategy.name,
        source: 'manual',
        reason: `主人指定「${strategy.name}」，材料满足它的证据门槛`,
        evidence: [evidence],
        confidence: confidenceOf(strategy.id),
      },
      rejected,
    }
  }

  for (const strategy of ARGUMENT_STRATEGIES) {
    const evidence = strategy.requirements(brief)
    if (evidence === undefined) {
      rejected.push({ id: strategy.id, missing: strategy.summary })
      continue
    }
    return {
      choice: {
        id: strategy.id,
        name: strategy.name,
        source: 'auto',
        reason: `自动选择：${evidence.why}`,
        evidence: [evidence],
        confidence: confidenceOf(strategy.id),
      },
      rejected,
    }
  }

  return { rejected }
}

/** 把选择结果渲染成给模型的一段指令。 */
export function renderStrategy(choice: StrategyChoice): string {
  const strategy = strategyById(choice.id)
  const lines: string[] = []
  lines.push(`【本轮打法：${choice.name}】${strategy?.summary ?? ''}`)
  lines.push(strategy?.instruction ?? '')
  lines.push(`选择依据：${choice.reason}`)
  if (choice.evidence.length > 0) {
    for (const item of choice.evidence) {
      const ids = item.postIds.length > 0 ? `（${item.postIds.join('、')}）` : ''
      lines.push(`- 依据${ids}：${item.why}`)
    }
  }
  lines.push('这一轮只按这个打法写。不要同时铺开几种打法，也不要用别的打法的结论凑长度。')
  return lines.join('\n')
}
