/**
 * 从案例定义生成盲评用的语料文件。
 *
 * ## 为什么要有这个脚本
 *
 * `scripts/quality-corpus-materials.json` 是 `blind-review.mjs` 与
 * `compare-quality-runs.mjs` 读的**原始材料**：它们据此计算「回复里有多少字来自材料」
 * 这类指标。案例本身定义在 `test/gui/quality-cases.ts`（采集器要真跑模型，读的是那份）。
 *
 * 两份各写一次的结果，是采到 q01–q30 而评分只认识 q01–q20 —— 那种不一致不会报错，
 * 只会让指标安静地算错分母。所以这里只做一件事：把那一份事实复制成 JSON。
 *
 * ## 为什么直接 import 而不是解析源码
 *
 * 第一版用正则从 TS 里抠 `content` 数组。它漏掉了两条案例（`q10`、`q19`），又把一条
 * 长案例截断在 40 行 —— 而**脚本自己报了「已写 28 条」**，看起来像成功了。解析源码
 * 这件事本来就不该做：案例模块没有运行时依赖，直接 import 就能拿到真正的数组。
 *
 *   node --experimental-transform-types scripts/gen-quality-materials.ts
 *   node --experimental-transform-types scripts/gen-quality-materials.ts --check
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { CASES } from '../test/gui/quality-cases.ts'

const MATERIALS = new URL('./quality-corpus-materials.json', import.meta.url)

/** 每种 id 必须恰好一条；缺一条就是材料与案例脱节。 */
const duplicates = new Set()
const seen = new Set()
for (const item of CASES) {
  if (seen.has(item.id)) duplicates.add(item.id)
  seen.add(item.id)
}
if (duplicates.size > 0) {
  throw new Error(`案例 id 重复：${[...duplicates].join('、')}`)
}

const materials: Record<string, string> = {}
for (const item of CASES) {
  if (item.content.length === 0) throw new Error(`${item.id} 的正文是空的`)
  materials[item.id] = item.content
}

const payload = `${JSON.stringify(materials, null, 2)}\n`
const check = process.argv.includes('--check')

if (check) {
  const existing = readFileSync(MATERIALS, 'utf8')
  if (existing !== payload) {
    process.stderr.write('语料文件与案例定义不一致，请运行：\n')
    process.stderr.write('  node --experimental-transform-types scripts/gen-quality-materials.ts\n')
    process.exit(1)
  }
  process.stdout.write(`语料文件与案例定义一致（${CASES.length} 条）\n`)
} else {
  writeFileSync(MATERIALS, payload, 'utf8')
  const longest = CASES.reduce((a, b) => (a.content.length >= b.content.length ? a : b))
  process.stdout.write(`已写 ${CASES.length} 条（${CASES[0].id}…${CASES[CASES.length - 1].id}）\n`)
  process.stdout.write(`最长一条：${longest.id}，${longest.content.split('\n').length} 行\n`)
}
