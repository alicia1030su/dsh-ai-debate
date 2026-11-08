/**
 * v0.2.33 §六：OAuth 与服务状态的分诊。
 *
 * ## 这一组要解决的具体问题
 *
 * 主人反复遇到「登录状态消失」。`doctor` 对这一整类处境的回答是同一句话：
 *
 * ```
 * × 注册或登录
 * ```
 *
 * 而它背后至少是四件不同的事：
 *
 * 1. 从来没登录过 → 去登录；
 * 2. 登录过，令牌被平台拒了 → 去重新登录（但要先确认不是网络）；
 * 3. 登录过，网络不通 → 先修网络，此时重新登录只会再失败一次；
 * 4. 凭据文件读不出来 → 权限或格式问题。
 *
 * v0.2.31 区分了 1 和 2/3，但 2 与 3 只能写成「要么…要么…」。v0.2.33 加了一个
 * **不带任何凭据**的 HTTPS 探测来收敛它：域名答话 = 网络不是原因。
 *
 * ## 这些测试证明什么、不证明什么
 *
 * 它们证明判定逻辑：给定「有记录 + 探测结果 X」，面板说的话不同、给的下一步不同。
 * 它们**不证明**真实网络的行为——那需要一个真实的外部请求，属于人工验收。
 * 探测本身用注入的假实现测，绝不在这组用例里访问网络。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildReadiness } from '../lib/platforms/weibo/readiness.js'
import { probeAuthHostReachability } from '../lib/platforms/weibo/network-state.js'

/** 造一份「CLI 装了、命令一条都不可用、doctor 三行全 ×」的探测输入。 */
function blockedProbe(overrides: Record<string, unknown> = {}): Parameters<typeof buildReadiness>[0] {
  return {
    cliInstalled: true,
    cliVersion: '0.9.8',
    commands: { ok: true as const, count: 0 },
    doctorSteps: [
      { label: '注册或登录', ok: false },
      { label: '完成开发者认证', ok: false },
      { label: '开通服务', ok: false },
    ],
    doctorExitCode: 0,
    now: '2026-11-07T12:00:00.000Z',
    ...overrides,
  } as Parameters<typeof buildReadiness>[0]
}

function loginCheckOf(snapshot: ReturnType<typeof buildReadiness>) {
  const check = snapshot.checks.find((entry) => entry.id === 'login')
  assert.ok(check !== undefined, '八项里必须有 login')
  return check
}

test('有登录记录 + 授权主机答话 → 断言是令牌被拒，不再说「两种可能」', () => {
  const snapshot = buildReadiness(
    blockedProbe({
      credential: {
        state: 'recorded',
        username: '一个天真的矿哥',
        recordedAt: '2026-11-07T07:56:14.180Z',
        storage: 'keychain',
      },
      network: { state: 'reachable', status: 404 },
    }),
  )
  const check = loginCheckOf(snapshot)
  assert.equal(check.state, 'blocked')
  assert.match(check.detail, /答话了/)
  assert.match(check.detail, /不是网络问题/)
  assert.match(check.detail, /一个天真的矿哥/)
  // 注意：404 也算可达。这里断言的是「拿到 HTTP 状态码」而不是「200」，
  // 因为探测问的是链路通不通，不是那个 URL 上有东西。
  assert.match(check.detail, /404/)
  assert.ok(
    check.next.some((step) => step.includes('--device')),
    '无图形界面时要给出 --device 这条替代路径',
  )
})

test('有登录记录 + 授权主机连不上 → 先修网络，不要盲目重新登录', () => {
  const snapshot = buildReadiness(
    blockedProbe({
      credential: { state: 'recorded', username: '一个天真的矿哥' },
      network: { state: 'unreachable', reason: '2500 毫秒内没有响应' },
    }),
  )
  const check = loginCheckOf(snapshot)
  assert.equal(check.state, 'blocked')
  assert.match(check.detail, /连不上/)
  assert.match(check.detail, /重新登录同样会失败/)
  assert.ok(check.next.some((step) => /代理/.test(step)), '代理是最常见的原因，要说出来')
})

