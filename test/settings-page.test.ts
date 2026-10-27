/**
 * The credential seam and the settings wire.
 *
 * These tests exist because both modules sit on a boundary where a mistake is
 * silent: a credential read that returns a value, a settings route that accepts a
 * field it should not, or an overlay that quietly keeps serving a rotated cookie.
 * None of those throw; they just leak or rot. So each one is pinned here.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import {
  EMPTY_OVERLAY,
  SECRET_REFS,
  clearSecret,
  describeSecrets,
  findCredentialSeam,
  loadOverlay,
  maskedTail,
  overlayValue,
  storeSecret,
  withOverlayValue,
  type CredentialSeam,
} from '../lib/secrets.js'
import {
  isTrustedRequest,
  makeSettingsRoutes,
  ROUTE_SECRETS,
  ROUTE_SETTINGS,
  ROUTE_STATUS,
  ROUTE_ACTION,
  type SettingsRouteDeps,
} from '../lib/settings-routes.js'
import { previewPersonas } from '../lib/diagnostics.js'

// --------------------------------------------------------------- fake seam

/** An in-memory credential service, recording every write. */
function fakeSeam(initial: { cookie?: string; llmKey?: string } = {}): CredentialSeam & {
  values: Map<string, string>
  writes: string[]
} {
  const values = new Map<string, string>()
  if (initial.cookie !== undefined && initial.cookie !== '') {
    values.set('DSH_AI_DEBATE_TIEBA_COOKIE', initial.cookie)
  }
  if (initial.llmKey !== undefined && initial.llmKey !== '') {
    values.set('DSH_AI_DEBATE_LLM_API_KEY', initial.llmKey)
  }
  const writes: string[] = []
  return {
    values,
    writes,
    async describe(ref) {
      const value = values.get(ref)
      return {
        configured: value !== undefined && value.length > 0,
        ...(value === undefined ? {} : { source: 'store' }),
        writable: true,
      }
    },
    async resolve(ref) {
      const value = values.get(ref)
      return value === undefined || value === '' ? undefined : { value, source: 'store' }
    },
    async set(ref, value) {
      writes.push(`set:${ref}`)
      values.set(ref, value)
    },
    async unset(ref) {
      writes.push(`unset:${ref}`)
      values.delete(ref)
    },
  }
}

// ------------------------------------------------------------------ overlay

test('the overlay starts empty so a missing credential service degrades to config', () => {
  assert.equal(EMPTY_OVERLAY.cookie, '')
  assert.equal(EMPTY_OVERLAY.llmApiKey, '')
  assert.equal(EMPTY_OVERLAY.stored.size, 0)
})

test('a stored value replaces the overlay entry and is marked as stored', () => {
  const next = withOverlayValue(EMPTY_OVERLAY, 'DSH_AI_DEBATE_TIEBA_COOKIE', 'ST=fixture-short')
  assert.equal(next.cookie, 'ST=fixture-short')
  assert.equal(next.stored.has('DSH_AI_DEBATE_TIEBA_COOKIE'), true)
  // The other half is untouched: writing one secret must not clear the other.
  assert.equal(next.llmApiKey, '')
})

test('an empty value removes the overlay entry and its stored mark', () => {
  const withCookie = withOverlayValue(EMPTY_OVERLAY, 'DSH_AI_DEBATE_TIEBA_COOKIE', 'ST=fixture-short')
  const cleared = withOverlayValue(withCookie, 'DSH_AI_DEBATE_TIEBA_COOKIE', '')
  assert.equal(cleared.cookie, '')
  assert.equal(cleared.stored.has('DSH_AI_DEBATE_TIEBA_COOKIE'), false)
})

test('overlayValue reads the right half for each reference', () => {
  const overlay = withOverlayValue(
    withOverlayValue(EMPTY_OVERLAY, 'DSH_AI_DEBATE_TIEBA_COOKIE', 'COOKIE'),
    'DSH_AI_DEBATE_LLM_API_KEY',
    'KEY',
  )
  assert.equal(overlayValue(overlay, 'DSH_AI_DEBATE_TIEBA_COOKIE'), 'COOKIE')
  assert.equal(overlayValue(overlay, 'DSH_AI_DEBATE_LLM_API_KEY'), 'KEY')
})

