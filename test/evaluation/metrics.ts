/**
 * The ten quality dimensions, scored per case, and split by what they actually are.
 *
 * ## Why the split matters more than the numbers
 *
 * Four of these are facts about the output: did the reply aim at the right post, did it
 * invent a number, did it repeat something already said. They have a right answer and can
 * gate. The other six are *proxies* for prose quality — "does it engage with the argument",
 * "does it read naturally" — and a threshold on a proxy is a number someone will eventually
 * lower to make CI green.
 *
 * So the two groups are computed and reported separately, and the report never averages
 * them into one score. A run that scores 5/5 on facts and 2/6 on proxies is telling you
 * something a single 7/11 would hide: it is safe and dull.
 *
 * ## What a proxy may not do
 *
 * It may not claim to measure what a human reader would conclude. Every proxy here is a
 * *structural* observation — presence of a concrete detail, absence of template markers,
 * distance between personas — chosen because it is reproducible. The doc comment on each
 * one says what it does not capture.
 */

import type { EvalCase } from './corpus.ts'
import { traceNumbers } from '../../lib/number-trace.js'

/**
 * 分词：CJK 二元组 + 拉丁词 + 数字。
 *
 * ## 为什么这一份是自带的，而不是从 lib 里 import
 *
 * 这个评分器要能对着**任意一个构建**跑（v0.2.34 与 v0.2.35 对比就是这么做出来的），
 * 而 `lib/argument-structure.ts` 是 v0.2.35 才有的模块。评分器一旦依赖被测构建的
 * 内部函数，两个版本的分数就不可比 —— 连分词口径都可能不同。
 *
 * 所以这里保留一份最小实现，只服务于评分，不参与产品逻辑。
 */
const STOP_BIGRAMS: ReadonlySet<string> = new Set([
  '这个', '那个', '就是', '不是', '什么', '我们', '你们', '他们', '自己', '现在',
  '然后', '因为', '所以', '但是', '可以', '一个', '没有', '还是', '这么', '那么',
  '这样', '那样', '时候', '问题', '觉得', '知道', '说的', '说了', '起来', '出来',
  '的话', '其实', '真的', '已经', '应该', '如果', '虽然', '而且', '或者', '以及',
  '一样', '一点', '有点', '怎么', '为什么', '是不是', '有没有',
])

function subjectTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}/g)) tokens.add(match[0].toLowerCase())
  for (const match of text.matchAll(/\d+(?:\.\d+)?%?/g)) tokens.add(match[0])
  const cjk = [...text.replace(/[^\u4e00-\u9fff]/g, '')]
  for (let index = 0; index + 1 < cjk.length; index += 1) {
    const bigram = `${cjk[index]}${cjk[index + 1]}`
    if (STOP_BIGRAMS.has(bigram)) continue
    tokens.add(bigram)
  }
  return tokens
}

/** Whether a dimension is a fact or a stand-in for a judgement. */
export type MetricKind = 'deterministic' | 'proxy'

/**
 * 简报里找到的结构，按通道分开记。
 *
 * ## 为什么不能只数三项（v0.2.38）
 *
 * 旧版只统计「对方论据 / 未答问题 / 矛盾」，于是 `baseline/05` 被判成零结构 ——
 * 而那一条的简报明明找到了 `answeredByOwner`（对方问了、主人已经答过）和
 * `challenges`（对方重复提问）。回复要说的正是「这个我答过了」，材料在简报里，
 * 指标却看不见。
 *
 * 这不是把标准调松：一条什么都没找到的简报仍然是全零。它修的是**测错了对象** ——
 * 「有没有可用的结构」不等于「三个特定字段是不是非空」。
 */
export interface StructureSummary {
  readonly arguments: number
  readonly unanswered: number
  readonly contradictions: number
  /** 对方问了、主人回答过的问题。 */
  readonly answeredByOwner?: number
  /** 对方提出、主人没有回应的质疑。 */
  readonly challenges?: number
  /** 对方离开话题的次数。 */
  readonly topicShifts?: number
  /** 对方帖子里引用第三方的次数。 */
  readonly thirdPartyCitations?: number
  /** 论证形式问题（诉诸人身、以偏概全等）。 */
  readonly fallacies?: number
}

/** 结构总数：所有通道加起来。 */
export function structureCountOf(structure: StructureSummary): number {
  return (
    structure.arguments +
    structure.unanswered +
    structure.contradictions +
    (structure.answeredByOwner ?? 0) +
    (structure.challenges ?? 0) +
    (structure.topicShifts ?? 0) +
    (structure.thirdPartyCitations ?? 0) +
    (structure.fallacies ?? 0)
  )
}

