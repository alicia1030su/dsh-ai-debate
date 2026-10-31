#!/usr/bin/env node
/**
 * 生成机器可读的交付状态报告（任务书 §二）。
 *
 * ## 为什么这件事必须由发布工作流自己做
 *
 * v0.2.16 的验收报告里写着「发布提交 f1c111c」，而标签实际指向 `57ffec6`。那不是笔误：
 * Markdown 报告写在提交里，而「这个提交的 SHA」只有提交之后才知道 —— 这个形式本身
 * 不可能自洽。任何人手写都会遇到同样的问题。
 *
 * 唯一能自洽的做法是：**在发布当时，由握着这些值的进程把它写下来**。这个脚本跑在
 * Release 工作流里，它读得到 `GITHUB_SHA`、`GITHUB_RUN_ID`，也算得出现成两个附件的哈希。
 *
 * ## 未知就是 null，不是 0，也不是占位文本
 *
 * `'TBD'` 会被读的人当成一个值；`0` 会被当成「测过了，零失败」。两者都会把「未验证」
 * 伪装成「已验证」。所以凡是这次运行没观测到的事实，一律写 `null`，并在 `unverified`
 * 里用一句话说清楚缺什么。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/delivery-status-report.mjs --test-log /tmp/test.log
 * node scripts/delivery-status-report.mjs --out .ship/delivery-status-0.2.17.json
 * ```
 *
 * 环境变量（CI 里由 Actions 注入）：`GITHUB_REPOSITORY`、`GITHUB_SHA`、`GITHUB_REF_NAME`、
 * `GITHUB_RUN_ID`、`GITHUB_SERVER_URL`。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  artifactOf,
  assertReportConsistent,
  createStatusReport,
  decodeTestLog,
  parseTestSummary,
  statusFileName,
} from './lib/delivery-status.mjs'

const root = process.cwd()
const args = process.argv.slice(2)
const valueOf = (flag, fallback = null) => {
  const index = args.indexOf(flag)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const testLogPath = valueOf('--test-log')
const ciRunId = valueOf('--ci-run-id')
const status = valueOf('--status', 'success')
const stage = valueOf('--stage', 'done')
const failureReason = valueOf('--failure-reason')

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 测试日志按 BOM 解码。解码规则放在 lib 里，因为它有真实的失败模式需要被测试钉住 ——
 * 本机用 PowerShell 重定向出来的日志是 UTF-16LE，按 UTF-8 读会把 1170 项全过读成 0 项。
 */
