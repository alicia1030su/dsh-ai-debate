/**
 * Regenerate the README test-coverage table from what the suite actually reports.
 *
 * ## Why this is a script and not a manual edit
 *
 * The table has to agree with `scripts/test-count.mjs` or it becomes a second, wrong
 * source of truth — and it is the number a reader trusts when deciding whether a claim
 * is tested. Hand-editing drifted once already (the table said 612 while the suite ran
 * 627), so the entries are regenerated from the machine output instead of typed.
 *
 * ## What it preserves
 *
 * The per-file "coverage" column is prose and cannot be derived, so it is kept verbatim
 * from the existing table; only the numbers and any newly added files are written.
 * A new file with no description gets a placeholder rather than being dropped, so a
 * forgotten description is visible instead of silent.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate'
const readmePath = path.join(ROOT, 'README.md')

// The machine's own count, the same one `npm run test:count` prints.
const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts/test-count.mjs')], {
  encoding: 'utf8',
})

/** Parse the script's markdown table into `file -> count`. */
function countsFrom(text) {
  const counts = new Map()
  for (const line of text.split('\n')) {
    const match = /^\| `(test\/[^`]+)` \| (\d+) \|/.exec(line.trim())
    if (match !== null) counts.set(match[1], Number(match[2]))
  }
  return counts
}

const counts = countsFrom(output)
const totalMatch = /\*\*合计\*\* \| \*\*(\d+)\*\*/.exec(output)
const total = totalMatch === null ? [...counts.values()].reduce((sum, n) => sum + n, 0) : Number(totalMatch[1])
if (counts.size === 0) {
  throw new Error('test-count.mjs 没有输出可解析的表格；先修脚本，别改 README')
}

let readme = fs.readFileSync(readmePath, 'utf8')
const lines = readme.split('\n')

// Locate the table and collect the existing descriptions.
const startIndex = lines.findIndex((line) => line.trim() === '| 测试文件 | 数量 | 覆盖内容 |')
if (startIndex < 0) throw new Error('README 里找不到测试覆盖表')
let endIndex = startIndex
while (endIndex < lines.length && lines[endIndex].startsWith('|')) endIndex += 1

const descriptions = new Map()
for (const line of lines.slice(startIndex, endIndex)) {
  const match = /^\| `(test\/[^`]+)` \| \d+ \| (.*) \|$/.exec(line.trim())
  if (match !== null) descriptions.set(match[1], match[2])
}

// Rebuild every row, keeping the README's own ordering; new files append at the end.
const existingOrder = [...descriptions.keys()]
const newFiles = [...counts.keys()].filter((file) => !descriptions.has(file))

const rows = []
for (const file of existingOrder) {
  if (!counts.has(file)) {
    // A file that no longer runs must not linger in the table: a stale row reads as
    // coverage that does not exist.
    console.log(`删除已不存在的条目：${file}`)
    continue
  }
  rows.push(`| \`${file}\` | ${counts.get(file)} | ${descriptions.get(file)} |`)
}
for (const file of newFiles) {
  console.log(`新增条目：${file}（${counts.get(file)}）—— 请补上覆盖内容说明`)
  rows.push(`| \`${file}\` | ${counts.get(file)} | TODO 说明这个文件覆盖什么 |`)
}

const table = ['| 测试文件 | 数量 | 覆盖内容 |', '| --- | --- | --- |', ...rows, `| **合计** | **${total}** | |`]
readme = [...lines.slice(0, startIndex), ...table, ...lines.slice(endIndex)].join('\n')

// Keep the prose number in step with the table. It is the first thing a reader sees.
readme = readme.replace(
  /\*\*\d+ 项自动化测试全部通过\*\*/,
  `**${total} 项自动化测试全部通过**`,
)

fs.writeFileSync(readmePath, readme, 'utf8')
console.log(`合计 ${total} 项，${rows.length} 个文件；README 已更新`)
