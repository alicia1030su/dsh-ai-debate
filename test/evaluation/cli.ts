/**
 * Run the corpus against the build this file sits next to, and write a run record.
 *
 * ```bash
 * node --experimental-transform-types test/evaluation/cli.ts --out .eval/v0235.json
 * ```
 *
 * ## Why a CLI and not only the test suite
 *
 * A comparison needs two records produced by the **same scorer** against **different
 * builds**. That means the scorer must be runnable from inside an older checkout, which is
 * what `scripts/eval-compare.mjs` sets up: it copies this directory into the baseline
 * worktree and calls this file there. A test file could not be invoked that way without
 * pulling in the current build's `lib/`.
 *
 * The record says which mode produced it (`realModel`) and which model, so a report can
 * never present scripted numbers as if a model had generated them.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { runScripted, pluginVersion } from './run-metrics.ts'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const out = arg('out')
if (out === undefined) {
  process.stderr.write('缺少 --out：必须把结果写到文件，否则这次运行不可比较\n')
  process.exit(2)
}

const record = await runScripted()
const target = resolve(out)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

const empty = record.cases.filter((item) => item.reply === '').length
process.stdout.write(
  `已写入 ${target}\n` +
    `版本 ${record.version}　案例 ${record.cases.length} 个　空回复 ${empty} 个\n` +
    `产物版本标记（编译期）：${pluginVersion()}\n`,
)
