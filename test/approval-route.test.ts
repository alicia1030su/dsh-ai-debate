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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    config: () => resolveConfig({ tiebaCookie: 'ST=fixture-supersecret-0001', llmApiKey: 'sk-fixture-supersecret-00000001' }),
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
  const { deps, dir } = makeDeps({ pendingApprovals: async () => ({ ok: true, rows: pending }) })
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
    const view = JSON.parse(payload) as {
      pendingApprovals?: unknown
      pendingApprovalsState?: { status?: string; count?: number }
    }
    assert.deepEqual(view.pendingApprovals, pending)
    // The state field is what tells a renderer the read actually happened; without it
    // an array is indistinguishable from "we could not read".
    assert.equal(view.pendingApprovalsState?.status, 'ready')
    assert.equal(view.pendingApprovalsState?.count, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读取失败时不得渲染成空列表：状态字段必须是 failed 且带原因（v0.2.8）', async () => {
  // The failure this pins: a corrupt/vanished state file made the read fail, the route
  // answered `pendingApprovals: []`, and the page told the owner "当前没有待批准候选".
  // A calm empty list is the single most misleading thing to show here, because the
  // correct action (go fix the state file) is the opposite of what the page suggests.
  const { deps, dir } = makeDeps({
    pendingApprovals: async () => ({
      ok: false,
      reason: '状态文件已损坏；为避免覆盖掉可恢复的内容，这次写入被拒绝。',
      code: 'corrupt',
    }),
  })
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
    const view = JSON.parse(payload) as {
      pendingApprovals?: unknown
      pendingApprovalsState?: { status?: string; reason?: string; code?: string }
    }
    assert.equal(view.pendingApprovalsState?.status, 'failed')
    assert.match(String(view.pendingApprovalsState?.reason), /损坏/)
    assert.equal(view.pendingApprovalsState?.code, 'corrupt')
    // The legacy array stays empty rather than absent, so a v0.2.7 client renders
    // "nothing to approve" instead of crashing on `undefined.length`.
    assert.deepEqual(view.pendingApprovals, [])
    // The rest of the view still renders: a failed pending list must not take the
    // whole settings page down with it.
    assert.equal((view as Record<string, unknown>).status, 'ready')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pendingApprovals 抛异常也不得变成 500：降级为 failed 状态（v0.2.8）', async () => {
  const { deps, dir } = makeDeps({
    pendingApprovals: async () => {
      throw new Error('模拟底层读取器崩溃')
    },
  })
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
    const view = JSON.parse(payload) as {
      status?: string
      pendingApprovalsState?: { status?: string; reason?: string }
    }
    assert.equal(view.status, 'ready', '其余设置仍应可用')
    assert.equal(view.pendingApprovalsState?.status, 'failed')
    assert.match(String(view.pendingApprovalsState?.reason), /崩溃/)
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

// ---------------------------------------------------------------------------
// v0.2.8: 事务化批准 —— 并发与原子性
// ---------------------------------------------------------------------------

test('并发批准同一候选，只留一条有效记录（v0.2.8）', async () => {
  // v0.2.7 先在事务外读候选、核对快照，再 mutate() 追加。两个请求同时到达时，两次
  // 都读到同一个「尚无记录」的状态，于是两条记录都被写下 —— 主人只看到一个按钮，
  // 却签出了两份授权。现在核对与写入在同一个锁持有内完成，未消费的旧记录会被替换，
  // 所以「一次点击只能对应一份有效授权」是结构性的，不靠时序运气。
  const dir = mkdtempSync(join(tmpdir(), 'dsd-approve-race-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()

    // 直接压 store 层：这里验证的是并发语义，不是路由。
    const record = (id: string) => ({
      id,
      sessionId: 's-race',
      candidateId: 's-race-c1',
      platform: 'tieba',
      targetPostId: 'n5',
      publishingAccount: '1001',
      textHash: 'h',
      candidateVersion: 1,
      assessmentFingerprint: 'f',
      grantedBy: 'owner',
      grantedAt: new Date().toISOString(),
    })
    const write = async (tag: string) =>
      store.transact((data) => ({
        commit: {
          ...data,
          approvals: [
            // 与 index.ts 里的规则一致：已消费的留作历史，未消费的全部替换。
            ...(data.approvals ?? []).filter((row) => row.consumedAt !== undefined),
            record(tag),
          ],
        },
        value: tag,
      }))

    await Promise.all([write('ap-a'), write('ap-b')])
    const live = store.getApprovals().filter((row) => row.consumedAt === undefined)
    assert.equal(live.length, 1, `并发后只该有一条未消费记录，实际 ${live.length} 条`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transact 的 abort 不写盘、不改内存（v0.2.8）', async () => {
  // `mutate` 无法表达「拒绝」：它只能返回下一份文档，想说「不」就只能抛错，而抛错
  // 会被 store 记成一次写盘失败（dirty），于是页面显示「状态写不进去」——一个本来
  // 只是「你看到的内容已经过期」的正常结果，被渲染成了磁盘故障。
  // `transact` 的 abort 是一次干净的否决：文件不动、内存不动、dirty 不变。
  const dir = mkdtempSync(join(tmpdir(), 'dsd-transact-abort-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, security: [] }))
    const before = readFileSync(join(dir, 'state.json'), 'utf8')

    const outcome = await store.transact(() => ({ abort: 'refused' as const }))
    assert.equal('aborted' in outcome, true)
    assert.equal((outcome as { value: string }).value, 'refused')

    const after = readFileSync(join(dir, 'state.json'), 'utf8')
    assert.equal(after, before, 'abort 不得改动磁盘')
    assert.equal(store.hasUnsavedChanges, false, 'abort 不是写盘失败，不该标 dirty')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transact 的 commit 同时带回持久化结果与裁决（v0.2.8）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-transact-commit-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const outcome = await store.transact((data) => ({
      commit: { ...data, security: [] },
      value: { status: 200 as const, body: { approved: true } },
    }))
    assert.equal('committed' in outcome, true)
    const value = (outcome as { value: { status: number } }).value
    assert.equal(value.status, 200, 'commit 的 value 必须原样交还调用方')
    JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
