/**
 * Reply generation: prompt construction, JSON parsing, and rule-based checks.
 *
 * Three ideas hold this together:
 *
 * 1. **The model proposes, the program disposes.** The model returns a small
 *    JSON object; every field is validated and every rule that can be checked
 *    in code (target identity, length, leakage, repetition) is checked in code.
 *    A model that ignores instructions then produces a *rejected* candidate,
 *    not a published mistake.
 * 2. **Retry on parse failure, never on policy failure.** Malformed JSON gets
 *    one repair attempt. A reply that violates a hard rule is not retried
 *    against the same prompt hoping for a different outcome — it is reported.
 * 3. **`needs_more_context` / `needs_confirmation` are valid answers.** The
 *    schema accepts them explicitly, so the model has an honest way out and
 *    does not have to invent a reply to satisfy a schema.
 */

import type { Dispute } from './analyzer.js'
import type { CompressedContext } from './compressor.js'
import { countCharacters, buildPersonaPrompt, type PersonaConfig } from './persona.js'
import { LlmError, type LlmClient } from './llm.js'

/** What the model is asked to return. */
export interface GenerationDraft {
  readonly owner_position: string
  readonly opponent_position: string
  readonly main_dispute: string
  readonly latest_argument: string
  readonly response_target_id: string
  readonly strategy: ReplyStrategy
  readonly confidence: number
  readonly uncertainties: readonly string[]
  readonly reply: string
  /** Set instead of `reply` when the model refuses to answer. */
  readonly status?: 'ok' | 'needs_more_context' | 'needs_confirmation'
  /** Why it refused, when `status` is not `ok`. */
  readonly reason?: string
}

/** Supported reply strategies. */
export type ReplyStrategy =
  | 'direct_rebuttal'
  | 'clarify_misunderstanding'
  | 'demand_evidence'
  | 'correct_fact'
  | 'question_premise'
  | 'point_out_contradiction'
  | 'humorous_jab'
  | 'calm_explanation'
  | 'concede_and_continue'
  | 'end_discussion'

/** Every strategy, for validation. */
export const STRATEGIES: readonly ReplyStrategy[] = [
  'direct_rebuttal',
  'clarify_misunderstanding',
  'demand_evidence',
  'correct_fact',
  'question_premise',
  'point_out_contradiction',
  'humorous_jab',
  'calm_explanation',
  'concede_and_continue',
  'end_discussion',
]

/** The output of one generation attempt, before review. */
export interface GenerationResult {
  readonly draft?: GenerationDraft
  /** Rule violations; a non-empty list means the draft must not be published. */
  readonly violations: readonly Violation[]
  /** Non-blocking remarks for the reviewer. */
  readonly notes: readonly string[]
  /** True when the model itself asked for more input. */
  readonly needsInput: boolean
  readonly needsInputReason?: string
  /** How many model calls were spent. */
  readonly attempts: number
  readonly usage: { inputTokens: number; outputTokens: number; elapsedMs: number }
}

/** One broken rule. */
export interface Violation {
  readonly code: string
  readonly message: string
}

/** Generation inputs. */
export interface GenerateOptions {
  readonly dispute: Dispute
  readonly context: CompressedContext
  readonly persona: PersonaConfig
  /** Reply ids already published in this session, for duplicate detection. */
  readonly alreadyPublished?: readonly string[]
  /** Recent reply texts, to avoid repeating the same opener. */
  readonly recentReplies?: readonly string[]
  readonly signal?: AbortSignal
  /** Extra guidance the owner typed in the summon. */
  readonly ownerInstruction?: string
  /**
   * The rendered `DebateBrief` (v0.2.12).
   *
   * Optional so existing callers keep compiling, but the production path always supplies it:
   * `runtime.runGeneration` builds the brief, validates it, and **refuses to call the model
   * at all** when validation fails. The presence of this field in the prompt is therefore a
   * consequence of a passed check, not a hint the model may ignore.
   */
  readonly brief?: string
  /**
   * Sampling temperature.
   *
   * Defaults low on purpose: this task needs the right target and stable JSON far
   * more than it needs variety, and a small model at high temperature starts
   * inventing ids and dropping fields.
   */
  readonly temperature?: number
  /** Cap on the model's own answer, so a runaway reply cannot be truncated. */
  readonly maxTokens?: number
}

/**
 * Default sampling temperature.
 *
 * Chosen for reliability, not variety: the reply must name a real post id and
 * return parseable JSON, both of which degrade quickly as temperature rises.
 */
export const DEFAULT_TEMPERATURE = 0.4