test('没有探测结果时退回「两种可能」，不假装知道', () => {
  const snapshot = buildReadiness(
    blockedProbe({
      credential: { state: 'recorded', username: '一个天真的矿哥' },
    }),
  )
  const check = loginCheckOf(snapshot)
  assert.equal(check.state, 'blocked')
  assert.match(check.detail, /两种可能/)
  assert.doesNotMatch(check.detail, /不是网络问题/)
})

test('从来没有登录记录 → 说的是「没有记录」，不是「令牌失效」', () => {
  const snapshot = buildReadiness(blockedProbe({ credential: { state: 'absent' } }))
  const check = loginCheckOf(snapshot)
  assert.equal(check.state, 'blocked')
  assert.match(check.detail, /没有登录记录/)
  assert.doesNotMatch(check.detail, /令牌/)
})

test('凭据文件读不出来 → unknown，不猜成任何一边', () => {
  const snapshot = buildReadiness(
    blockedProbe({ credential: { state: 'unknown', reason: '权限不足' } }),
  )
  const check = loginCheckOf(snapshot)
  assert.equal(check.state, 'unknown')
  assert.match(check.detail, /无法确认/)
})

test('快照一定带 checkedAt：状态会变，观测必须带时间', () => {
  const snapshot = buildReadiness(blockedProbe())
  assert.equal(snapshot.checkedAt, '2026-11-07T12:00:00.000Z')
  assert.ok(snapshot.staleAfterMs > 0)
})

test('凭据状态不影响已就绪的登录项：doctor 说 ✓ 就是 ✓', () => {
  const snapshot = buildReadiness(
    blockedProbe({
      commands: { ok: true as const, count: 51 },
      doctorSteps: [
        { label: '注册或登录', ok: true },
        { label: '完成开发者认证', ok: true },
        { label: '开通服务', ok: true },
      ],
      credential: { state: 'recorded', username: '一个天真的矿哥' },
      network: { state: 'reachable', status: 200 },
    }),
  )
  const check = loginCheckOf(snapshot)
  assert.equal(check.state, 'ready')
  assert.match(check.detail, /一个天真的矿哥/)
})

test('网络探测：超时报 unreachable 而不是抛错', async () => {
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  const result = await probeAuthHostReachability({ timeoutMs: 10, fetchImpl: hanging })
  assert.equal(result.state, 'unreachable')
  assert.match((result as { reason: string }).reason, /没有响应/)
})

test('网络探测：拿到任何 HTTP 状态码都算可达', async () => {
  for (const status of [200, 204, 403, 404, 500]) {
    const stub: typeof fetch = async () => new Response(null, { status })
    const result = await probeAuthHostReachability({ fetchImpl: stub })
    assert.equal(result.state, 'reachable')
    assert.equal((result as { status: number }).status, status)
  }
})

test('网络探测：抛错时归类为 unreachable，并带上可读原因', async () => {
  const failing: typeof fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND open.weibo.com')
  }
  const result = await probeAuthHostReachability({ fetchImpl: failing })
  assert.equal(result.state, 'unreachable')
  assert.match((result as { reason: string }).reason, /ENOTFOUND/)
})

test('网络探测不带凭据：请求里没有 Authorization，也没有 Cookie', async () => {
  let seen: RequestInit | undefined
  const stub: typeof fetch = async (_input, init) => {
    seen = init
    return new Response(null, { status: 200 })
  }
  await probeAuthHostReachability({ fetchImpl: stub })
  assert.ok(seen !== undefined)
  assert.equal(seen?.method, 'HEAD', '只问链路通不通，不需要响应正文')
  assert.equal(seen?.headers, undefined, '不附加任何头')
  assert.equal(seen?.body, undefined, '不带正文')
})
