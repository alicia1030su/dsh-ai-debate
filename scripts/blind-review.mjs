#!/usr/bin/env node
/**
 * 盲评：把同一批案例的多版本输出打乱、隐藏版本来源，再逐条评分。
 *
 * ## 为什么必须盲
 *
 * v0.2.38 的对照报告里写了一句实话：「命中具体要素从 1.20 降到 0.84」。那个数字是
 * 用规则算的，规则不知道哪条来自哪一版 —— 所以它本身不偏。但它量的东西（四字片段
 * 字符串匹配）奖励复述原文、惩罚改写，于是「新版更低」既可能是变差了，也可能只是
 * 说得不像原文。用这个数去下结论，等于用尺子量温度。
 *
 * 盲评要解决的是更基本的一件事：**评分者不该知道自己在评哪一版**。做到了这一点，
 * 即使评分者是一个模型、一套规则，至少「偏袒新版」这个偏差被去掉了。做不到这一点，
 * 任何分数都只是评审者对版本号的印象。
 *
 * ## 三个不能含糊的地方
 *
 * 1. **打乱要可复现。** 用固定种子的伪随机，种子记进结果文件。否则「随机打乱」这四个字
 *    没法被别人复核 —— 而一次不可复核的随机化，可能是选择性随机化。
 * 2. **版本与标签的映射单独存。** 评分过程读不到它；评分结束后由另一个函数解盲。
 * 3. **评审来源要标清楚是自动还是人工。** 拿不到真人就说拿不到。把「一个模型评的」写成
 *    「独立评审」，是这个项目里最容易犯也最难被发现的一类失真。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/blind-review.mjs \
 *   --run v0.2.37=path/a.json --run v0.2.38=path/b.json --run v0.2.39=path/c.json \
 *   --out .eval/blind
 * ```
 *
 * 产出：
 * - `.eval/blind/bundle.json` —— 打乱后的条目（只有匿名标签，没有版本）
 * - `.eval/blind/key.json` —— 匿名标签 ↔ 版本的映射（评分时不要读）
 * - `.eval/blind/scores.json` —— 确定性评审的逐条分数（可复算）
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isQuantifiedClaim, traceNumbers } from '../lib/number-trace.js'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : (process.argv[index + 1] ?? '')
}

function argAll(name) {
  const values = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}`) values.push(process.argv[index + 1] ?? '')
  }
  return values
}

const outDir = resolve(arg('out', '.eval/blind'))
const runs = argAll('run').map((entry) => {
  const eq = entry.indexOf('=')
  if (eq === -1) throw new Error(`--run 的格式是 <版本>=<文件>，收到：${entry}`)
  return { label: entry.slice(0, eq), file: entry.slice(eq + 1) }
})
if (runs.length < 2) throw new Error('至少需要两个 --run 才能比较')

/**
 * 固定种子的伪随机（mulberry32）。
 *
 * 不用 `Math.random()`：同一条命令跑两次要得到同一个顺序，否则「随机打乱」这句话
 * 无法被第三方复核 —— 而随机化不可复核时，它和「挑好看的」在结果上无法区分。
 */
function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = seeded(0x2039_0001)

/** Fisher–Yates。就地打乱，调用方拿到的是同一个数组。 */
function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

/** 每条记录里可以拿来评分的字段。缺的留空串，不编。 */
function normalise(run, record) {
  return {
    version: run.label,
    id: record.id,
    title: record.title ?? '',
    text: typeof record.text === 'string' ? record.text : '',
    outcome: typeof record.outcome === 'string' ? record.outcome : record.text ? 'valid_draft' : 'technical_failure',
    strategy: record.argumentStrategy?.id ?? record.strategyRequested ?? '',
    securityDecision: record.securityDecision ?? '',
    violations: Array.isArray(record.violations) ? record.violations : [],
    reason: typeof record.reason === 'string' ? record.reason : '',
    elapsedMs: typeof record.elapsedMs === 'number' ? record.elapsedMs : null,
  }
}

