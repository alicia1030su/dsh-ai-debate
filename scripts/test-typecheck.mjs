#!/usr/bin/env node
/**
 * 测试代码的类型检查闸门（棘轮式）。
 *
 * ## 为什么不是「跑一下 tsc 看退出码」
 *
 * `tsconfig.test.json` 过去继承了基配置的 `exclude: ["node_modules","lib","test"]`，
 * 于是 `tsc -p tsconfig.test.json` 会「编译成功」，但 `--listFilesOnly` 里一个测试文件都没有。
 * 这个闸门在 v0.2.17 之前一直是绿的，而它什么都没检查 —— 绿得毫无意义。
 *
 * 修好 `exclude` 之后真相露出来了：**测试代码里现存几百条类型错误**。它们是历史债，
 * 多数是 `any` 与 mock 对象的结构不匹配，不影响运行时（三千多个测试照样全过）。
 *
 * 一次性清零不现实，但也不能因此把闸门关掉 —— 那就又退回「绿得毫无意义」。
 * 所以用棘轮：**记录当前错误数，只许变少，不许变多**。新代码引入的类型错误会立刻变红，
 * 而历史债被明确记在案，不会假装不存在。
 *
 * 用法：
 *   node scripts/test-typecheck.mjs            # 检查，超过基线则退出码 1
 *   node scripts/test-typecheck.mjs --update   # 把当前错误数写成新基线（只应在错误数下降后执行）
 *   node scripts/test-typecheck.mjs --verbose  # 打印全部错误
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BASELINE_PATH = join(ROOT, 'test-typecheck-baseline.json')
const CONFIG = join(ROOT, 'tsconfig.test.json')

const argv = new Set(process.argv.slice(2))
const update = argv.has('--update')
const verbose = argv.has('--verbose')

/** PowerShell 的 `>` 重定向写 UTF-16LE，CI 里是 UTF-8，两种都要能读。 */
function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8')
  return buffer.toString('utf8')
}

function runTsc() {
  // 直接用本进程的 node 跑 tsc 的入口，避免依赖 pnpm / PATH 里有没有 node。
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) {
    console.error('::error::找不到本地 typescript，请先 pnpm install --frozen-lockfile')
    process.exit(1)
  }
  try {
    const stdout = execFileSync(process.execPath, [tsc, '-p', CONFIG, '--pretty', 'false'], {
      cwd: ROOT,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, output: decode(stdout) }
  } catch (error) {
    const parts = []
    if (error.stdout) parts.push(decode(error.stdout))
    if (error.stderr) parts.push(decode(error.stderr))
    return { code: error.status ?? 1, output: parts.join('') }
  }
}

/** 只统计测试与辅助文件的问题；src/ 已经有 `tsc -p tsconfig.json` 这道更严的闸门。 */
function parseErrors(output) {
  const errors = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^((?:test|scripts)\/[^(]+)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line)
    if (!match) continue
    errors.push({ file: match[1], line: Number(match[2]), code: match[4], message: match[5] })
  }
  return errors
}

const { code, output } = runTsc()
const errors = parseErrors(output)

if (errors.length === 0 && code !== 0) {
  // tsc 失败却没有可归属的错误行：配置坏了、找不到文件之类。不能当成「零错误」放过去。
  console.error('::error::tsc 退出码非 0，但输出里没有可归属的错误行 —— 先看完整输出：')
  console.error(output.trim().slice(0, 4000) || '（空输出）')
  process.exit(1)
}

const byFile = new Map()
for (const error of errors) {
  byFile.set(error.file, (byFile.get(error.file) ?? 0) + 1)
}
const byCode = new Map()
for (const error of errors) {
  byCode.set(error.code, (byCode.get(error.code) ?? 0) + 1)
}

if (verbose) {
  for (const error of errors) console.log(`${error.file}(${error.line}): ${error.code} ${error.message}`)
}

if (update) {
  const baseline = {
    schema: 1,
    baseline: errors.length,
    updatedAt: new Date().toISOString(),
    note: '测试代码里已知的类型错误数。只许下降：这个数字变大说明新代码引入了新的类型错误，闸门会变红。改小之后请用 node scripts/test-typecheck.mjs --update 收紧基线。',
    worstFiles: [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([file, count]) => ({ file, count })),
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  console.log(`基线已更新：${errors.length} 条`)
  process.exit(0)
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`::error::缺少基线文件 ${BASELINE_PATH}，先用 node scripts/test-typecheck.mjs --update 生成`)
  process.exit(1)
}

let baseline
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
} catch (error) {
  console.error(`::error::基线文件不是合法 JSON：${error.message}`)
  process.exit(1)
}
if (typeof baseline?.baseline !== 'number' || !Number.isInteger(baseline.baseline)) {
  console.error('::error::基线文件缺少整数 baseline 字段')
  process.exit(1)
}

console.log(`测试类型检查：当前 ${errors.length} 条，基线 ${baseline.baseline} 条`)

if (errors.length > baseline.baseline) {
  const grew = errors.length - baseline.baseline
  const sorted = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  console.error(`::error::测试代码新增了 ${grew} 条类型错误（${baseline.baseline} → ${errors.length}）`)
  console.error('这通常意味着新写的测试与真实类型不符 —— 请改测试，不要去调高基线。')
  for (const [file, count] of sorted) console.error(`  ${file}: ${count}`)
  const codes = [...byCode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  console.error(`常见类型：${codes.map(([code, count]) => `${code}×${count}`).join('，')}`)
  console.error('要看全部：node scripts/test-typecheck.mjs --verbose')
  process.exit(1)
}

if (errors.length < baseline.baseline) {
  console.log(`比基线少了 ${baseline.baseline - errors.length} 条 —— 可以执行 node scripts/test-typecheck.mjs --update 收紧基线。`)
}

console.log(`测试类型检查：通过（未超过基线）`)
