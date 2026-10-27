/**
 * Context compression under an explicit token budget.
 *
 * The constraint that shapes this module: a small model gets ~2000 tokens for
 * the whole task, so "paste the thread" is not an option and neither is a
 * summarizer that drops the one line that matters. Instead every piece of
 * context has a **priority**, the budget is spent top-down, and each item is
 * either included whole or replaced by a marked truncation — never silently
 * dropped, so the generator can say "I don't have that" instead of inventing it.
 */

import type { Dispute, Statement } from './analyzer.js'
import type { CollectedThread, TimelineEntry } from './collector.js'
import { buildTimeline } from './collector.js'
import type { PersonaConfig } from './persona.js'

/**
 * Rough token accounting for mixed Chinese/ASCII text.
 *
 * Chinese characters cost roughly one token each in modern tokenizers while
 * ASCII costs about a quarter; over-estimating is the safe direction, because
 * exceeding the window fails the whole call while under-using it merely wastes
 * headroom.
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    tokens += char.codePointAt(0)! > 0x2e80 ? 1 : 0.3
  }
  return Math.ceil(tokens)
}

/** Names of the context slots, highest priority first. */
export type ContextSlot =
  | 'trigger'
  | 'opponentLatest'
  | 'disputeChain'
  | 'ownerClaims'
  | 'threadMeta'
  | 'background'

/** One assembled piece of prompt context. */
export interface ContextChunk {
  readonly slot: ContextSlot
  readonly label: string
  readonly text: string
  readonly tokens: number
}

/** The compressed context plus a full account of what was cut. */
export interface CompressedContext {
  readonly chunks: readonly ContextChunk[]
  /** Rendered prompt text. */
  readonly text: string
  /** Tokens the quoted context actually uses. */
  readonly tokens: number
  /** The slice of the total budget available to the quoted context. */
  readonly budget: number
  /** The whole request's budget, including fixed costs. */
  readonly totalBudget: number
  /** What the request costs outside the quoted context. */
  readonly fixedCosts: FixedCosts
  /** Slots that were dropped or shortened, with the reason. */
  readonly omissions: readonly string[]
}

/** A token budget preset. */
export interface ContextBudget {
  /**
   * Total tokens for the **whole request**, not just the quoted thread.
   *
   * The old accounting counted only the compressed thread text, so a "2000 token"
   * context really meant 2000 + the system prompt + the persona + the reply +
   * the JSON scaffolding — which is how a small model blows its window while the
   * report says "736/2000".
   */
  readonly tokens: number
  /** Max characters quoted from any single statement. */
  readonly quoteLimit: number
}

/** Preset budgets for common model sizes. */
export const BUDGET_PRESETS: Readonly<Record<'small' | 'medium' | 'large', ContextBudget>> = {
  small: { tokens: 2000, quoteLimit: 200 },
  medium: { tokens: 4000, quoteLimit: 400 },
  large: { tokens: 8000, quoteLimit: 800 },
}

/**
 * Tokens the request spends outside the quoted context.
 *
 * These are measured, not guessed: the generator builds its system prompt from
 * constants, the persona block from the configured parameters, and asks for a
 * fixed-shape JSON object, so their cost is stable enough to reserve up front.
 */
export interface FixedCosts {
  /** The generator's system prompt. */
  readonly systemPrompt: number
  /** Persona instructions embedded in the user message. */
  readonly persona: number
  /** The structural wrapper around the quoted context. */
  readonly scaffold: number
  /** The model's own answer, reserved so it is not truncated. */
  readonly reply: number
}

/**
 * Fixed-cost defaults, matching what the generator actually sends.
 *
 * `systemPrompt` is measured from `SYSTEM_PROMPT` by a test, which fails if the
 * prompt grows past this reservation. Keep them in step rather than guessing.
 */
export const FIXED_COSTS: FixedCosts = {
  systemPrompt: 560,
  persona: 200,
  scaffold: 140,
  reply: 340,
}

/** Sum of the non-context costs. */
export function fixedCostTotal(costs: FixedCosts = FIXED_COSTS): number {
  return costs.systemPrompt + costs.persona + costs.scaffold + costs.reply
}