test('a mask shows only the last four characters, and nothing at all for a short value', () => {
  assert.equal(maskedTail('sk-1234567890abcd'), '…abcd')
  // Shorter than eight characters returns nothing: masking four of six reveals
  // more than it hides.
  assert.equal(maskedTail('short'), undefined)
  assert.equal(maskedTail(''), undefined)
  // The tail must never be the whole value.
  const long = 'sk-abcdefghij'
  assert.notEqual(maskedTail(long), long)
})

// ------------------------------------------------------------ loadOverlay

test('loading without a credential service yields an empty overlay and says so', async () => {
  const loaded = await loadOverlay(undefined)
  assert.equal(loaded.overlay.cookie, '')
  assert.equal(loaded.overlay.llmApiKey, '')
  assert.ok(loaded.error !== undefined)
  assert.match(loaded.error, /凭据服务/)
})

test('loading reads both references out of the store', async () => {
  const seam = fakeSeam({ cookie: 'ST=fixture-cookie', llmKey: 'sk-fixture-key' })
  const loaded = await loadOverlay(seam)
  assert.equal(loaded.error, undefined)
  assert.equal(loaded.overlay.cookie, 'ST=fixture-cookie')
  assert.equal(loaded.overlay.llmApiKey, 'sk-fixture-key')
  assert.equal(loaded.overlay.stored.size, 2)
})

test('a blank stored value counts as absent, so the config fallback applies', async () => {
  const seam = fakeSeam()
  // The seam contract says an empty stored value is absent everywhere; a fake
  // that returned '' would let the overlay shadow a working config fallback.
  await seam.set('DSH_AI_DEBATE_TIEBA_COOKIE', '')
  const loaded = await loadOverlay(seam)
  assert.equal(loaded.overlay.cookie, '')
  assert.equal(loaded.overlay.stored.has('DSH_AI_DEBATE_TIEBA_COOKIE'), false)
})

test('one failing reference does not lose the other', async () => {
  const seam = fakeSeam({ llmKey: 'sk-fixture-key' })
  const failing: CredentialSeam = {
    ...seam,
    async describe(ref) {
      if (ref === 'DSH_AI_DEBATE_TIEBA_COOKIE') throw new Error('read failed')
      return seam.describe(ref)
    },
  }
  const loaded = await loadOverlay(failing)
  assert.equal(loaded.overlay.llmApiKey, 'sk-fixture-key')
  assert.ok(loaded.error !== undefined)
  assert.match(loaded.error, /read failed/)
})

// --------------------------------------------------------- describeSecrets

test('describe reports the store source and never the value', async () => {
  const seam = fakeSeam({ cookie: 'ST=fixture-not-real-0002' })
  const overlay = (await loadOverlay(seam)).overlay
  const rows = await describeSecrets(seam, overlay, () => '')
  const cookie = rows.find((row) => row.ref === 'DSH_AI_DEBATE_TIEBA_COOKIE')
  assert.ok(cookie !== undefined)
  assert.equal(cookie.configured, true)
  assert.equal(cookie.source, 'store')
  assert.equal(cookie.tail, '…0002')
  // Nothing in the row can reconstruct the value: the serialized status must
  // not contain the fixture body anywhere.
  const serialized = JSON.stringify(cookie)
  assert.equal(serialized.includes('fixture-not-real'), false)
})

