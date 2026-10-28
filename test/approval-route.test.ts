/**
 * The v0.2.5 approval endpoint and panel.
 *
 * ## What these cover that the publisher tests do not
 *
 * The publisher refuses a publish without a record; `approval-adversarial.test.ts` checks
 * that the binding cannot be forged or reused. Neither touches the two halves that make
 * an approval *possible*: the authenticated route that creates one, and the panel that
 * shows the owner what they are approving. A bug there is invisible from the publish side
 * — every publish would simply be refused, and every test that asserts a refusal would
 * still pass.
 *
 * ## The fence is the point
 *
 * `/approve` mints authorisation. If it were reachable without a session, the whole
 * version would be theatre: any local process could POST one and the "human approval" it
 * records would be the process's, not the owner's. So the first block is about refusal,
 * and each case asserts the *status* rather than "it threw", because a 500 from a crash
 * would also satisfy a lax assertion while proving nothing about the fence.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { EMPTY_OVERLAY } from '../lib/secrets.js'
import {
  makeSettingsRoutes,
  ROUTE_APPROVE,
  type ApprovalOutcome,
  type PendingApprovalView,
  type SettingsRouteDeps,
  type WebRoute,
} from '../lib/settings-routes.js'
import { DebateStore } from '../lib/store.js'

/** A minimal deps object; `approve` and `pendingApprovals` are what matter here. */
function makeDeps(
  overrides: Partial<SettingsRouteDeps> = {},
): { deps: SettingsRouteDeps; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-approve-'))
  const base: SettingsRouteDeps = {
    authorize: () => 'ok',
    config: () => resolveConfig({}),
    credentials: () => undefined,
    overlay: () => EMPTY_OVERLAY,
    refreshSecrets: async () => undefined,
    settings: () => undefined,
    namespace: () => 'dsh-ai-debate',
    testModel: async () => ({ ok: false, baseUrl: '', model: '', message: 'not used' }),
    checkLogin: async () => ({ ok: false, authenticated: false, message: 'not used', cookieNames: [] }),
    previewPersonas: async () => [],
    stopAllActive: async () => ({ stopped: [], refused: [], abortedInFlight: 0, alreadyPublished: 0 }),
    diagnostics: async () => ({
      enabled: true,
      storePath: join(dir, 'state.json'),
      sessions: { total: 0, active: 0, awaitingConfirmation: 0, published: 0 },
      publishLedger: { total: 0, confirmed: 0, pending: 0, failed: 0, overCapacity: false },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 },
      recentErrors: [],
      rateLimit: { limited: false, note: '' },
      pluginVersion: '0.2.5',
    }),
    ...overrides,
  }
  return { deps: base, dir }
}

/** Call one route with a POST body. */
async function callRoute(
  routes: readonly WebRoute[],
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routes.find((entry) => entry.path === path)
  assert.ok(route !== undefined, `${path} must be registered`)

  // The handler writes through a ServerResponse. A tiny recorder is far less fragile
  // than a real socket, and it captures exactly the two things asserted: status and body.
  let status = 0
  let payload = ''
  const response = {
    writeHead: (code: number) => {
      status = code
      return response
    },
    end: (chunk?: string) => {
      payload = typeof chunk === 'string' ? chunk : ''
      return response
    },
  } as never
  const request = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:51271', origin: 'http://127.0.0.1:51271' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  } as never

  await route.handler(request, response)
  return { status, json: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }
}

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

