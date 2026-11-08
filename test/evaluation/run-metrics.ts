/**
 * Run the whole corpus against a scripted model, on a chosen build, and record ten metrics.
 *
 * ## Two entry points, one scorer
 *
 * `runScripted` answers with the reply each case already carries, which is how the *pipeline*
 * is measured: same corpus, same fixtures, same scorer, only the build under test changes.
 * `runReal` sends the real prompt to a real endpoint and scores whatever comes back.
 *
 * They share `scoreReply`, so a drop between the two is a drop in the model, not in the
 * measurement.
 *
 * ## Why the scripted run is not "fake success"
 *
 * The scripted reply is not a golden answer and is never compared to one. What it exercises
 * is everything except the model: target resolution, the analyzer, the brief and its
 * citations, the guards, persona selection. A build that regresses any of those shows up
 * here; a build that merely generates less elegant prose does not. The report says which
 * mode produced it, and the two are never mixed into one table.
 */

import { readFileSync } from 'node:fs'

import { analyzeDispute, type OwnerIdentity } from '../../lib/analyzer.js'
import { buildBrief } from '../../lib/brief-builder.js'
import { renderBrief } from '../../lib/brief.js'
import { compressContext, resolveBudget, splitBudget } from '../../lib/compressor.js'
import { generateReply } from '../../lib/generator.js'
import type { LlmClient, LlmResponse } from '../../lib/llm.js'
import { resolvePersona, type PersonaConfig, type PersonaStyle } from '../../lib/persona.js'
import { ALL_CASES } from './index.ts'
import type { EvalCase } from './corpus.ts'
import { caseThread } from './evaluate-deterministic.ts'
import { scoreReply, type CaseResult, type RunRecord, type ScoreInput } from './metrics.ts'

/** Which version's records this is. Written into the report, not read from it. */
export function pluginVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { version?: unknown }).version === 'string') {
      return (parsed as { version: string }).version
    }
  } catch {
    // A missing manifest must not stop a measurement; it only stops the label.
  }
  return 'unknown'
}

/** Which persona a case is scored under. Absent means the default. */
function personaOf(c: EvalCase): PersonaConfig {
  const style: PersonaStyle = 'tieba_veteran'
  return resolvePersona({ style, maxLength: 150 })
}

/** The owner identity the case implies, by the same rule the deterministic channel uses. */
function ownerOf(c: EvalCase): OwnerIdentity {
  const ownerPost =
    c.body?.role === 'owner'
      ? c.body
      : c.floors.flatMap((f) => [f.author, ...f.nested]).find((p) => p.role === 'owner')
  if (ownerPost?.numericUid !== undefined) {
    return { userId: ownerPost.numericUid, ...(c.platform === undefined ? {} : { platform: c.platform }) }
  }
  if (ownerPost?.handle !== undefined) return { userId: ownerPost.handle }
  return { userId: 'owner_un' }
}

/** A client that answers every request with the case's scripted reply. */
class CaseClient implements LlmClient {
  readonly label = 'scripted-case'
  /**
   * 不用「参数属性」写法（`constructor(private readonly x: T)`）。
   *
   * Node 的类型剥离模式不支持它，而 `scripts/eval-compare.mjs` 会用动态 import 加载
   * 这个文件去做对比 —— 那条路径上不会走完整的 transform。显式赋值少一行糖，
   * 换来的是「两种加载方式都能跑」。
   */
  private readonly build: (request: {
    system?: string
    messages: readonly { role: string; content: string }[]
  }) => LlmResponse
  constructor(build: (request: {
    system?: string
    messages: readonly { role: string; content: string }[]
  }) => LlmResponse) {
    this.build = build
  }
  async complete(request: Parameters<LlmClient['complete']>[0]): Promise<LlmResponse> {
    return this.build(request)
  }
}

/** Everything one case's run produced, beyond the reply itself. */
interface CaseRun {
  readonly reply?: string
  readonly error?: string
  readonly targetPostId?: string
  readonly ownerPosition?: string
  readonly structure: { arguments: number; unanswered: number; contradictions: number }
  readonly contextText: string
  readonly missingContext: boolean
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly elapsedMs?: number
}

