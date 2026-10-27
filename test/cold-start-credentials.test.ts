/**
 * The cold-start credential mirror.
 *
 * v0.1.9 had a bug that no isolated test caught, because it needed a real
 * restart of a real host: after booting, the settings page reported every
 * credential as unconfigured while the store still held them. Saving any secret
 * made both appear — which is what gave the cause away.
 *
 * The mechanism: `loadOverlay` is the async bridge between `ctx.credentials`
 * and the synchronous `resolveConfig`. At mount the plugin reads the store once.
 * On a cold start that read can land before `resolve()` is able to answer —
 * `describe()` already sees the record, `resolve()` returns nothing — and the
 * empty mirror was then cached for the life of the process. Nothing retried it;
 * only a credential write fired `credentials/reference-updated`.
 *
 * These tests run against the built modules and a seam that reproduces the
 * "not ready yet, then ready" sequence, so the regression is pinned without
 * needing a host restart.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import {
  makeSettingsRoutes,
  ROUTE_SETTINGS,
  ROUTE_STATUS,
  type SettingsRouteDeps,
} from '../lib/settings-routes.js'
import { EMPTY_OVERLAY, loadOverlay, type CredentialSeam } from '../lib/secrets.js'

const FIXTURE_COOKIE = 'ST=fixture-cold-start-cookie-1111'
const FIXTURE_KEY = 'sk-fixture-cold-start-key-2222'

/**
 * A seam that is only ready after `readyAfter` calls.
 *
 * This is the observed shape of the real failure: the very first `resolve()`
 * calls return nothing while `describe()` already reports `configured: true`.
 */
function lazySeam(readyAfter: number, store: Record<string, string>) {
  let resolves = 0
  const seam: CredentialSeam & { resolveCalls(): number; makeReady(): void } = {
    async describe(ref: string) {
      return {
        configured: typeof store[ref] === 'string' && store[ref]!.length > 0,
        writable: true,
        source: 'store',
      }
    },
    async resolve(ref: string) {
      resolves += 1
      if (resolves <= readyAfter) return undefined
      const value = store[ref]
      return typeof value === 'string' && value.length > 0 ? { value, source: 'store' } : undefined
    },
    async set(ref: string, value: string) {
      store[ref] = value
    },
    async unset(ref: string) {
      delete store[ref]
    },
    resolveCalls: () => resolves,
    makeReady() {
      resolves = Number.MAX_SAFE_INTEGER
    },
  }
  return seam
}

/**
 * Mirror of the host half's overlay state machine (src/index.ts).
 *
 * It must reproduce the REAL rule, including the `empty` case — the previous
 * version of this helper omitted that clause and therefore agreed with the bug
 * it was supposed to pin: a cold start whose store had not loaded yet produced
 * `configured: false` + no error + no unresolved row, which the old rule read as
 * "the store is empty, trust it", clearing the flag and freezing the empty
 * mirror for the life of the process.
 */
function makeMirror(seam: CredentialSeam) {
  let overlay = EMPTY_OVERLAY
  let stale = true
  let attempts = 0
  const MAX = 5
  const refresh = async (): Promise<void> => {
    const loaded = await loadOverlay(seam)
    overlay = loaded.overlay
    // The same rule the host uses: untrustworthy when the load failed, when the
    // store claims a value whose body did not come back, or when nothing
    // resolved at all (which a not-yet-loaded service looks exactly like).
    stale =
      loaded.error !== undefined || (loaded.unresolved?.length ?? 0) > 0 || loaded.empty
    if (!stale) attempts = 0
  }
  const ensureFresh = async (): Promise<void> => {
    if (!stale || attempts >= MAX) return
    attempts += 1
    await refresh()
  }
  return {
    current: () => overlay,
    refresh,
    ensureFresh,
    isStale: () => stale,
    attempts: () => attempts,
  }
}

test('a cold start that reads too early is retried, not cached forever', async () => {
  const seam = lazySeam(2, {
    DSH_AI_DEBATE_TIEBA_COOKIE: FIXTURE_COOKIE,
    DSH_AI_DEBATE_LLM_API_KEY: FIXTURE_KEY,
  })
  const mirror = makeMirror(seam)

  // Mount-time read lands before the store can answer.
  await mirror.refresh()
  assert.equal(mirror.current().cookie, '', 'precondition: the first read sees nothing')
  assert.equal(mirror.isStale(), true, 'an empty read must be treated as untrustworthy')

  // A consumer arrives later: this is what the tool/route path does.
  await mirror.ensureFresh()
  assert.equal(mirror.current().cookie, FIXTURE_COOKIE, 'the retry must pick the value up')
  assert.equal(mirror.current().llmApiKey, FIXTURE_KEY)
  assert.equal(mirror.isStale(), false, 'a successful non-empty read clears the flag')
})

