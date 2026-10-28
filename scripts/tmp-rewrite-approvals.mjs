/**
 * Insert a real approval record before each publish that relied on the removed
 * `humanApproved: true` shortcut.
 *
 * ## History: why this is the fourth version
 *
 * 1. A 40-line look-ahead decided whether to insert, then a file-wide `replace`
 *    deleted the flag. Different matchers, so the delete hit calls the insert had
 *    skipped: 25 flags vanished with nothing in their place.
 * 2. It only understood `publishCandidate(...)`; most sites go through
 *    `runPublish(runtime, {...})`, so 26 of 27 were skipped.
 * 3. It edited the text while walking it, so a single cursor tried to track how
 *    much every earlier edit had shifted later offsets. It got that arithmetic
 *    wrong and rewrote one call per file.
 *
 * This version does not edit while scanning. It records (lineIndex, text) pairs
 * against the untouched source, then splices them in from the bottom up, so no
 * recorded position can drift. Slow is fine here; wrong is not.
 *
 * ## Call shapes it knows
 *
 *   publishCandidate({ adapter, store, ... }, { sessionId, candidateId, ... })
 *   runPublish(runtime, { sessionId, candidateId, ... })
 *
 * ## What it leaves alone, deliberately
 *
 * - `checkPublishPolicy(...)`: a pure function whose `humanApproved` input is
 *   legitimate and stays.
 * - A call whose `sessionId` is a literal naming no stored session (`'any'`, `'x'`):
 *   those tests assert a failure that happens before authorisation (a dirty store,
 *   a read error), so adding a record would change what they prove.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'C:/Users/23866/Documents/deepseek-harness/default-workspace/dsh-ai-debate/test'

const FILES = [
  'dedupe-ledger.test.ts',
  'identity-and-limits.test.ts',
  'pipeline.test.ts',
  'platform-contract.test.ts',
  'platform-routing.test.ts',
  'publish-credential-gate.test.ts',
  'publisher-safety.test.ts',
  'trigger-identity.test.ts',
  'verification-and-auth.test.ts',
]

const PHANTOM = new Set(["'any'", '"any"', "'x'", '"x"', "'none'", "'s-any'"])

let total = 0
const report = []

for (const name of FILES) {
  const file = path.join(ROOT, name)
  const source = fs.readFileSync(file, 'utf8')
  const result = rewrite(source, name)
  if (result.insertions.length > 0) fs.writeFileSync(file, result.text, 'utf8')
  total += result.insertions.length
  report.push(
    `${name}: 插入 ${result.insertions.length}，跳过 ${result.skipped.length}，无关 ${result.ignored}`,
  )
  for (const note of result.skipped) report.push(`    ! ${note}`)
}

console.log(`插入总数: ${total}`)
for (const line of report) console.log('  ' + line)

/** Plan every insertion against `source`, then splice bottom-up. */
function rewrite(source, fileName) {
  const lines = source.split('\n')
  // Absolute offset of the start of each line, so paren matching can walk the
  // whole file while the line index stays meaningful.
  const offsets = []
  let running = 0
  for (const line of lines) {
    offsets.push(running)
    running += line.length + 1
  }

  const insertions = []
  const skipped = []
  let ignored = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    if (/^import\b/.test(line) || /\bfrom '/.test(line)) continue

    // Look for either callee anywhere on the line: the call is routinely
    // introduced by `const report = await ...`, so anchoring on the callee at the
    // start of the line missed almost every site.
    let callee
    let column = -1
    for (const name of ['publishCandidate', 'runPublish']) {
      const found = line.indexOf(`${name}(`)
      if (found >= 0 && (column < 0 || found < column)) {
        callee = name
        column = found
      }
    }
    if (callee === undefined) continue
    const open = offsets[index] + column + callee.length
    const close = matchParen(source, open)
    if (close < 0) {
      skipped.push(`L${index + 1} 括号不匹配`)
      continue
    }
    const block = source.slice(open, close + 1)
    if (!/humanApproved:\s*true/.test(block)) {
      ignored += 1
      continue
    }

    const firstEnd = findFirstArgEnd(source, open)
    const head = source.slice(open, firstEnd + 1)

    let store
    let configExpr
    if (callee === 'publishCandidate') {
      // The deps object is written both ways in this suite:
      //   { adapter, store, policy: DEFAULT_POLICY, config: BOUND_ACCOUNT }
      //   { adapter: a, store: s, ... }
      // A `store:`-only regex silently skipped every shorthand site, which is
      // nearly all of publisher-safety.test.ts.
      store = /store:\s*([A-Za-z_$][\w$.]*)/.exec(head)?.[1]
      if (store === undefined && /(?:^|[\s,{])store(?:[\s,}])/.test(head)) store = 'store'
      configExpr = /config:\s*([A-Za-z_$][\w$.]*)/.exec(head)?.[1]
    } else {
      const runtimeExpr = source.slice(open + 1, firstEnd).trim()
      store = `${runtimeExpr}.store`
      configExpr = `${runtimeExpr}.config`
    }

    const sessionId = /sessionId:\s*([^,\n]+)/.exec(block)?.[1].trim()
    const candidateId = /candidateId:\s*([^,\n]+)/.exec(block)?.[1].trim()

    if (store === undefined || sessionId === undefined || candidateId === undefined) {
      skipped.push(`L${index + 1} 解析不出 store/sessionId/candidateId`)
      continue
    }
    if (PHANTOM.has(sessionId)) {
      skipped.push(`L${index + 1} sessionId ${sessionId} 指向不存在的会话，按设计不授权`)
      continue
    }

    const indent = /^[ \t]*/.exec(line)[0]
    const configArg = configExpr === undefined ? '' : `, config: ${configExpr}`
    insertions.push({
      // Before the line the call starts on, not after it: the call's arguments
      // span several lines, so inserting after the first line would splice the
      // approval into the middle of the argument list.
      afterLine: index - 1,
      lines: [
        `${indent}// v0.2.5: a stored approval authorises the send; \`humanApproved\` is`,
        `${indent}// ignored by the publisher now, so create the record the old flag stood for.`,
        `${indent}await grantApproval(${store}, { sessionId: ${sessionId}, candidateId: ${candidateId}${configArg} })`,
      ],
    })
  }

  // Splice from the bottom so earlier line indices stay valid.
  const output = [...lines]
  for (const insertion of [...insertions].sort((a, b) => b.afterLine - a.afterLine)) {
    output.splice(insertion.afterLine + 1, 0, ...insertion.lines)
  }

  // Clean up any `humanApproved: true` the insertions now make redundant. Done as
  // one targeted pass over calls we actually authorised, so a call we skipped keeps
  // whatever it had — its flag is inert either way, and removing it would erase the
  // intent the test author recorded.
  let text = output.join('\n')
  if (insertions.length > 0) {
    text = text.replace(/(\n[ \t]*humanApproved:\s*true,?(?=\s*\n))/g, '')
    text = ensureImport(text, fileName)
  }
  return { text, insertions, skipped, ignored }
}

