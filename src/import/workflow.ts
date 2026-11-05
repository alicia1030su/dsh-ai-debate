/**
 * 离线工作流的完整链路（v0.2.30 §二）。
 *
 * ## 十一步，每一步都要能被页面单独说清
 *
 * ```
 * 导入 → 预览 → 确认 → 分析 → 选中 → 人格 → 生成 → 编辑 → 安全评估 → 人工确认 → 复制
 * ```
 *
 * 任务书要求这条链路「可独立解释」。落到实处是：每一步失败都有一个不属于
 * 「未知错误」的原因，且原因说的是**下一步能做什么**，而不是「操作失败」。
 *
 * ## 这里没有第二个辩论引擎
 *
 * 分析用 `analyzeDispute`，生成用 `generateReply`，评估用 `guardOutput`，
 * 压缩用 `compressContext`，简报用 `buildBrief` + `validateBrief`——与真实平台
 * 走的是**同一批函数**。本文件做的是把它按离线场景的顺序串起来，并在每一个
 * 需要写库的地方落库。任何一行「自己判断谁在跟谁吵」的代码都意味着出现了
 * 第二个引擎，那是任务书明确禁止的。
 *
 * ## 终点是剪贴板
 *
 * `copyReply` 返回纯文本，不调用任何发布路径。这不是「暂时不支持发表」的委婉说法：
 * `runPublish` 对导入会话有显式拒绝，`platform: 'manual'` 在注册表里不存在，
 * 两道门都在。
 */

import type { CollectedThread } from '../collector.js'
import { buildTimeline, containerOf } from '../collector.js'
import type { Dispute } from '../analyzer.js'
import { buildBrief } from '../brief-builder.js'
import { renderBrief, validateBrief } from '../brief.js'
import { compressContext, resolveBudget, splitBudget } from '../compressor.js'
import { generateReply } from '../generator.js'
import { PERSONAS, resolvePersona, type PersonaConfig, type PersonaStyle } from '../persona.js'
import { guardOutput, toStorageRecord, type ConversationPost } from '../security/output-guard.js'
import { contentHash, resolveTarget, type TargetExpectation } from '../target.js'
import { detectInjection, transition } from '../safety.js'
import type { ResolvedConfig } from '../config.js'
import type { LlmClient } from '../llm.js'
import type {
  DebateStore,
  StoredCandidate,
  StoredComment,
  StoredManualImport,
  StoredSession,
} from '../store.js'
import { newCandidateId } from '../store.js'
import { buildCommentList } from '../comment-list.js'
import { analyzeImported, collectedFromStored, excerptOf, localTargetResolver } from './session.js'
import type { CopyableReply } from './session.js'
import { MANUAL_PLATFORM } from './manual.js'
import { MANUAL_CAPABILITIES, MANUAL_IMPORT } from './source.js'

/**
 * 工作流的十一步。
 *
 * 用字符串联合而不是枚举：它要出现在页面的 `data-step`、日志和错误消息里，
 * 数字会让这三处都变得难以阅读。
 */
export type ManualStep =
  | 'import'
  | 'preview'
  | 'confirm'
  | 'analyze'
  | 'select'
  | 'persona'
  | 'generate'
  | 'edit'
  | 'assess'
  | 'approve'
  | 'copy'

/** 每一步的中文名，供页面与错误消息共用一份。 */
export const STEP_TITLES: Readonly<Record<ManualStep, string>> = {
  import: '导入讨论',
  preview: '预览解析结果',
  confirm: '确认导入',
  analyze: '分析争论结构',
  select: '选中要回复的那一条',
  persona: '选择人格',
  generate: '生成候选回复',
  edit: '编辑正文',
  assess: '安全评估',
  approve: '人工确认',
  copy: '复制回复',
}

/** 一步的结果。失败时 `reason` 必须说清「下一步能做什么」。 */
export interface StepResult<T> {
  readonly ok: boolean
  readonly step: ManualStep
  readonly value?: T
  readonly reason?: string
  /** 用户能做的事，按顺序。失败时通常非空。 */
  readonly next?: readonly string[]
}

function failed(step: ManualStep, reason: string, next: readonly string[] = []): StepResult<never> {
  return { ok: false, step, reason, next }
}

function succeeded<T>(step: ManualStep, value: T): StepResult<T> {
  return { ok: true, step, value }
}

/**
 * 四种人格，供页面选择。
 *
 * 直接从 `PERSONAS` 生成，不另抄一份：抄一份意味着将来加了第五种人格，
 * 离线流程看不到它，而且没有任何测试会发现。
 */
export interface PersonaOption {
  readonly id: PersonaStyle
  readonly name: string
  readonly summary: string
  readonly approach: string
}

export function personaOptions(): readonly PersonaOption[] {
  return (Object.keys(PERSONAS) as PersonaStyle[]).map((id) => {
    const persona = PERSONAS[id]
    return { id, name: persona.name, summary: persona.summary, approach: persona.approach }
  })
}