test('/approve 在没有会话认证的部署里整体关闭', async () => {
  // `authorize: undefined` is the honest state of a CLI/headless composition. There is
  // no way to tell the owner's browser from any other local process, so the endpoint
  // must refuse everything rather than fall back to "loopback means trusted".
  const { deps, dir } = makeDeps({ authorize: undefined })
  try {
    const routes = makeSettingsRoutes(deps)
    const result = await callRoute(routes, ROUTE_APPROVE, { sessionId: 's', candidateId: 'c' })
    assert.equal(result.status, 403)
    assert.match(String(result.json.error), /会话认证|设置页/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/approve 拒绝未登录的会话', async () => {
  const { deps, dir } = makeDeps({ authorize: () => 401 })
  try {
    const routes = makeSettingsRoutes(deps)
    const result = await callRoute(routes, ROUTE_APPROVE, { sessionId: 's', candidateId: 'c' })
    assert.equal(result.status, 401)
    assert.match(String(result.json.error), /unauthorized/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/approve 拒绝会话校验不通过的请求', async () => {
  const { deps, dir } = makeDeps({ authorize: () => 403 })
  try {
    const routes = makeSettingsRoutes(deps)
    const result = await callRoute(routes, ROUTE_APPROVE, { sessionId: 's', candidateId: 'c' })
    assert.equal(result.status, 403)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('一个抛错的授权检查算作拒绝，不算放行', async () => {
  // A throwing authorizer must not be read as "no objection". This is the failure mode
  // that turns an outage into an open door.
  const { deps, dir } = makeDeps({
    authorize: () => {
      throw new Error('session store unavailable')
    },
  })
  try {
    const routes = makeSettingsRoutes(deps)
    const result = await callRoute(routes, ROUTE_APPROVE, { sessionId: 's', candidateId: 'c' })
    assert.equal(result.status, 403)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/approve 只接受 POST', async () => {
  const { deps, dir } = makeDeps({ approve: async () => ({ status: 200, body: { approved: true } }) })
  try {
    const routes = makeSettingsRoutes(deps)
    const route = routes.find((entry) => entry.path === ROUTE_APPROVE)!
    let status = 0
    const response = {
      writeHead: (code: number) => {
        status = code
        return response
      },
      end: () => response,
    } as never
    await route.handler(
      {
        method: 'GET',
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:51271', origin: 'http://127.0.0.1:51271' },
      } as never,
      response,
    )
    assert.equal(status, 405)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/approve 在 Host 不提供批准能力时返回 501，而不是假装成功', async () => {
  // The page must be able to say "this build cannot approve" rather than showing a
  // button that appears to work. Silently succeeding here would be the worst outcome:
  // the owner believes a record exists, the publish refuses, and the message blames
  // "no approval" for something that never happened.
  const { deps, dir } = makeDeps()
  try {
    const routes = makeSettingsRoutes(deps)
    const result = await callRoute(routes, ROUTE_APPROVE, { sessionId: 's', candidateId: 'c' })
    assert.equal(result.status, 501)
    assert.match(String(result.json.error), /没有提供人工批准接口/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// What the route passes through, and what it must not add
// ---------------------------------------------------------------------------

test('/approve 把请求体原样交给 Host 的批准实现，不多也不少', async () => {
  const seen: unknown[] = []
  const outcome: ApprovalOutcome = {
    status: 200,
    body: { approved: true, approvalId: 'ap-1', expiresAt: '2026-01-01T00:00:00Z' },
  }
  const { deps, dir } = makeDeps({
    approve: async (input) => {
      seen.push(input)
      return outcome
    },
  })
  try {
    const routes = makeSettingsRoutes(deps)
    const result = await callRoute(routes, ROUTE_APPROVE, {
      sessionId: 's-1',
      candidateId: 's-1-c1',
    })

    assert.equal(result.status, 200)
    assert.equal(result.json.approved, true)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], { sessionId: 's-1', candidateId: 's-1-c1' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('批准失败时返回 Host 给的代码和原因', async () => {
  const { deps, dir } = makeDeps({
    approve: async () => ({ status: 409, body: { error: '这个候选已被安全闸门阻止', code: 'blocked' } }),
  })
  try {
    const routes = makeSettingsRoutes(deps)
    const result = await callRoute(routes, ROUTE_APPROVE, { sessionId: 's', candidateId: 'c' })
    assert.equal(result.status, 409)
    assert.equal(result.json.code, 'blocked')
    assert.match(String(result.json.error), /安全闸门/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('批准接口不会把凭据写进响应', async () => {
  // Broad but cheap: the response to an approval request must never contain a cookie or
  // a key, however the Host is configured. `assert` on the serialized payload catches a
  // future field that happens to be copied from config.
  const { deps, dir } = makeDeps({
    config: () => resolveConfig({ tiebaCookie: 'ST=SUPERSECRET', llmApiKey: 'sk-SUPERSECRET' }),
    approve: async () => ({ status: 200, body: { approved: true, approvalId: 'ap-1' } }),
  })
  try {
    const routes = makeSettingsRoutes(deps)
    const result = await callRoute(routes, ROUTE_APPROVE, { sessionId: 's', candidateId: 'c' })
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('SUPERSECRET'), false, serialized)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The pending list
// ---------------------------------------------------------------------------

test('设置视图透传待批准列表', async () => {
  const pending: PendingApprovalView[] = [
    {
      sessionId: 's-1',
      candidateId: 's-1-c1',
      platform: 'tieba',
      threadTitle: '某个帖子',
      threadUrl: 'https://tieba.baidu.com/p/1',
      targetPostId: 'n5',
      text: '这是候选正文。',
      candidateVersion: 1,
      verdict: 'review',
      createdAt: '2026-01-01T00:00:00Z',
      reason: '需要人工确认',
    },
  ]
  const { deps, dir } = makeDeps({ pendingApprovals: () => pending })
  try {
    const routes = makeSettingsRoutes(deps)
    const route = routes.find((entry) => entry.path === '/api/dsh-ai-debate/settings')!
    let payload = ''
    const response = {
      writeHead: () => response,
      end: (chunk?: string) => {
        payload = typeof chunk === 'string' ? chunk : ''
        return response
      },
    } as never
    await route.handler(
      {
        method: 'GET',
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:51271', origin: 'http://127.0.0.1:51271' },
      } as never,
      response,
    )
    const view = JSON.parse(payload) as { pendingApprovals?: unknown }
    assert.deepEqual(view.pendingApprovals, pending)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Host 不提供待批准列表时，字段缺席而不是空数组', async () => {
  // "This build cannot report them" and "nothing is waiting" are different facts, and
  // the page needs to say different things. An empty array would collapse them.
  const { deps, dir } = makeDeps()
  try {
    const routes = makeSettingsRoutes(deps)
    const route = routes.find((entry) => entry.path === '/api/dsh-ai-debate/settings')!
    let payload = ''
    const response = {
      writeHead: () => response,
      end: (chunk?: string) => {
        payload = typeof chunk === 'string' ? chunk : ''
        return response
      },
    } as never
    await route.handler(
      {
        method: 'GET',
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:51271', origin: 'http://127.0.0.1:51271' },
      } as never,
      response,
    )
    const view = JSON.parse(payload) as Record<string, unknown>
    assert.equal('pendingApprovals' in view, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The store underpinning the list
// ---------------------------------------------------------------------------

test('emptyStore 同时带上 security 与 approvals 两个空列表', async () => {
  // `prune()` and `validateStore()` both rebuild the document field by field, so a field
  // absent from `emptyStore()` is a field that quietly never exists. v0.2.5's own bug was
  // exactly this shape.
  const { emptyStore } = await import('../lib/store.js')
  const empty = emptyStore()
  assert.deepEqual(empty.security, [])
  assert.deepEqual(empty.approvals, [])
})

test('一个全新的 store 读得到空的批准列表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-approve-store-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    assert.deepEqual(store.getApprovals(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
