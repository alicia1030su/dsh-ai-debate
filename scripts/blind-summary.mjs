#!/usr/bin/env node
/**
 * 解盲与汇总：把盲评包里匿名条目的分数按版本聚合。
 *
 * ## 为什么解盲要单独一步
 *
 * 评分过程（`blind-review.mjs`）只见过匿名标签，没见过版本号 —— 那一步的证据是
 * `bundle.json` + `scores.json`，两者都不含版本。解盲是**之后**的事，读的是 `key.json`。
 * 分成两步的意义：任何人可以在不看 `key.json` 的情况下复核打分，然后才解开对应关系。
 *
 * ## 两个评审来源，都是自动的
 *
 * 1. **表面规则**（`rules`）：空不空、多长、数字能不能追回原文、有没有对人说话。
 * 2. **结构规则**（`structure`）：跨案例的重复度 —— 二十条回复里有多少条以同一句话开头、
 *    三字片段重复率多少。它量的是「像不像一个模板写出来的」，与第 1 个来源量的事不重叠。
 *
 * **没有人工评审，也没有模型评审。** 报告里不许写「独立评审一致认为」这种话，
 * 除非真的有人看过。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? '')
}

const dir = resolve(arg('dir', '.eval/blind'))
const outFile = arg('out', join(dir, 'summary.json'))

const bundle = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8'))
const scores = JSON.parse(readFileSync(join(dir, 'scores.json'), 'utf8'))
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'))

const scoreByLabel = new Map(scores.entries.map((entry) => [entry.label, entry]))
const versionOf = (label) => key[label]?.version ?? 'unknown'

/** 按版本聚合。 */
const perVersion = new Map()
for (const entry of bundle.entries) {
  const version = versionOf(entry.label)
  if (!perVersion.has(version)) {
    perVersion.set(version, { version, labels: [], texts: [], outcomes: [], scores: [] })
  }
  const bucket = perVersion.get(version)
  bucket.labels.push(entry.label)
  bucket.texts.push(entry.text)
  bucket.outcomes.push(entry.outcome)
  const score = scoreByLabel.get(entry.label)
  if (score !== undefined) bucket.scores.push(score)
}

/** 三字片段重复：跨案例看「像不像同一个模板」。 */
function templateStats(texts) {
  const nonEmpty = texts.filter((text) => text.trim() !== '')
  const grams = new Map()
  for (const text of nonEmpty) {
    const seen = new Set()
    const cleaned = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    for (let i = 0; i + 3 <= cleaned.length; i += 1) {
      const gram = cleaned.slice(i, i + 3)
      if (seen.has(gram)) continue
      seen.add(gram)
      grams.set(gram, (grams.get(gram) ?? 0) + 1)
    }
  }
  // 出现在两个以上案例里的三字片段，占全部片段的多少。
  const shared = [...grams.values()].filter((count) => count >= 2).length
  const total = grams.size
  /**
   * 开头两字的重合。
   *
   * 这一项单独看，是因为「所有回复都以『你说』开头」是最容易被读者一眼识破的模板感，
   * 而它在三字片段重复率里只占很小一份。
   */
  const openings = nonEmpty.map((text) => text.replace(/[^\u4e00-\u9fa5]/g, '').slice(0, 2))
  const openingCounts = new Map()
  for (const opening of openings) openingCounts.set(opening, (openingCounts.get(opening) ?? 0) + 1)
  const topOpening = [...openingCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  return {
    nonEmpty: nonEmpty.length,
    sharedGramRatio: total === 0 ? 0 : Number((shared / total).toFixed(3)),
    topOpening: topOpening[0],
    topOpeningCount: topOpening[1],
  }
}

const rows = []
for (const bucket of [...perVersion.values()].sort((a, b) => a.version.localeCompare(b.version))) {
  const n = bucket.scores.length
  const sum = (pick) => bucket.scores.reduce((total, entry) => total + pick(entry), 0)
  const chars = sum((entry) => entry.chars)
  const hits = sum((entry) => entry.concreteHits)
  rows.push({
    version: bucket.version,
    cases: bucket.scores.length,
    emptyReplies: bucket.scores.filter((entry) => entry.empty).length,
    outcomes: bucket.outcomes.reduce((acc, outcome) => {
      acc[outcome] = (acc[outcome] ?? 0) + 1
      return acc
    }, {}),
    avgChars: n === 0 ? 0 : Number((chars / n).toFixed(1)),
    avgConcreteHits: n === 0 ? 0 : Number((hits / n).toFixed(2)),
    concretePer100: chars === 0 ? 0 : Number(((hits / chars) * 100).toFixed(2)),
    untraceableNumbers: sum((entry) => entry.untraceableNumbers.length),
    addressesOpponent: bucket.scores.filter((entry) => entry.addressesOpponent).length,
    ...templateStats(bucket.texts),
  })
}

const report = {
  generatedAt: new Date().toISOString(),
  seed: bundle.seed,
  reviewers: [
    { id: 'rules', kind: 'automated', basis: '空/长度/数字可追溯/是否对人说话' },
    { id: 'structure', kind: 'automated', basis: '跨案例三字片段重复率与开头重合' },
  ],
  /** 这句必须跟着数字一起出现在报告里。 */
  disclaimer:
    '两个评审来源都是自动规则，不是人工盲评，也不是模型评审。' +
    '它们能排除「新版被偏好」这一偏差，但不能替代语义判断：' +
    '「论证是否切中要害」这张表答不了。',
  rows,
}

writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`已写 ${outFile}\n`)
for (const row of rows) {
  process.stdout.write(
    `${row.version}  案例 ${row.cases}  空 ${row.emptyReplies}  平均 ${row.avgChars} 字  ` +
      `命中 ${row.avgConcreteHits}（每百字 ${row.concretePer100}）  ` +
      `不可追溯数字 ${row.untraceableNumbers}  对人说话 ${row.addressesOpponent}  ` +
      `共享片段 ${(row.sharedGramRatio * 100).toFixed(1)}%  最常见开头「${row.topOpening}」×${row.topOpeningCount}\n`,
  )
}