/** 从配置取人格基础值。与 `runtime.ts` 的 `personaFromConfig` 同一份字段。 */
function personaFromConfig(config: ResolvedConfig): PersonaConfig {
  return resolvePersona({
    style: config.personaStyle,
    intensity: config.intensity,
    maxLength: config.maxLength,
    emojiLevel: config.emojiLevel,
    sarcasmLevel: config.sarcasmLevel,
    directness: config.directness,
  })
}

/** 校验一个人格 id，返回可写进会话的配置。 */
export function personaOf(
  style: string | undefined,
  config: ResolvedConfig,
  overrides?: { readonly intensity?: number; readonly maxLength?: number },
): PersonaConfig {
  const base = personaFromConfig(config)
  const withOverrides = resolvePersona({
    ...base,
    ...(overrides?.intensity === undefined ? {} : { intensity: overrides.intensity }),
    ...(overrides?.maxLength === undefined ? {} : { maxLength: overrides.maxLength }),
  })
  if (style === undefined || style.trim() === '') return withOverrides
  const known = (Object.keys(PERSONAS) as PersonaStyle[]).includes(style as PersonaStyle)
  if (!known) {
    throw new Error(
      `未知的人格「${style}」。可选：${personaOptions()
        .map((option) => `${option.id}（${option.name}）`)
        .join('、')}。`,
    )
  }
  return { ...withOverrides, style: style as PersonaStyle }
}

// ---------------------------------------------------------------------------
// 分析：把导入内容变成会话
// ---------------------------------------------------------------------------

export interface ManualAnalyzeInput {
  readonly imported: StoredManualImport
  /** 主人是谁（导入内容里的某个作者名）。不填时用原帖作者。 */
  readonly ownerName?: string
  /** 要回复哪一条。不填时用最后一条发言。 */
  readonly targetPostId?: string
  readonly persona: PersonaConfig
  readonly config: ResolvedConfig
  readonly now?: () => number
}

export interface ManualAnalyzeOutput {
  readonly collected: CollectedThread
  readonly dispute: Dispute
  readonly targetPostId: string
  readonly session: StoredSession
  /** 参与者的展示列表，与真实分析输出的形状一致。 */
  readonly participants: readonly {
    readonly name: string
    readonly postCount: number
    readonly isOwner: boolean
    readonly isOpponent: boolean
  }[]
  /** 注入检测的结果，按发言逐条。与 `runAnalysis` 的做法一致。 */
  readonly securityNotes: readonly string[]
}

/**
 * 分析一份导入的讨论，并落库成会话。
 *
 * ## 为什么会话要写两次
 *
 * 第一次写入是「会话已创建」，第二次补上分析结果（`ownerKey`、`disputeFloorPostId`、
 * 参与者）。分开是因为分析可能抛错：抛错时用户应该看到一个「导入了但没分析成功」
 * 的会话，而不是「什么都没有」——前者可以重试，后者得从头再来一遍。
 *
 * 但它们必须在同一个会话 id 上。所以第一次写入就定下 id，第二次按 id 更新。
 */
