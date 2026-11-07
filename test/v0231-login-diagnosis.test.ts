/**
 * v0.2.31 §六：登录状态必须是一个**带时间的观测**，不是一句永久事实。
 *
 * ## 这一组测试在防什么
 *
 * 1. **把「登录过」显示成「登录着」**。`doctor` 对「从没登录」与「令牌失效」打印
 *    同一行 `× 注册或登录`。不区分这两者，用户会以为插件在说假话（「我明明登录过」），
 *    或者以为需要重新注册。v0.2.30 的 README 就是这么把一个会过期的状态写成了永久事实。
 * 2. **把网络故障说成令牌过期**。CLI 的 `resolveToken()` 在刷新失败时返回 null，
 *    它把所有异常都吞了。断言里所以必须同时出现「网络」和「重新登录」两条动作。
 * 3. **把历史成功缓存成现状**。快照必须带 `checkedAt` 与 `staleAfterMs`，
 *    过期之后页面不能继续把它画成绿的。
 * 4. **泄漏凭据**。整个模块只读那个指向保管库的引用文件，且只取四个非敏感字段。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildReadiness, readinessIsStale, type ReadinessProbe } from '../lib/platforms/weibo/readiness.js'
import {
  describeAge,
  loginVerdictOf,
  probeCredentialPresence,
  type CredentialPresence,
} from '../lib/platforms/weibo/credential-state.js'

const AT = '2026-11-06T12:00:00.000Z'

function probeOf(overrides: Partial<ReadinessProbe> = {}): ReadinessProbe {
  return {
    cliInstalled: true,
    cliVersion: '0.9.8',
    commands: { ok: true, count: 0 },
    doctorSteps: [
      { label: '注册或登录', ok: false },
      { label: '完成开发者认证', ok: false },
      { label: '开通服务', ok: false },
    ],
    doctorExitCode: 0,
    now: AT,
    ...overrides,
  }
}

const NOT_LOGGED = probeOf({
  credential: { state: 'absent' },
})

const EXPIRED = probeOf({
  credential: {
    state: 'recorded',
    username: '一个天真的矿哥',
    recordedAt: '2026-11-05T15:12:31.336Z',
    storage: 'keychain',
  },
})

test('登录 1：从没登录过时说「没有登录记录」，不说「已过期」', () => {
  const snapshot = buildReadiness(NOT_LOGGED)
  const login = snapshot.checks.find((check) => check.id === 'login')!
  assert.equal(login.state, 'blocked')
  assert.match(login.detail, /没有登录记录|从来没有/)
  assert.ok(!/过期|失效/.test(login.detail), '不能把「从没登录」说成「过期」')
})

test('登录 2：有记录但拿不到令牌时，同时给出网络与重新登录两条动作', () => {
  const snapshot = buildReadiness(EXPIRED)
  const login = snapshot.checks.find((check) => check.id === 'login')!
  assert.equal(login.state, 'blocked')
  assert.match(login.detail, /登录记录/, '必须承认本机有记录——否则用户会觉得插件在说谎')
  assert.match(login.detail, /网络|过期|失效/, '必须说明可能是令牌失效，也可能是网络')
  const next = login.next.join(' ')
  assert.match(next, /网络/, '先确认网络')
  assert.match(next, /auth login/, '再重新登录')
})

test('登录 3：doctor 通过时登录项为 ready，并带上账号名', () => {
  const snapshot = buildReadiness(
    probeOf({
      doctorSteps: [
        { label: '注册或登录', ok: true },
        { label: '完成开发者认证', ok: true },
        { label: '开通服务', ok: true },
      ],
      commands: { ok: true, count: 9 },
      credential: { state: 'recorded', username: '一个天真的矿哥' },
    }),
  )
  const login = snapshot.checks.find((check) => check.id === 'login')!
  assert.equal(login.state, 'ready')
  assert.match(login.detail, /一个天真的矿哥/)
  assert.equal(snapshot.canRead, true)
})

test('登录 4：没有凭据证据时不做推断，只说「无法确认」', () => {
  const noEvidence = buildReadiness(
    probeOf({ credential: undefined }),
  )
  const login = noEvidence.checks.find((check) => check.id === 'login')!
  // 没有 doctor 也没有凭据记录时只能落在上游的「没有证据」措辞上。
  assert.ok(
    login.state === 'unknown' || login.state === 'blocked',
    `没有证据时不能宣称 ready，实际 ${login.state}`,
  )

  const unreadable = buildReadiness(
    probeOf({ credential: { state: 'unknown', reason: '文件不是合法 JSON' } }),
  )
  const unknownLogin = unreadable.checks.find((check) => check.id === 'login')!
  assert.equal(unknownLogin.state, 'unknown', '读不出凭据记录时不能断言「没登录」')
  assert.match(unknownLogin.detail, /无法确认/)
})

test('登录 5：快照带检查时间与失效期，过期之后能被认出来', () => {
  const snapshot = buildReadiness(NOT_LOGGED)
  assert.equal(snapshot.checkedAt, AT)
  assert.ok(snapshot.staleAfterMs > 0)
  const justNow = Date.parse(AT) + 60_000
  assert.equal(readinessIsStale(snapshot, justNow), false, '一分钟内不算过期')
  const later = Date.parse(AT) + snapshot.staleAfterMs + 1
  assert.equal(readinessIsStale(snapshot, later), true, '超过失效期必须能认出来')
})

test('登录 6：同样的输入两次得到同样的快照（诊断是纯函数）', () => {
  const a = buildReadiness(EXPIRED)
  const b = buildReadiness(EXPIRED)
  assert.deepEqual(a, b, '同一份探测结果不能给出两份不同结论')
})

test('登录 7：三种登录结论分别对应三种下一步', () => {
  const absent: CredentialPresence = { state: 'absent' }
  const recorded: CredentialPresence = { state: 'recorded', username: 'x' }
  assert.equal(loginVerdictOf({ credential: absent, cliLoginOk: false }), 'no_credential')
  assert.equal(loginVerdictOf({ credential: recorded, cliLoginOk: false }), 'credential_unusable')
  assert.equal(loginVerdictOf({ credential: recorded, cliLoginOk: true }), 'ok')
  assert.equal(
    loginVerdictOf({ credential: recorded, cliLoginOk: undefined }),
    'unknown',
    '没跑 doctor 时不能下结论',
  )
})

test('登录 8：登录时长能算出来，用来提醒会话有寿命', () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z')
  assert.equal(describeAge('2026-11-06T11:30:00.000Z', now), '不到一小时')
  assert.equal(describeAge('2026-11-06T03:00:00.000Z', now), '9 小时')
  assert.equal(describeAge('2026-11-04T12:00:00.000Z', now), '2 天')
  assert.equal(describeAge(undefined, now), undefined)
  assert.equal(describeAge('不是时间', now), undefined)
})

test('登录 9：凭据探测只取白名单字段，任何令牌字段都不会被带出来', () => {
  // 用一个假的 home 目录，避免碰主人真实的 ~/.weibo-cli。
  const home = mkdtempSync(join(tmpdir(), 'dsh-cred-'))
  const previous = process.env.HOME
  const previousUser = process.env.USERPROFILE
  try {
    const dir = join(home, '.weibo-cli')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'credential-ref.json'),
      JSON.stringify({
        account_id: 'default',
        username: '一个天真的矿哥',
        user_id: '1911858642',
        storage: 'keychain',
        created_at: '2026-11-05T15:12:31.336Z',
        // 故意塞进来：真实的 CLI 现在不写这两个字段，但将来可能会。
        access_token: 'at_should_never_leak',
        refresh_token: 'rt_should_never_leak',
        cookie: 'SUB=should_never_leak',
      }),
      'utf8',
    )
    process.env.HOME = home
    process.env.USERPROFILE = home
    const presence = probeCredentialPresence()
    assert.equal(presence.state, 'recorded')
    assert.equal(presence.username, '一个天真的矿哥')
    const serialized = JSON.stringify(presence)
    for (const secret of ['should_never_leak', 'user_id', '1911858642', 'account_id']) {
      assert.ok(!serialized.includes(secret), `凭据探测结果里不能出现「${secret}」：${serialized}`)
    }
  } finally {
    process.env.HOME = previous
    process.env.USERPROFILE = previousUser
    rmSync(home, { recursive: true, force: true })
  }
})

test('登录 10：没有凭据文件时报 absent，不是 unknown', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cred-empty-'))
  const previous = process.env.HOME
  const previousUser = process.env.USERPROFILE
  try {
    process.env.HOME = home
    process.env.USERPROFILE = home
    assert.equal(probeCredentialPresence().state, 'absent')
  } finally {
    process.env.HOME = previous
    process.env.USERPROFILE = previousUser
    rmSync(home, { recursive: true, force: true })
  }
})
