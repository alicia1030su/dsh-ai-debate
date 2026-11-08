/**
 * 两版真实模型输出的对照评分（v0.2.38 §5）。
 *
 * ## 只算「可复算的那一部分」
 *
 * 真实模型的措辞质量需要人读，机器读不出来。所以这里只算三件在代码里能判定的事：
 *
 * 1. **数字可追溯**：回复里的每个量化数字，能不能在案例材料里找到、或由其中的两个数算出来；
 * 2. **编造检测**：是否出现案例里没有的具体统计（这一条与 1 是同一件事的两面，分开报是为了看清）；
 * 3. **结构要素**：是否引用了案例里的具体要素（迁移成本、44%、第三楼附表……），
 *    还是通篇泛泛而谈。
 *
 * 语义质量（是否真的反驳到点上、措辞是否有人味）**不在这里打分** —— 报告里给出
 * 逐条原文，由人读。任何「提升 X%」的说法都不出自这个脚本。
 *
 * ## 为什么这仍然是一个有意义的对照
 *
 * 两版用同一批案例、同一模型、同一人格、同一输出上限。因此「数字可追溯率」和
 * 「结构要素引用率」的差异，是两版**输入**造成的，不是模型换了。
 *
 * 用法：node scripts/compare-quality-runs.mjs --a <v037.json> --b <v038.json>
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { traceNumbers, isQuantifiedClaim } from '../lib/number-trace.js'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? '')
}

const aPath = arg('a')
const bPath = arg('b')
const outPath = arg('out')

if (aPath === '' || bPath === '') {
  process.stderr.write(
    '用法：node scripts/compare-quality-runs.mjs --a <旧版 quality-cases.json> --b <新版> [--out 报告.json]\n',
  )
  process.exit(2)
}

const load = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'))
const runA = load(aPath)
const runB = load(bPath)

/**
 * 一条回复的确定性评分。
 *
 * `sources` 是**该案例的材料文本** —— 为了让两版比对同一个东西，这里用案例本身的
 * 导入正文（不含任何版本的内部状态）。这样「能不能追溯」不会因为某一版压缩得更狠
 * 而被算成「更会编」。
 */
function scoreOne(text, material) {
  const verdicts = traceNumbers(text, [material])
  const quantified = verdicts.filter((verdict) => isQuantifiedClaim(verdict.value, text))
  // 只统计「陈述数量」的数字：编号（第 3 节）不是事实主张，两版都一样处理。
  const unknown = quantified.filter((verdict) => verdict.kind === 'unknown')
  const derived = quantified.filter((verdict) => verdict.kind === 'derived')

  // 「结构要素」：回复里是否出现了案例材料中的实词片段（四字以上的连续片段）。
  const compact = (value) => value.replace(/\s+/g, '')
  const materialCompact = compact(material)
  const shingles = new Set()
  for (const clause of material.split(/[\n。！？；，,]+/)) {
    const trimmed = compact(clause)
    if (trimmed.length < 4) continue
    for (let i = 0; i + 4 <= trimmed.length; i += 2) shingles.add(trimmed.slice(i, i + 4))
  }
  let hits = 0
  const textCompact = compact(text)
  for (const shingle of shingles) if (textCompact.includes(shingle)) hits += 1

  return {
    chars: [...text].length,
    quantifiedNumbers: quantified.length,
    derivedNumbers: derived.length,
    unknownNumbers: unknown.map((verdict) => verdict.value),
    // 具体要素命中数：同一套 shingle 集合，两版可比。
    concreteHits: hits,
    /**
     * 每百字命中数。
     *
     * ## 为什么必须按字数归一
     *
     * 两版的平均字数不同（51 vs 49）。「命中数」这个原始值会随着回复变长自然变大，
     * 于是「哪版写得多」会被读成「哪版更贴题」。归一之后至少量的是密度。
     */
    concreteHitsPer100: [...text].length === 0 ? 0 : Number(((hits * 100) / [...text].length).toFixed(2)),
    materialChars: materialCompact.length,
  }
}

/** 案例的导入正文（去掉标题行），两版共用。 */
function materialOf(record) {
  // `quality-cases.json` 不存正文；用标题 + 期望作为稳定替代会失真，所以从语料文件里取。
  return MATERIALS[record.id] ?? ''
}

/**
 * 案例材料。
 *
 * ## 为什么必须与采集器里的字符串一致
 *
 * 材料是「模型看到的是不是这个」的基准。这里若手抄一份略有出入的版本，数字可追溯
 * 就会被算错 —— 例如少抄了「从 18 涨到 26」，44% 立刻从「算得出」变成「编造」。
 * 所以这份表与 `test/gui/collect-quality-corpus.ts` 里的 `content` 逐字相同。
 */
const MATERIALS = JSON.parse(readFileSync(new URL('./quality-corpus-materials.json', import.meta.url), 'utf8'))