/** One dimension's outcome. */
export interface MetricScore {
  readonly id: MetricId
  readonly label: string
  readonly kind: MetricKind
  /** 0 or 1 for deterministic metrics; 0..1 for proxies. */
  readonly score: number
  /** Why it scored that way — required, so a number can always be traced to evidence. */
  readonly basis: string
}

/** The ten dimensions §5.2 asks for. */
export type MetricId =
  | 'target_accuracy'
  | 'argument_recognition'
  | 'stance_consistency'
  | 'substantive_rebuttal'
  | 'factual_credibility'
  | 'context_use'
  | 'persona_style'
  | 'naturalness'
  | 'non_repetition'
  | 'uncertainty_handling'

/** Everything needed to score one reply. */
export interface ScoreInput {
  readonly caseId: string
  readonly reply: string
  /** The target the pipeline used, and the one the case requires. */
  readonly targetPostId?: string
  readonly expectedTargetPostId?: string
  /** The owner's reconstructed position, for the stance check. */
  readonly ownerPosition?: string
  /** The thread text the model was actually given. */
  readonly contextText: string
  /** Every post text in the case, for "did it use a concrete detail". */
  readonly threadText: string
  /** How many structure findings the brief carried (§3.1). */
  readonly structure: StructureSummary
  /** Replies this session already sent, for the repetition check. */
  readonly previousReplies?: readonly string[]
  /** True when the read was incomplete or the brief listed missing context. */
  readonly missingContext: boolean
  /** Persona id, for the cross-case distinctness check. */
  readonly persona?: string
  /**
   * True when the case's correct outcome is *not* a reply (a refusal).
   *
   * ## Why this has to be an input rather than an inference
   *
   * A refusal case has no opponent by design — there is nobody to argue with — so
   * `argument_recognition` finds no structure and scores zero. Counting that as a hard
   * failure would put "this case correctly refused" and "this case failed to find the
   * argument" in the same list, which is exactly the kind of conflation the report is
   * supposed to prevent.
   */
  readonly refusalCase?: boolean
  /**
   * 这条案例里，对方本来就没有给出可提取的论据（v0.2.38）。
   *
   * 与 `refusalCase` 不同：这里**要**生成一条回复，只是正确行为是追问而不是反驳。
   * 评分器据此改判：零结构不扣分；反过来，如果硬抽出了结构，那才是编造。
   */
  readonly evidenceInsufficient?: boolean
}

/** Markers that make prose read like a school essay rather than a forum reply. */
const TEMPLATE_MARKERS = [
  '首先',
  '其次',
  '最后',
  '综上所述',
  '总而言之',
  '总的来说',
  '总的说来',
  '第一，',
  '第二，',
  '一方面',
  '另一方面',
  '值得注意的是',
]

/** Check one dimension. */
function metric(id: MetricId, label: string, kind: MetricKind, score: number, basis: string): MetricScore {
  return { id, label, kind, score: Math.max(0, Math.min(1, score)), basis }
}