export async function analyzeImport(
  store: DebateStore,
  input: ManualAnalyzeInput,
): Promise<StepResult<ManualAnalyzeOutput>> {
  let collected: CollectedThread
  try {
    collected = collectedFromStored(input.imported)
  } catch (error) {
    return failed('analyze', `无法从导入内容重建讨论：${(error as Error).message}`, [
      '检查导入的正文是否完整（每条发言要有「作者：内容」）',
      '重新导入一次',
    ])
  }

  const ownerName = input.ownerName?.trim() || input.imported.root.author
  let analyzed: { dispute: Dispute; targetPostId: string }
  try {
    analyzed = analyzeImported({
      collected,
      ownerName,
      ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
      ...(input.config.aiAccountName === '' ? {} : { aiAccountName: input.config.aiAccountName }),
      ...(input.now === undefined ? {} : { now: input.now }),
    })
  } catch (error) {
    // 分析器的错误本来就是具体的（「没有找到主人」「触发回复不在对话里」），
    // 原样透出而不是包一层「分析失败」——包一层会把可行动的原因变成噪音。
    return failed('analyze', (error as Error).message, [
      '检查「主人是谁」是否填了导入内容里的某个作者名',
      '确认至少有一条别人的发言（只有原帖时没有可回复的对象）',
    ])
  }

  const { dispute, targetPostId } = analyzed
  const now = new Date(input.now?.() ?? Date.now()).toISOString()
  /**
   * 会话 id。
   *
   * ## 为什么不能只用「时间戳 + 线程哈希」
   *
   * 第一版就是这么算的，而它有一个只在真实使用中才出现的缺陷：同一秒内对同一份
   * 内容分析两次（`reselectImport` 正是这样——它先建一个新会话再把内容搬到旧 id 上），
   * 两次得到同一个 id。于是「删掉刚才多插的那一条」把原会话一起删掉了，
   * 用户看到的是「会话消失了」。
   *
   * 时间戳精确到秒、线程哈希确定，只有第三个分量能保证唯一。用进程内单调计数：
   * 它不依赖随机数（可测），也不依赖更多的时间精度（同一毫秒仍会撞）。
   */
  const sessionId = `m${now.replace(/[-:.TZ]/g, '').slice(0, 14)}${nextManualSessionSerial().toString(36)}`

  const participants = [
    dispute.owner,
    ...(dispute.opponent === undefined ? [] : [dispute.opponent]),
    ...dispute.bystanders,
  ].map((person) => ({
    name: person.displayName,
    postCount: person.postCount,
    isOwner: person.key === dispute.owner.key,
    isOpponent: person.key === dispute.opponent?.key,
  }))

  // 注入检测：报告，不执行。与 `runAnalysis` 的措辞一致，因为用户可能在两处
  // 看到同一条内容，两处说不同的话会让人怀疑哪一处是真的。
  const securityNotes: string[] = []
  for (const entry of buildTimeline(collected)) {
    const hits = detectInjectionText(entry.content)
    if (hits.length > 0) {
      securityNotes.push(
        `${entry.authorName ?? entry.postId} 的发言里出现可疑指令性文本（${hits.join('、')}），` +
          '已按普通用户发言处理，不会作为系统指令执行',
      )
    }
  }

  const comments = buildStoredComments(collected)
  const reasons = [...collected.completeness.reasons]
  if (input.imported.droppedComments > 0) {
    reasons.push(
      `导入时只保存了 ${input.imported.comments.length} 条，另有 ${input.imported.droppedComments} 条没有保存。`,
    )
  }
  if (input.imported.truncatedComments > 0) {
    reasons.push(`有 ${input.imported.truncatedComments} 条正文被截断保存。`)
  }

  const session: StoredSession = {
    id: sessionId,
    platform: MANUAL_PLATFORM,
    threadId: collected.thread.id,
    threadUrl: input.imported.url ?? '',
    threadTitle: input.imported.title,
    forumName: '',
    ownerKey: dispute.owner.key,
    ownerName: dispute.owner.displayName,
    ...(dispute.opponent === undefined
      ? {}
      : { opponentKey: dispute.opponent.key, opponentName: dispute.opponent.displayName }),
    ...(dispute.opponent?.lastPostId === undefined
      ? {}
      : { targetKind: postKindOf(collected, targetPostId) }),
    ownerIdentityAssurance: dispute.ownerIdentityAssurance,
    ownerIdentityEvidence: dispute.ownerIdentityEvidence,
    disputeFloorPostId: dispute.floorPostId,
    disputeFloorNumber: dispute.floorNumber ?? 0,
    triggerPostId: targetPostId,
    state: 'ANALYZING',
    statusText: '人工导入：内容来自剪贴板，未经平台核验',
    persona: {
      style: input.persona.style,
      intensity: input.persona.intensity,
      maxLength: input.persona.maxLength,
    },
    candidates: [],
    comments,
    readQuality: {
      floorsRead: collected.floors.length,
      nestedRead: collected.floors.reduce((sum, entry) => sum + entry.nested.length, 0),
      // 导入的永远不是「完整读取」：内容来自剪贴板，没有平台来证明它没被裁剪。
      truncated: true,
      reasons,
      observationOverflow: [],
    },
    sentTexts: [],
    publishedPostIds: [],
    imported: input.imported,
    participants,
    createdAt: now,
    updatedAt: now,
  }

  await store.mutate((data) => ({ ...data, sessions: [...data.sessions, session] }))

  return succeeded('analyze', {
    collected,
    dispute,
    targetPostId,
    session,
    participants,
    securityNotes,
  })
}

/** 与 `runAnalysis` 同一套检测，避免两处措辞分叉。 */
function detectInjectionText(text: string): readonly string[] {
  // 直接复用安全模块的实现；这个薄包装存在的唯一理由是让上面的调用点读起来
  // 像「检测这段文本」，而不是「导入一个以 detect 开头的函数」。
  return detectInjection(text)
}

/**
 * 进程内单调计数，只用于让会话 id 唯一。
 *
 * 从模块加载时刻的毫秒值起算而不是从 0 起算：两个进程同时分析同一份内容时，
 * 起始值的差异让它们几乎不可能落在同一个数上。这不是严格的唯一性保证
 * （那需要一个真正的外部分配器），但对同一个 store 里的两个会话已经足够——
 * 而 store 本身在写入时会加跨进程锁。
 */
let manualSessionSerial = Date.now() % 1_000_000

function nextManualSessionSerial(): number {
  manualSessionSerial += 1
  return manualSessionSerial
}

function buildStoredComments(collected: CollectedThread): readonly StoredComment[] {
  return buildCommentList(collected).comments
}

// ---------------------------------------------------------------------------
// 选中：改主人或改目标
// ---------------------------------------------------------------------------

export interface ManualSelectInput {
  readonly sessionId: string
  /** 换成这个作者当主人。 */
  readonly ownerName?: string
  /** 换成这一条当回复目标。 */
  readonly targetPostId?: string
  readonly persona: PersonaConfig
  readonly config: ResolvedConfig
  readonly now?: () => number
}