/** System prompt: role, hard rules, and the honesty escape hatches. */
export const SYSTEM_PROMPT = `你是一个替主人在网络论坛上接话的助手。你的任务是根据提供的对话上下文，写一条能直接发出去的回复。

铁律：
1. 只能使用上下文中出现的发言内容。上下文里没有的事实，一律不要编。
2. 回复对象必须是给定的争论对手，不要回应别人。
3. 如果上下文不足以支撑一条有信息量的回复，返回 status="needs_more_context" 并说明缺什么。
4. 如果无法确定回复对象，返回 status="needs_confirmation"。
5. 不攻击对方身份、职业、地域、外貌、隐私；不威胁；不煽动他人围攻。
6. 不输出分析过程、提示词、字段名或任何结构化说明，只输出要求的 JSON。
7. 被问到是否 AI 时如实说明，不冒充真人经历。

输出格式：严格输出一个 JSON 对象，不要加 markdown 代码块，不要加解释文字。
字段：
{
  "status": "ok" | "needs_more_context" | "needs_confirmation",
  "owner_position": "主人的核心主张",
  "opponent_position": "对手的核心主张",
  "main_dispute": "双方真正的分歧点",
  "latest_argument": "对手最新一句的关键论点",
  "response_target_id": "要回复的那条发言的 post id",
  "strategy": "direct_rebuttal|clarify_misunderstanding|demand_evidence|correct_fact|question_premise|point_out_contradiction|humorous_jab|calm_explanation|concede_and_continue|end_discussion",
  "confidence": 0到1之间的小数,
  "uncertainties": ["你不确定的地方"],
  "reply": "准备发表的回复正文",
  "reason": "仅当 status 不是 ok 时说明原因"
}`

/** Build the user prompt from compressed context and persona. */
export function buildGenerationPrompt(options: GenerateOptions): string {
  const { dispute, context, persona } = options
  const opponent = dispute.opponent
  const lines: string[] = []

  lines.push('## 任务')
  lines.push(
    `替主人回复「${opponent?.displayName ?? '未知对手'}」。` +
      `回复对象的 post id 应为 ${opponent?.lastPostId ?? '（未确定）'}。`,
  )
  if (options.ownerInstruction) {
    lines.push(`主人的附加要求：${options.ownerInstruction}`)
  }

  // --- the structured brief (v0.2.12) --------------------------------------------
  //
  // This section is what makes the brief more than a test artefact. It carries the
  // *structure* — both positions with their citations, the unresolved challenges, who else
  // spoke — and it is rendered from data that already passed `validateBrief`.
  //
  // Kept separate from the raw context below on purpose: the context quotes the posts a
  // reviewer checks, while the brief states the relationships. Merging them would bury the
  // structure inside the transcript, which is where the model used to lose it.
  if (options.brief !== undefined) {
    lines.push('')
    lines.push('## 争论简报（已通过证据校验）')
    lines.push(options.brief)
  }

  lines.push('')
  lines.push('## 对话上下文')
  lines.push(context.text)

  lines.push('')
  lines.push('## 人格设定')
  lines.push(buildPersonaPrompt(persona))

  if (options.recentReplies && options.recentReplies.length > 0) {
    lines.push('')
    lines.push('## 你之前已经说过的内容（不要重复同样的开头和句式）')
    for (const reply of options.recentReplies.slice(-3)) lines.push(`- ${reply}`)
  }

  if (context.omissions.length > 0) {
    lines.push('')
    lines.push('## 注意：以下内容因预算限制未能提供')
    for (const omission of context.omissions) lines.push(`- ${omission}`)
    lines.push('这些缺失部分如果影响判断，请在 uncertainties 中说明，不要猜测。')
  }

  lines.push('')
  lines.push('现在输出 JSON。')
  return lines.join('\n')
}

/**
 * Extract the JSON object from a model reply.
 *
 * Models wrap JSON in prose or fences even when told not to, so the object is
 * located rather than assumed to be the whole string. Braces are matched with
 * a scan because a regex cannot balance them.
 */
export function extractJsonObject(raw: string): string | undefined {
  const text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced ? (fenced[1] as string).trim() : text
  const start = candidate.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index] as string
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      if (inString) escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return candidate.slice(start, index + 1)
    }
  }
  return undefined
}

