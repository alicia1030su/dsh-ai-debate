/**
 * Run the quality channel against a real model endpoint.
 *
 * ```bash
 * node --experimental-transform-types test/evaluation/run-quality.ts \
 *   --base-url http://127.0.0.1:11434/v1 \
 *   --model qwen2.5:7b \
 *   --out .eval/quality.json
 * ```
 *
 * ## Why this is a separate entry point
 *
 * The unit suite must stay hermetic: no network, no key, no surprise bill. This file is the
 * only thing in the repository that calls a real endpoint, and it is never imported by a test.
 *
 * ## What it refuses to do
 *
 * Without `--base-url` and `--model` it exits non-zero with a message, rather than falling
 * back to "0 cases scored, 0 failures" — a run that measured nothing must not look like a run
 * that measured everything and found no problems.
 *
 * The API key, when needed, comes from the environment (`DSH_EVAL_API_KEY`) or `--api-key`.
 * It is never written into the report.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { OpenAiCompatibleClient } from '../../lib/llm.js'
import { ALL_CASES } from './index.ts'
import { formatReport, runQuality } from './evaluate-model.ts'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const baseUrl = arg('base-url') ?? process.env.DSH_EVAL_BASE_URL ?? ''
const model = arg('model') ?? process.env.DSH_EVAL_MODEL ?? ''
const apiKey = arg('api-key') ?? process.env.DSH_EVAL_API_KEY ?? ''
const outPath = arg('out') ?? ''
const maxCasesRaw = arg('max-cases')
const timeoutMs = Number(arg('timeout-ms') ?? '120000')

if (baseUrl === '' || model === '') {
  process.stderr.write(
    '缺少模型配置。\n' +
      '用法：node --experimental-transform-types test/evaluation/run-quality.ts \\\n' +
      '        --base-url <OpenAI 兼容地址，如 http://127.0.0.1:11434/v1> \\\n' +
      '        --model <模型名> [--api-key <key>] [--max-cases N] [--out 报告路径]\n' +
      '\n' +
      '没有配置时不会假装跑过：这个命令必须以非零退出，\n' +
      '否则「0 个案例通过」看起来会和「全部通过」一样。\n',
  )
  process.exit(2)
}

const client = new OpenAiCompatibleClient({
  baseUrl,
  apiKey,
  model,
  timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 120_000,
})

const maxCases = maxCasesRaw === undefined ? undefined : Number(maxCasesRaw)
if (maxCases !== undefined && (!Number.isFinite(maxCases) || maxCases <= 0)) {
  process.stderr.write(`--max-cases 必须是正整数，收到 ${maxCasesRaw}\n`)
  process.exit(2)
}

const started = Date.now()
const report = await runQuality(client, {
  ...(maxCases === undefined ? {} : { maxCases }),
  ...(outPath === '' ? {} : { outPath }),
})
const elapsed = Date.now() - started

process.stdout.write(`${formatReport(report)}\n`)
process.stdout.write(`\n耗时：${(elapsed / 1000).toFixed(1)} 秒\n`)

// A run that produced no scores at all is a failed run, not a clean one.
if (report.totals.dimensionsTotal === 0) {
  process.stderr.write('\n没有产生任何评分：检查接口地址、模型名与网络。\n')
  process.exit(1)
}

// `--out` is written by `runQuality`; also drop a sibling text report so the numbers and the
// prose explaining them travel together.
if (outPath !== '') {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath.replace(/\.json$/, '.txt'), `${formatReport(report)}\n`, 'utf8')
}

process.stdout.write(`已覆盖 ${report.totals.scored}/${ALL_CASES.length} 个案例\n`)