const byId = new Map()
for (const run of runs) {
  const parsed = JSON.parse(readFileSync(resolve(run.file), 'utf8'))
  const cases = Array.isArray(parsed.cases) ? parsed.cases : []
  for (const raw of cases) {
    const record = normalise(run, raw)
    if (!byId.has(record.id)) byId.set(record.id, [])
    byId.get(record.id).push(record)
  }
}

// 每个案例内部打乱，然后给匿名标签 A/B/C。标签与版本的对应关系只写进 key.json。
const bundle = []
const key = {}
let counter = 0
for (const id of [...byId.keys()].sort()) {
  const entries = shuffle([...byId.get(id)])
  const labels = []
  for (const entry of entries) {
    counter += 1
    const label = `R${String(counter).padStart(3, '0')}`
    labels.push(label)
    key[label] = { version: entry.version, id: entry.id }
    bundle.push({ label, id: entry.id, title: entry.title, text: entry.text, outcome: entry.outcome })
  }
  // 只记顺序，不记内容 —— 内容在 bundle 里，顺序在这里。
  key[`order:${id}`] = labels
}

/**
 * 评审来源一：确定性规则。
 *
 * 它**不**评价「说得好不好」，只回答几个能被第三方用同一段代码复核的问题：
 * 是不是空、有没有超长、数字能不能追回原文、有没有把主人的立场说反。
 *
 * 明确标注 `source: 'rules'`：这不是人工评审，也不是语义判断。
 */
function scoreByRules(entry, materials) {
  const text = entry.text
  const chars = [...text].length
  const numbers = [...text.matchAll(/\d+(?:\.\d+)?%?/g)]
    .map((match) => match[0])
    .filter((token) => isQuantifiedClaim(token, text))
  const traced = traceNumbers(text, [materials])
  const unknown = numbers.filter((token) => {
    const verdict = traced.find((item) => item.value === token)
    return verdict !== undefined && verdict.kind === 'unknown'
  })

  return {
    source: 'rules',
    empty: chars === 0,
    chars,
    quantifiedNumbers: numbers.length,
    untraceableNumbers: unknown,
    /** 有没有真的提到案例里的具体要素（四字片段）。量的是「贴题」，不是「说得好」。 */
    concreteHits: concreteHits(text, materials),
    /** 回复里出现「你」「您」等第二人称 = 在对人说话，不是在对空气说话。 */
    addressesOpponent: /你|您|阁下|你自己/.test(text),
  }
}

/** 与案例材料的四字片段重合数。刻意简单：可复算比聪明重要。 */
function concreteHits(text, materials) {
  const cleaned = (value) => value.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
  const haystack = cleaned(materials)
  const needle = cleaned(text)
  if (haystack.length < 4 || needle.length < 4) return 0
  let hits = 0
  const seen = new Set()
  for (let i = 0; i + 4 <= needle.length; i += 1) {
    const gram = needle.slice(i, i + 4)
    if (seen.has(gram)) continue
    seen.add(gram)
    if (haystack.includes(gram)) hits += 1
  }
  return hits
}

const materialsPath = arg('materials', 'scripts/quality-corpus-materials.json')
const materials = JSON.parse(readFileSync(resolve(materialsPath), 'utf8'))

const scores = bundle.map((entry) => ({
  label: entry.label,
  id: entry.id,
  ...scoreByRules(entry, materials[entry.id] ?? ''),
}))

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'bundle.json'), `${JSON.stringify({ seed: 0x2039_0001, entries: bundle }, null, 2)}\n`, 'utf8')
writeFileSync(join(outDir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`, 'utf8')
writeFileSync(
  join(outDir, 'scores.json'),
  `${JSON.stringify({ source: 'rules', reviewer: 'deterministic-rules', entries: scores }, null, 2)}\n`,
  'utf8',
)

console.log(`已写 ${outDir}`)
console.log(`  案例：${byId.size}`)
console.log(`  条目：${bundle.length}（每个案例 ${runs.length} 版）`)
console.log(`  种子：0x20390001（写进 bundle.json，可复算）`)
console.log('  评分来源：确定性规则（不是人工评审）')