/** How many sentences, and how varied their lengths are. */
function sentenceStats(text: string): { count: number; spread: number } {
  const sentences = text
    .split(/[。！？!?\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (sentences.length === 0) return { count: 0, spread: 0 }
  const lengths = sentences.map((line) => [...line].length)
  const max = Math.max(...lengths)
  const min = Math.min(...lengths)
  return { count: sentences.length, spread: max - min }
}

/**
 * Score one reply on all ten dimensions.
 *
 * Pure: no network, no time, no randomness. That is what makes a comparison between two
 * versions meaningful — the only thing that changes between runs is the reply.
 */
export function scoreReply(input: ScoreInput): readonly MetricScore[] {
  const reply = input.reply.trim()
  const replyTokens = subjectTokens(reply)
  const threadTokens = subjectTokens(input.threadText)
  const contextTokens = subjectTokens(input.contextText)

  // 1. Target accuracy — a fact: the id either matches or it does not.
  const targetOk =
    input.expectedTargetPostId === undefined || input.targetPostId === undefined
      ? undefined
      : input.targetPostId === input.expectedTargetPostId

  // 2. Argument recognition — did the analysis actually find structure to work with?
  //
  // v0.2.38：八个通道相加，而不是只数三项。理由见 `StructureSummary`。
  const structureCount = structureCountOf(input.structure)

  // 3. Stance consistency — the reply must not argue the owner's own position down.
  const ownerTokens = subjectTokens(input.ownerPosition ?? '')
  let stanceOverlap = 0
  for (const token of ownerTokens) if (replyTokens.has(token)) stanceOverlap += 1
  const negatesOwnPosition =
    ownerTokens.size > 0 &&
    stanceOverlap > 0 &&
    /(我也觉得你说的对|你说得对|我认输|确实是我错了)/.test(reply)

  // 4. Substantive rebuttal — does the reply use a concrete element, or is it filler?
  let concrete = 0
  for (const token of replyTokens) if (threadTokens.has(token)) concrete += 1
  const concreteRatio = replyTokens.size === 0 ? 0 : concrete / replyTokens.size

  /**
   * 5. Factual credibility — every number must be traceable to what it was given.
   *
   * ## 为什么不再只做字面比对（v0.2.38）
   *
   * 旧实现把「上下文里没出现过这个字符串」直接判成编造。这会把**一次正确的推算和一次
   * 编造算成同一件事**：原文写「从 18 涨到 26」，回复写「涨了 44%」——两个数都在原文，
   * 结论也正确，却因为 `44%` 这个 token 没逐字出现过而被判红（`weibo/06`）。
   *
   * 现在区分三种：原文出现（quoted）、由原文两个数可复算（derived）、追不回去
   * （unknown）。只有 unknown 判 0，并且依据里带上算式，人能当场核对。
   * 判据在 `src/number-trace.ts`，评分器与产品侧共用同一份。
   */
  const numberVerdicts = traceNumbers(reply, [input.contextText])
  const unknownNumbers = numberVerdicts.filter((verdict) => verdict.kind === 'unknown')
  const derived = numberVerdicts.filter((verdict) => verdict.kind === 'derived')

  // 6. Context use — how much of the reply's vocabulary comes from the supplied context.
  let fromContext = 0
  for (const token of replyTokens) if (contextTokens.has(token)) fromContext += 1
  const contextRatio = replyTokens.size === 0 ? 0 : fromContext / replyTokens.size

  // 7. Persona style — a register marker, not a judgement of quality.
  const styleVisible =
    input.persona === undefined
      ? 0
      : /(你这|我|别|倒是|其实|呵|呢|吧|啊|？|\?)/.test(reply)
        ? 0.7
        : 0.4

  // 8. Naturalness — absence of essay scaffolding and some sentence-length variety.
  const templates = TEMPLATE_MARKERS.filter((marker) => reply.includes(marker))
  const stats = sentenceStats(reply)
  const naturalness =
    templates.length > 0 ? 0 : stats.count <= 1 ? 0.6 : stats.spread >= 4 ? 1 : 0.8

  // 9. Non-repetition — identical to something already sent, or internally repetitive.
  const normalized = reply.replace(/\s+/g, '')
  const duplicated = (input.previousReplies ?? []).some(
    (previous) => previous.replace(/\s+/g, '') === normalized,
  )
  const repeatedPhrase = /(.{6,})\1/.test(normalized)

  // 10. Uncertainty handling — with missing context, the reply must not pretend otherwise.
  const admitsLimit = /(看不到|没读到|不确定|可能|据我所知|如果.{0,6}的话|没法确认)/.test(reply)
  const uncertainty = input.missingContext ? (admitsLimit ? 1 : 0.2) : 1

  return [
    metric(
      'target_accuracy',
      '目标准确性',
      'deterministic',
      targetOk === undefined ? 0.5 : targetOk ? 1 : 0,
      targetOk === undefined
        ? '这次运行没有记录目标 id，无法判定'
        : targetOk
          ? `回复目标是 ${input.targetPostId}`
          : `回复目标是 ${input.targetPostId ?? '（空）'}，应为 ${input.expectedTargetPostId}`,
    ),
    metric(
      'argument_recognition',
      '论点识别准确性',
      'deterministic',
      /**
       * 二元，不是比例。
       *
       * 一度写成 `min(1, 条数/3)`，那会让「发现一条论据」和「发现三条」落在 0.33 与 1.0
       * 之间，而这两个数的差别不说明洞察力，只说明这一楼里对方说了几句。确定性维度
       * 的用处是「有 / 没有」，数量写在依据里，让人自己判断。
       */
      input.refusalCase === true
        ? 1
        : input.evidenceInsufficient === true
          ? structureCount === 0
            ? 1
            : 0
          : structureCount > 0
            ? 1
            : 0,
      input.refusalCase === true
        ? '这个案例按设计不生成回复，不评价论点识别'
        : input.evidenceInsufficient === true
          ? structureCount === 0
            ? '这个案例里对方本来就只有一句表态、没有任何论据：零结构是正确结果，不扣分'
            : `这个案例里对方只有一句表态，却抽出了 ${structureCount} 条结构 —— 这是编造，不是识别`
          : structureCount === 0
            ? '论证结构里一条都没找到（对方论据/未答问题/矛盾/已答问题/质疑/跑题/引用/谬误）'
            : `结构里找到 ${structureCount} 条：对方论据 ${input.structure.arguments}、未答问题 ${input.structure.unanswered}、矛盾 ${input.structure.contradictions}` +
              `、已答问题 ${input.structure.answeredByOwner ?? 0 }、质疑 ${input.structure.challenges ?? 0}` +
              `、跑题 ${input.structure.topicShifts ?? 0}、引用 ${input.structure.thirdPartyCitations ?? 0}、谬误 ${input.structure.fallacies ?? 0}`,
    ),
    metric(
      'stance_consistency',
      '立场一致性',
      'deterministic',
      negatesOwnPosition ? 0 : 1,
      negatesOwnPosition ? '回复里有认输式表述，等于替主人改口' : '没有发现替主人改口的表述',
    ),
    metric(
      'substantive_rebuttal',
      '实质反驳能力',
      'proxy',
      Math.min(1, concreteRatio * 2.2),
      `回复里 ${Math.round(concreteRatio * 100)}% 的词来自讨论本身（代理指标：不衡量反驳是否真的成立）`,
    ),
    metric(
      'factual_credibility',
      '事实可信度',
      'deterministic',
      unknownNumbers.length === 0 ? 1 : 0,
      unknownNumbers.length > 0
        ? `回复里出现了上下文没有、也算不出来的数字：${unknownNumbers.map((verdict) => verdict.value).join('、')}`
        : derived.length > 0
          ? `数字都可追溯；其中 ${derived.map((verdict) => `${verdict.value} ${verdict.basis}`).join('；')}`
          : '回复里的数字都能在给定上下文里找到',
    ),
    metric(
      'context_use',
      '上下文利用程度',
      'proxy',
      Math.min(1, contextRatio * 2.5),
      `回复里 ${Math.round(contextRatio * 100)}% 的词出现在提供的上下文里（代理指标）`,
    ),
    metric(
      'persona_style',
      '人格风格辨识度',
      'proxy',
      styleVisible,
      input.persona === undefined
        ? '这次运行没有记录人格'
        : `按口语标记粗判 ${input.persona}（代理指标：不衡量像不像这个具体人格）`,
    ),
    metric(
      'naturalness',
      '表达自然度',
      'proxy',
      naturalness,
      templates.length > 0
        ? `出现了作文式连接词：${templates.join('、')}`
        : stats.count <= 1
          ? '只有一句话，判不出句式变化'
          : `句长跨度 ${stats.spread} 字，没有作文式连接词`,
    ),
    metric(
      'non_repetition',
      '重复程度',
      'deterministic',
      duplicated ? 0 : repeatedPhrase ? 0.5 : 1,
      duplicated
        ? '与本会话已发内容完全相同'
        : repeatedPhrase
          ? '回复内部有重复片段'
          : '没有与已发内容重复，也没有内部重复',
    ),
    metric(
      'uncertainty_handling',
      '不确定性处理',
      'deterministic',
      uncertainty,
      input.missingContext
        ? admitsLimit
          ? '这次读取有缺失，回复里也承认了限制'
          : '这次读取有缺失，但回复没有承认任何限制'
        : '这次读取没有缺失，无需承认限制',
    ),
  ]
}

/** One case's result in a run record. */
export interface CaseResult {
  readonly caseId: string
  readonly persona?: string
  readonly reply: string
  readonly scores: readonly MetricScore[]
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly elapsedMs?: number
}

/** A complete run, as written to disk and compared later. */
export interface RunRecord {
  /** Which version produced it. Compared reports refuse to mix models. */
  readonly version: string
  readonly model: string
  readonly protocol: string
  readonly generatedAt: string
  /** True when a real endpoint produced these replies. */
  readonly realModel: boolean
  readonly cases: readonly CaseResult[]
}

/** Mean score per metric across a run. */
export function meanByMetric(cases: readonly CaseResult[]): Map<MetricId, number> {
  const totals = new Map<MetricId, { sum: number; count: number }>()
  for (const item of cases) {
    for (const score of item.scores) {
      const entry = totals.get(score.id) ?? { sum: 0, count: 0 }
      entry.sum += score.score
      entry.count += 1
      totals.set(score.id, entry)
    }
  }
  const out = new Map<MetricId, number>()
  for (const [id, entry] of totals) out.set(id, entry.count === 0 ? 0 : entry.sum / entry.count)
  return out
}

/** Which metrics a case set can even measure. */
export function metricKindOf(id: MetricId): MetricKind {
  if (
    id === 'target_accuracy' ||
    id === 'argument_recognition' ||
    id === 'stance_consistency' ||
    id === 'factual_credibility' ||
    id === 'non_repetition' ||
    id === 'uncertainty_handling'
  ) {
    return 'deterministic'
  }
  return 'proxy'
}

/** The corpus case ids, so a comparison can refuse a mismatched pair. */
export function caseIdsOf(cases: readonly EvalCase[]): readonly string[] {
  return cases.map((item) => item.id).sort()
}