/** The token split for one request. */
export interface BudgetBreakdown {
  /** Tokens available for quoted context after fixed costs. */
  readonly contextTokens: number
  readonly fixed: FixedCosts
  readonly total: number
}

/**
 * Split a total budget into "what the thread may use" and "what the request
 * always costs", so the reported usage describes the real request.
 *
 * If the fixed costs alone exceed the total, context gets a floor rather than a
 * negative number: the call will still be attempted, but the report says the
 * budget is too small for this model.
 */
export function splitBudget(tokens: number, costs: FixedCosts = FIXED_COSTS): BudgetBreakdown {
  const fixed = fixedCostTotal(costs)
  return {
    contextTokens: Math.max(120, tokens - fixed),
    fixed: costs,
    total: tokens,
  }
}

/** Resolve a preset name or an explicit token count. */
export function resolveBudget(input: {
  preset?: 'small' | 'medium' | 'large'
  tokens?: number
  quoteLimit?: number
}): ContextBudget {
  const base = BUDGET_PRESETS[input.preset ?? 'small']
  const tokens =
    typeof input.tokens === 'number' && Number.isFinite(input.tokens) && input.tokens > 0
      ? Math.min(200_000, Math.round(input.tokens))
      : base.tokens
  const quoteLimit =
    typeof input.quoteLimit === 'number' && input.quoteLimit > 0
      ? Math.min(4000, Math.round(input.quoteLimit))
      : base.quoteLimit
  return { tokens, quoteLimit }
}

