/**
 * 把 README 的测试表格与真实统计对齐（v0.2.8）。
 *
 * 只做两件事：
 *   1. 已有行的数量按实际值更新；
 *   2. 统计里有、README 里没有的文件行，插入到「合计」之前。
 *
 * 描述列（第三列）**不自动生成** —— 一段机器编出来的说明读起来像真的，但它没读过
 * 那个测试文件。新行留 `TODO` 占位，由人补。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const table = execFileSync(process.execPath, [join(root, 'scripts', 'test-count.mjs')], {
  encoding: 'utf8',
})
const actual = new Map()
for (const line of table.split(/\r?\n/)) {
  const match = /^\| `(test\/[^`]+)` \| (\d+) \|/.exec(line)
  if (match) actual.set(match[1], Number(match[2]))
}
const total = [...actual.values()].reduce((sum, value) => sum + value, 0)

const path = join(root, 'README.md')
const source = readFileSync(path, 'utf8')
const lines = source.split(/\r?\n/)

const seen = new Set()
const out = []
let totalLine = -1
for (const line of lines) {
  const match = /^\| `(test\/[^`]+)` \| (\d+) \|(.*)$/.exec(line)
  if (match === null) {
    if (/^\| \*\*合计\*\* \|/.test(line)) totalLine = out.length
    out.push(line)
    continue
  }
  const file = match[1]
  seen.add(file)
  const count = actual.get(file)
  if (count === undefined) {
    // A file that no longer exists keeps no row: the table claims to describe this suite.
    continue
  }
  out.push(`| \`${file}\` | ${count} |${match[3]}`)
}

// Files the table never listed, inserted just above the total.
const missing = [...actual.keys()].filter((file) => !seen.has(file)).sort()
if (missing.length > 0) {
  const rows = missing.map((file) => `| \`${file}\` | ${actual.get(file)} | TODO: 补充覆盖说明 |`)
  const insertAt = totalLine === -1 ? out.length : totalLine
  out.splice(insertAt, 0, ...rows)
}

const totalIndex = out.findIndex((line) => /^\| \*\*合计\*\* \|/.test(line))
if (totalIndex !== -1) out[totalIndex] = `| **合计** | **${total}** | |`

let next = out.join('\n')
// The prose number above the table is a claim too.
next = next.replace(/\*\*\d+ 项自动化测试全部通过\*\*/u, `**${total} 项自动化测试全部通过**`)
writeFileSync(path, next, 'utf8')

console.log(`合计 ${total} 项；更新行 ${seen.size}；新增行 ${missing.length}`)
if (missing.length > 0) console.log('新增：', missing.join(', '))
