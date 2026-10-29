/**
 * 交付收尾：算产物哈希，写 SHA256SUMS.txt，并把报告里的占位换成实测值。
 *
 * 归档无法包含自身的哈希，所以 `SHA256SUMS.txt` 是唯一的权威校验和来源；报告只
 * 引用它，不自己编一个。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = process.cwd()
const workspace = join(root, '..')

const tgz = join(root, 'dsh-ai-debate-0.2.8.tgz')
const zip = join(workspace, 'dsh-ai-debate-source-0.2.8.zip')

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

for (const path of [tgz, zip]) {
  if (!existsSync(path)) throw new Error(`缺少产物：${path}`)
}

const tgzHash = sha(tgz)
const zipHash = sha(zip)
const tgzSize = statSync(tgz).size
const zipSize = statSync(zip).size

const sums = [
  '# AI代吵架 v0.2.8 交付校验和（2026-10-29）',
  '#',
  '# 本文件是权威校验和；归档无法包含自身的哈希，所以报告里只引用这里。',
  '',
  `${tgzHash}  ${basename(tgz)}        (${tgzSize} 字节)`,
  `${zipHash}  ${basename(zip)} (${zipSize} 字节)`,
  '',
].join('\n')
writeFileSync(join(root, 'SHA256SUMS.txt'), sums, 'utf8')

const reportPath = join(root, 'docs', 'v0.2.8-acceptance.md')
let report = readFileSync(reportPath, 'utf8')
// ## Why the report names no artifact hash at all
//
// The report travels *inside* both archives. Writing a hash (or even a byte count) of
// an archive into a file inside that archive makes the archive depend on its own
// digest: I measured the zip change on every run through three separate attempts
// before accepting the simple conclusion — a self-referential fact cannot be recorded
// in the thing it describes.
//
// So the report points at `SHA256SUMS.txt`, which is generated after both archives are
// sealed. That file is the only place the hashes appear, and it is written outside the
// source tree, so nothing inside either archive refers back to it.
report = report.replace(
  /\| `dsh-ai-debate-0\.2\.8\.tgz` \|[^\n]*\n/,
  '| `dsh-ai-debate-0.2.8.tgz` | 见 `SHA256SUMS.txt` | 见 `SHA256SUMS.txt` |\n',
)
report = report.replace(
  /\| `dsh-ai-debate-source-0\.2\.8\.zip` \|[^\n]*\n/,
  '| `dsh-ai-debate-source-0.2.8.zip` | 见 `SHA256SUMS.txt` | 见 `SHA256SUMS.txt` |\n',
)
writeFileSync(reportPath, report, 'utf8')

console.log(sums)