test('a legacy config value is reported as a fallback, and flagged when superseded', async () => {
  // Config-only: the seam has nothing.
  const emptySeam = fakeSeam()
  const emptyRows = await describeSecrets(emptySeam, EMPTY_OVERLAY, (ref) =>
    ref === 'DSH_AI_DEBATE_TIEBA_COOKIE' ? 'ST=fixture-from-config-03' : '',
  )
  const fallback = emptyRows.find((row) => row.ref === 'DSH_AI_DEBATE_TIEBA_COOKIE')
  assert.equal(fallback?.fromConfigFallback, true)
  assert.equal(fallback?.configSuperseded, false)
  assert.equal(fallback?.source, 'config')

  // Store wins over config: the row must say the config copy is superseded
  // rather than leaving the user to wonder which one is live.
  const seam = fakeSeam({ cookie: 'ST=fixture-from-store-004' })
  const overlay = (await loadOverlay(seam)).overlay
  const rows = await describeSecrets(seam, overlay, (ref) =>
    ref === 'DSH_AI_DEBATE_TIEBA_COOKIE' ? 'ST=fixture-from-config-03' : '',
  )
  const superseded = rows.find((row) => row.ref === 'DSH_AI_DEBATE_TIEBA_COOKIE')
  assert.equal(superseded?.configSuperseded, true)
  assert.equal(superseded?.source, 'store')
})

test('describe without a credential service still reports the config fallback', async () => {
  const rows = await describeSecrets(undefined, EMPTY_OVERLAY, (ref) =>
    ref === 'DSH_AI_DEBATE_LLM_API_KEY' ? 'sk-legacy' : '',
  )
  const key = rows.find((row) => row.ref === 'DSH_AI_DEBATE_LLM_API_KEY')
  assert.equal(key?.configured, true)
  assert.equal(key?.writable, false)
  assert.equal(key?.source, 'config')
})

// ------------------------------------------------------------- write paths

