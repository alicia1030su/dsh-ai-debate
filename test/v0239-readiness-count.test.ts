/**
 * v0.3.0 准入评估的统计必须能从逐条标记数出来（v0.2.39 复审 §4）。
 *
 * ## 修的是什么
 *
 * 这份文档的总体结论表写着 `7 + 3 + 2 + 1`，正文却说「12 项」—— 光是加法就不成立；
 * 而逐条读下去又会数出第三个数字。表格是给人做决定用的，一个自己都加不起来的表，
 * 读者只能选择相信或不信，没有办法核对。
 *
 * 顺带发现的同类问题：上一版（v0.2.38）的表写 `4 + 4 + 3 + 1 = 12`，实际逐条标记是
 * `6 + 5 + 1 + 0 = 12`。数字对得上总数，分档却错了三格 —— 说明问题不在于某一次笔误，
 * 而在于这张表从来没有被任何东西核对过。
 *
 * ## 所以这里核对三件事
 *
 * 1. 编号连续（1..N，不跳号、不重复）；
 * 2. 每一档的项数等于正文里该标记的条数；
 * 3. 各档之和等于条目总数，且表里写明的合计与之相同。
 *
 * 文档改一个条目而忘了改表，CI 就会红。这不是形式主义：这张表是「能不能对外说这是产品」
 * 的唯一入口，它的可信度只能来自「每次都被算一遍」。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const DOC = join(ROOT, 'docs', 'v0.3.0-readiness.md')

type Bucket = 'satisfied' | 'unmet' | 'evidence' | 'blocked'

interface Item {
  readonly number: number
  readonly title: string
  readonly bucket: Bucket
}

/** 标记与档位的对应关系。顺序有意义：先认更具体的文字，再认符号。 */
function bucketOf(marker: string): Bucket {
  if (marker.includes('外部授权受阻')) return 'blocked'
  if (marker.includes('缺少真实证据')) return 'evidence'
  if (marker.includes('未满足')) return 'unmet'
  if (marker.includes('✅')) return 'satisfied'
  throw new Error(`无法归类的状态标记：${marker}`)
}

/** 解析正文里 `### N. 标题 — 标记` 的条目。 */
function itemsIn(text: string): Item[] {
  const items: Item[] = []
  for (const match of text.matchAll(/^### (\d+)\.\s+(.+?)\s+—\s+(.+)$/gm)) {
    items.push({
      number: Number(match[1]),
      title: match[2]!.trim(),
      bucket: bucketOf(match[3]!),
    })
  }
  return items
}

/** 解析总体结论表里某一列的数字。 */
function tableColumn(text: string, column: 1 | 2): Map<string, number> {
  const counts = new Map<string, number>()
  const row = /^\|\s*(已满足|未满足|缺少真实证据|外部授权受阻)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|$/gm
  for (const match of text.matchAll(row)) {
    counts.set(match[1]!, Number(column === 1 ? match[2] : match[3]))
  }
  const total = /^\|\s*\*\*合计\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|$/m.exec(text)
  assert.ok(total !== null, '总体结论表必须有「合计」行')
  counts.set('合计', Number(column === 1 ? total[1] : total[2]))
  return counts
}

const bucketLabel: Readonly<Record<Bucket, string>> = {
  satisfied: '已满足',
  unmet: '未满足',
  evidence: '缺少真实证据',
  blocked: '外部授权受阻',
}

test('readiness：编号从 1 连续，不跳号也不重复', () => {
  const items = itemsIn(readFileSync(DOC, 'utf8'))
  assert.ok(items.length >= 10, `只解析到 ${items.length} 条，解析规则可能失效`)
  items.forEach((item, index) => {
    assert.equal(item.number, index + 1, `第 ${index + 1} 条的编号是 ${item.number}，不连续`)
  })
})

test('readiness：总体结论表的每一档等于正文里的标记数，合计等于条目数', () => {
  const text = readFileSync(DOC, 'utf8')
  const items = itemsIn(text)
  const counts = tableColumn(text, 2)

  const actual: Record<Bucket, number> = { satisfied: 0, unmet: 0, evidence: 0, blocked: 0 }
  for (const item of items) actual[item.bucket] += 1

  for (const bucket of Object.keys(actual) as Bucket[]) {
    assert.equal(
      counts.get(bucketLabel[bucket]),
      actual[bucket],
      `「${bucketLabel[bucket]}」的表格数字与正文标记数不一致`,
    )
  }

  const sum = Object.values(actual).reduce((total, value) => total + value, 0)
  assert.equal(sum, items.length, '各档之和必须等于条目总数')
  assert.equal(counts.get('合计'), items.length, '表里的「合计」必须等于正文条目数')
})

test('readiness：上一版那一列自身也要加得起来', () => {
  const text = readFileSync(DOC, 'utf8')
  const counts = tableColumn(text, 1)
  const buckets = ['已满足', '未满足', '缺少真实证据', '外部授权受阻'] as const
  const sum = buckets.reduce((total, label) => total + (counts.get(label) ?? 0), 0)
  assert.equal(counts.get('合计'), sum, 'v0.2.38 列的合计必须等于四档之和')
})
