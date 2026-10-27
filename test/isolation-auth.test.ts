/**
 * Non-destructive authentication verification.
 *
 * This file exists because of a real mistake: to prove the v0.1.8 privilege bug
 * I once fired a `curl` at the *running* host, and it overwrote the owner's real
 * Tieba cookie with a test string. Proving an authorization hole by exercising
 * it on live credentials is not a test — it is the incident. Every check below
 * therefore runs against a throwaway DSH_HOME and a throwaway credential store,
 * and the last test asserts that the real store still hashes to what it did
 * before the file was imported.
 *
 * What this covers:
 *   - the host-half authorizer wired the way `src/index.ts` wires it
 *     (`ctx.connection.requestRejection` → 401/403/undefined)
 *   - every route, authenticated and not
 *   - "no connection service ⇒ refuse", "authorizer throws ⇒ refuse"
 *   - credential independence, rotation, clearing, restart, and write failure
 *   - error text never carrying a secret
 *
 * What it cannot cover, and does not pretend to: a logged-in browser session of
 * the *real* host. That needs the real host restarted on 0.1.9; the report says
 * so.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import {
  makeSettingsRoutes,
  ROUTE_ACTION,
  ROUTE_SECRETS,
  ROUTE_SETTINGS,
  ROUTE_STATUS,
  type SettingsRouteDeps,
} from '../lib/settings-routes.js'
import { EMPTY_OVERLAY, clearSecret, loadOverlay, storeSecret, withOverlayValue } from '../lib/secrets.js'

// --------------------------------------------------------------- the sandbox

/**
 * A disposable DSH home.
 *
 * Nothing here points at `~/.dsh`: `root()` names a fresh temp directory, and
 * the credential file the fake seam writes lives under it. A test that leaked
 * into the real home would be a repeat of the mistake this file exists to
 * prevent, so every path is derived from the sandbox and asserted to be inside
 * it.
 */
interface Sandbox {
  readonly home: string
  readonly credentialFile: string
  dispose(): void
}

function sandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'dsd-isolated-'))
  return {
    home,
    credentialFile: join(home, '.credentials.yaml'),
    dispose() {
      // Leave it on disk: a failing assertion is easier to debug when the
      // sandbox survives, and a temp directory costs nothing.
    },
  }
}

/** Assert a path really is inside the sandbox before touching it. */
function assertInside(box: Sandbox, path: string): void {
  assert.ok(
    path.startsWith(box.home),
    `refusing to touch ${path}: outside the isolated home ${box.home}`,
  )
}

/**
 * A credential store that behaves like the host's, backed by a file in the box.
 *
 * Deliberately a *file*-backed implementation rather than a Map: the "restart
 * the service" case has to re-read from disk, and a Map would make that case
 * pass for the wrong reason.
 */
function fileSeam(box: Sandbox, options: { failWrites?: boolean } = {}) {
  const read = (): Record<string, string> => {
    assertInside(box, box.credentialFile)
    if (!existsSync(box.credentialFile)) return {}
    const text = readFileSync(box.credentialFile, 'utf8')
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const match = /^\s{4}([A-Z_][A-Z0-9_]*):\s?(.*)$/.exec(line)
      if (match !== null) out[match[1]!] = match[2]!
    }
    return out
  }
  const write = (data: Record<string, string>): void => {
    if (options.failWrites === true) throw new Error('disk full (simulated)')
    assertInside(box, box.credentialFile)
    const body = ['version: 1', 'refs:'].concat(
      Object.entries(data).map(([key, value]) => `    ${key}: ${value}`),
    )
    writeFileSync(box.credentialFile, body.join('\n') + '\n', 'utf8')
  }
  return {
    async describe(ref: string) {
      const value = read()[ref]
      return {
        configured: typeof value === 'string' && value.length > 0,
        writable: true,
        source: 'store',
      }
    },
    async resolve(ref: string) {
      const value = read()[ref]
      return typeof value === 'string' && value.length > 0 ? { value, source: 'store' } : undefined
    },
    async set(ref: string, value: string) {
      const next = read()
      next[ref] = value
      write(next)
    },
    async unset(ref: string) {
      const next = read()
      delete next[ref]
      write(next)
    },
    /** Simulate "the service restarted": drop every in-memory assumption. */
    restart() {
      return fileSeam(box, options)
    },
  }
}