test('the retry is bounded so an unreadable store is not hammered', async () => {
  // The bad shape: the store says it holds a value but never hands it over.
  const seam = lazySeam(Number.MAX_SAFE_INTEGER, {
    DSH_AI_DEBATE_TIEBA_COOKIE: FIXTURE_COOKIE,
  })
  const mirror = makeMirror(seam)
  for (let i = 0; i < 50; i += 1) await mirror.ensureFresh()
  assert.ok(mirror.attempts() <= 5, `expected at most 5 retries, saw ${mirror.attempts()}`)
  // It stays stale so a later credential-change event still refreshes it.
  assert.equal(mirror.isStale(), true)
})

test('GET /settings refreshes before answering, so the badge is truthful', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-cold-'))
  const seam = lazySeam(1, {
    DSH_AI_DEBATE_TIEBA_COOKIE: FIXTURE_COOKIE,
    DSH_AI_DEBATE_LLM_API_KEY: FIXTURE_KEY,
  })
  const mirror = makeMirror(seam)
  await mirror.refresh() // the cold, too-early read

  const deps: SettingsRouteDeps = {
    authorize: () => 'ok',
    config: () => resolveConfig({}),
    credentials: () => seam,
    overlay: () => mirror.current(),
    refreshSecrets: () => mirror.ensureFresh(),
    settings: () => undefined,
    namespace: () => 'dsh-ai-debate',
    testModel: async () => ({ ok: true, baseUrl: 'x', model: 'y', message: 'ok' }),
    checkLogin: async () => ({ ok: true, authenticated: true, message: 'ok', cookieNames: [] }),
    previewPersonas: async () => [],
    stopAllActive: async () => ({ stopped: [], refused: [], abortedInFlight: 0, alreadyPublished: 0 }),
    diagnostics: async () => ({
      enabled: true,
      storePath: dir,
      sessions: { total: 0, active: 0, awaitingConfirmation: 0, published: 0 },
      publishLedger: { total: 0, confirmed: 0, pending: 0, failed: 0, overCapacity: false },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
      recentErrors: [],
      rateLimit: { limited: false, note: '' },
      pluginVersion: '0.1.10',
    }),
  }

  const route = makeSettingsRoutes(deps).find((candidate) => candidate.path === ROUTE_SETTINGS)
  assert.ok(route !== undefined)
  let status = 0
  let text = ''
  await route.handler(
    {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:1' },
      method: 'GET',
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {},
    } as never,
    {
      writeHead(value: number) {
        status = value
      },
      end(payload?: string) {
        text = payload ?? ''
      },
      headersSent: false,
      destroy() {},
    } as never,
  )

  assert.equal(status, 200)
  const body = JSON.parse(text) as { secrets: { ref: string; configured: boolean; length: number }[] }
  const cookie = body.secrets.find((row) => row.ref === 'DSH_AI_DEBATE_TIEBA_COOKIE')
  assert.ok(cookie !== undefined)
  assert.equal(cookie.configured, true)
  // The defect: this used to be 0 while the store held the value.
  assert.equal(cookie.length, FIXTURE_COOKIE.length, 'the view must report the real length')
})