/**
 * 重新分析：换主人或换目标。
 *
 * ## 为什么要重新分析而不是改两个字段
 *
 * 主人变了，`ownerKey`、`ownerIdentityEvidence`、争论对象、`floorPostId` 全都变；
 * 目标变了，对手和争论链也变。只改字段会让会话内部自相矛盾——而发表路径
 * 正是靠这些字段判断「这段话是给谁写的」。
 *
 * 所以这里重跑分析器，然后把结果整体覆盖到同一个会话 id 上。候选**全部作废**：
 * 它们是对着旧的主人和旧的对手写的。
 */
export async function reselectImport(
  store: DebateStore,
  input: ManualSelectInput,
): Promise<StepResult<ManualAnalyzeOutput>> {
  const session = store.getSession(input.sessionId)
  if (session === undefined) {
    return failed('select', `找不到会话 ${input.sessionId}`, ['刷新页面后重试'])
  }
  if (session.imported === undefined) {
    return failed('select', '这条会话不是人工导入的，不能这样重新选择。', [
      '真实平台的会话请用工作台的「用这条」',
    ])
  }

  const analyzed = await analyzeImport(store, {
    imported: session.imported,
    ownerName: input.ownerName ?? session.ownerName,
    targetPostId: input.targetPostId ?? session.triggerPostId,
    persona: input.persona,
    config: input.config,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  if (!analyzed.ok || analyzed.value === undefined) return analyzed

  // 分析生成了一个**新**会话（因为它总是插入）。把结果搬到原会话 id 上，
  // 并清掉候选——它们是对着旧目标写的。
  const fresh = analyzed.value
  const merged: StoredSession = {
    ...fresh.session,
    id: session.id,
    candidates: [],
    createdAt: session.createdAt,
  }
  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions
      // 先删掉刚才多插的那一条，再把内容覆盖到原 id 上。
      .filter((entry) => entry.id !== fresh.session.id)
      .map((entry) => (entry.id === session.id ? merged : entry)),
  }))

  return succeeded('select', { ...fresh, session: merged })
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export interface ManualGenerateInput {
  readonly sessionId: string
  /** 要回复哪一条。不填时用会话记下的那一条。 */
  readonly targetPostId?: string
  readonly persona?: Partial<PersonaConfig>
  readonly ownerInstruction?: string
  readonly config: ResolvedConfig
  readonly llm: () => LlmClient
  readonly signal?: AbortSignal
  readonly progress?: (message: string) => void
}

export interface ManualGenerateOutput {
  readonly sessionId: string
  readonly candidateId: string
  readonly text: string
  readonly version: number
  readonly violations: readonly string[]
  readonly notes: readonly string[]
  readonly securityDecision: 'allow' | 'review' | 'block'
  readonly securityReasons: readonly string[]
  readonly needsInput: boolean
  readonly needsInputReason?: string
}

/**
 * 为导入的会话生成候选。
 *
 * ## 与 `runGeneration` 的关系
 *
 * 它是**同一套步骤的不同入口**，因为 `runGeneration` 有三处真实平台专用的逻辑：
 * 读适配器（离线没有）、读配置里的主人绑定（离线不用）、发表目标校验用适配器
 * （离线用本地解析器）。除此之外的每一步——重投影、`analyzeDispute`、
 * `compressContext`、`buildBrief` + `validateBrief`、`generateReply`、
 * `guardOutput`、候选版本分配——都在这里原样重现。
 *
 * 之所以不把 `runGeneration` 参数化，是因为那会让真实发表路径上多出三个
 * 「如果这是离线会话」的分支，而那条路径的每一项检查都是防发错人的。
 * 复制一份步骤、共用全部函数，比让真实路径长出分支安全。
 */