/** Run one case through the real pipeline with a supplied model. */
async function runCase(c: EvalCase, clientFactory: (c: EvalCase) => LlmClient): Promise<CaseRun> {
  const collected = caseThread(c)
  const persona = personaOf(c)
  try {
    const dispute = analyzeDispute(collected, ownerOf(c), { postId: c.pickedPostId })
    const total = resolveBudget({ preset: 'medium' })
    const split = splitBudget(total.tokens)
    const context = compressContext({
      collected,
      dispute,
      trigger: { postId: c.pickedPostId },
      persona,
      budget: { tokens: split.contextTokens, quoteLimit: total.quoteLimit },
      totalTokens: total.tokens,
    })
    const built = buildBrief({
      collected,
      dispute,
      platform: c.platform ?? 'tieba',
      threadId: collected.thread.id,
      targetPostId: c.pickedPostId,
    })
    const target = c.pickedPostId
    const result = await generateReply(clientFactory(c), {
      dispute,
      context,
      persona,
      expectedTargetPostId: target,
      brief: renderBrief(built.brief),
      briefFacts: {
        opponentArgumentCount: built.brief.opponentArguments?.length ?? 0,
        unansweredByOpponent: built.brief.unansweredByOpponent?.length ?? 0,
        answeredByOwner: (built.brief.answeredByOwner ?? []).map((item) => item.quote),
        thirdPartyCitationCount: built.brief.thirdPartyCitations?.length ?? 0,
        missingContextCount: built.brief.missingContext?.length ?? 0,
      },
      ...(c.ownerInstruction === undefined ? {} : { ownerInstruction: c.ownerInstruction }),
    })
    return {
      ...(result.draft === undefined ? { error: result.violations.map((v) => v.message).join('；') } : { reply: result.draft.reply }),
      targetPostId: result.draft?.response_target_id,
      ownerPosition: built.brief.owner.summary,
      structure: {
        arguments: built.brief.opponentArguments?.length ?? 0,
        unanswered: built.brief.unansweredByOpponent?.length ?? 0,
        contradictions: built.brief.contradictions?.length ?? 0,
      },
      contextText: context.text,
      /**
       * 只认**夹具自身声明**的读取不完整，不认管线报出的「缺了什么」。
       *
       * 这是一个容易被忽略的可比性问题：v0.2.35 简报会额外报告「对手按昵称匹配」这类
       * 缺失，若把管线报告的条数当作输入，同一个案例在两个版本下的输入就不同了 ——
       * 得分差异里混进了「这一版更爱报告缺失」，而不是回复变差。夹具的 `complete`
       * 是案例自己的属性，两个版本读到的是同一个值。
       */
      missingContext: !collected.complete,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      elapsedMs: result.usage.elapsedMs,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      structure: { arguments: 0, unanswered: 0, contradictions: 0 },
      contextText: '',
      missingContext: false,
    }
  }
}

/** Score a completed case run. */
function scoreCase(c: EvalCase, run: CaseRun): CaseResult {
  const reply = run.reply ?? ''
  const input: ScoreInput = {
    caseId: c.id,
    reply,
    ...(run.targetPostId === undefined ? {} : { targetPostId: run.targetPostId }),
    expectedTargetPostId: c.pickedPostId,
    ...(run.ownerPosition === undefined ? {} : { ownerPosition: run.ownerPosition }),
    contextText: run.contextText,
    threadText: c.floors.map((f) => [f.author.content, ...f.nested.map((n) => n.content)].join('\n')).join('\n'),
    structure: run.structure,
    missingContext: run.missingContext,
    persona: 'tieba_veteran',
    ...(c.expectation.expectsRefusal === true ? { refusalCase: true } : {}),
  }
  return {
    caseId: c.id,
    persona: 'tieba_veteran',
    reply,
    scores: scoreReply(input),
    ...(run.inputTokens === undefined ? {} : { inputTokens: run.inputTokens }),
    ...(run.outputTokens === undefined ? {} : { outputTokens: run.outputTokens }),
    ...(run.elapsedMs === undefined ? {} : { elapsedMs: run.elapsedMs }),
  }
}

/**
 * Run the corpus with the case's own scripted reply.
 *
 * The scripted answer is wrapped in the JSON contract by the client, because the case
 * carries prose and the generator needs the envelope — the same division the deterministic
 * channel makes, for the same reason: a case author writes the sentence they mean.
 */
export async function runScripted(cases: readonly EvalCase[] = ALL_CASES): Promise<RunRecord> {
  const results: CaseResult[] = []
  for (const c of cases) {
    const prose = c.scriptedReply ?? '你只看了第一年。分摊到三年也没有改变要先垫钱这件事。'
    const client = new CaseClient((request) => {
      const target = c.pickedPostId
      const prompt = request.messages.map((m) => m.content).join('\n')
      const quoted = /回复对象的 post id 应为 ([^\s。]+)/.exec(prompt)?.[1] ?? target
      return {
        text: JSON.stringify({
          status: 'ok',
          owner_position: '成本会翻倍',
          opponent_position: '成本可以分摊',
          main_dispute: '成本是否可以分摊',
          latest_argument: '你只看了第一年',
          response_target_id: quoted,
          strategy: 'direct_rebuttal',
          confidence: 0.7,
          uncertainties: [],
          reply: prose,
        }),
        inputTokens: 0,
        outputTokens: 0,
      }
    })
    const run = await runCase(c, () => client)
    results.push(scoreCase(c, run))
  }
  return {
    version: pluginVersion(),
    model: 'scripted-corpus-reply',
    protocol: 'n/a',
    generatedAt: new Date().toISOString(),
    realModel: false,
    cases: results,
  }
}

/** Run the corpus against a real client, one case at a time. */
export async function runReal(client: LlmClient, model: string, protocol: string): Promise<RunRecord> {
  const results: CaseResult[] = []
  for (const c of ALL_CASES) {
    const run = await runCase(c, () => client)
    results.push(scoreCase(c, run))
  }
  return {
    version: pluginVersion(),
    model,
    protocol,
    generatedAt: new Date().toISOString(),
    realModel: true,
    cases: results,
  }
}

/** Parse a run record written by an earlier version. Only the fields the scorer reads. */
export function parseRun(text: string): RunRecord {
  const parsed = JSON.parse(text) as RunRecord
  if (!Array.isArray(parsed.cases)) throw new Error('运行记录里没有 cases 数组')
  return parsed
}
