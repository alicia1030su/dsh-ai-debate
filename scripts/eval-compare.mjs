/**
 * Compare two builds on the same corpus, using the same scorer.
 *
 * ```bash
 * node scripts/eval-compare.mjs --baseline ../wt-v034 --out .eval
 * ```
 *
 * ## Why a script and not "run it twice by hand"
 *
 * The comparison is only meaningful if the two runs differ in **exactly one thing**. By
 * hand, the things that differ are: the scorer version, the fixtures, the persona, the
 * budget preset, and — easiest to forget — which `package.json` supplied the version label.
 * This script copies the *current* scorer next to the *baseline* build, so both runs score
 * with the same code and only the build under test changes.
 *
 * ## Why the baseline is assembled in a scratch directory
 *
 * Running the scorer inside the baseline worktree would mean writing `test/` into someone
 * else's checkout — a modification this round has no business making, and one that would
 * leave a dirty tree if anything failed halfway. Instead the baseline's `lib/` and
 * `package.json` are copied into a scratch directory *inside this workspace*, the scorer is
 * copied next to them, and the run happens there. Nothing outside this directory changes.
 *
 * ## What it refuses to do
 *
 * It will not print "improved" when the baseline build is missing. A missing baseline is
 * reported as exactly that, with the command to build one. Treating "no baseline" as zero
 * and reporting a large gain is the failure mode this file exists to prevent.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '..')

/** Read one `--name value` argument. */
function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const baselineDir = arg('baseline')
const outDir = resolve(arg('out', join(root, '.eval')))
const nodeBin = process.execPath

if (baselineDir === '') {
  process.stderr.write(
    '缺少 --baseline。用法：\n' +
      '  node scripts/eval-compare.mjs --baseline <基线工作树路径> [--out .eval]\n' +
      '\n' +
      '基线工作树必须已经构建过（存在 lib/generator.js）。\n',
  )
  process.exit(2)
}

const baselineRoot = resolve(baselineDir)
if (!existsSync(join(baselineRoot, 'package.json'))) {
  process.stderr.write(`基线目录 ${baselineRoot} 看起来不是这个项目的工作树\n`)
  process.exit(2)
}
if (!existsSync(join(baselineRoot, 'lib', 'generator.js'))) {
  process.stderr.write(
    `基线 ${baselineRoot} 还没有构建产物（lib/generator.js 不存在）。\n` +
      '请先在那个工作树里编译一次，本脚本不会替你改别人的工作树。\n',
  )
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })

/** 把基线的产物放进一个临时目录：只复制 lib 与 package.json。 */
const scratch = join(root, 'tmp', 'eval-baseline')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'test'), { recursive: true })
cpSync(join(baselineRoot, 'lib'), join(scratch, 'lib'), { recursive: true })
cpSync(join(baselineRoot, 'package.json'), join(scratch, 'package.json'))
// 评分器与夹具用**当前**这份，保证两边量的是同一把尺子。
cpSync(join(root, 'test', 'evaluation'), join(scratch, 'test', 'evaluation'), { recursive: true })

/** Run one evaluation and return the record path. */
function runEval(worktree, label) {
  const outFile = join(outDir, `${label}.json`)
  const result = spawnSync(
    nodeBin,
    ['--experimental-transform-types', join(worktree, 'test', 'evaluation', 'cli.ts'), '--out', outFile],
    { cwd: worktree, encoding: 'utf8', stdio: 'pipe' },
  )
  if (result.status !== 0) {
    process.stderr.write(
      `\n✖ ${label} 运行失败（退出码 ${result.status}）\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n`,
    )
    process.exit(result.status ?? 1)
  }
  process.stdout.write(result.stdout ?? '')
  return outFile
}

const baselineFile = runEval(scratch, 'baseline')
const candidateFile = runEval(root, 'candidate')

/** 比较。两次运行用的是同一份评分器，所以这里加载的也是同一份。 */
const { compareRuns, formatComparison } = await import(
  pathToFileURL(join(root, 'test', 'evaluation', 'compare.ts')).href,
)
const { parseRun } = await import(pathToFileURL(join(root, 'test', 'evaluation', 'run-metrics.ts')).href)

const baseline = parseRun(readFileSync(baselineFile, 'utf8'))
const candidate = parseRun(readFileSync(candidateFile, 'utf8'))

const report = compareRuns(baseline, candidate)
const text = formatComparison(report)
const reportFile = join(outDir, 'comparison.md')
writeFileSync(reportFile, text, 'utf8')

process.stdout.write(`\n${text}\n已写入 ${reportFile}\n`)
if (!report.comparable) process.exit(3)
