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
  readonly structure: { arguments: number; unanswered: number; contradictions: number }
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

/** Numbers written in a text, normalised so `8%` and `8 %` compare equal. */
function numbersIn(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(/\d+(?:\.\d+)?%?/g)) found.add(match[0].replace(/\s+/g, ''))
  return found
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
  const structureCount =
    input.structure.arguments + input.structure.unanswered + input.structure.contradictions

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

  // 5. Factual credibility — every number in the reply must exist in what it was given.
  const newNumbers = [...numbersIn(reply)].filter((value) => !numbersIn(input.contextText).has(value))

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
      input.refusalCase === true || structureCount > 0 ? 1 : 0,
      input.refusalCase === true
        ? '这个案例按设计不生成回复，不评价论点识别'
        : structureCount === 0
          ? '论证结构里一条都没找到（对方论据/未答问题/矛盾）'
          : `结构里找到 ${input.structure.arguments} 条对方论据、${input.structure.unanswered} 个未答问题、${input.structure.contradictions} 处矛盾`,
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
      newNumbers.length === 0 ? 1 : 0,
      newNumbers.length === 0
        ? '回复里的数字都能在给定上下文里找到'
        : `回复里出现了上下文没有的数字：${newNumbers.join('、')}`,
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