export async function generateForImport(
  store: DebateStore,
  input: ManualGenerateInput,
): Promise<StepResult<ManualGenerateOutput>> {
  const progress = input.progress ?? (() => undefined)
  const session = store.getSession(input.sessionId)
  if (session === undefined) return failed('generate', `找不到会话 ${input.sessionId}`, ['刷新页面后重试'])
  if (session.imported === undefined) {
    return failed('generate', '这条会话不是人工导入的。', ['真实平台的会话请用工作台的「生成候选」'])
  }
  if (session.state === 'CANCELLED') {
    return failed('generate', '这条会话已被停止，不能再生成。', ['重新导入一次'])
  }

  const collected = collectedFromStored(session.imported)
  const targetPostId = input.targetPostId ?? session.selectedTargetPostId ?? session.triggerPostId

  // 目标必须在这份导入内容里。没有这一条，一个手写的 id 会让生成对着
  // 一段不存在的文字进行——而评估环节的所有引用校验都会因此失去意义。
  const known = buildTimeline(collected).some((entry) => entry.postId === targetPostId)
  if (!known) {
    return failed('generate', `目标 ${targetPostId} 不在这次导入的内容里，无法作为回复对象。`, [
      '在评论列表里重新点选一条',
    ])
  }

  let dispute: Dispute
  try {
    dispute = analyzeImported({
      collected,
      ownerName: session.ownerName ?? session.imported.root.author,
      targetPostId,
      ...(input.config.aiAccountName === '' ? {} : { aiAccountName: input.config.aiAccountName }),
    }).dispute
  } catch (error) {
    return failed('generate', (error as Error).message, ['检查「主人是谁」是否仍在这次导入的内容里'])
  }

  // 目标快照：走 `resolveTarget` 的完整校验，只是换成本地解析器。
  const expectation: TargetExpectation = {
    threadId: session.threadId,
    floorPostId: containerOf(collected, targetPostId)?.postId ?? dispute.floorPostId,
    targetPostId,
    targetKind: postKindOf(collected, targetPostId),
    ...(dispute.opponent?.userId === undefined ? {} : { targetAuthorId: dispute.opponent.userId }),
  }
  const resolved = await resolveTarget(localTargetResolver(collected), expectation, {
    platform: MANUAL_PLATFORM,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!resolved.ok) {
    return failed('generate', `回复目标无法确认：${resolved.message}`, [
      '重新选择要回复的那一条',
      '如果刚编辑过导入内容，重新导入一次',
    ])
  }

  const persona = { ...resolvePersona(input.config), ...(input.persona ?? {}) }
  const total = resolveBudget({
    preset: input.config.contextPreset,
    tokens: input.config.contextTokens > 0 ? input.config.contextTokens : undefined,
  })
  const split = splitBudget(total.tokens)
  const context = compressContext({
    collected,
    dispute,
    trigger: { postId: session.triggerPostId },
    persona,
    budget: { tokens: split.contextTokens, quoteLimit: total.quoteLimit },
    totalTokens: total.tokens,
    ...(input.ownerInstruction === undefined ? {} : { ownerInstruction: input.ownerInstruction }),
  })

  const briefBuild = buildBrief({
    platform: MANUAL_PLATFORM,
    threadId: session.threadId,
    collected,
    dispute,
    targetPostId,
  })
  const briefProblems = validateBrief(briefBuild.brief, briefBuild.sources)
  if (briefProblems.length > 0) {
    const summary = briefProblems.map((problem) => `${problem.field}：${problem.reason}`).join('；')
    return failed(
      'assess',
      `争论简报未通过证据校验，不能据此生成回复：${summary}`,
      ['这份导入内容可能不足以支撑一次回复，试试多导入几条对方的发言'],
    )
  }

  progress('正在生成回复…')
  const result = await generateReply(input.llm(), {
    dispute,
    context,
    persona,
    expectedTargetPostId: targetPostId,
    alreadyPublished: session.publishedPostIds,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.ownerInstruction === undefined ? {} : { ownerInstruction: input.ownerInstruction }),
    brief: renderBrief(briefBuild.brief),
    temperature: input.config.llmTemperature,
    ...(input.config.llmMaxOutputTokens > 0 ? { maxTokens: input.config.llmMaxOutputTokens } : {}),
  })

  if (result.draft === undefined) {
    const reasons = result.violations.map((violation) => violation.message).join('；')
    return failed('generate', `模型输出不符合约定，没有生成候选：${reasons}`, [
      '再点一次生成（模型偶尔不遵守格式）',
      '如果连续两次如此，换一个更强的模型',
    ])
  }

  const replyText = result.draft.reply
  const guarded = guardOutput({
    reply: replyText,
    targetPostId,
    expectedTargetPostId: targetPostId,
    owner: { platform: MANUAL_PLATFORM, displayName: session.ownerName ?? session.imported.root.author },
    ...(dispute.opponent?.displayName === undefined
      ? {}
      : { opponentName: dispute.opponent.displayName }),
    posts: collectedPostsOf(collected),
    ownerPostIds: new Set(dispute.ownerStatements.map((statement) => statement.postId)),
    opponentPostIds: new Set(dispute.exchange.map((statement) => statement.postId)),
    conversationText: conversationTextsOf(collected),
    strictness:
      input.config.securityStrictness === 'strict' || input.config.securityStrictness === 'relaxed'
        ? input.config.securityStrictness
        : 'standard',
    semanticSettled: briefBuild.verdict.requiresReview === false,
  })

  const violations = result.violations.map((violation) => violation.message)
  let stored: StoredCandidate | undefined
  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((entry) => {
      if (entry.id !== session.id) return entry
      const candidate: StoredCandidate = {
        replyId: newCandidateId(entry.id, nextIndex(entry)),
        text: replyText,
        strategy: result.draft?.strategy ?? 'direct_rebuttal',
        targetPostId,
        targetSnapshot: resolved.snapshot,
        candidateVersion: nextVersion(entry),
        textHash: hashOf(replyText),
        confidence: result.draft?.confidence ?? 0,
        violations,
        notes: result.notes,
        security: toStorageRecord(guarded.assessment, guarded.fingerprint),
        createdAt: new Date().toISOString(),
        approved: false,
      }
      stored = candidate
      const entered = transition(entry.state, 'GENERATING')
      const desired = result.needsInput
        ? 'NEEDS_CONFIRMATION'
        : violations.length === 0 && replyText.length > 0
          ? 'REVIEWING'
          : 'REVIEWING'
      const moved = transition(entered.state, desired)
      return {
        ...entry,
        state: moved.ok ? moved.state : entered.state,
        statusText: result.needsInput
          ? `模型要求补充信息：${result.needsInputReason ?? ''}`
          : violations.length > 0
            ? `候选回复未通过检查：${violations.join('；')}`
            : '候选回复已生成，等待你确认',
        candidates: [...entry.candidates, candidate],
        selectedTargetPostId: targetPostId,
        updatedAt: new Date().toISOString(),
      }
    }),
  }))

  if (stored === undefined) {
    return failed('generate', '内部错误：候选没有写入会话。', ['刷新页面后重试'])
  }

  return succeeded('generate', {
    sessionId: session.id,
    candidateId: stored.replyId,
    text: stored.text,
    version: stored.candidateVersion,
    violations,
    notes: result.notes,
    securityDecision: guarded.assessment.decision,
    securityReasons: guarded.assessment.reasons,
    needsInput: result.needsInput,
    ...(result.needsInputReason === undefined ? {} : { needsInputReason: result.needsInputReason }),
  })
}