/** Index of the `)` closing the `(` at `open`, skipping strings and comments. */
function matchParen(text, open) {
  if (text[open] !== '(') return -1
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === "'" || ch === '"' || ch === '`') {
      index = skipString(text, index)
      continue
    }
    if (ch === '/' && text[index + 1] === '/') {
      const next = text.indexOf('\n', index)
      if (next < 0) return -1
      index = next
      continue
    }
    if (ch === '/' && text[index + 1] === '*') {
      const next = text.indexOf('*/', index + 2)
      if (next < 0) return -1
      index = next + 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Index of the comma or `)` that ends the first argument of the call at `open`. */
function findFirstArgEnd(text, open) {
  let depth = 1
  for (let index = open + 1; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === "'" || ch === '"' || ch === '`') {
      index = skipString(text, index)
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1
      if (depth === 0) return index
    } else if (ch === ',' && depth === 1) return index
  }
  return -1
}

/** Index of the closing quote of the string starting at `start`. */
function skipString(text, start) {
  const quote = text[start]
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1
      continue
    }
    if (text[index] === quote) return index
  }
  return text.length - 1
}

/** Make sure `grantApproval` is imported. */
function ensureImport(text, fileName) {
  const head = text.split('\n').slice(0, 80).join('\n')
  if (/grantApproval/.test(head)) return text

  if (/from '(?:\.\.?\/)+helpers\.ts'/.test(text)) {
    return text.replace(
      /import \{([\s\S]*?)\} from '((?:\.\.?\/)+helpers\.ts)'/,
      (_match, names, spec) => {
        const trimmed = String(names).replace(/\s+$/, '')
        return `import {${trimmed}${trimmed.endsWith(',') ? '' : ','} grantApproval } from '${spec}'`
      },
    )
  }

  // A file with its own fixtures still needs the helper: group a standalone import
  // after the last top-level import statement.
  const lines = text.split('\n')
  let lastImport = -1
  let inBlock = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^import /.test(line)) {
      lastImport = index
      inBlock = !/from '.*'\s*$/.test(line) && !/;\s*$/.test(line)
      continue
    }
    if (inBlock) {
      lastImport = index
      if (/from '.*'\s*$/.test(line)) inBlock = false
    }
  }
  if (lastImport < 0) throw new Error(`${fileName}: 找不到任何 import，需手工补 grantApproval`)
  lines.splice(lastImport + 1, 0, "import { grantApproval } from './helpers.ts'")
  return lines.join('\n')
}
