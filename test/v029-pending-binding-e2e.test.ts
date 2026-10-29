/**
 * v0.2.9 §一（端到端）：真实的 `/settings` 路由是否按**完整绑定**筛选待批准列表。
 *
 * `v029-pending-binding.test.ts` 证明的是 `checkApproval()` 的语义正确。那份测试即使
 * 全绿，也证明不了 `listPendingApprovals()` 真的调用了它 —— v0.2.8 的问题恰恰是
 * 语义已经有、调用点没接上（旧代码只比 `sessionId + candidateId`）。
 *
 * 所以这里走真实装配：`apply()` 到一个真实 Cordis 容器 → 取得真实注册的 `/settings`
 * 路由 → 带合法 Host/Origin 调它 → 读回 JSON。断言落在**页面上会出现的那一个数组**上。
 *
 * ## 为什么不用手写的 deps 对象
 *
 * 手写 deps 是我提供什么它就用什么，调用点写错也能过。真实容器里 `apply` 自己决定
 * 怎么把 store、config、approver 接起来，那才是发布时会跑的那条路径。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import * as plugin from '../lib/index.js'
import { DebateStore } from '../lib/store.js'
import { hashText } from '../lib/security/approvals.js'
import type { WebRoute } from '../lib/settings-routes.js'

/** A recording webServer, the same shape the integration test uses. */
function fakeWebServer() {
  const routes: WebRoute[] = []
  return {
    routes,
    register(route: WebRoute) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

function fakeTools() {
  return { register: () => () => undefined }
}

function fakeSystemPrompt() {
  return { section: () => () => undefined }
}

/** Call a route with a browser-shaped request and return the parsed body. */
async function getSettings(routes: readonly WebRoute[]): Promise<Record<string, unknown>> {
  const { status, body } = await getSettingsRaw(routes)
  // A non-200 here would otherwise surface as "pendingApprovals is not an array", which
  // points at the wrong thing entirely: the file has to say what the route actually
  // answered, because a 403 means the request never reached the list at all.
  assert.equal(status, 200, `设置路由应返回 200，实际 ${status}：${JSON.stringify(body).slice(0, 500)}`)
  return body
}

/** Ask the route what it answered, including the non-200 case, so a failure is legible. */
async function getSettingsRaw(
  routes: readonly WebRoute[],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = routes.find((entry) => entry.path === '/api/dsh-ai-debate/settings')
  assert.ok(route !== undefined, '/settings 必须注册')
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
  await route.handler(
    {
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:51271', origin: 'http://127.0.0.1:51271' },
    } as never,
    response,
  )
  return { status, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }
}

/** One READY session with a single `review` candidate, shaped as the store expects. */
function session(overrides: { text?: string; version?: number; fingerprint?: string } = {}) {
  const text = overrides.text ?? '你这条论据没有出处。'
  const now = new Date().toISOString()
  return {
    id: 's-e2e',
    platform: 'tieba',
    threadId: '900000000000',
    threadUrl: 'https://tieba.baidu.com/p/900000000000',
    threadTitle: '端到端帖子',
    forumName: '测试吧',
    ownerKey: 'o',
    ownerName: '主人',
    opponentKey: 'b',
    opponentName: '对手B',
    opponentUserId: 'opp-1',
    disputeFloorPostId: '900000000001',
    disputeFloorNumber: 1,
    triggerPostId: 'n7',
    targetKind: 'nested' as const,
    targetPostId: 'n5',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [
      {
        replyId: 'c-e2e',
        text,
        strategy: 'direct_rebuttal',
        targetPostId: 'n5',
        candidateVersion: overrides.version ?? 2,
        textHash: hashText(text),
        confidence: 0.8,
        violations: [],
        notes: [],
        security: {
          injectionDetected: false,
          ownerIdentityValid: true,
          targetIdentityValid: true,
          stanceConsistency: 'consistent' as const,
          ownerDirectedAttack: false,
          unauthorizedInstructionFollowed: false,
          secretLeakRisk: false,
          evidenceIntegrityValid: true,
          decision: 'review' as const,
          reasons: ['需要人工确认'],
          fingerprint: overrides.fingerprint ?? 'fp-current',
        },
        createdAt: now,
        approved: false,
      },
    ],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * The `connection` service the route's authorizer asks for.
 *
 * Its whole job here is to answer "would the real DSH session layer reject this
 * request". Returning `undefined` means "no rejection" — the same answer the Host gives
 * a request carrying a valid same-origin session. Without providing this service the
 * route answers **403 by design** (a deployment that cannot verify a session must not
 * accept writes), which is why a test that forgets it sees a forbidden response rather
 * than a list.
 */
function fakeConnection() {
  return { requestRejection: () => undefined }
}

/** Mount the plugin against a throwaway store directory. */
async function mount(dir: string) {
  const app = new Context()
  const server = fakeWebServer()
  app.provide('webServer', server)
  app.provide('tools', fakeTools())
  app.provide('systemPrompt', fakeSystemPrompt())
  // Not optional: the authorizer refuses every request in a deployment without a
  // verifiable session, which is the correct behaviour and would otherwise make these
  // tests fail for a reason unrelated to what they check.
  app.provide('connection', fakeConnection())
  const fiber = app.plugin(plugin, {
    enabled: true,
    storeDir: dir,
    // A bound AI account, so the expectation is buildable; without it the route
    // deliberately lists the row as "cannot approve" regardless of history.
    aiAccountUserId: '900',
    aiAccountName: 'ai-account',
    announceToAgent: false,
  })
  await fiber
  return { fiber, server }
}

test('端到端：正文变了之后，旧批准不得把候选从列表里隐藏（v0.2.9）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-v029-e2e-'))
  try {
    // Seed the store with the *current* candidate, then a record approved for a body
    // that no longer exists. This is the exact shape of "regenerated after approval".
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({
      ...data,
      sessions: [session() as never],
      approvals: [
        {
          id: 'ap-stale',
          sessionId: 's-e2e',
          candidateId: 'c-e2e',
          platform: 'tieba',
          targetPostId: 'n5',
          publishingAccount: '900',
          textHash: hashText('批准时的旧正文，已经不存在了。'),
          candidateVersion: 2,
          assessmentFingerprint: 'fp-current',
          grantedBy: 'owner',
          grantedAt: new Date().toISOString(),
        } as never,
      ],
    }))

    const { fiber, server } = await mount(dir)
    try {
      const view = await getSettings(server.routes)
      const rows = view.pendingApprovals as unknown[]
      assert.equal(Array.isArray(rows), true, '待批准列表必须是数组')
      assert.equal(rows.length, 1, `旧批准不该隐藏变了正文的候选，实际 ${rows.length} 行`)
      const state = view.pendingApprovalsState as { status?: string }
      assert.equal(state?.status, 'ready')
    } finally {
      await fiber.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：完全匹配的批准仍然把候选隐藏（正面对照，v0.2.9）', async () => {
  // Without this, the test above could pass because the route stopped hiding rows
  // entirely — which would bring back "approve the same row over and over".
  const dir = mkdtempSync(join(tmpdir(), 'dsd-v029-e2e-ok-'))
  try {
    const text = '你这条论据没有出处。'
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({
      ...data,
      sessions: [session({ text }) as never],
      approvals: [
        {
          id: 'ap-live',
          sessionId: 's-e2e',
          candidateId: 'c-e2e',
          platform: 'tieba',
          targetPostId: 'n5',
          publishingAccount: '900',
          textHash: hashText(text),
          candidateVersion: 2,
          assessmentFingerprint: 'fp-current',
          grantedBy: 'owner',
          grantedAt: new Date().toISOString(),
        } as never,
      ],
    }))

    const { fiber, server } = await mount(dir)
    try {
      const view = await getSettings(server.routes)
      const rows = view.pendingApprovals as unknown[]
      assert.equal(rows.length, 0, `已经有效批准的候选不该再要求批准，实际 ${rows.length} 行`)
    } finally {
      await fiber.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：已消费的批准不得隐藏候选（v0.2.9）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-v029-e2e-consumed-'))
  try {
    const text = '你这条论据没有出处。'
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({
      ...data,
      sessions: [session({ text }) as never],
      approvals: [
        {
          id: 'ap-used',
          sessionId: 's-e2e',
          candidateId: 'c-e2e',
          platform: 'tieba',
          targetPostId: 'n5',
          publishingAccount: '900',
          textHash: hashText(text),
          candidateVersion: 2,
          assessmentFingerprint: 'fp-current',
          grantedBy: 'owner',
          grantedAt: new Date().toISOString(),
          consumedAt: new Date().toISOString(),
        } as never,
      ],
    }))

    const { fiber, server } = await mount(dir)
    try {
      const view = await getSettings(server.routes)
      assert.equal((view.pendingApprovals as unknown[]).length, 1, '消费过的批准不该压掉候选')
    } finally {
      await fiber.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：账号切换后旧批准不得隐藏候选（v0.2.9）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-v029-e2e-acct-'))
  try {
    const text = '你这条论据没有出处。'
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({
      ...data,
      sessions: [session({ text }) as never],
      approvals: [
        {
          id: 'ap-otheracct',
          sessionId: 's-e2e',
          candidateId: 'c-e2e',
          platform: 'tieba',
          targetPostId: 'n5',
          // Granted while a different account was bound.
          publishingAccount: '2002',
          textHash: hashText(text),
          candidateVersion: 2,
          assessmentFingerprint: 'fp-current',
          grantedBy: 'owner',
          grantedAt: new Date().toISOString(),
        } as never,
      ],
    }))

    const { fiber, server } = await mount(dir)
    try {
      const view = await getSettings(server.routes)
      assert.equal((view.pendingApprovals as unknown[]).length, 1, '账号变了，旧批准不该继续生效')
    } finally {
      await fiber.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