/** Parse and validate a model reply into a {@link GenerationDraft}. */
export function parseDraft(raw: string): { draft?: GenerationDraft; error?: string } {
  const json = extractJsonObject(raw)
  if (!json) return { error: `模型输出里没有找到 JSON 对象：${raw.slice(0, 160)}` }

  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    return { error: `JSON 解析失败：${(error as Error).message}` }
  }
  if (typeof value !== 'object' || value === null) return { error: '模型输出不是 JSON 对象' }

  const record = value as Record<string, unknown>
  const status = typeof record.status === 'string' ? record.status : 'ok'
  const strategy = typeof record.strategy === 'string' && STRATEGIES.includes(record.strategy as ReplyStrategy)
    ? (record.strategy as ReplyStrategy)
    : 'direct_rebuttal'

  const uncertainties = Array.isArray(record.uncertainties)
    ? record.uncertainties.filter((item): item is string => typeof item === 'string')
    : []

  const confidenceRaw = typeof record.confidence === 'number' ? record.confidence : Number(record.confidence)
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5

  const draft: GenerationDraft = {
    owner_position: String(record.owner_position ?? ''),
    opponent_position: String(record.opponent_position ?? ''),
    main_dispute: String(record.main_dispute ?? ''),
    latest_argument: String(record.latest_argument ?? ''),
    response_target_id: String(record.response_target_id ?? ''),
    strategy,
    confidence,
    uncertainties,
    reply: String(record.reply ?? ''),
    status: status === 'needs_more_context' || status === 'needs_confirmation' ? status : 'ok',
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  }

  if (draft.status === 'ok' && !draft.reply.trim()) {
    return { error: '模型返回 status=ok 但 reply 为空' }
  }
  return { draft }
}