/** 与 `runtime.ts` 的 `postKindOf` 同一规则：只有嵌套回复才是 `nested`。 */
function postKindOf(collected: CollectedThread, postId: string): 'floor' | 'nested' {
  for (const entry of collected.floors) {
    if (entry.nested.some((reply) => reply.postId === postId)) return 'nested'
  }
  return 'floor'
}

/** 与 `runtime.ts` 的私有实现同一规则：取最大值 + 1。 */
function nextVersion(session: StoredSession): number {
  return session.candidates.reduce((max, candidate) => Math.max(max, candidate.candidateVersion), 0) + 1
}

/** 与 `runtime.ts` 同一规则：取已有 `-cN` 的最大 N + 1。 */
function nextIndex(session: StoredSession): number {
  let max = 0
  for (const candidate of session.candidates) {
    const match = candidate.replyId.match(/-c(\d+)$/)
    if (match === null) continue
    max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

function hashOf(text: string): string {
  // 与 `target.ts` 的 `contentHash` 同一算法：批准记录会跨两条路径比较同一个哈希，
  // 算法不同会让「编辑过的正文」在离线路径上看起来仍然是原样。
  return contentHash(text)
}

function collectedPostsOf(collected: CollectedThread): readonly ConversationPost[] {
  const out: ConversationPost[] = []
  for (const entry of collected.floors) {
    out.push({
      postId: entry.floor.postId,
      authorKey: entry.floor.authorId ?? entry.floor.authorName ?? '',
      text: entry.floor.content,
    })
    for (const reply of entry.nested) {
      out.push({
        postId: reply.postId,
        authorKey: reply.authorId ?? reply.authorName ?? '',
        text: reply.content,
      })
    }
  }
  return out
}

function conversationTextsOf(collected: CollectedThread): readonly string[] {
  const out: string[] = [collected.thread.title, collected.thread.content]
  for (const entry of collected.floors) {
    out.push(entry.floor.content)
    for (const reply of entry.nested) out.push(reply.content)
  }
  return out.filter((text) => text.trim() !== '')
}

// ---------------------------------------------------------------------------
// 复制
// ---------------------------------------------------------------------------

export interface ManualCopyInput {
  readonly sessionId: string
  readonly candidateId: string
  /** 用户看到的正文。必须与存下的一致，否则说明页面上的不是将要复制的东西。 */
  readonly visibleText?: string
}

/**
 * 复制之前的那一步。
 *
 * ## 为什么这也要走一次服务端
 *
 * 因为「复制」是这个流程的终点，而终点必须能回答三个问题：
 * 复制的是哪一份正文、它是回给谁的、它当时通过了什么评估。
 * 让页面自己从 state 里拼这三个答案，等于让页面去猜——而页面拿到的候选正文
 * 可能已经被编辑过（编辑会 bump 版本，但页面上的旧 state 不会自己刷新）。
 *
 * 所以复制前问一次服务端，由它给出**存下来的那一份**。正文与 `visibleText`
 * 不一致时拒绝：那不是同一段文字，复制出去会和用户看到的不同。
 */
export async function copyReply(
  store: DebateStore,
  input: ManualCopyInput,
): Promise<StepResult<CopyableReply>> {
  const session = store.getSession(input.sessionId)
  if (session === undefined) return failed('copy', `找不到会话 ${input.sessionId}`, ['刷新页面后重试'])
  if (session.imported === undefined) {
    return failed('copy', '这条会话不是人工导入的。', ['真实平台请用「发表」流程'])
  }

  const candidate = session.candidates.find((entry) => entry.replyId === input.candidateId)
  if (candidate === undefined) {
    return failed('copy', `这条会话里没有候选 ${input.candidateId}`, ['重新生成一次'])
  }
  if (candidate.text.trim() === '') {
    return failed('copy', '这段正文是空的，复制不出任何内容。', ['重新生成一次'])
  }
  if (input.visibleText !== undefined && input.visibleText !== candidate.text) {
    return failed(
      'copy',
      '页面上的正文与保存下来的不一致（可能刚被编辑过）。' +
        '为避免复制出你没看过的内容，请刷新后再复制。',
      ['刷新页面', '重新检查正文，再复制'],
    )
  }

  const collected = collectedFromStored(session.imported)
  const target = findTarget(collected, candidate.targetPostId)

  const assessment = candidate.security
  const blockers: string[] = []
  if (assessment === undefined) {
    blockers.push(
      '这段正文没有安全评估记录（可能是旧版本写入的候选）。' +
        '可以重新生成一次，让评估重新跑一遍。',
    )
  } else if (assessment.decision === 'block') {
    blockers.push(
      `安全评估判定为「阻止」：${assessment.reasons.join('；') || '未说明原因'}。` +
        '这段文字不应该贴到任何地方。',
    )
  }
  if (candidate.violations.length > 0) {
    blockers.push(`候选检查未通过：${candidate.violations.join('；')}`)
  }

  return succeeded('copy', {
    sessionId: session.id,
    candidateId: candidate.replyId,
    text: candidate.text,
    target: {
      ...(target?.author === undefined ? {} : { author: target.author }),
      excerpt: excerptOf(target?.text ?? ''),
      postId: candidate.targetPostId,
    },
    persona: personaNameOf(session.persona.style),
    // `review` 不是「不安全」，它是「需要你看过再决定」。所以只有 `block` 与
    // 未评估会阻止一键复制；`review` 允许复制，但 blockers 里会说明它为什么被标记。
    safe: assessment !== undefined && assessment.decision !== 'block' && candidate.violations.length === 0,
    blockers:
      assessment?.decision === 'review'
        ? [...blockers, `安全评估标记为「需人工确认」：${assessment.reasons.join('；')}`]
        : blockers,
  })
}

function findTarget(
  collected: CollectedThread,
  postId: string,
): { readonly author?: string; readonly text: string } | undefined {
  if (postId === collected.thread.id) {
    return {
      ...(collected.thread.authorName === undefined ? {} : { author: collected.thread.authorName }),
      text: collected.thread.content,
    }
  }
  for (const entry of collected.floors) {
    if (entry.floor.postId === postId) {
      return {
        ...(entry.floor.authorName === undefined ? {} : { author: entry.floor.authorName }),
        text: entry.floor.content,
      }
    }
    const nested = entry.nested.find((reply) => reply.postId === postId)
    if (nested !== undefined) {
      return {
        ...(nested.authorName === undefined ? {} : { author: nested.authorName }),
        text: nested.content,
      }
    }
  }
  return undefined
}

function personaNameOf(style: string): string {
  const known = (Object.keys(PERSONAS) as PersonaStyle[]).find((id) => id === style)
  return known === undefined ? style : PERSONAS[known].name
}

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

export interface ManualEditInput {
  readonly sessionId: string
  readonly candidateId: string
  readonly text: string
  readonly config: ResolvedConfig
}

/**
 * 编辑正文并重新评估。
 *
 * ## 为什么必须重新评估
 *
 * 评估记录绑定的是「这一版正文 + 这个目标」。改了正文却留着旧记录，
 * 就等于让复制环节声称「这段文字通过了评估」——通过的是另一段文字。
 *
 * `runtime.ts` 的 `editCandidate` 已经因为同样的理由在 v0.2.26 补上了重评估；
 * 这里做同一件事，理由相同。差别只有一处：主人身份只有昵称。
 */
export async function editImportedCandidate(
  store: DebateStore,
  input: ManualEditInput,
): Promise<StepResult<{ readonly candidateVersion: number; readonly textHash: string }>> {
  const trimmed = input.text.trim()
  if (trimmed === '') {
    return failed('edit', '正文不能是空的。', ['如果不想用这条，重新生成一次'])
  }
  const session = store.getSession(input.sessionId)
  if (session === undefined) return failed('edit', `找不到会话 ${input.sessionId}`, ['刷新页面后重试'])
  if (session.imported === undefined) return failed('edit', '这条会话不是人工导入的。', [])

  const candidate = session.candidates.find((entry) => entry.replyId === input.candidateId)
  if (candidate === undefined) {
    return failed('edit', `这条会话里没有候选 ${input.candidateId}`, ['重新生成一次'])
  }

  const collected = collectedFromStored(session.imported)
  const targetId = candidate.targetSnapshot?.targetPostId ?? candidate.targetPostId
  const guarded = guardOutput({
    reply: trimmed,
    targetPostId: targetId,
    expectedTargetPostId: targetId,
    owner: { platform: MANUAL_PLATFORM, displayName: session.ownerName ?? session.imported.root.author },
    ...(session.opponentName === undefined ? {} : { opponentName: session.opponentName }),
    posts: collectedPostsOf(collected),
    conversationText: conversationTextsOf(collected),
    strictness:
      input.config.securityStrictness === 'strict' || input.config.securityStrictness === 'relaxed'
        ? input.config.securityStrictness
        : 'standard',
    semanticSettled: candidate.security?.semanticSettled,
  })

  const version = nextVersion(session)
  const hash = contentHash(trimmed)

  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((entry) =>
      entry.id === session.id
        ? {
            ...entry,
            candidates: entry.candidates.map((row) =>
              row.replyId === input.candidateId
                ? {
                    ...row,
                    text: trimmed,
                    textHash: hash,
                    candidateVersion: version,
                    approved: false,
                    security: toStorageRecord(guarded.assessment, guarded.fingerprint),
                  }
                : row,
            ),
            updatedAt: new Date().toISOString(),
          }
        : entry,
    ),
  }))

  return succeeded('edit', { candidateVersion: version, textHash: hash })
}