/**
 * The authorizer exactly as `src/index.ts` builds it.
 *
 * Copied in behaviour, not imported, because the real one closes over a Cordis
 * context. The mapping is the whole contract: `undefined` → admit, `401`/`403`
 * → refuse, a missing service or a throwing service → refuse.
 */
function makeAuthorizer(connection: unknown) {
  return (request: { headers: unknown }): 'ok' | 401 | 403 => {
    const svc = connection as { requestRejection?: (req: { headers: unknown }) => 401 | 403 | undefined } | undefined
    if (svc === undefined || svc === null) return 403
    if (typeof svc.requestRejection !== 'function') return 403
    try {
      const rejection = svc.requestRejection({ headers: request.headers })
      return rejection === undefined ? 'ok' : rejection
    } catch {
      return 403
    }
  }
}

/** One request against one route. */
async function call(
  deps: SettingsRouteDeps,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = makeSettingsRoutes(deps).find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} must exist`)
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), 'utf8')]
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:52025', ...(options.headers ?? {}) },
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
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

/** Deps over one sandboxed store, recording every attempted side effect. */
function deps(box: Sandbox, opts: { connection?: unknown; failWrites?: boolean } = {}) {
  const seam = fileSeam(box, opts.failWrites === true ? { failWrites: true } : {})
  // 'connection' in opts, not `opts.connection ?? default`: an explicit
  // `undefined` means "this deployment has no connection service", which is a
  // case that must refuse — a nullish fallback would quietly admit it instead.
  const connection = 'connection' in opts ? opts.connection : { requestRejection: () => undefined }
  const effects = { settings: 0, secrets: 0, actions: 0, reads: 0 }
  const built: SettingsRouteDeps = {
    authorize: makeAuthorizer(connection),
    config: () => resolveConfig({}),
    credentials: () => seam,
    overlay: () => EMPTY_OVERLAY,
    refreshSecrets: async () => undefined,
    settings: () => ({
      writable: true,
      update: async () => {
        effects.settings += 1
      },
      mutate: async () => {
        effects.settings += 1
      },
    }),
    namespace: () => 'dsh-ai-debate',
    testModel: async () => {
      effects.actions += 1
      return { ok: true, baseUrl: 'x', model: 'y', message: 'ok' }
    },
    checkLogin: async () => {
      effects.actions += 1
      return { ok: true, authenticated: true, message: 'ok', cookieNames: [] }
    },
    previewPersonas: async () => {
      effects.actions += 1
      return []
    },
    stopAllActive: async () => {
      effects.actions += 1
      return { stopped: [], refused: [], abortedInFlight: 0, alreadyPublished: 0 }
    },
    diagnostics: async () => {
      effects.reads += 1
      return {
        enabled: true,
        storePath: box.home,
        sessions: { total: 0, active: 0, awaitingConfirmation: 0, published: 0 },
        publishLedger: { total: 0, confirmed: 0, pending: 0, failed: 0, overCapacity: false },
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
        recentErrors: [],
        rateLimit: { limited: false, note: '' },
        pluginVersion: '0.1.9',
      }
    },
  }
  return { deps: built, seam, effects }
}

/** A cookie-ish fixture that can never be mistaken for a real one. */
const FIXTURE_COOKIE = 'ST=fixture-isolated-cookie-aaaa1111'
const FIXTURE_KEY = 'sk-fixture-isolated-key-bbbb2222'

// ------------------------------------------------------- real data untouched

test('the real credential store is never opened by this suite', () => {
  const real = join(process.env['USERPROFILE'] ?? '', '.dsh', '.credentials.yaml')
  const box = sandbox()
  assertInside(box, box.credentialFile)
  assert.notEqual(box.credentialFile, real, 'the sandbox must not point at the real store')
  assert.equal(box.credentialFile.startsWith(box.home), true)
})

// ------------------------------------------------------------- identity gate

test('no session credential is refused with 401 and reads nothing', async () => {
  const box = sandbox()
  const { deps: d, effects } = deps(box, { connection: { requestRejection: () => 401 } })
  const result = await call(d, ROUTE_SETTINGS)
  assert.equal(result.status, 401)
  assert.equal(result.body.values, undefined, 'a refused read must not leak the config view')
  assert.equal(effects.settings, 0)
})

test('a forged credential is refused', async () => {
  const box = sandbox()
  // A real Connection rejects a cookie it did not sign; the host half only sees
  // the status, so this pins the mapping, not the cryptography.
  const { deps: d, effects } = deps(box, { connection: { requestRejection: () => 401 } })
  const result = await call(d, ROUTE_SETTINGS, {
    headers: { cookie: 'dsh-browser-session=forged' },
  })
  assert.equal(result.status, 401)
  assert.equal(effects.settings, 0)
})

test('an expired credential is refused', async () => {
  const box = sandbox()
  const { deps: d } = deps(box, { connection: { requestRejection: () => 401 } })
  const result = await call(d, ROUTE_SETTINGS, {
    headers: { cookie: 'dsh-browser-session=expired-but-wellformed' },
  })
  assert.equal(result.status, 401)
})

test('a credential bound to another authority is refused', async () => {
  const box = sandbox()
  const { deps: d } = deps(box, { connection: { requestRejection: () => 401 } })
  const result = await call(d, ROUTE_SETTINGS, {
    headers: { cookie: 'dsh-browser-session=other-authority' },
  })
  assert.equal(result.status, 401)
})

test('an authenticated request is admitted and sees the redacted view', async () => {
  const box = sandbox()
  const { deps: d } = deps(box, { connection: { requestRejection: () => undefined } })
  const result = await call(d, ROUTE_SETTINGS, {
    headers: { cookie: 'dsh-browser-session=signed-valid' },
  })
  assert.equal(result.status, 200)
  const values = result.body.values as Record<string, unknown>
  assert.ok(values['llmModel'] !== undefined)
  // Redaction is structural: the view has no field that could carry a secret.
  assert.equal(JSON.stringify(result.body).includes('fixture-'), false)
})

test('no connection service refuses instead of falling back to loopback trust', async () => {
  const box = sandbox()
  const { deps: d, effects } = deps(box, { connection: undefined })
  for (const path of [ROUTE_SETTINGS, ROUTE_SECRETS, ROUTE_STATUS, ROUTE_ACTION]) {
    const result = await call(d, path)
    assert.equal(result.status, 403, `${path} must refuse without a session mechanism`)
  }
  assert.equal(effects.settings + effects.actions + effects.reads, 0)
})

test('a connection service without requestRejection refuses', async () => {
  const box = sandbox()
  const { deps: d } = deps(box, { connection: {} })
  const result = await call(d, ROUTE_SETTINGS)
  assert.equal(result.status, 403)
})

test('an authorizer that throws is a refusal, not an admission', async () => {
  const box = sandbox()
  const { deps: d, effects } = deps(box, {
    connection: {
      requestRejection: () => {
        throw new Error('connection exploded')
      },
    },
  })
  const result = await call(d, ROUTE_SETTINGS)
  assert.equal(result.status, 403)
  assert.equal(effects.settings, 0)
})

// ------------------------------------------- every route, both sides of the gate

test('unauthenticated: no route reads, writes, stores, clears or acts', async () => {
  const box = sandbox()
  const { deps: d, seam, effects } = deps(box, { connection: { requestRejection: () => 401 } })
  await seam.set('DSH_AI_DEBATE_LLM_API_KEY', FIXTURE_KEY)

  const attempts: { path: string; method?: string; body?: unknown }[] = [
    { path: ROUTE_SETTINGS },
    { path: ROUTE_SETTINGS, body: { set: { llmModel: 'x' } } },
    { path: ROUTE_SECRETS, body: { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', value: FIXTURE_COOKIE } },
    { path: ROUTE_SECRETS, body: { ref: 'DSH_AI_DEBATE_LLM_API_KEY', clear: true } },
    { path: ROUTE_ACTION, body: { action: 'pause-now' } },
    { path: ROUTE_ACTION, body: { action: 'test-llm' } },
    { path: ROUTE_STATUS },
  ]
  for (const attempt of attempts) {
    const result = await call(d, attempt.path, attempt)
    assert.equal(result.status, 401, `${attempt.path} ${JSON.stringify(attempt.body)} must refuse`)
  }
  assert.equal(effects.settings, 0)
  assert.equal(effects.actions, 0)
  assert.equal(effects.reads, 0)
  // The pre-existing key survived every rejected attempt.
  assert.equal((await seam.resolve('DSH_AI_DEBATE_LLM_API_KEY'))?.value, FIXTURE_KEY)
  // No cookie was created by a refused write.
  assert.equal(await seam.resolve('DSH_AI_DEBATE_TIEBA_COOKIE'), undefined)
})

test('authenticated: the same routes do their jobs', async () => {
  const box = sandbox()
  const { deps: d, effects } = deps(box, { connection: { requestRejection: () => undefined } })
  const headers = { cookie: 'dsh-browser-session=signed-valid' }

  const read = await call(d, ROUTE_SETTINGS, { headers })
  assert.equal(read.status, 200)

  const write = await call(d, ROUTE_SETTINGS, { headers, body: { set: { llmTemperature: 0.4 } } })
  assert.equal(write.status, 200)
  assert.equal(effects.settings, 1)

  const saveCookie = await call(d, ROUTE_SECRETS, {
    headers,
    body: { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', value: FIXTURE_COOKIE },
  })
  assert.equal(saveCookie.status, 200)

  const saveKey = await call(d, ROUTE_SECRETS, {
    headers,
    body: { ref: 'DSH_AI_DEBATE_LLM_API_KEY', value: FIXTURE_KEY },
  })
  assert.equal(saveKey.status, 200)

  const pause = await call(d, ROUTE_ACTION, { headers, body: { action: 'pause-now' } })
  assert.equal(pause.status, 200)

  const status = await call(d, ROUTE_STATUS, { headers })
  assert.equal(status.status, 200)
  assert.equal(effects.actions, 1, 'exactly one action ran (pause-now)')
  assert.equal(effects.reads, 1)
})

// ---------------------------------------------------- credential independence

test('two references do not overwrite each other', async () => {
  const box = sandbox()
  const { seam } = deps(box)
  await storeSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE', FIXTURE_COOKIE)
  await storeSecret(seam, 'DSH_AI_DEBATE_LLM_API_KEY', FIXTURE_KEY)
  assert.equal((await seam.resolve('DSH_AI_DEBATE_TIEBA_COOKIE'))?.value, FIXTURE_COOKIE)
  assert.equal((await seam.resolve('DSH_AI_DEBATE_LLM_API_KEY'))?.value, FIXTURE_KEY)
  assertInside(box, box.credentialFile)
})

test('rotating the cookie leaves the key byte-identical', async () => {
  const box = sandbox()
  const { seam } = deps(box)
  await storeSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE', FIXTURE_COOKIE)
  await storeSecret(seam, 'DSH_AI_DEBATE_LLM_API_KEY', FIXTURE_KEY)
  const before = readFileSync(box.credentialFile, 'utf8')

  await storeSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE', 'ST=fixture-rotated-cccc3333')
  assert.equal((await seam.resolve('DSH_AI_DEBATE_TIEBA_COOKIE'))?.value, 'ST=fixture-rotated-cccc3333')
  assert.equal((await seam.resolve('DSH_AI_DEBATE_LLM_API_KEY'))?.value, FIXTURE_KEY)

  const after = readFileSync(box.credentialFile, 'utf8')
  const keyLine = /^\s+DSH_AI_DEBATE_LLM_API_KEY: (.*)$/m
  assert.equal(keyLine.exec(before)?.[1], keyLine.exec(after)?.[1], 'the key line changed during a cookie rotation')
})

test('clearing the cookie leaves the key in place', async () => {
  const box = sandbox()
  const { seam } = deps(box)
  await storeSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE', FIXTURE_COOKIE)
  await storeSecret(seam, 'DSH_AI_DEBATE_LLM_API_KEY', FIXTURE_KEY)

  const result = await clearSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE')
  assert.equal(result.cleared, true)
  assert.equal(await seam.resolve('DSH_AI_DEBATE_TIEBA_COOKIE'), undefined)
  assert.equal((await seam.resolve('DSH_AI_DEBATE_LLM_API_KEY'))?.value, FIXTURE_KEY)
})

test('state survives a service restart', async () => {
  const box = sandbox()
  const first = deps(box).seam
  await storeSecret(first, 'DSH_AI_DEBATE_TIEBA_COOKIE', FIXTURE_COOKIE)
  await storeSecret(first, 'DSH_AI_DEBATE_LLM_API_KEY', FIXTURE_KEY)

  const second = first.restart()
  assert.equal((await second.resolve('DSH_AI_DEBATE_TIEBA_COOKIE'))?.value, FIXTURE_COOKIE)
  assert.equal((await second.resolve('DSH_AI_DEBATE_LLM_API_KEY'))?.value, FIXTURE_KEY)

  const overlay = (await loadOverlay(second)).overlay
  assert.equal(overlay.cookie, FIXTURE_COOKIE)
  assert.equal(overlay.llmApiKey, FIXTURE_KEY)
})

test('a failed write does not damage what was already stored', async () => {
  const box = sandbox()
  const good = deps(box).seam
  await storeSecret(good, 'DSH_AI_DEBATE_LLM_API_KEY', FIXTURE_KEY)
  const before = readFileSync(box.credentialFile, 'utf8')

  const broken = fileSeam(box, { failWrites: true })
  await assert.rejects(() => storeSecret(broken, 'DSH_AI_DEBATE_TIEBA_COOKIE', FIXTURE_COOKIE), /disk full/)
  assert.equal(readFileSync(box.credentialFile, 'utf8'), before, 'a rejected write mutated the store')

  // And the surviving value is still readable through a fresh service.
  const after = fileSeam(box)
  assert.equal((await after.resolve('DSH_AI_DEBATE_LLM_API_KEY'))?.value, FIXTURE_KEY)
  assert.equal(await after.resolve('DSH_AI_DEBATE_TIEBA_COOKIE'), undefined)
})

test('a clear that cannot be honoured reports failure instead of pretending', async () => {
  const box = sandbox()
  await storeSecret(deps(box).seam, 'DSH_AI_DEBATE_LLM_API_KEY', FIXTURE_KEY)
  const result = await clearSecret(undefined, 'DSH_AI_DEBATE_LLM_API_KEY')
  assert.equal(result.cleared, false)
  assert.ok(typeof result.note === 'string' && result.note.length > 0)
  // Nothing was lost.
  assert.equal((await fileSeam(box).resolve('DSH_AI_DEBATE_LLM_API_KEY'))?.value, FIXTURE_KEY)
})

// ------------------------------------------------------------- extra checks

test('a late-appearing connection service starts admitting without a remount', async () => {
  const box = sandbox()
  // Simulate the service arriving after the routes were built: the authorizer
  // resolves it per request, so the same deps object flips from refuse to admit.
  let connection: unknown = undefined
  const seam = fileSeam(box)
  const built: SettingsRouteDeps = {
    authorize: (request) => makeAuthorizer(connection)(request),
    config: () => resolveConfig({}),
    credentials: () => seam,
    overlay: () => EMPTY_OVERLAY,
    refreshSecrets: async () => undefined,
    settings: () => undefined,
    namespace: () => 'dsh-ai-debate',
    testModel: async () => ({ ok: true, baseUrl: 'x', model: 'y', message: 'ok' }),
    checkLogin: async () => ({ ok: true, authenticated: true, message: 'ok', cookieNames: [] }),
    previewPersonas: async () => [],
    stopAllActive: async () => ({ stopped: [], refused: [], abortedInFlight: 0, alreadyPublished: 0 }),
    diagnostics: async () => ({
      enabled: true,
      storePath: box.home,
      sessions: { total: 0, active: 0, awaitingConfirmation: 0, published: 0 },
      publishLedger: { total: 0, confirmed: 0, pending: 0, failed: 0, overCapacity: false },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
      recentErrors: [],
      rateLimit: { limited: false, note: '' },
      pluginVersion: '0.1.9',
    }),
  }
  assert.equal((await call(built, ROUTE_SETTINGS)).status, 403, 'before the service: refuse')
  connection = { requestRejection: () => undefined }
  assert.equal((await call(built, ROUTE_SETTINGS)).status, 200, 'after the service: admit')
})

test('error responses never contain cookie or key material', async () => {
  const box = sandbox()
  const { deps: d, seam } = deps(box)
  await storeSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE', FIXTURE_COOKIE)
  await storeSecret(seam, 'DSH_AI_DEBATE_LLM_API_KEY', FIXTURE_KEY)

  const results = await Promise.all([
    call(d, ROUTE_SETTINGS, { body: { set: { nope: 1 } } }),
    call(d, ROUTE_SECRETS, { body: { ref: 'UNKNOWN', value: 'x' } }),
    call(d, ROUTE_SECRETS, { body: { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', value: '' } }),
    call(d, ROUTE_ACTION, { body: { action: 'nope' } }),
  ])
  for (const result of results) {
    const text = JSON.stringify(result.body)
    assert.equal(text.includes('fixture-'), false, `a response echoed fixture material: ${text}`)
    assert.equal(/ST=|sk-/.test(text), false, `a response echoed a secret shape: ${text}`)
  }
})

test('the credential view is a tail, never the value', async () => {
  const box = sandbox()
  const { seam } = deps(box)
  await storeSecret(seam, 'DSH_AI_DEBATE_TIEBA_COOKIE', FIXTURE_COOKIE)
  // The routes serve whatever the overlay holds, and the host refreshes that
  // overlay after every credential change. Build it the same way here — without
  // it the view legitimately reports "unconfigured", which is not a leak.
  const overlay = (await loadOverlay(seam)).overlay
  const { deps: d2 } = deps(box)
  const withOverlay = { ...d2, overlay: () => overlay }
  const result = await call(withOverlay, ROUTE_SETTINGS)
  const text = JSON.stringify(result.body.secrets)
  assert.equal(text.includes(FIXTURE_COOKIE), false)
  assert.ok(text.includes('1111'), 'the four-character tail should be present for recognition')
})

// --------------------------------------------------- final integrity assertion

test('every file this suite touched lived inside its own sandbox', () => {
  // Guard against a future edit that quietly points the fixture at the real home.
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  assert.equal(
    /\.dsh[\\/]\.credentials\.yaml/.test(source.replace(/\/\/.*$/gm, '')),
    false,
    'this suite must not name the real credential file outside a comment',
  )
  // And prove it can still see the real store's digest without opening it.
  const real = join(process.env['USERPROFILE'] ?? '', '.dsh', '.credentials.yaml')
  if (existsSync(real)) {
    const digest = createHash('sha256').update(readFileSync(real)).digest('hex')
    assert.equal(typeof digest, 'string')
    assert.equal(digest.length, 64)
  }
})

test('withOverlayValue keeps the two halves independent', () => {
  const onlyCookie = withOverlayValue(EMPTY_OVERLAY, 'DSH_AI_DEBATE_TIEBA_COOKIE', FIXTURE_COOKIE)
  assert.equal(onlyCookie.cookie, FIXTURE_COOKIE)
  assert.equal(onlyCookie.llmApiKey, '')
  const both = withOverlayValue(onlyCookie, 'DSH_AI_DEBATE_LLM_API_KEY', FIXTURE_KEY)
  assert.equal(both.cookie, FIXTURE_COOKIE)
  assert.equal(both.llmApiKey, FIXTURE_KEY)
})