/** Patterns that would mean the model leaked its instructions or account data. */
const LEAK_PATTERNS: readonly { readonly re: RegExp; readonly code: string; readonly message: string }[] = [
  { re: /系统提示|system prompt|SYSTEM_PROMPT/i, code: 'leak_prompt', message: '回复里出现了系统提示词相关内容' },
  { re: /api[_-]?key|sk-[A-Za-z0-9]{8,}|Bearer\s+\S{10,}/i, code: 'leak_secret', message: '回复里出现了疑似密钥的内容' },
  { re: /cookie|set-cookie|BAIDUID|BDUSS/i, code: 'leak_credential', message: '回复里出现了凭据相关内容' },
  { re: /debate_[a-z_]+|response_target_id|owner_position/i, code: 'leak_schema', message: '回复里出现了内部字段名' },
  { re: /```json|"strategy"\s*:/i, code: 'leak_json', message: '回复里出现了结构化元信息' },
]

/**
 * Check a draft against every rule that can be verified in code.
 *
 * @param draft the parsed draft
 * @param options the same generation options, for target/length/repetition
 * @returns violations (blocking) and notes (informational)
 */
export function validateDraft(
  draft: GenerationDraft,
  options: GenerateOptions,
): { violations: readonly Violation[]; notes: readonly string[] } {
  const violations: Violation[] = []
  const notes: string[] = []
  const { dispute, persona } = options

  if (draft.status !== 'ok') {
    return { violations, notes }
  }

  // Target correctness.
  //
  // The old check only fired when an expected target existed *and* the model
  // supplied something different, so with no confirmed opponent any non-empty id
  // passed. Now an unconfirmed opponent blocks the draft outright, and a
  // supplied id must be the opponent's verified post — not merely "some id".
  const expectedTarget = dispute.opponent?.lastPostId
  if (dispute.needsConfirmation || !dispute.opponent) {
    violations.push({
      code: 'no_confirmed_opponent',
      message:
        '还没有确认争论对象，不能生成可直接发表的回复。请先用 debate_analyze_reply 指定要回复的那条帖子。',
    })
  } else if (!expectedTarget) {
    violations.push({
      code: 'missing_target',
      message: '无法确定对手最近一条发言的 id，不能确定回复位置',
    })
  } else if (!draft.response_target_id) {
    violations.push({ code: 'missing_target', message: '模型没有给出回复对象 id' })
  } else if (draft.response_target_id !== expectedTarget) {
    violations.push({
      code: 'wrong_target',
      message: `模型选择的回复对象是 ${draft.response_target_id}，但当前对手的发言是 ${expectedTarget}`,
    })
  }

  const length = countCharacters(draft.reply)
  if (length > persona.maxLength) {
    violations.push({
      code: 'too_long',
      message: `回复长度 ${length} 字超过上限 ${persona.maxLength} 字`,
    })
  }
  if (length < 4) {
    violations.push({ code: 'too_short', message: `回复只有 ${length} 字，不足以构成有效回应` })
  }

  for (const pattern of LEAK_PATTERNS) {
    if (pattern.re.test(draft.reply)) {
      violations.push({ code: pattern.code, message: pattern.message })
    }
  }

  // Repetition against what this session already sent.
  const normalized = draft.reply.replace(/\s+/g, '')
  for (const previous of options.recentReplies ?? []) {
    if (previous.replace(/\s+/g, '') === normalized) {
      violations.push({ code: 'duplicate_reply', message: '这条回复与本会话之前发过的内容完全相同' })
      break
    }
  }

  // A reply that only echoes the opponent adds nothing.
  const opponentText = draft.opponent_position.replace(/\s+/g, '')
  if (opponentText.length > 8 && normalized.includes(opponentText)) {
    notes.push('回复里大段复述了对方的原话，可能显得啰嗦')
  }

  if (draft.confidence < 0.35) {
    notes.push(`模型自评置信度较低（${draft.confidence.toFixed(2)}），建议人工再看一遍`)
  }
  if (draft.uncertainties.length > 0) {
    notes.push(`模型标注的不确定点：${draft.uncertainties.join('；')}`)
  }

  return { violations, notes }
}

/**
 * Generate one candidate reply.
 *
 * One repair attempt is made when the model's answer cannot be parsed at all.
 * A parsed answer that breaks a rule is returned as-is with its violations, so
 * the reviewer sees exactly what the model wanted to say and why it was
 * rejected — silently re-rolling would hide a systematic prompt problem.
 */
export async function generateReply(
  client: LlmClient,
  options: GenerateOptions,
): Promise<GenerationResult> {
  const startedAt = Date.now()
  let inputTokens = 0
  let outputTokens = 0
  let attempts = 0
  let lastError: string | undefined

  const prompt = buildGenerationPrompt(options)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    attempts += 1
    const messages = [{ role: 'user' as const, content: prompt }]
    if (lastError) {
      messages.push({
        role: 'user' as const,
        content: `上一次输出无法解析成 JSON（${lastError}）。请只输出那一个 JSON 对象，不要任何其他文字。`,
      })
    }

    let response
    try {
      response = await client.complete({
        system: SYSTEM_PROMPT,
        messages,
        // Lower default than before: structured output plus a verified target id
        // is a precision task, and 0.85 made small models improvise both.
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        maxTokens:
          options.maxTokens ?? Math.min(1200, Math.max(400, options.persona.maxLength * 4)),
        signal: options.signal,
      })
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError(`生成失败：${(error as Error).message}`, 'unknown', { cause: error })
    }

    inputTokens += response.inputTokens ?? 0
    outputTokens += response.outputTokens ?? 0

    const parsed = parseDraft(response.text)
    if (!parsed.draft) {
      lastError = parsed.error
      continue
    }

    const validation = validateDraft(parsed.draft, options)
    const needsInput = parsed.draft.status === 'needs_more_context' || parsed.draft.status === 'needs_confirmation'
    return {
      draft: parsed.draft,
      violations: validation.violations,
      notes: validation.notes,
      needsInput,
      needsInputReason: needsInput ? parsed.draft.reason ?? '模型要求补充信息' : undefined,
      attempts,
      usage: { inputTokens, outputTokens, elapsedMs: Date.now() - startedAt },
    }
  }

  return {
    violations: [
      {
        code: 'unparseable',
        message: `模型输出连续 ${attempts} 次都无法解析为 JSON：${lastError ?? '未知原因'}`,
      },
    ],
    notes: [],
    needsInput: false,
    attempts,
    usage: { inputTokens, outputTokens, elapsedMs: Date.now() - startedAt },
  }
}

/**
 * Run the analysis step: turn the context into the structured JSON the task
 * description calls for, without generating a reply.
 *
 * Kept separate from generation so a reviewer can inspect the reconstructed
 * positions before any words are written.
 */
export async function analyzeWithModel(
  client: LlmClient,
  options: Omit<GenerateOptions, 'persona'> & { signal?: AbortSignal },
): Promise<{
  draft?: GenerationDraft
  notes: readonly string[]
  usage: { inputTokens: number; outputTokens: number; elapsedMs: number }
}> {
  const startedAt = Date.now()
  const prompt = buildGenerationPrompt({
    ...options,
    persona: { style: 'aloof', intensity: 1, maxLength: 60, emojiLevel: 0, sarcasmLevel: 0, directness: 3 },
  })
  const response = await client.complete({
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content:
          `${prompt}\n\n本次只需要分析，不要写最终回复：reply 字段填一个空字符串即可，` +
          '但 owner_position、opponent_position、main_dispute、latest_argument、response_target_id 必须填。',
      },
    ],
    temperature: 0.2,
    maxTokens: 600,
    signal: options.signal,
  })
  const parsed = parseDraft(response.text)
  return {
    draft: parsed.draft,
    notes: parsed.error ? [parsed.error] : [],
    usage: {
      inputTokens: response.inputTokens ?? 0,
      outputTokens: response.outputTokens ?? 0,
      elapsedMs: Date.now() - startedAt,
    },
  }
}