/** Truncate text to a character limit with a visible marker. */
export function clampText(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(1, limit - 1))}…`
}

/** Render one statement as an attributed line. */
function renderStatement(statement: Statement, quoteLimit: number): string {
  const speaker = statement.authorName ?? statement.authorKey
  const target = statement.replyToName ? ` → ${statement.replyToName}` : ''
  return `[${statement.floorNumber}楼 ${statement.postId}] ${speaker}${target}：${clampText(statement.content, quoteLimit)}`
}

/** Render one timeline entry as an attributed line. */
function renderEntry(entry: TimelineEntry, quoteLimit: number): string {
  const speaker = entry.authorName ?? entry.authorId ?? '未知'
  const target = entry.replyToName ? ` → ${entry.replyToName}` : ''
  const where = entry.kind === 'floor' ? `${entry.floorNumber}楼` : `${entry.floorNumber}楼楼中楼`
  return `[${where} ${entry.postId}] ${speaker}${target}：${clampText(entry.content, quoteLimit)}`
}

/**
 * Assemble context for one reply under a hard budget.
 *
 * Priority order is fixed and deliberate: the trigger and the opponent's latest
 * line are what the reply must answer, so they are never the ones cut. Thread
 * background is the cheapest to lose and goes last.
 *
 * @param input dispute, collection, personas and budget
 * @returns chunks in priority order plus a list of what was omitted
 */
export function compressContext(input: {
  collected: CollectedThread
  dispute: Dispute
  trigger: { postId: string; content?: string }
  persona: PersonaConfig
  budget: ContextBudget
  /** The whole request's budget, when the caller already split it. */
  totalTokens?: number
  /** Extra instruction the owner typed when summoning. */
  ownerInstruction?: string
}): CompressedContext {
  const { collected, dispute, trigger, budget } = input
  const { quoteLimit } = budget
  const omissions: string[] = []
  const candidates: { slot: ContextSlot; label: string; text: string }[] = []

  // 1. The trigger itself: the owner's summon, with any extra instruction.
  const triggerEntry = buildTimeline(collected).find((entry) => entry.postId === trigger.postId)
  const triggerText = trigger.content ?? triggerEntry?.content ?? ''
  candidates.push({
    slot: 'trigger',
    label: '主人召唤这条回复',
    text: `[召唤 ${trigger.postId}] ${clampText(triggerText, quoteLimit * 2)}` +
      (input.ownerInstruction ? `\n主人的附加要求：${clampText(input.ownerInstruction, quoteLimit)}` : ''),
  })

  // 2. The opponent's latest line — the thing being answered.
  const opponentLatest = [...dispute.exchange]
    .reverse()
    .find((statement) => statement.authorKey === dispute.opponent?.key)
  if (opponentLatest) {
    candidates.push({
      slot: 'opponentLatest',
      label: '对手最新发言',
      text: renderStatement(opponentLatest, quoteLimit * 2),
    })
  } else {
    omissions.push('没有定位到对手的最新发言，生成时只能依据主人自己的表述')
  }

  // 3. The direct dispute chain, oldest first, excluding what slot 2 covered.
  const chainLines = dispute.exchange
    .filter((statement) => statement.postId !== opponentLatest?.postId)
    .map((statement) => renderStatement(statement, quoteLimit))
  if (chainLines.length > 0) {
    candidates.push({
      slot: 'disputeChain',
      label: '争论往来经过',
      text: chainLines.join('\n'),
    })
  } else {
    omissions.push('本次争论没有形成往返对话，只能依据单条发言')
  }

  // 4. The owner's earlier claims across the thread, not just this floor.
  const otherClaims = dispute.ownerStatements
    .filter((statement) => !dispute.exchange.some((entry) => entry.postId === statement.postId))
    .map((statement) => renderStatement(statement, quoteLimit))
  if (otherClaims.length > 0) {
    candidates.push({
      slot: 'ownerClaims',
      label: '主人在本帖的其他相关发言',
      text: otherClaims.join('\n'),
    })
  }

  // 5. Thread metadata: enough to know where the argument sits.
  const threadLines = [
    `帖子标题：${collected.thread.title || '（该帖没有标题）'}`,
    `所在贴吧：${collected.thread.forum.name}`,
    `楼主：${collected.thread.authorName ?? '未知'}（${collected.thread.authorId ?? '无 id'}）`,
    `争论位置：第 ${dispute.floorNumber} 楼`,
    collected.thread.content
      ? `主帖开头：${clampText(collected.thread.content, quoteLimit)}`
      : '主帖正文：空',
  ]
  candidates.push({ slot: 'threadMeta', label: '帖子背景', text: threadLines.join('\n') })

  // 6. Everything else that might matter, cheapest to lose.
  const used = new Set<string>([
    trigger.postId,
    ...dispute.exchange.map((statement) => statement.postId),
    ...dispute.ownerStatements.map((statement) => statement.postId),
  ])
  const background = buildTimeline(collected)
    .filter((entry) => !used.has(entry.postId))
    .filter((entry) => entry.content.length > 0)
    .slice(-12)
    .map((entry) => renderEntry(entry, Math.max(60, Math.floor(quoteLimit / 3))))
  if (background.length > 0) {
    candidates.push({
      slot: 'background',
      label: '其他参与者发言（可能不相关）',
      text: background.join('\n'),
    })
  }

  // Spend the budget in priority order.
  //
  // The budget handed in is the *context* share: the caller has already removed
  // the system prompt, persona, scaffolding and reply reservation, so what is
  // reported here plus the fixed costs is the real request size.
  const chunks: ContextChunk[] = []
  let spent = 0
  for (const candidate of candidates) {
    const cost = estimateTokens(`${candidate.label}\n${candidate.text}`)
    if (spent + cost <= budget.tokens) {
      chunks.push({ ...candidate, tokens: cost })
      spent += cost
      continue
    }
    // Try a shortened version before giving up the slot entirely.
    const remaining = budget.tokens - spent
    if (remaining < 120) {
      omissions.push(`「${candidate.label}」因预算不足被整体略去`)
      continue
    }
    const affordableChars = Math.max(80, Math.floor(remaining * 2.4))
    const shortened = clampText(candidate.text, affordableChars)
    const shortenedCost = estimateTokens(`${candidate.label}\n${shortened}`)
    if (shortenedCost <= remaining) {
      chunks.push({ ...candidate, text: shortened, tokens: shortenedCost })
      spent += shortenedCost
      omissions.push(`「${candidate.label}」被压缩到 ${affordableChars} 字符以适配预算`)
    } else {
      omissions.push(`「${candidate.label}」因预算不足被整体略去`)
    }
  }

  const breakdown = splitBudget(input.totalTokens ?? budget.tokens + fixedCostTotal())
  return {
    chunks,
    text: chunks.map((chunk) => `## ${chunk.label}\n${chunk.text}`).join('\n\n'),
    tokens: spent,
    budget: budget.tokens,
    totalBudget: breakdown.total,
    fixedCosts: breakdown.fixed,
    omissions,
  }
}