// ---------------------------------------------------------------------------
// 人工确认
// ---------------------------------------------------------------------------

export interface ManualApproveInput {
  readonly sessionId: string
  readonly candidateId: string
  /** 用户点确认时看到的那一版正文。与存下的不一致时拒绝。 */
  readonly approvedText: string
}

/**
 * 人工确认。
 *
 * ## 这里的「确认」确认的是什么
 *
 * 不是「可以发表」——离线流程不发表。它确认的是：**这段正文就是我读过的、
 * 我要复制的那一段**。绑定的是正文的哈希与候选版本，与真实流程的批准记录同一语义。
 *
 * 记录写在会话的候选上，不新建批准台账：批准台账的用途是「一次授权一次发表」，
 * 而离线流程没有发表，往那里写会让台账声称一次并不存在的授权。
 */
export async function approveImportedCandidate(
  store: DebateStore,
  input: ManualApproveInput,
): Promise<StepResult<{ readonly approvedAt: string }>> {
  const session = store.getSession(input.sessionId)
  if (session === undefined) return failed('approve', `找不到会话 ${input.sessionId}`, ['刷新页面后重试'])
  if (session.imported === undefined) return failed('approve', '这条会话不是人工导入的。', [])

  const candidate = session.candidates.find((entry) => entry.replyId === input.candidateId)
  if (candidate === undefined) {
    return failed('approve', `这条会话里没有候选 ${input.candidateId}`, ['重新生成一次'])
  }
  if (candidate.text !== input.approvedText) {
    return failed(
      'approve',
      '你确认的正文与保存的不一致（可能刚被编辑过）。请刷新页面，确认后再点一次。',
      ['刷新页面', '重新读一遍正文'],
    )
  }
  if (candidate.security?.decision === 'block') {
    return failed(
      'approve',
      `安全评估判定为「阻止」，这段正文不能确认：${candidate.security.reasons.join('；')}`,
      ['换一种说法重新生成'],
    )
  }

  const approvedAt = new Date().toISOString()
  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((entry) =>
      entry.id === session.id
        ? {
            ...entry,
            candidates: entry.candidates.map((row) =>
              row.replyId === input.candidateId ? { ...row, approved: true } : row,
            ),
            updatedAt: approvedAt,
          }
        : entry,
    ),
  }))
  return succeeded('approve', { approvedAt })
}

