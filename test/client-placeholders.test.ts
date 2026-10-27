/**
 * Placeholder/key agreement between the status panel's templates and the
 * payload the Host actually sends.
 *
 * This is a narrow test for a defect that a screenshot found and no test did:
 * `sessionsDetail` was written as "待确认 {awaiting}" while the route returns
 * `awaitingConfirmation`, and `usageDetail` asked for `{input}`/`{output}` while
 * the route returns `inputTokens`/`outputTokens`. `format()` leaves an unknown
 * placeholder untouched, so the panel rendered the literal text
 * "待确认 {awaiting}" and "输入 {input} tokens" — visible to the user, silent to
 * every existing test, because both halves were individually well-formed.
 *
 * The rule enforced here: for every template `format()` is called with, every
 * `{name}` in it must exist as a key of the object passed alongside it, and the
 * key sets are read from the TypeScript source rather than copied by hand so a
 * future field rename breaks this test instead of the UI.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')

/** The `{name}` tokens a template asks `format()` to fill. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)
}

/** Every `name: '...'` string literal inside the locale blocks. */
function localeStrings(source: string, key: string): string[] {
  const pattern = new RegExp(`\\b${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g')
  return [...source.matchAll(pattern)].map((match) => match[1]!)
}

/** The property names of the object type named `name` in the route source. */
function payloadKeys(source: string, name: string): Set<string> {
  const index = source.indexOf(`${name}: {`)
  assert.ok(index >= 0, `could not find "${name}" in the route source`)
  const body = source.slice(index + name.length + 2)
  const end = body.indexOf('}')
  assert.ok(end > 0, `could not find the end of "${name}"`)
  const keys = new Set<string>()
  for (const match of body.slice(0, end).matchAll(/(\w+)\s*:/g)) keys.add(match[1]!)
  return keys
}

test('every placeholder in the status panel exists on the payload it is given', () => {
  const client = readFileSync(join(ROOT, 'client', 'client.cjs'), 'utf8')
  const routes = readFileSync(join(ROOT, 'src', 'settings-routes.ts'), 'utf8')

  const pairs: { template: string; payload: Set<string>; where: string }[] = [
    { key: 'sessionsDetail', payload: payloadKeys(routes, 'sessions'), where: 'status.sessions' },
    { key: 'ledgerDetail', payload: payloadKeys(routes, 'publishLedger'), where: 'status.publishLedger' },
    { key: 'usageDetail', payload: payloadKeys(routes, 'usage'), where: 'status.usage' },
  ].map((entry) => {
    const templates = localeStrings(client, entry.key)
    assert.ok(templates.length > 0, `no locale strings found for "${entry.key}"`)
    return { templates, payload: entry.payload, where: entry.where }
  })

  const problems: string[] = []
  for (const pair of pairs) {
    for (const template of pair.templates) {
      for (const name of placeholders(template)) {
        if (!pair.payload.has(name)) {
          problems.push(`${pair.where}: template needs {${name}}, payload has only ${[...pair.payload].join(', ')}`)
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('the formatter itself leaves unknown placeholders visible rather than blanking them', () => {
  // The behaviour that let the defect ship quietly: an unknown key is not an
  // error, it is echoed. Pinning it here documents why the test above is the
  // only thing standing between a rename and a broken panel.
  const client = readFileSync(join(ROOT, 'client', 'client.cjs'), 'utf8')
  const declared = /function format\(template, values\) \{\s*return String\(template\)\.replace\(\/\\\{\(\\w\+\)\\\}\/g, \(whole, key\) =>\s*values && key in values \? String\(values\[key\]\) : whole,?\s*\)\s*\}/
  assert.ok(declared.test(client), 'format() must keep echoing unknown placeholders')
})