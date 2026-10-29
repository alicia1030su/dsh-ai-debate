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

// Record every invocation before answering, so a test can inspect calls even when the
// script has no matching entry.
const logPath = process.env.FAKE_CLI_LOG
if (logPath !== undefined && logPath !== '') {
  appendFileSync(logPath, `${JSON.stringify(args)}\n`, 'utf8')
}

const scriptPath = process.env.FAKE_CLI_SCRIPT
if (scriptPath === undefined || scriptPath === '') {
  process.stderr.write('fake-cli: FAKE_CLI_SCRIPT is not set\n')
  process.exit(2)
}

/** @type {{ rules: Array<{ match: string, stdout?: string, stderr?: string, exit?: number }> }} */
const script = JSON.parse(readFileSync(scriptPath, 'utf8'))

const joined = args.join(' ')
// Longest match first: `commands show statuses/show` must not be caught by a `commands`
// rule, and a more specific rule is always the more intentional one.
const rules = [...script.rules].sort((a, b) => b.match.length - a.match.length)
const rule = rules.find((candidate) => joined.startsWith(candidate.match))

if (rule === undefined) {
  process.stderr.write(`fake-cli: no rule for "${joined}"\n`)
  process.exit(3)
}

if (rule.stdout !== undefined) process.stdout.write(rule.stdout)
if (rule.stderr !== undefined) process.stderr.write(rule.stderr)
process.exit(rule.exit ?? 0)
