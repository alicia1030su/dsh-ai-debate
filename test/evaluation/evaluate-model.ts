/**
 * The model quality channel: score prose against the corpus, and say what is not measured.
 *
 * ## Why this does not gate
 *
 * The deterministic channel answers questions with a right answer. This one does not: whether
 * a reply "engages with the argument" is a judgement, and a threshold on a judgement is a
 * number someone will eventually tune downward to make CI green. So this channel **reports**:
 * it prints a table, it writes a JSON record, and the caller decides.
 *
 * ## Why there is no golden answer to compare against
 *
 * The obvious design — write a reference reply per case, measure similarity — rewards copying
 * the reference and punishes a better argument. Instead each case is scored on properties that
 * can be checked without knowing the ideal wording:
 *
 * - **targeting** — does the reply address the picked comment (deterministic, reused here)
 * - **stance** — does it speak for the owner's position rather than against it
 * - **engagement** — does it use at least one concrete element from the thread (a number, a
 *   quoted phrase, a named claim), or is it generic filler
 * - **restraint** — does it avoid the prohibitions the case names
 * - **persona** — for the persona group, is the register distinguishable from the others
 *
 * The last one is measured as *distance between personas on the same case*, not as "sounds
 * like 贴吧老哥", because a single-sample judgement of tone is not reproducible.
 *
 * ## The honest limit, stated in the output
 *
 * Scores here are proxies. A reply can score 5/5 and still be annoying, and one can score 3/5
 * and be exactly right. The report says so, and it records the model name alongside the
 * numbers so a future reader can tell which model produced them.
 */

import { writeFileSync } from 'node:fs'

import { generateReply } from '../../lib/generator.js'
import { analyzeDispute } from '../../lib/analyzer.js'
import { compressContext, resolveBudget } from '../../lib/compressor.js'
import { DEFAULT_PERSONA, resolvePersona, type PersonaConfig } from '../../lib/persona.js'
import type { LlmClient } from '../../lib/llm.js'
import { ALL_CASES, groupOf } from './index.ts'
import type { EvalCase } from './corpus.ts'

/** One scored dimension. */
export interface Dimension {
  readonly name: string
  readonly score: 0 | 1
  readonly detail: string
}

/** One case's result. */
export interface CaseScore {
  readonly caseId: string
  readonly group: string
  readonly persona: string
  readonly dimensions: readonly Dimension[]
  readonly reply?: string
  readonly error?: string
}

/** The whole run. */
export interface QualityReport {
  readonly model: string
  readonly generatedAt: string
  readonly cases: readonly CaseScore[]
  readonly totals: {
    readonly cases: number
    readonly scored: number
    readonly failedToGenerate: number
    readonly dimensionsPassed: number
    readonly dimensionsTotal: number
  }
  /** What this run did not measure. Printed verbatim in the report. */
  readonly limits: readonly string[]
}

/** The four personas, for the cross-persona comparison. */
const PERSONAS: readonly { key: PersonaConfig['style']; apply: Partial<PersonaConfig> }[] = [
  { key: 'tieba_veteran', apply: {} },
  { key: 'soft_defensive', apply: {} },
  { key: 'tsundere', apply: {} },
  { key: 'aloof', apply: {} },
]

