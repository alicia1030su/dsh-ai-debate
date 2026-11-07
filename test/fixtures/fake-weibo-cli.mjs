/**
 * A stand-in for the official `weibo-cli`, driven by a JSON script.
 *
 * ## Why this exists
 *
 * The machine that built this plugin has no `weibo-cli`, no developer qualification and no
 * OAuth login, so **no real Weibo read has ever run here**. But "does the adapter actually
 * invoke a command, with the right arguments, and convert the answer correctly" is a
 * different question from "does Weibo's real API return this shape" — and the first one can
 * be answered honestly with a fake executable.
 *
 * ## What it is and is not
 *
 * - It **is** a real child process, spawned by the real `execFile` call path in `cli.ts`.
 *   Nothing about the invocation layer is mocked.
 * - It **is not** evidence that the real platform behaves this way. A passing test here
 *   proves the wiring, not the platform.
 *
 * ## How it decides what to answer
 *
 * Reads `FAKE_CLI_SCRIPT` (a JSON file) which maps `argv.join(' ')` prefixes to responses.
 * Writes the argv it received to `FAKE_CLI_LOG` so a test can assert the **exact**
 * arguments — that is how "we passed the mid, not the URL" gets proven.
 */

import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)

const logPath = process.env.FAKE_CLI_LOG

// Record every invocation before answering, so a test can inspect calls even when the
// script has no matching entry.
//
// ## 并发写日志会抛 EBUSY / EPERM，而此时**不能崩**（v0.2.33）
//
// 产品代码现在会并发探测（`probeWeiboCli()` 与 `listAvailableCommands()` 同时跑、
// 正文与评论两条候选链同时跑），于是同一个假 CLI 会被多个进程同时启动，同时
// `appendFileSync` 到同一个日志文件。Windows 上这不是原子的：第二个写入者会拿到
// `EBUSY` / `EPERM`，进程随之中断——父进程看到的是「空输出 + 非零退出」，
// 被分类成「weibo-cli 调用失败。」。
//
// 表现是**几个不同的用例偶发地红，单独跑却 20 次全过**。第一版用
// `process.exitCode` 替换 `process.exit()` 只治了「输出被截断」那一半，
// 没治这一半。
//
// 日志是测试的观测手段，不是产品的输出。观测手段不该让被测对象崩溃：
// 写不进去就跳过这一次记录，并在 stderr 留一句可追的说明。
try {
  if (logPath !== undefined && logPath !== '') {
    appendFileSync(logPath, `${JSON.stringify(args)}\n`, 'utf8')
  }
} catch (error) {
  try {
    process.stderr.write(`fake-cli: 日志写入失败（${error?.code ?? 'unknown'}），本次不记录\n`)
  } catch {
    // 连 stderr 都写不进去时保持沉默：这不是产品该关心的事。
  }
}

const scriptPath = process.env.FAKE_CLI_SCRIPT
if (scriptPath === undefined || scriptPath === '') {
  // 同样不能 `process.exit(2)` 就完事：见文件末尾那段说明。
  process.stderr.write('fake-cli: FAKE_CLI_SCRIPT is not set\n')
  process.exitCode = 2
} else {
  /** @type {{ rules: Array<{ match: string, stdout?: string, stderr?: string, exit?: number }> }} */
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'))

  const joined = args.join(' ')
  // Longest match first: `commands show statuses/show` must not be caught by a `commands`
  // rule, and a more specific rule is always the more intentional one.
  const rules = [...script.rules].sort((a, b) => b.match.length - a.match.length)
  const rule = rules.find((candidate) => joined.startsWith(candidate.match))

  if (rule === undefined) {
    process.stderr.write(`fake-cli: no rule for "${joined}"\n`)
    process.exitCode = 3
  } else {
    if (rule.stdout !== undefined) process.stdout.write(rule.stdout)
    if (rule.stderr !== undefined) process.stderr.write(rule.stderr)
    process.exitCode = rule.exit ?? 0
  }
}