function summarize(run, label) {
  const rows = []
  for (const record of run.cases) {
    if (typeof record.text !== 'string' || record.text.trim() === '') {
      rows.push({ id: record.id, title: record.title, missing: true, label })
      continue
    }
    rows.push({
      id: record.id,
      title: record.title,
      label,
      ...scoreOne(record.text, materialOf(record)),
      text: record.text,
      elapsedMs: record.elapsedMs ?? null,
      argumentStrategy: record.argumentStrategy?.id ?? null,
      securityDecision: record.securityDecision ?? null,
    })
  }
  const scored = rows.filter((row) => row.missing !== true)
  const sum = (key) => scored.reduce((acc, row) => acc + (row[key] ?? 0), 0)
  return {
    label,
    cases: rows.length,
    produced: scored.length,
    avgChars: scored.length === 0 ? 0 : Math.round(sum('chars') / scored.length),
    avgConcreteHits: scored.length === 0 ? 0 : Number((sum('concreteHits') / scored.length).toFixed(2)),
    avgConcretePer100:
      scored.length === 0 ? 0 : Number((sum('concreteHitsPer100') / scored.length).toFixed(2)),
    unknownNumberCases: scored.filter((row) => row.unknownNumbers.length > 0).length,
    rows,
  }
}

const a = summarize(runA, 'old')
const b = summarize(runB, 'new')

/** 逐案例并排，供人读。 */
const pairs = []
for (const rowA of a.rows) {
  const rowB = b.rows.find((row) => row.id === rowA.id)
  pairs.push({
    id: rowA.id,
    title: rowA.title,
    old: { text: rowA.text ?? '', ...(rowA.missing === true ? { missing: true } : {}), chars: rowA.chars ?? 0, unknownNumbers: rowA.unknownNumbers ?? [], concreteHits: rowA.concreteHits ?? 0, elapsedMs: rowA.elapsedMs ?? null },
    new: { text: rowB?.text ?? '', ...(rowB?.missing === true ? { missing: true } : {}), chars: rowB?.chars ?? 0, unknownNumbers: rowB?.unknownNumbers ?? [], concreteHits: rowB?.concreteHits ?? 0, elapsedMs: rowB?.elapsedMs ?? null },
  })
}

const report = {
  comparable: a.produced > 0 && b.produced > 0,
  old: {
    label: runA.versionLabel ?? 'old',
    cases: a.cases,
    produced: a.produced,
    failed: a.cases - a.produced,
    avgChars: a.avgChars,
    avgConcreteHits: a.avgConcreteHits,
    avgConcretePer100: a.avgConcretePer100,
    casesWithUnknownNumber: a.unknownNumberCases,
    budget: runA.budget ?? null,
    persona: runA.persona ?? null,
    modelSource: runA.modelSource ?? null,
  },
  new: {
    label: runB.versionLabel ?? 'new',
    cases: b.cases,
    produced: b.produced,
    failed: b.cases - b.produced,
    avgChars: b.avgChars,
    avgConcreteHits: b.avgConcreteHits,
    avgConcretePer100: b.avgConcretePer100,
    casesWithUnknownNumber: b.unknownNumberCases,
    budget: runB.budget ?? null,
    persona: runB.persona ?? null,
    modelSource: runB.modelSource ?? null,
  },
  /**
   * 明确写出这一份报告**没有**测什么。
   *
   * 「没有」比「测了但不好看」更容易被读者当成「不存在」，所以单列一段。
   */
  notMeasured: [
    '回复是否真的反驳到点上（需要人读）',
    '措辞是否有人味、是否符合人格（需要人读）',
    '两版之间的统计显著性（样本 20，且为单次采样）',
    '「命中具体要素」是四字片段的字符串匹配，它会奖励复述原文、惩罚改写 —— 密度高不等于论证好',
  ],
  pairs,
  generatedAt: new Date().toISOString(),
  evidenceHash: createHash('sha256')
    .update(JSON.stringify(pairs.map((pair) => [pair.id, pair.old.text, pair.new.text])))
    .digest('hex'),
}

const lines = []
lines.push(`对照：${report.old.label}（${report.old.produced}/${report.old.cases}） vs ${report.new.label}（${report.new.produced}/${report.new.cases}）`)
lines.push('')
lines.push('| 指标 | 旧版 | 新版 |')
lines.push('| --- | --- | --- |')
lines.push(`| 产出成功 | ${report.old.produced}/${report.old.cases} | ${report.new.produced}/${report.new.cases} |`)
lines.push(`| 平均字数 | ${report.old.avgChars} | ${report.new.avgChars} |`)
lines.push(`| 平均命中案例具体要素数 | ${report.old.avgConcreteHits} | ${report.new.avgConcreteHits} |`)
lines.push(`| 每百字命中数（按长度归一） | ${report.old.avgConcretePer100} | ${report.new.avgConcretePer100} |`)
lines.push(`| 出现无法追溯数字的案例数 | ${report.old.casesWithUnknownNumber} | ${report.new.casesWithUnknownNumber} |`)
lines.push('')
lines.push('未测量：语义是否反驳到位、措辞人格、统计显著性。')
lines.push('')
lines.push(`证据哈希：${report.evidenceHash}`)

process.stdout.write(`${lines.join('\n')}\n`)
if (outPath !== '') {
  writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`\n已写入 ${resolve(outPath)}\n`)
}