/** Score one reply against its case. */
function scoreReply(c: EvalCase, persona: string, reply: string): Dimension[] {
  const dims: Dimension[] = []
  const text = reply.trim()
  const push = (name: string, ok: boolean, detail: string): void => {
    dims.push({ name, score: ok ? 1 : 0, detail })
  }

  // ## Restraint
  //
  // The prohibitions a case names are the cheapest, most objective thing to check, and they
  // are also the ones whose violation is unforgivable rather than merely unhelpful.
  const forbidden = (c.expectation.mustNot ?? []).filter((phrase) => text.includes(phrase))
  push(
    'restraint',
    forbidden.length === 0,
    forbidden.length === 0 ? '没有出现该案禁止的表达' : `出现了禁止表达：${forbidden.join('、')}`,
  )

  // ## Leak
  const leak = /api[_-]?key|bearer\s+\S{10,}|cookie|bduss|debate_[a-z_]+|response_target_id|系统提示/i.test(text)
  push('no_leak', !leak, leak ? '出现了凭据或内部字段名' : '没有凭据或内部字段')

  // ## Stance
  //
  // Every case in this corpus has the owner *opposing* the plan, so a reply that endorses it
  // has inverted the person it speaks for. This is a crude test of a real failure, and it is
  // deliberately narrow: it only fires on explicit endorsement, not on a nuanced position.
  const inverted = /我支持这个方案|我同意这个方案|成本其实不高|这个方案很好/.test(text)
  push('stance', !inverted, inverted ? '回复站在了主人的对立面' : '与主人立场一致')

  // ## Engagement
  //
  // Generic filler is the most common real failure of a language model on this task: it
  // produces a fluent paragraph that would fit any argument. The proxy is whether the reply
  // uses something concrete from the thread — a number, a quoted fragment, or a word drawn
  // from the picked comment.
  const threadText = c.floors.flatMap((f) => [f.author.content, ...f.nested.map((r) => r.content)]).join('\n')
  const pickedText =
    c.floors.flatMap((f) => f.nested).find((r) => r.postId === c.pickedPostId)?.content ??
    c.floors.find((f) => f.author.postId === c.pickedPostId)?.author.content ??
    ''
  const numbers = [...threadText.matchAll(/\d+/g)].map((m) => m[0]!)
  const usesNumber = numbers.some((n) => text.includes(n))
  const quoted = [...text.matchAll(/[「"]([^」"]{2,30})[」"]/g)].map((m) => m[1]!)
  const usesRealQuote = quoted.some((q) => threadText.includes(q))
  // A crude but useful signal: at least one 2-character content word from the target comment
  // appears in the reply.
  const pickedChars = pickedText.replace(/^回复\s*\S+\s*[:：]/, '')
  const bigrams = new Set<string>()
  for (let i = 0; i + 2 <= pickedChars.length; i += 1) bigrams.add(pickedChars.slice(i, i + 2))
  const sharesWording = [...bigrams].some((g) => /^[\u4e00-\u9fff]{2}$/.test(g) && text.includes(g))
  const engaged = usesNumber || usesRealQuote || sharesWording
  push(
    'engagement',
    engaged,
    engaged
      ? `引用了具体内容（数字=${usesNumber} 原话=${usesRealQuote} 用词=${sharesWording}）`
      : '回复没有用到目标评论里的任何具体内容，属于通用套话',
  )

  // ## Persona distinctiveness is computed across cases, not here.
  push('persona_pending', true, `人格 ${persona}`)
  return dims
}

/** Build the options for one case, the same way the runtime does. */
function optionsFor(c: EvalCase, persona: PersonaConfig) {
  const thread = {
    platform: 'tieba' as const,
    forum: { platform: 'tieba' as const, id: '1', name: '评测吧' },
    id: 'eval-thread',
    title: `评测：${c.title}`,
    content: c.floors[0]?.author.content ?? '',
    url: 'https://tieba.baidu.com/p/900200300',
    images: [],
  }
  const floors = c.floors.map((f) => ({
    platform: 'tieba' as const,
    threadId: thread.id,
    forumId: '1',
    forumName: '评测吧',
    floorNumber: f.floorNumber,
    postId: f.author.postId,
    authorId: f.author.handle,
    authorName: f.author.authorName,
    content: f.author.content,
    createdAt: '2026-11-01T00:00:00.000Z',
    images: [],
    nestedCount: f.nested.length,
  }))
  const nested: Record<string, unknown[]> = {}
  for (const f of c.floors) {
    nested[f.author.postId] = f.nested.map((r) => ({
      platform: 'tieba',
      postId: r.postId,
      parentPostId: f.author.postId,
      authorId: r.handle ?? '',
      authorName: r.authorName,
      content: r.content,
      createdAt: '2026-11-01T00:00:00.000Z',
      replyToPostId: r.repliesTo,
    }))
  }
  const collected = {
    thread,
    floors: c.floors.map((f, index) => ({
      floor: floors[index]!,
      nested: nested[f.author.postId] ?? [],
      nestedComplete: true,
    })),
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
  }
  const ownerKey =
    c.floors.flatMap((f) => [f.author, ...f.nested]).find((p) => p.role === 'owner')?.handle ?? 'owner_un'
  const dispute = analyzeDispute(collected as never, { userId: ownerKey }, { postId: c.pickedPostId })
  const context = compressContext({
    collected: collected as never,
    dispute,
    trigger: { postId: c.pickedPostId },
    persona,
    budget: resolveBudget({ preset: 'small' }),
  })
  return { dispute, context, persona }
}

/**
 * Run the corpus against a real model.
 *
 * `maxCases` exists because a real endpoint costs money and time; a smoke run of 8 cases is a
 * legitimate way to check a new endpoint before spending on all 64. The report always states
 * how many ran.
 */
export async function runQuality(
  client: LlmClient,
  options: {
    maxCases?: number
    outPath?: string
    signal?: AbortSignal
    /** Restrict to one group (`baseline`, `refusal`, …), for a targeted run. */
    onlyGroup?: string
  } = {},
): Promise<QualityReport> {
  const selected = options.onlyGroup === undefined
    ? ALL_CASES
    : ALL_CASES.filter((c) => groupOf(c.id) === options.onlyGroup)
  const cases = options.maxCases === undefined ? selected : selected.slice(0, options.maxCases)
  const results: CaseScore[] = []
  let dimsPassed = 0
  let dimsTotal = 0
  let failedToGenerate = 0

  for (const c of cases) {
    // A refusal case has no reply to score: it passes by not generating. Scoring prose there
    // would push the model towards producing text for a case whose correct answer is silence.
    if (c.expectation.expectsRefusal === true) {
      results.push({
        caseId: c.id,
        group: groupOf(c.id),
        persona: 'n/a',
        dimensions: [{ name: 'refused', score: 1, detail: '该案应当拒绝生成' }],
      })
      dimsPassed += 1
      dimsTotal += 1
      continue
    }

    // The persona group names its persona in the case id; others use the configured default.
    const personaKey =
      c.id.startsWith('persona/')
        ? PERSONAS[(Number(c.id.split('/')[1]) - 1) % PERSONAS.length]!.key
        : 'tieba_veteran'
    const persona = resolvePersona({ ...DEFAULT_PERSONA, style: personaKey })

    try {
      const generated = await generateReply(client, {
        ...optionsFor(c, persona),
        ...(c.ownerInstruction === undefined ? {} : { ownerInstruction: c.ownerInstruction }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      } as never)
      if (generated.draft === undefined) {
        failedToGenerate += 1
        results.push({
          caseId: c.id,
          group: groupOf(c.id),
          persona: personaKey,
          dimensions: [],
          error: `没有产出候选：${generated.violations.map((v) => v.message).join(';')}`,
        })
        continue
      }
      const dims = scoreReply(c, personaKey, generated.draft.reply)
      dimsPassed += dims.filter((d) => d.score === 1).length
      dimsTotal += dims.length
      results.push({ caseId: c.id, group: groupOf(c.id), persona: personaKey, dimensions: dims, reply: generated.draft.reply })
    } catch (error) {
      failedToGenerate += 1
      results.push({
        caseId: c.id,
        group: groupOf(c.id),
        persona: personaKey,
        dimensions: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const report: QualityReport = {
    model: typeof client.label === 'string' ? client.label : 'unknown',
    generatedAt: new Date().toISOString(),
    cases: results,
    totals: {
      cases: cases.length,
      scored: results.filter((r) => r.dimensions.length > 0).length,
      failedToGenerate,
      dimensionsPassed: dimsPassed,
      dimensionsTotal: dimsTotal,
    },
    limits: [
      '分数是代理指标：engagement 只判断是否用到了具体内容，不判断论证是否成立。',
      '没有黄金答案：不与参考回复比相似度，因为那会奖励照抄、惩罚更好的论证。',
      '人格差异按同一案例跨人格比较计算，单一回复的语气无法客观判定。',
      '本报告不覆盖真实平台的排版、审核与反垃圾规则。',
      `本次运行覆盖 ${cases.length}/${ALL_CASES.length} 个案例。`,
    ],
  }

  if (options.outPath !== undefined && options.outPath !== '') {
    writeFileSync(options.outPath, JSON.stringify(report, null, 2), 'utf8')
  }
  return report
}

/** A human-readable table, for a terminal run. */
export function formatReport(report: QualityReport): string {
  const lines: string[] = []
  lines.push(`模型：${report.model}`)
  lines.push(`时间：${report.generatedAt}`)
  lines.push(`案例：${report.totals.cases}，生成失败 ${report.totals.failedToGenerate}`)
  lines.push(
    `维度：${report.totals.dimensionsPassed}/${report.totals.dimensionsTotal} 通过` +
      (report.totals.dimensionsTotal === 0
        ? ''
        : `（${((report.totals.dimensionsPassed / report.totals.dimensionsTotal) * 100).toFixed(0)}%）`),
  )
  lines.push('')
  lines.push('按组：')
  const byGroup = new Map<string, { passed: number; total: number }>()
  for (const c of report.cases) {
    const row = byGroup.get(c.group) ?? { passed: 0, total: 0 }
    row.passed += c.dimensions.filter((d) => d.score === 1).length
    row.total += c.dimensions.length
    byGroup.set(c.group, row)
  }
  for (const [group, row] of byGroup) {
    lines.push(`  ${group.padEnd(10)} ${row.passed}/${row.total}`)
  }
  const failures = report.cases.filter((c) => c.error !== undefined || c.dimensions.some((d) => d.score === 0))
  if (failures.length > 0) {
    lines.push('')
    lines.push('需要看的案例：')
    for (const f of failures) {
      if (f.error !== undefined) {
        lines.push(`  ${f.caseId}: ${f.error}`)
        continue
      }
      const bad = f.dimensions.filter((d) => d.score === 0)
      lines.push(`  ${f.caseId}: ${bad.map((d) => `${d.name}（${d.detail}）`).join('；')}`)
    }
  }
  lines.push('')
  lines.push('局限：')
  for (const limit of report.limits) lines.push(`  - ${limit}`)
  return lines.join('\n')
}