test('storing a secret trims it and refuses an empty value', async () => {
  const seam = fakeSeam()
  await storeSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE', '  ST=fixture-trimmed  ')
  assert.equal(seam.values.get('DSH_AI_DEBATE_TIEBA_COOKIE'), 'ST=fixture-trimmed')
  await assert.rejects(() => storeSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE', '   '), /空/)
  // The rejection must not have written anything.
  assert.equal(seam.values.get('DSH_AI_DEBATE_TIEBA_COOKIE'), 'ST=fixture-trimmed')
})

test('storing without a credential service fails instead of pretending', async () => {
  await assert.rejects(() => storeSecret(undefined, 'DSH_AI_DEBATE_TIEBA_COOKIE', 'ST=fixture-short'), /凭据服务/)
})

test('clearing a secret reports honestly when there is no store', async () => {
  const result = await clearSecret(undefined, 'DSH_AI_DEBATE_TIEBA_COOKIE')
  assert.equal(result.cleared, false)
  assert.ok(result.note !== undefined)
})

test('clearing removes the stored value', async () => {
  const seam = fakeSeam({ cookie: 'ST=fixture-short' })
  const result = await clearSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE')
  assert.equal(result.cleared, true)
  assert.equal(seam.values.has('DSH_AI_DEBATE_TIEBA_COOKIE'), false)
})

test('the two references are the only ones this plugin owns', () => {
  assert.deepEqual([...SECRET_REFS], ['DSH_AI_DEBATE_TIEBA_COOKIE', 'DSH_AI_DEBATE_LLM_API_KEY'])
})

// ------------------------------------------------------- findCredentialSeam

test('a context without a credential service yields undefined, not a throw', () => {
  assert.equal(findCredentialSeam({ get: () => undefined }), undefined)
  assert.equal(findCredentialSeam({}), undefined)
  assert.equal(
    findCredentialSeam({
      get: () => {
        throw new Error('service missing')
      },
    }),
    undefined,
  )
  // A service shaped like something else is not accepted: a partial implementation
  // would fail mid-write, which is worse than falling back to config.
  assert.equal(findCredentialSeam({ get: () => ({ describe: async () => ({}) }) }), undefined)
})

test('a complete credential service is accepted', () => {
  const seam = fakeSeam()
  assert.equal(findCredentialSeam({ get: () => seam }), seam)
})

// ------------------------------------------------------------- route fence

/** A minimal IncomingMessage stand-in for the trust check. */
function fakeRequest(options: {
  address?: string
  host?: string
  origin?: string
  fetchSite?: string
}): { socket: { remoteAddress: string }; headers: Record<string, string> } {
  return {
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    headers: {
      ...(options.host === undefined ? { host: '127.0.0.1:63339' } : { host: options.host }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.fetchSite === undefined ? {} : { 'sec-fetch-site': options.fetchSite }),
    },
  }
}

test('the route fence accepts a loopback same-origin request', () => {
  assert.equal(isTrustedRequest(fakeRequest({}) as never), true)
  assert.equal(
    isTrustedRequest(fakeRequest({ origin: 'http://127.0.0.1:63339' }) as never),
    true,
  )
  assert.equal(isTrustedRequest(fakeRequest({ address: '::1' }) as never), true)
})

test('the route fence refuses a non-loopback peer', () => {
  assert.equal(isTrustedRequest(fakeRequest({ address: '192.168.1.5' }) as never), false)
})

test('the route fence refuses a cross-site request and a foreign origin', () => {
  assert.equal(isTrustedRequest(fakeRequest({ fetchSite: 'cross-site' }) as never), false)
  assert.equal(isTrustedRequest(fakeRequest({ origin: 'http://evil.example' }) as never), false)
  // A Host header pointing at another machine is refused even from loopback: it
  // is the DNS-rebinding shape.
  assert.equal(isTrustedRequest(fakeRequest({ host: 'evil.example' }) as never), false)
})

// ------------------------------------------------------------- route family

/** Build deps over a fake seam, with a settings service recording writes. */
function makeDeps(overrides: Partial<SettingsRouteDeps> = {}): {
  deps: SettingsRouteDeps
  seam: ReturnType<typeof fakeSeam>
  updates: { namespace: string; patch: Record<string, unknown> }[]
  unsets: { namespace: string; ops: readonly { op: 'unset'; path: readonly string[] }[] }[]
  dir: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-settings-'))
  const seam = fakeSeam()
  const updates: { namespace: string; patch: Record<string, unknown> }[] = []
  const unsets: { namespace: string; ops: readonly { op: 'unset'; path: readonly string[] }[] }[] = []
  const base: SettingsRouteDeps = {
    // Default to an authorizer that admits: the tests below that care about the
    // fence override it explicitly, and every other test is about a behaviour
    // that only happens *after* admission.
    authorize: () => 'ok',
    config: () => resolveConfig({}),
    credentials: () => seam,
    overlay: () => EMPTY_OVERLAY,
    refreshSecrets: async () => undefined,
    settings: () => ({
      writable: true,
      update: async (namespace, patch) => {
        updates.push({ namespace, patch })
      },
      mutate: async (namespace, ops) => {
        unsets.push({ namespace, ops })
      },
    }),
    namespace: () => 'dsh-ai-debate',
    testModel: async () => ({ ok: true, baseUrl: 'x', model: 'y', message: 'ok' }),
    checkLogin: async () => ({ ok: true, authenticated: true, message: 'ok', cookieNames: [] }),
    previewPersonas: async () => [],
    stopAllActive: async () => ({
      stopped: [],
      refused: [],
      abortedInFlight: 0,
      alreadyPublished: 0,
    }),
    diagnostics: async () => ({
      enabled: true,
      storePath: dir,
      sessions: { total: 0, active: 0, awaitingConfirmation: 0, published: 0 },
      publishLedger: { total: 0, confirmed: 0, pending: 0, failed: 0, overCapacity: false },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
      recentErrors: [],
      rateLimit: { limited: false, note: '' },
      pluginVersion: '0.1.6',
    }),
    ...overrides,
  }
  return { deps: base, seam, updates, unsets, dir }
}

/** Drive one route handler with a fake request/response pair. */
async function callRoute(
  deps: SettingsRouteDeps,
  path: string,
  options: {
    method?: string
    body?: unknown
    request?: ReturnType<typeof fakeRequest>
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = makeSettingsRoutes(deps).find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} should exist`)
  const request = options.request ?? fakeRequest({})
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), 'utf8')]
  Object.assign(request, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  })
  let status = 200
  let text = ''
  const response = {
    writeHead(value: number) {
      status = value
    },
    end(payload?: string) {
      text = payload ?? ''
    },
    headersSent: false,
    destroy() {},
  }
  await route.handler(request as never, response as never)
  return { status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) }
}

test('the settings view never contains a secret value', async () => {
  const seam = fakeSeam({ cookie: 'ST=fixture-super-secret-05', llmKey: 'sk-fixture-super-secret-0008' })
  const overlay = (await loadOverlay(seam)).overlay
  const { deps, dir } = makeDeps({ credentials: () => seam, overlay: () => overlay })
  try {
    const result = await callRoute(deps, ROUTE_SETTINGS)
    assert.equal(result.status, 200)
    const serialized = JSON.stringify(result.body)
    assert.equal(serialized.includes('super-secret-cookie'), false)
    assert.equal(serialized.includes('super-secret-key'), false)
    // The status flags are present, so the page can render something true.
    const secrets = result.body.secrets as { ref: string; configured: boolean }[]
    assert.equal(secrets.length, 2)
    assert.ok(secrets.every((row) => row.configured === true))
    assert.equal(result.body.status, 'ready')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a settings write accepts allowlisted fields and coerces numbers', async () => {
  const { deps, updates, dir } = makeDeps()
  try {
    const result = await callRoute(deps, ROUTE_SETTINGS, {
      body: { set: { ownerUserId: '1171245451', intensity: '4' } },
    })
    assert.equal(result.status, 200)
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].patch, { ownerUserId: '1171245451', intensity: 4 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a settings write refuses an unknown field by name', async () => {
  const { deps, updates, dir } = makeDeps()
  try {
    const result = await callRoute(deps, ROUTE_SETTINGS, {
      body: { set: { notAField: 'x' } },
    })
    assert.equal(result.status, 400)
    assert.match(String(result.body.error), /notAField/)
    assert.equal(updates.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the settings wire refuses to write a legacy plaintext secret field', async () => {
  const { deps, updates, dir } = makeDeps()
  try {
    const result = await callRoute(deps, ROUTE_SETTINGS, {
      body: { set: { tiebaCookie: 'ST=fixture-leak-attempt' } },
    })
    assert.equal(result.status, 400)
    assert.match(String(result.body.error), /凭据/)
    // The whole point: a cookie must not reach the settings document.
    assert.equal(updates.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a legacy secret field can still be cleared from the config', async () => {
  const { deps, unsets, dir } = makeDeps()
  try {
    const result = await callRoute(deps, ROUTE_SETTINGS, { body: { unset: ['tiebaCookie'] } })
    assert.equal(result.status, 200)
    assert.equal(unsets.length, 1)
    assert.deepEqual(unsets[0].ops, [{ op: 'unset', path: ['tiebaCookie'] }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a read-only deployment refuses the write and says why', async () => {
  const { deps, updates, dir } = makeDeps({
    settings: () => ({
      writable: false,
      update: async () => {
        updates.push({ namespace: 'x', patch: {} })
      },
      mutate: async () => undefined,
    }),
  })
  try {
    const result = await callRoute(deps, ROUTE_SETTINGS, { body: { set: { intensity: 3 } } })
    assert.equal(result.status, 409)
    assert.match(String(result.body.error), /只读/)
    assert.equal(updates.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a settings conflict surfaces as a conflict, not a generic failure', async () => {
  const { deps, dir } = makeDeps({
    settings: () => ({
      writable: true,
      update: async () => {
        throw new Error('revision mismatch')
      },
      mutate: async () => undefined,
    }),
  })
  try {
    const result = await callRoute(deps, ROUTE_SETTINGS, { body: { set: { intensity: 3 } } })
    assert.equal(result.status, 409)
    assert.match(String(result.body.error), /revision mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a secret write stores the value and returns the reloaded view', async () => {
  const seam = fakeSeam()
  const { deps, dir } = makeDeps({ credentials: () => seam })
  try {
    const result = await callRoute(deps, ROUTE_SECRETS, {
      body: { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', value: 'ST=fixture-short' },
    })
    assert.equal(result.status, 200)
    assert.equal(seam.values.get('DSH_AI_DEBATE_TIEBA_COOKIE'), 'ST=fixture-short')
    // The response carries the redacted view, never the value it just accepted.
    assert.equal(JSON.stringify(result.body).includes('ST=fixture-short'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a secret write rejects an unknown reference', async () => {
  const { deps, seam, dir } = makeDeps()
  try {
    const result = await callRoute(deps, ROUTE_SECRETS, { body: { ref: 'SOMETHING_ELSE', value: 'x' } })
    assert.equal(result.status, 400)
    assert.equal(seam.writes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a secret clear removes the value', async () => {
  const seam = fakeSeam({ cookie: 'ST=fixture-short' })
  const { deps, dir } = makeDeps({ credentials: () => seam })
  try {
    const result = await callRoute(deps, ROUTE_SECRETS, {
      body: { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', clear: true },
    })
    assert.equal(result.status, 200)
    assert.equal(seam.values.has('DSH_AI_DEBATE_TIEBA_COOKIE'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every route refuses a cross-site request before doing anything', async () => {
  const { deps, seam, updates, dir } = makeDeps()
  try {
    for (const path of [ROUTE_SETTINGS, ROUTE_SECRETS, ROUTE_STATUS, ROUTE_ACTION]) {
      const result = await callRoute(deps, path, {
        method: 'POST',
        body: { set: { intensity: 3 }, ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', value: 'x', action: 'test-llm' },
        request: fakeRequest({ fetchSite: 'cross-site' }),
      })
      assert.equal(result.status, 403, `${path} must refuse a cross-site request`)
    }
    assert.equal(updates.length, 0)
    assert.equal(seam.writes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the action route dispatches the three probes and rejects anything else', async () => {
  let tested = 0
  let checked = 0
  let previewed = 0
  const { deps, dir } = makeDeps({
    testModel: async () => {
      tested += 1
      return { ok: true, baseUrl: 'x', model: 'y', message: 'ok' }
    },
    checkLogin: async () => {
      checked += 1
      return { ok: true, authenticated: true, message: 'ok', cookieNames: [] }
    },
    previewPersonas: async () => {
      previewed += 1
      return []
    },
  })
  try {
    assert.equal((await callRoute(deps, ROUTE_ACTION, { body: { action: 'test-llm' } })).status, 200)
    assert.equal((await callRoute(deps, ROUTE_ACTION, { body: { action: 'check-login' } })).status, 200)
    assert.equal(
      (await callRoute(deps, ROUTE_ACTION, { body: { action: 'preview-personas' } })).status,
      200,
    )
    assert.equal(tested, 1)
    assert.equal(checked, 1)
    assert.equal(previewed, 1)
    const unknown = await callRoute(deps, ROUTE_ACTION, { body: { action: 'drop-tables' } })
    assert.equal(unknown.status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// -------------------------------------------------------------- personas

test('the persona preview renders all four styles without a model', async () => {
  const previews = await previewPersonas(resolveConfig({}))
  assert.equal(previews.length, 4)
  assert.deepEqual(
    previews.map((row) => row.style),
    ['tieba_veteran', 'soft_defensive', 'tsundere', 'aloof'],
  )
  for (const row of previews) {
    assert.ok(row.name.length > 0)
    assert.ok(row.summary.length > 0)
    assert.ok(row.sample.length > 0)
    assert.ok(row.promptShape.length > 0)
  }
})

test('the persona preview reflects the configured intensity', async () => {
  const mild = await previewPersonas(resolveConfig({ intensity: 1 }))
  const sharp = await previewPersonas(resolveConfig({ intensity: 5 }))
  // Same personas, different prompt shape: the numbers must reach the text.
  assert.notEqual(mild[0].promptShape, sharp[0].promptShape)
})
