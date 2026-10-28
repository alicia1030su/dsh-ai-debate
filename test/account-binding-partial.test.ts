/**
 * A partial config must not crash the account resolver.
 *
 * ## The defect
 *
 * `resolveBindings` reads the legacy global fields — `ownerUserId`, `ownerUserName`,
 * `allowedOwnerIds`, `aiAccountUserId`, `aiAccountName` — and called `.trim()` on each
 * unconditionally. A *resolved* config always has all five, so this never fired in
 * production. But:
 *
 * - `runPublish` resolves the publishing account through `bindingsOf(config)`, and
 * - tests commonly hand the publisher a two-field object (`{ aiAccountUserId }`), and
 * - any future caller that builds the account fields by hand would do the same,
 *
 * so the miss surfaced as `Cannot read properties of undefined (reading 'trim')` in the
 * middle of a publish. That message names no field, no platform and no setting, which
 * makes it one of the least actionable errors this plugin can produce: it looks like a
 * bug in the publisher rather than a missing config key.
 *
 * `parsePlatformAccounts` had the identical shape (`raw.trim()` on a possibly-undefined
 * field), and `platformSettingsOf` a third (`config.tiebaCookie.trim()`). All three now
 * read absent as "not configured", which is what their own doc comments already said
 * malformed input should do.
 *
 * ## Why the assertions are about *shape*, not just "does not throw"
 *
 * `bindingsOf` returning some object is not enough: reading absent as empty has to
 * produce the same binding as reading it as `''`, or a partial config would silently
 * bind an account to nothing-a-platform and the publish would then be refused for
 * `identity_unbound` instead of using the account it was given.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { bindingsOf, platformSettingsOf } from '../lib/runtime.js'
import { aiAccountFor, ownerFor } from '../lib/platforms/accounts.js'

/** A partial config as a test double or a hand-built caller would supply it. */
type PartialConfig = Record<string, unknown>

test('bindingsOf accepts a config carrying only the AI account id', () => {
  assert.doesNotThrow(() => bindingsOf({ aiAccountUserId: '1001' } as never))
  const binding = bindingsOf({ aiAccountUserId: '1001' } as never)
  const account = aiAccountFor(binding, 'tieba')
  assert.equal(account?.account.accountId, '1001', 'the one field that was present must still bind')
})

test('bindingsOf accepts a config carrying only the AI account name', () => {
  const binding = bindingsOf({ aiAccountName: 'ai-account' } as never)
  const account = aiAccountFor(binding, 'tieba')
  assert.equal(account?.account.displayName, 'ai-account')
  // A name-only binding is weaker and the resolver must say so, or the analyzer will
  // treat it as a stable id.
  assert.equal(account?.account.idStrength, 'name_only')
})

test('bindingsOf accepts a config carrying only the owner fields', () => {
  const binding = bindingsOf({ ownerUserId: 'owner-1' } as never)
  const owner = ownerFor(binding, 'tieba')
  assert.equal(owner?.primary.accountId, 'owner-1')
  // No AI account was configured, so none may be invented.
  assert.equal(aiAccountFor(binding, 'tieba'), undefined)
})

test('an absent legacy field means the same as an empty one', () => {
  // The load-bearing property. If absent and '' diverged, a partial config would bind
  // differently from a complete one and the difference would be invisible.
  const absent = bindingsOf({ aiAccountUserId: '1001' } as never)
  const empty = bindingsOf({
    aiAccountUserId: '1001',
    aiAccountName: '',
    ownerUserId: '',
    ownerUserName: '',
    allowedOwnerIds: '',
  } as never)
  assert.deepEqual(absent, empty)
})

test('bindingsOf accepts a completely empty config', () => {
  // Nothing configured is a legitimate state: reading and drafting work without a
  // binding, and only publishing refuses. It must not be a crash.
  const binding = bindingsOf({} as never)
  assert.deepEqual(binding, { owners: [], aiAccounts: [] })
})

test('an absent platformAccounts field falls back to the legacy bindings', () => {
  // `parsePlatformAccounts` used to throw here. The documented contract is that
  // unusable input falls back so the legacy globals take over.
  const binding = bindingsOf({ aiAccountUserId: '1001' } as never)
  assert.equal(aiAccountFor(binding, 'tieba')?.account.accountId, '1001')
})

test('a malformed platformAccounts field still falls back rather than throwing', () => {
  // The contract predates this fix and must not regress: one typo in the JSON field
  // cannot take the plugin down.
  const binding = bindingsOf({
    aiAccountUserId: '1001',
    platformAccounts: '{ not json',
  } as never)
  assert.equal(aiAccountFor(binding, 'tieba')?.account.accountId, '1001')
})

test('structured bindings win over the legacy pair', () => {
  const binding = bindingsOf({
    aiAccountUserId: '1001',
    platformAccounts: JSON.stringify({
      owners: [],
      aiAccounts: [
        { platform: 'tieba', account: { platform: 'tieba', accountId: '9009', idStrength: 'stable' } },
      ],
    }),
  } as never)
  assert.equal(aiAccountFor(binding, 'tieba')?.account.accountId, '9009')
})

test('platformSettingsOf tolerates an absent legacy cookie', () => {
  // Third site of the same defect: `.trim()` on a field a partial config lacks. The
  // Tieba adapter then received `cookie: undefined`, which is correct — there is no
  // legacy cookie to send.
  const settings = platformSettingsOf({ tiebaCookie: undefined } as never, 'tieba') as {
    cookie?: string
  }
  assert.equal(settings.cookie, undefined)

  const configured = platformSettingsOf({ tiebaCookie: '  ST=abc  ' } as never, 'tieba') as {
    cookie?: string
  }
  assert.equal(configured.cookie, 'ST=abc', 'a configured cookie is still trimmed and passed')

  const blank = platformSettingsOf({ tiebaCookie: '   ' } as never, 'tieba') as {
    cookie?: string
  }
  assert.equal(blank.cookie, undefined, 'whitespace only is not a cookie')
})

test('a non-Tieba platform never receives the legacy cookie', () => {
  // The security property this function exists for: the legacy cookie belongs to one
  // platform and must not leak into another platform's adapter settings.
  const settings = platformSettingsOf({ tiebaCookie: 'ST=secret' } as never, 'fake-a') as {
    cookie?: string
  }
  assert.equal(settings.cookie, undefined)
})

// Silence the unused-type warning while keeping the alias documented.
export const _partialConfigType: PartialConfig = {}