/** 页面上要显示的能力表（人工导入固定那一份）。 */
export function manualCapabilityRows(): typeof MANUAL_CAPABILITIES {
  return MANUAL_CAPABILITIES
}

/** 页面上要显示的来源标识（人工导入固定那一份）。 */
export function manualSource(): typeof MANUAL_IMPORT {
  return MANUAL_IMPORT
}

/**
 * 会话当前处在哪一步。
 *
 * 从存下来的事实推导，不存一个 `step` 字段：存字段意味着它可以和候选、批准、
 * 编辑记录三者不一致，而页面会把那个陈旧的 step 当成事实渲染。
 * 这与 `workbench.ts` 的 `deriveWorkbenchState` 是同一条理由。
 */
export function stepOf(session: StoredSession | undefined): ManualStep {
  if (session === undefined) return 'import'
  if (session.imported === undefined) return 'import'
  if (session.candidates.length === 0) return 'generate'
  const latest = session.candidates[session.candidates.length - 1]!
  if (latest.security === undefined) return 'assess'
  if (latest.security.decision === 'block') return 'edit'
  if (!latest.approved) return 'approve'
  return 'copy'
}

/** 十一步里，前六步在会话存在之前就完成了；提供它们的完成标记。 */
export function completedSteps(session: StoredSession | undefined): readonly ManualStep[] {
  if (session === undefined) return []
  const step = stepOf(session)
  const order: readonly ManualStep[] = [
    'import',
    'preview',
    'confirm',
    'analyze',
    'select',
    'persona',
    'generate',
    'edit',
    'assess',
    'approve',
    'copy',
  ]
  const at = order.indexOf(step)
  return order.slice(0, at)
}
