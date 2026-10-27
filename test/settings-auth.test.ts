/**
 * Authorization for the configuration API.
 *
 * The plugin owns two credentials — a Tieba login cookie and a model API key.
 * Before v0.1.9 the only thing standing between them and any process on the
 * machine was `isTrustedRequest`: "the socket came from 127.0.0.1 and the
 * Origin header, if present, pointed at us". That is a *shape* check, not
 * identity. Every local process satisfies it, `curl` satisfies it, and a
 * missing `Origin` was treated as trustworthy.
 *
 * v0.1.9 adds a second stage that delegates to DSH's own browser-session
 * authentication (`ctx.connection.requestRejection`, which checks the signed
 * `HttpOnly` session cookie minted by the Connection layer). This file pins the
 * behaviour of both stages and, above all, pins the ordering: **nothing is
 * written unless the request was admitted.** A fingerprint that changes state
 * on a rejected request is worse than no fence at all, because it looks safe.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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
  isTrustedRequest,
  type RequestAuthorizer,
  type SettingsRouteDeps,
} from '../lib/settings-routes.js'
import { EMPTY_OVERLAY } from '../lib/secrets.js'

// --------------------------------------------------------------- scaffolding

/** One fake request, with every header the fence and the authorizer look at. */
interface FakeRequest {
  socket: { remoteAddress: string }
  headers: Record<string, string>
  method?: string
  [Symbol.asyncIterator]?: () => AsyncGenerator<Buffer>
}

function fakeRequest(options: {
  address?: string
  host?: string
  origin?: string
  fetchSite?: string
  cookie?: string
} = {}): FakeRequest {
  return {
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    headers: {
      host: options.host ?? '127.0.0.1:52025',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.fetchSite === undefined ? {} : { 'sec-fetch-site': options.fetchSite }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
  }
}

/** What the routes were asked to change. The point of the file: these stay empty. */
interface Writes {
  updates: Record<string, unknown>[]
  unsets: readonly unknown[][]
  storedSecrets: string[]
  clearedSecrets: string[]
  paused: number
  probes: string[]
}

function makeHarness(overrides: Partial<SettingsRouteDeps> = {}): {
  deps: SettingsRouteDeps
  writes: Writes
} {
  const writes: Writes = {
    updates: [],
    unsets: [],
    storedSecrets: [],
    clearedSecrets: [],
    paused: 0,
    probes: [],
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsd-auth-'))
  const seam = {
    async describe() {
      return { configured: true, writable: true, source: 'store' }
    },
    async resolve() {
      return { value: 'stored-secret-value-1234', source: 'store' }
    },
    async set(_ref: string, value: string) {
      writes.storedSecrets.push(value)
    },
    async unset(ref: string) {
      writes.clearedSecrets.push(ref)
    },
  }
  const deps: SettingsRouteDeps = {
    authorize: () => 'ok',
    config: () => resolveConfig({}),
    credentials: () => seam,
    overlay: () => EMPTY_OVERLAY,
    refreshSecrets: async () => undefined,
    settings: () => ({
      writable: true,
      update: async (_namespace, patch) => {
        writes.updates.push(patch)
      },
      mutate: async (_namespace, ops) => {
        writes.unsets.push(ops as never)
      },
    }),
    namespace: () => 'dsh-ai-debate',
    testModel: async () => {
      writes.probes.push('test-llm')
      return { ok: true, baseUrl: 'x', model: 'y', message: 'ok' }
    },
    checkLogin: async () => {
      writes.probes.push('check-login')
      return { ok: true, authenticated: true, message: 'ok', cookieNames: [] }
    },
    previewPersonas: async () => {
      writes.probes.push('preview-personas')
      return []
    },
    stopAllActive: async () => {
      writes.paused += 1
      return { stopped: ['s1'], refused: [], abortedInFlight: 1, alreadyPublished: 0 }
    },
    diagnostics: async () => ({
      enabled: true,
      storePath: dir,
      sessions: { total: 0, active: 0, awaitingConfirmation: 0, published: 0 },
      publishLedger: { total: 0, confirmed: 0, pending: 0, failed: 0, overCapacity: false },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
      recentErrors: [],
      rateLimit: { limited: false, note: '' },
      pluginVersion: '0.1.9',
    }),
    ...overrides,
  }
  return { deps, writes }
}

/** Drive one route and collect the response. */
async function call(
  deps: SettingsRouteDeps,
  path: string,
  options: { method?: string; body?: unknown; request?: FakeRequest } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = makeSettingsRoutes(deps).find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, `route ${path} must exist`)
  const request = options.request ?? fakeRequest()
  const chunks =
    options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), 'utf8')]
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