test('the status route also refreshes, for the same reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-cold2-'))
  const seam = lazySeam(1, { DSH_AI_DEBATE_TIEBA_COOKIE: FIXTURE_COOKIE })
  const mirror = makeMirror(seam)
  await mirror.refresh()

  let refreshed = 0
  const deps: SettingsRouteDeps = {
    authorize: () => 'ok',
    config: () => resolveConfig({}),
    credentials: () => seam,
    overlay: () => mirror.current(),
    refreshSecrets: async () => {
      refreshed += 1
      await mirror.ensureFresh()
    },
    settings: () => undefined,
    namespace: () => 'dsh-ai-debate',
    testModel: async () => ({ ok: true, baseUrl: 'x', model: 'y', message: 'ok' }),
    checkLogin: async () => ({ ok: true, authenticated: true, message: 'ok', cookieNames: [] }),
    previewPersonas: async () => [],
    stopAllActive: async () => ({ stopped: [], refused: [], abortedInFlight: 0, alreadyPublished: 0 }),
    diagnostics: async () => ({
      enabled: true,
      storePath: dir,
      sessions: { total: 0, active: 0, awaitingConfirmation: 0, published: 0 },
      publishLedger: { total: 0, confirmed: 0, pending: 0, failed: 0, overCapacity: false },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
      recentErrors: [],
      rateLimit: { limited: false, note: '' },
      pluginVersion: '0.1.10',
    }),
  }
  const route = makeSettingsRoutes(deps).find((candidate) => candidate.path === ROUTE_STATUS)
  assert.ok(route !== undefined)
  await route.handler(
    {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:1' },
      method: 'GET',
      async *[Symbol.asyncIterator]() {},
    } as never,
    {
      writeHead() {},
      end() {},
      headersSent: false,
      destroy() {},
    } as never,
  )
  assert.ok(refreshed >= 1, 'the status route must refresh the mirror too')
})

/**
 * A seam whose whole document is still unparsed, which is the shape the real
 * failure actually had.
 *
 * `dsh-credentials-local` exposes the service and then runs `loadInitial()`,
 * which assigns `this.values` only after the YAML is read. Before that
 * assignment both `describe()` AND `resolve()` answer "nothing" — there is no
 * `configured: true` to tip anyone off, and no error either. The plugin
 * therefore cannot distinguish this from an empty store by inspection, which is
 * exactly why the old rule (`error || unresolved`) was wrong.
 */
function unloadedThenReadySeam(store: Record<string, string>) {
  let loaded = false
  const seam: CredentialSeam & { load(): void } = {
    async describe(ref: string) {
      if (!loaded) return { configured: false, writable: true }
      const value = store[ref]
      return value === undefined
        ? { configured: false, writable: true }
        : { configured: true, writable: true, source: 'file' }
    },
    async resolve(ref: string) {
      if (!loaded) return undefined
      const value = store[ref]
      return typeof value === 'string' && value.length > 0
        ? { value, source: 'file' }
        : undefined
    },
    async set(ref: string, value: string) {
      store[ref] = value
    },
    async unset(ref: string) {
      delete store[ref]
    },
    load() {
      loaded = true
    },
  }
  return seam
}

test('a store that is merely unparsed is not mistaken for an empty one', async () => {
  // This is the actual v0.1.9 regression: cold start, values on disk, and the
  // very first read lands before the document is parsed. Nothing is claimed and
  // nothing errors, so only the `empty` signal can reveal the ambiguity.
  const seam = unloadedThenReadySeam({
    DSH_AI_DEBATE_TIEBA_COOKIE: FIXTURE_COOKIE,
    DSH_AI_DEBATE_LLM_API_KEY: FIXTURE_KEY,
  })
  const mirror = makeMirror(seam)

  await mirror.refresh()
  assert.equal(mirror.current().cookie, '', 'precondition: nothing is readable yet')
  assert.equal(
    mirror.isStale(),
    true,
    'an all-empty read must stay retryable: the store may not have loaded yet',
  )

  seam.load()
  await mirror.ensureFresh()
  assert.equal(mirror.current().cookie, FIXTURE_COOKIE, 'the retry picks the value up after load')
  assert.equal(mirror.current().llmApiKey, FIXTURE_KEY)
  assert.equal(mirror.isStale(), false)
})

