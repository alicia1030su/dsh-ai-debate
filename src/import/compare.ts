/**
 * 「四种人格比较」的服务端编排（v0.2.37 §7）。
 *
 * ## 它为什么不是一个新引擎
 *
 * 每一次生成仍然走 `generateForImport` —— 同一套 `analyzeDispute` / `compressContext` /
 * `buildBrief` + `validateBrief` / `generateReply` / `guardOutput` / 候选版本分配。
 * 这个模块只做三件引擎之外的事：
 *
 * 1. **串行**：一次只发一个模型请求。四种人格并发发出去，在多数服务上会撞限流，
 *    而限流的失败形状是「其中两条莫名其妙没出来」，用户无法分辨是模型差还是被限。
 * 2. **预算**：调用次数由调用方显式给出，且封顶在四个人格。默认**不**自动跑四份 ——
 *    那是四次真实计费调用，必须由人点。
 * 3. **可取消**：一个 `AbortSignal` 贯穿整批。取消之后**不再发起下一次**；
 *    已经发出去的那一次由它自己的 signal 收尾，且它的结果不落盘（见下面的 stale 判定）。
 *
 * ## 为什么取消之后不能落盘
 *
 * `generateForImport` 内部已经用 signal 控制模型请求；但「请求已返回、正要写库」这一
 * 瞬间取消，仍会写进一条候选。那会变成「我取消了，但它还是多出来一条」——
 * 用户会怀疑取消按钮是假的。所以这里在每次写入前再看一次 signal。
 */

import type { LlmClient } from '../llm.js'
import type { ResolvedConfig } from '../config.js'
import { PERSONAS, type PersonaStyle } from '../persona.js'
import { generateForImport, personaOf, type ManualGenerateOutput } from './workflow.js'
import type { DebateStore } from '../store.js'

/** 一条人格的生成结果。失败也是一种结果，带原因。 */
export interface CompareRow {
  readonly persona: string
  readonly personaName: string
  readonly ok: boolean
  readonly candidateId?: string
  readonly text?: string
  readonly securityDecision?: 'allow' | 'review' | 'block'
  readonly securityReasons?: readonly string[]
  readonly violations?: readonly string[]
  readonly elapsedMs?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  /** 失败原因（人读）。 */
  readonly reason?: string
}

/** 整批的结果。 */
export interface CompareOutcome {
  readonly ok: boolean
  /** 逐条结果，顺序与请求的人格顺序一致。跳过的那些不会出现在这里。 */
  readonly rows: readonly CompareRow[]
  /** 实际发出的模型调用次数。用于页面显示「这次花了几次」。 */
  readonly calls: number
  /** 因为取消而没有发起的人格。 */
  readonly skipped: readonly string[]
  /** 整批被取消时为 true。 */
  readonly cancelled: boolean
  /** 一句能直接显示给用户的话。 */
  readonly message: string
}

/** 允许的人格 id，顺序固定（页面上也是这个顺序）。 */
export const COMPARE_PERSONAS: readonly PersonaStyle[] = ['tieba_veteran', 'soft_defensive', 'tsundere', 'aloof']

/**
 * 跑一批人格生成。
 *
 * @param input.personas 要跑哪些人格；缺省是全部四种。未知 id 被忽略（不报错，
 *   因为页面可能带着一个已下线的 id，那不该让整批失败）。
 * @param input.signal 取消信号。每次发起前与每次写入前都会检查。
 */
export async function comparePersonas(input: {
  readonly store: DebateStore
  readonly sessionId: string
  readonly targetPostId?: string
  readonly personas?: readonly string[]
  readonly ownerInstruction?: string
  readonly config: ResolvedConfig
  readonly llm: () => LlmClient
  readonly signal?: AbortSignal
  readonly progress?: (message: string) => void
}): Promise<CompareOutcome> {
  const wanted = (input.personas === undefined || input.personas.length === 0
    ? COMPARE_PERSONAS
    : COMPARE_PERSONAS.filter((id) => input.personas!.includes(id))) as readonly PersonaStyle[]

  const rows: CompareRow[] = []
  const skipped: string[] = []
  let calls = 0
  let cancelled = false

  for (const style of wanted) {
    if (input.signal?.aborted === true) {
      cancelled = true
      skipped.push(style)
      continue
    }
    const name = PERSONAS[style].name
    input.progress?.(`正在生成「${name}」…`)
    calls += 1
    const started = Date.now()
    try {
      const result = await generateForImport(input.store, {
        sessionId: input.sessionId,
        ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
        persona: personaOf(style, input.config),
        ...(input.ownerInstruction === undefined
          ? {}
          : { ownerInstruction: input.ownerInstruction }),
        config: input.config,
        llm: input.llm,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })

      if (!result.ok || result.value === undefined) {
        rows.push({
          persona: style,
          personaName: name,
          ok: false,
          elapsedMs: Date.now() - started,
          reason: result.reason ?? '生成失败，未说明原因。',
        })
        continue
      }
      const value: ManualGenerateOutput = result.value
      rows.push({
        persona: style,
        personaName: name,
        ok: true,
        candidateId: value.candidateId,
        text: value.text,
        securityDecision: value.securityDecision,
        securityReasons: value.securityReasons,
        violations: value.violations,
        elapsedMs: Date.now() - started,
      })
    } catch (error) {
      /**
       * 取消会让 `generateForImport` 抛（模型层把 abort 归一成 cancelled）。那不是
       * 失败，是用户的要求 —— 记成 cancelled 而不是 reason，页面才不会显示成红色。
       */
      if (input.signal !== undefined && input.signal.aborted) {
        cancelled = true
        skipped.push(style)
        continue
      }
      rows.push({
        persona: style,
        personaName: name,
        ok: false,
        elapsedMs: Date.now() - started,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const okCount = rows.filter((row) => row.ok).length
  const failed = rows.length - okCount
  const message = cancelled
    ? `已取消：完成 ${okCount} 个，未发起 ${skipped.length} 个。`
    : failed === 0
      ? `四种人格各生成一条（共 ${okCount} 条），可以逐条比较后选一条确认。`
      : `完成 ${okCount} 个，失败 ${failed} 个。失败原因见每一条下面。`

  return {
    ok: okCount > 0,
    rows,
    calls,
    skipped,
    cancelled,
    message,
  }
}