/** Every route that can change something. */
const WRITE_ROUTES = [ROUTE_SETTINGS, ROUTE_SECRETS, ROUTE_ACTION] as const

/** One write per route, so the "nothing happened" assertions are meaningful. */
const WRITE_BODIES: Record<string, unknown> = {
  [ROUTE_SETTINGS]: { set: { llmModel: 'a-model' } },
  [ROUTE_SECRETS]: { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', value: 'ST=fixture-not-real-0001' },
  [ROUTE_ACTION]: { action: 'pause-now' },
}

// ------------------------------------------------------------ stage 2: identity

test('a request with no session credential is refused with 401', async () => {
  const { deps, writes } = makeHarness({ authorize: () => 401 })
  const result = await call(deps, ROUTE_SETTINGS)
  assert.equal(result.status, 401)
  assert.match(String(result.body.error), /unauthorized/)
  // A read refused here must not leak the view either.
  assert.equal(result.body.values, undefined)
  assert.equal(writes.updates.length, 0)
})

test('a request with a forged or expired credential is refused with 401', async () => {
  const { deps, writes } = makeHarness({ authorize: () => 401 })
  const result = await call(deps, ROUTE_SETTINGS, {
    request: fakeRequest({ cookie: 'dsh-browser-session=forged-value' }),
  })
  assert.equal(result.status, 401)
  assert.equal(writes.updates.length, 0)
})

test('a credential that does not belong to this authority is refused', async () => {
  // DSH binds the cookie to the listening host and port, so a cookie minted for
  // another port fails. The authorizer reports that as 401, not as admission.
  const { deps, writes } = makeHarness({ authorize: () => 401 })
  const result = await call(deps, ROUTE_SECRETS, {
    body: WRITE_BODIES[ROUTE_SECRETS],
    request: fakeRequest({ cookie: 'dsh-browser-session=other-authority' }),
  })
  assert.equal(result.status, 401)
  assert.deepEqual(writes.storedSecrets, [])
})

test('a 403 from the authorizer is reported as 403, not flattened into 401', async () => {
  const { deps } = makeHarness({ authorize: () => 403 })
  const result = await call(deps, ROUTE_SETTINGS)
  assert.equal(result.status, 403)
  assert.match(String(result.body.error), /forbidden/)
})

test('a normal authenticated desktop request is admitted', async () => {
  const { deps, writes } = makeHarness({
    // The real authorizer returns undefined for a valid cookie; the host half
    // maps that to 'ok'. Here we assert the admitted path end to end.
    authorize: () => 'ok',
  })
  const read = await call(deps, ROUTE_SETTINGS, {
    request: fakeRequest({ cookie: 'dsh-browser-session=signed-valid-value' }),
  })
  assert.equal(read.status, 200)
  assert.equal((read.body.values as Record<string, unknown>).llmModel !== undefined, true)

  const write = await call(deps, ROUTE_SETTINGS, {
    body: { set: { llmTemperature: 0.5 } },
    request: fakeRequest({ cookie: 'dsh-browser-session=signed-valid-value' }),
  })
  assert.equal(write.status, 200)
  assert.deepEqual(writes.updates, [{ llmTemperature: 0.5 }])
})

test('a deployment without any session mechanism refuses instead of falling back', async () => {
  // No `authorize` at all: a stripped composition, a headless host, or an older
  // DSH. There is no safe default here — admitting would mean "loopback is
  // enough", which is exactly the assumption this release removes.
  const { deps, writes } = makeHarness({ authorize: undefined })
  const result = await call(deps, ROUTE_SETTINGS)
  assert.equal(result.status, 403)
  assert.match(String(result.body.error), /会话认证/)
  assert.equal(writes.updates.length, 0)
})

test('an authorizer that throws is a refusal, never an admission', async () => {
  const { deps, writes } = makeHarness({
    authorize: (() => {
      throw new Error('connection service exploded')
    }) as RequestAuthorizer,
  })
  const result = await call(deps, ROUTE_SETTINGS)
  assert.equal(result.status, 403)
  assert.equal(writes.updates.length, 0)
})

// ------------------------------------------- stage 1: the structural shape check

test('a non-loopback peer is refused before the authorizer is consulted', async () => {
  let consulted = 0
  const { deps } = makeHarness({
    authorize: () => {
      consulted += 1
      return 'ok'
    },
  })
  const result = await call(deps, ROUTE_SETTINGS, {
    request: fakeRequest({ address: '192.168.1.5' }),
  })
  assert.equal(result.status, 403)
  assert.equal(consulted, 0, 'a remote peer must not even reach the authorizer')
})

test('a cross-site fetch is refused', async () => {
  const { deps } = makeHarness()
  const result = await call(deps, ROUTE_SETTINGS, {
    request: fakeRequest({ fetchSite: 'cross-site' }),
  })
  assert.equal(result.status, 403)
})

test('a foreign Origin is refused', async () => {
  const { deps } = makeHarness()
  const result = await call(deps, ROUTE_SETTINGS, {
    request: fakeRequest({ origin: 'http://evil.example' }),
  })
  assert.equal(result.status, 403)
})

test('a Host header naming another machine is refused even from loopback', async () => {
  // The DNS-rebinding shape: the socket is loopback because the attacker's
  // resolver pointed a name at it.
  const { deps } = makeHarness()
  const result = await call(deps, ROUTE_SETTINGS, {
    request: fakeRequest({ host: 'evil.example' }),
  })
  assert.equal(result.status, 403)
})

test('a missing Origin is admitted by the shape check but still needs identity', () => {
  // This is the rule that was wrong before: absent Origin does NOT mean trusted.
  // The shape check lets it through so a real non-browser caller can present a
  // credential; the authorizer then decides, and refusing there is the default.
  assert.equal(isTrustedRequest(fakeRequest({}) as never), true)

  const { deps, writes } = makeHarness({ authorize: () => 401 })
  return call(deps, ROUTE_SETTINGS).then((result) => {
    assert.equal(result.status, 401)
    assert.equal(writes.updates.length, 0)
  })
})

test('another local process on loopback is refused without a session', async () => {
  // The concrete threat the release notes call out: any local program can open
  // a socket to 127.0.0.1 and forge `Host`. It cannot forge the signed cookie.
  const { deps, writes } = makeHarness({ authorize: () => 401 })
  const result = await call(deps, ROUTE_SECRETS, {
    body: { ref: 'DSH_AI_DEBATE_LLM_API_KEY', value: 'sk-fixture-attacker-0009' },
    request: fakeRequest({ host: '127.0.0.1:52025' }),
  })
  assert.equal(result.status, 401)
  assert.deepEqual(writes.storedSecrets, [], 'no local process may write a credential')
})

// -------------------------------------------------- every write path is covered

test('every state-changing route refuses an unauthenticated request', async () => {
  for (const path of WRITE_ROUTES) {
    const { deps, writes } = makeHarness({ authorize: () => 401 })
    const result = await call(deps, path, { body: WRITE_BODIES[path] })
    assert.equal(result.status, 401, `${path} must refuse`)
    assert.deepEqual(writes.updates, [], `${path} must not write settings`)
    assert.deepEqual(writes.unsets, [], `${path} must not unset fields`)
    assert.deepEqual(writes.storedSecrets, [], `${path} must not store a secret`)
    assert.deepEqual(writes.clearedSecrets, [], `${path} must not clear a secret`)
    assert.equal(writes.paused, 0, `${path} must not stop tasks`)
    assert.deepEqual(writes.probes, [], `${path} must not run a probe`)
  }
})

test('the read-only status route is protected too', async () => {
  const { deps } = makeHarness({ authorize: () => 401 })
  const result = await call(deps, ROUTE_STATUS)
  assert.equal(result.status, 401)
  assert.equal(result.body.sessions, undefined)
})

test('a rejected secret clear does not remove the stored value', async () => {
  const { deps, writes } = makeHarness({ authorize: () => 403 })
  const result = await call(deps, ROUTE_SECRETS, {
    body: { ref: 'DSH_AI_DEBATE_TIEBA_COOKIE', clear: true },
  })
  assert.equal(result.status, 403)
  assert.deepEqual(writes.clearedSecrets, [])
})

test('a rejected pause-now does not stop anything', async () => {
  const { deps, writes } = makeHarness({ authorize: () => 401 })
  const result = await call(deps, ROUTE_ACTION, { body: { action: 'pause-now' } })
  assert.equal(result.status, 401)
  assert.equal(writes.paused, 0)
})

// ------------------------------------------------- the authorized pause path

test('an authorized pause-now reports what it actually stopped', async () => {
  const { deps, writes } = makeHarness({
    stopAllActive: async () => {
      writes.paused += 1
      return {
        stopped: ['s1', 's2'],
        refused: [{ sessionId: 's3', reason: '已经发表过' }],
        abortedInFlight: 2,
        alreadyPublished: 1,
      }
    },
  })
  const result = await call(deps, ROUTE_ACTION, { body: { action: 'pause-now' } })
  assert.equal(result.status, 200)
  assert.equal(writes.paused, 1)
  assert.deepEqual(result.body.stopped, ['s1', 's2'])
  assert.equal(result.body.abortedInFlight, 2)
  // The reply that already reached the platform is reported, never hidden.
  assert.equal(result.body.alreadyPublished, 1)
  // The caller gets a fresh view, so the page can update without a second read.
  assert.ok(result.body.view !== undefined)
})