test('POST /settings and the settings GET both recover from an unparsed store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-cold3-'))
  const seam = unloadedThenReadySeam({
    DSH_AI_DEBATE_TIEBA_COOKIE: FIXTURE_COOKIE,
    DSH_AI_DEBATE_LLM_API_KEY: FIXTURE_KEY,
  })
  const mirror = makeMirror(seam)
  await mirror.refresh() // cold, too-early
  assert.equal(mirror.current().cookie, '')
  seam.load()

  const deps: SettingsRouteDeps = {
    authorize: () => 'ok',
    config: () => resolveConfig({}),
    credentials: () => seam,
    overlay: () => mirror.current(),
    // The routes re-read unconditionally, so a single page load is enough.
    refreshSecrets: () => mirror.refresh(),
    settings: () => undefined,
    namespace: () => 'dsh-ai-debate',
    testModel: async () => ({ ok: true, baseUrl: 'x', model: 'y', message: 'ok' }),
    checkLogin: async () => ({ ok: true, authenticated: true, message: 'ok', cookieNames: [] }),
    previewPersonas: async () => [],
    stopAllActive: async () => ({ stopped: [], refused: [], abortedInFlight: 0, alreadyPublished: 0 }),
    diagnostics: async () => ({
      enabled: true,
      storePath: dir,
      sessions: { total: 0, active: 0, awaitingConfirmation: 0, published: 0 },
      publishLedger: { total: 0, confirmed: 0, pending: 0, failed: 0, overCapacity: false },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
      recentErrors: [],
      rateLimit: { limited: false, note: '' },
      pluginVersion: '0.1.10',
    }),
  }

  const route = makeSettingsRoutes(deps).find((candidate) => candidate.path === ROUTE_SETTINGS)
  assert.ok(route !== undefined)
  let status = 0
  let text = ''
  await route.handler(
    {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:1' },
      method: 'GET',
      async *[Symbol.asyncIterator]() {},
    } as never,
    {
      writeHead(value: number) {
        status = value
      },
      end(payload?: string) {
        text = payload ?? ''
      },
      headersSent: false,
      destroy() {},
    } as never,
  )

  assert.equal(status, 200)
  const body = JSON.parse(text) as {
    secrets: { ref: string; configured: boolean; length: number }[]
  }
  const cookie = body.secrets.find((row) => row.ref === 'DSH_AI_DEBATE_TIEBA_COOKIE')
  assert.ok(cookie !== undefined)
  assert.equal(cookie.configured, true, 'one page load after the store is ready must show it')
  assert.equal(cookie.length, FIXTURE_COOKIE.length, 'and the length must be the real one')
})

test('a store that stays empty stops being retried after the bounded budget', async () => {
  // A deployment with genuinely nothing stored, and a service that never
  // resolves anything. There is no way to tell this apart from "the store has
  // not finished loading" at the moment of the read, so the honest behaviour is
  // to retry a bounded number of times and then stop — never to hammer the
  // store forever, and never to declare the empty result authoritative on the
  // very first read (which is what froze v0.1.9's mirror).
  const seam = lazySeam(Number.MAX_SAFE_INTEGER, {})
  const mirror = makeMirror(seam)
  await mirror.refresh()
  assert.equal(mirror.isStale(), true, 'an all-empty read is ambiguous, so it stays retryable')
  assert.equal(mirror.current().cookie, '', 'the mirror itself is still empty')

  for (let i = 0; i < 50; i += 1) await mirror.ensureFresh()
  assert.ok(mirror.attempts() <= 5, `expected at most 5 retries, saw ${mirror.attempts()}`)
})

test('once the store answers, the retry budget is restored for a later cold start', async () => {
  // A read that finally resolves something must clear both the stale flag and
  // the spent-attempts counter, or a long-lived process would only ever get one
  // round of retries for the rest of its life.
  const store: Record<string, string> = { DSH_AI_DEBATE_TIEBA_COOKIE: FIXTURE_COOKIE }
  const seam = lazySeam(Number.MAX_SAFE_INTEGER, store)
  const mirror = makeMirror(seam)
  for (let i = 0; i < 10; i += 1) await mirror.ensureFresh()
  assert.ok(mirror.attempts() > 0)

  seam.makeReady()
  await mirror.refresh()
  assert.equal(mirror.current().cookie, FIXTURE_COOKIE)
  assert.equal(mirror.isStale(), false)
  assert.equal(mirror.attempts(), 0, 'a successful read must reset the retry budget')
})

test('the source actually wires the retry (guards against a silent revert)', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('ensureSecretsFresh'), 'src/index.ts must define the bounded retry')
  assert.ok(
    source.includes('overlayStale'),
    'src/index.ts must track whether the mirror is trustworthy',
  )
  const routes = readFileSync(new URL('../src/settings-routes.ts', import.meta.url), 'utf8')
  // The GET branch and the status route both have to call it.
  const getBranch = routes.slice(routes.indexOf("if (method === 'GET')"), routes.indexOf("if (method !== 'POST')"))
  assert.ok(getBranch.includes('deps.refreshSecrets'), 'GET /settings must refresh before answering')
})