function readLogText(path) {
  return decodeTestLog(readFileSync(path))
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const report = createStatusReport({ version })

const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
const repo = process.env.GITHUB_REPOSITORY ?? 'alicia1030su/dsh-ai-debate'
const sha = process.env.GITHUB_SHA ?? null
const refName = process.env.GITHUB_REF_NAME ?? null
const runId = process.env.GITHUB_RUN_ID ?? null

report.status = status
report.stage = stage
report.github.repo = repo
report.github.commitSha = sha
report.github.tag = refName !== null && /^v\d+\.\d+\.\d+$/.test(refName) ? refName : null
report.github.runs.release =
  runId === null ? null : { id: runId, url: `${serverUrl}/${repo}/actions/runs/${runId}` }
report.github.runs.ci =
  ciRunId === null ? null : { id: ciRunId, url: `${serverUrl}/${repo}/actions/runs/${ciRunId}` }

if (report.github.tag === null) {
  report.unverified.push('发布标签（本次运行不是由标签触发）')
}

// 没在版本标签上跑，就没有「发布成功」这回事 —— 手写 `--status success` 也不行。
// 这一次很可能是 workflow_dispatch 的 dry_run：产物建出来了，但 Release 一步被跳过。
// 报 `success` 会让后来读这份文件的人以为发过版；报 `blocked` 才是实话。
if (report.status === 'success' && report.github.tag === null) {
  report.status = 'blocked'
  report.stage = stage === 'done' ? 'release' : stage
  report.failure = {
    stage: report.stage,
    reason: `本次运行没有由版本标签触发（ref: ${refName ?? '未知'}），因此没有发布任何版本`,
    recovery: [
      '如果要发布：确认 main 上版本号已提交，再创建并推送对应标签',
      '如果只想要产物：这是 workflow_dispatch 的 dry_run 结果，产物在 Actions 的附件里',
    ],
  }
  console.error('::notice::本次运行不在版本标签上，交付状态记为 blocked（没有发布任何版本）')
}
if (report.github.runs.ci === null) {
  report.unverified.push('CI 运行编号与地址（发布工作流不查询同提交的 CI 运行）')
}

// --- 测试计数 -------------------------------------------------------------

// 测试文件数可以直接数：报告生成时仓库就在磁盘上。它与日志里的用例数一起，
// 让「少跑了一个文件」这种事在报告里看得见。
const testFileCount = readdirSync(join(root, 'test')).filter((name) => name.endsWith('.test.ts')).length

if (testLogPath !== null) {
  if (!existsSync(testLogPath)) {
    report.checks.tests = false
    report.unverified.push(`测试输出（找不到 ${testLogPath}）`)
  } else {
    const summary = parseTestSummary(readLogText(testLogPath))
    report.checks.tests = summary.consistent && summary.failed === 0 && (summary.total ?? 0) > 0
    report.tests = {
      files: testFileCount,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
    }
    if (!summary.consistent) {
      report.unverified.push('测试计数不自洽（总数与分项对不上，可能有测试进程崩了没写汇总）')
    }
    if (summary.total === null) {
      report.unverified.push('测试计数（测试输出里找不到汇总行）')
    }
  }
} else {
  report.checks.tests = null
  report.unverified.push('测试计数（没有传 --test-log，本次报告不声称测试跑过）')
}

// --- 产物 -----------------------------------------------------------------

const tarball = `dsh-ai-debate-${version}.tgz`
const sourceZip = `dsh-ai-debate-source-${version}.zip`
const artifacts = []

for (const [name, kind] of [
  [tarball, 'install'],
  [sourceZip, 'source'],
]) {
  const path = join(root, name)
  if (!existsSync(path)) {
    report.unverified.push(`${name}（文件不存在）`)
    continue
  }
  const bytes = readFileSync(path).length
  artifacts.push(artifactOf({ name, bytes, sha256: sha256Of(path), kind }))
}
report.artifacts = artifacts

report.checks.installArchive = artifacts.some((artifact) => artifact.kind === 'install')
report.checks.sourceArchive = artifacts.some((artifact) => artifact.kind === 'source')

// 这两个检查本脚本自己无法观测：它们是别的步骤的结论，由调用方通过 --note 转述。
report.checks.typecheck = null
report.checks.leakScan = null
report.checks.archiveScan = null
report.unverified.push('编译与类型检查（由工作流前面的步骤执行，本脚本不重跑）')
report.unverified.push('凭据与归档扫描（由工作流前面的步骤执行，本脚本不重跑）')

// --- 失败信息 -------------------------------------------------------------

if (status === 'failed' || status === 'blocked') {
  report.failure = {
    stage,
    reason: failureReason ?? '未提供失败原因',
    recovery: ['查看本次运行的 Actions 日志', '修复后重新运行发布工作流'],
  }
}

// --- 附加说明 -------------------------------------------------------------

for (const note of args.filter((arg) => arg.startsWith('--note='))) {
  report.notes.push(note.slice('--note='.length))
}

// --- 自洽校验 -------------------------------------------------------------

if (status === 'success') {
  try {
    assertReportConsistent(report)
  } catch (error) {
    // 声称成功却不自洽，说明这个报告本身在骗人。宁可变红，也不发出可疑证据。
    console.error(`::error::${error.message}`)
    report.status = 'failed'
    report.failure = {
      stage: 'verify_release',
      reason: error.message,
      recovery: ['补齐缺失的观测项后重新生成报告'],
    }
    const out = valueOf('--out', join(root, '.ship', statusFileName(version)))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.exit(1)
  }
}

const outPath = valueOf('--out', join(root, '.ship', statusFileName(version)))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('交付状态报告')
console.log(`  文件：    ${outPath}`)
console.log(`  状态：    ${status}`)
console.log(`  阶段：    ${stage}`)
console.log(`  版本：    ${version}`)
console.log(`  提交：    ${sha ?? '（未知）'}`)
console.log(`  标签：    ${report.github.tag ?? '（未知）'}`)
console.log(`  运行：    ${report.github.runs.release?.url ?? '（未知）'}`)
console.log(`  附件：    ${artifacts.map((artifact) => `${artifact.name} ${artifact.sha256.slice(0, 12)}…`).join(' / ') || '（无）'}`)
console.log(`  未验证：  ${report.unverified.length} 项`)
for (const item of report.unverified) console.log(`    · ${item}`)
