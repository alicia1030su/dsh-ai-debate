/**
 * v0.2.34 §2：微博 OAuth 失效的分诊与并发边界。
 *
 * ## 这些测试测的是「我们能证到什么」，不是「我们猜到了什么」
 *
 * 真实 OAuth 故障有三种完全不同的成因，而 CLI 对它们给出**同一个回答**：
 *
 * | 真实成因 | CLI 的回答 | 正确的下一步 |
 * | --- | --- | --- |
 * | 平台拒绝了刷新令牌 | 「缺少登录令牌」 | 重新授权 |
 * | 另一个进程正持锁刷新 | 「缺少登录令牌」 | 等一下再试 |
 * | 网络断了 | 「缺少登录令牌」 | 先修网络 |
 *
 * 所以产品侧能做的不是「修复上游」，而是**把这三件事从同一个回答里拆出来**。
 * 下面每一条断言的都是这个拆分本身。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildReadiness, type ReadinessProbe } from '../lib/platforms/weibo/readiness.js'
import { probeCredentialPresence } from '../lib/platforms/weibo/credential-state.js'

/** 造一份隔离的 CLI 配置目录，并把它挂到当前进程的 homedir 上。 */
function withConfigDir<T>(
  env: 'production' | 'development',
  setup: (dir: string) => void,
  run: () => T,
): T {
  const home = mkdtempSync(join(tmpdir(), 'wb-diag-'))
  const dir = join(home, env === 'development' ? '.weibo-cli-dev' : '.weibo-cli')
  mkdirSync(dir, { recursive: true })
  setup(dir)

  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  const previousNodeEnv = process.env.NODE_ENV
  // homedir() 在 Windows 上读 USERPROFILE，在 POSIX 上读 HOME。两个都改。
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.NODE_ENV = env === 'development' ? 'development' : 'production'
  try {
    return run()
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
}

/** 写一份只有非敏感字段的凭据引用文件。 */
function writeRef(dir: string, extra: { recordedAt?: string; username?: string } = {}): void {
  writeFileSync(
    join(dir, 'credential-ref.json'),
    JSON.stringify({
      account_id: 'default',
      env: 'production',
      storage: 'keychain',
      // 关键：这两个字段是「令牌」的替代品，测试里必须是假值，且绝不能出现在诊断里。
      access_token: 'fixture-access-token-must-not-leak',
      refresh_token: 'fixture-refresh-token-must-not-leak',
      username: extra.username ?? '矿哥',
      created_at: extra.recordedAt ?? '2026-11-07T07:56:14.180Z',
    }),
  )
}

/** 造一个「登录这一步没通过」的就绪探测输入。`credential` 可整体覆盖。 */
type ProbeCredential = NonNullable<ReadinessProbe['credential']>

function blockedProbe(
  dir: string,
  extra: {
    network?: { state: 'reachable'; status: number } | { state: 'unreachable'; reason: string }
    credential?: Partial<ProbeCredential>
  } = {},
): ReadinessProbe {
  const credential: ProbeCredential = {
    state: 'recorded',
    username: '矿哥',
    recordedAt: '2026-11-07T07:56:14.180Z',
    configDir: dir,
    ...(extra.credential ?? {}),
  }
  return {
    cliInstalled: true,
    cliVersion: '0.9.8',
    doctorSteps: [{ label: '注册或登录', ok: false }],
    commands: { ok: true, count: 51 },
    credential,
    ...(extra.network === undefined ? {} : { network: extra.network }),
  }
}

test('有登录记录、网络通、没有锁：判定为令牌被平台拒绝', () => {
  withConfigDir(
    'production',
    (dir) => writeRef(dir),
    () => {
      const snapshot = buildReadiness(blockedProbe(join('C:/tmp', '.weibo-cli'), { network: { state: 'reachable', status: 200 } }))
      const login = snapshot.checks.find((step) => step.id === 'login')
      assert.ok(login !== undefined)
      assert.equal(login.state, 'blocked')
      // 结论必须是「令牌被拒」，而不是「要么网络要么令牌」。
      assert.match(login.detail, /不是网络问题/)
      assert.match(login.detail, /平台拒绝了手上的令牌/)
      // 下一步必须是重新授权（用 --device 给没有图形界面的情况）。
      assert.ok(login.next.some((line) => line.includes('auth login')))
    },
  )
})

test('有登录记录、网络不通：下一步是修网络，不是重新登录', () => {
  withConfigDir(
    'production',
    (dir) => writeRef(dir),
    () => {
      const snapshot = buildReadiness(
        blockedProbe(join('C:/tmp', '.weibo-cli'), {
          network: { state: 'unreachable', reason: '连接被拒绝' },
        }),
      )
      const login = snapshot.checks.find((step) => step.id === 'login')
      assert.ok(login !== undefined)
      assert.match(login.detail, /连不上/)
      // 「这时重新登录同样会失败」是这句话的关键：它阻止主人做无效动作。
      assert.match(login.detail, /重新登录同样会失败/)
    },
  )
})

test('刷新锁新鲜：判定为「另一个进程正在刷新」，并明确说这不等于登录失效', () => {
  withConfigDir(
    'production',
    (dir) => writeRef(dir),
    () => {
      const snapshot = buildReadiness(
        blockedProbe(join('C:/tmp', '.weibo-cli'), {
          network: { state: 'reachable', status: 200 },
          credential: { refreshLock: { present: true, ageMs: 2_000, stale: false } },
        }),
      )
      const login = snapshot.checks.find((step) => step.id === 'login')
      assert.ok(login !== undefined)
      assert.equal(login.state, 'blocked')
      assert.match(login.detail, /另一个 weibo-cli 进程正在刷新令牌/)
      assert.match(login.detail, /不代表登录失效/)
      // 下一步必须是否定式：不要重新登录。
      assert.ok(login.next.some((line) => line.includes('不需要重新登录')))
    },
  )
})

test('刷新锁陈旧（超过 CLI 的 30 秒阈值）：不再归因为「别人在刷新」', () => {
  const snapshot = buildReadiness(
    blockedProbe('C:/tmp/.weibo-cli', {
      credential: { refreshLock: { present: true, ageMs: 45_000, stale: true } },
      network: { state: 'reachable', status: 200 },
    }),
  )
  const login = snapshot.checks.find((step) => step.id === 'login')
  assert.ok(login !== undefined)
  assert.doesNotMatch(login.detail, /另一个 weibo-cli 进程正在刷新令牌/)
  assert.match(login.detail, /平台拒绝了手上的令牌/)
})

test('当前环境没有记录、另一套有：说清是找错了目录，而不是「从没登录过」', () => {
  withConfigDir(
    'production',
    () => {
      // production 那套是空的；development 那套才有记录。模拟「宿主跑在开发构建里，
      // 而主人用普通终端登录过」。
      const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
      const devDir = join(home, '.weibo-cli-dev')
      mkdirSync(devDir, { recursive: true })
      writeRef(devDir, { username: '矿哥' })
    },
    () => {
      const snapshot = buildReadiness({
        cliInstalled: true,
        cliVersion: '0.9.8',
        doctorSteps: [{ label: '注册或登录', ok: false }],
        credential: {
          state: 'absent' as const,
          env: 'production' as const,
          otherEnv: { env: 'development' as const, username: '矿哥', recordedAt: '2026-11-07T07:56:14.180Z' },
        },
      })
      const login = snapshot.checks.find((step) => step.id === 'login')
      assert.ok(login !== undefined)
      // 绝不能写「从来没有完成过 OAuth 登录」——那是假话。
      assert.doesNotMatch(login.detail, /从来没有完成过/)
      assert.match(login.detail, /development/)
      assert.match(login.detail, /去错了目录/)
    },
  )
})

test('两套都没有记录：仍然如实说「从没登录过」', () => {
  const snapshot = buildReadiness({
    cliInstalled: true,
    cliVersion: '0.9.8',
    doctorSteps: [{ label: '注册或登录', ok: false }],
    credential: { state: 'absent' as const, env: 'production' as const },
  })
  const login = snapshot.checks.find((step) => step.id === 'login')
  assert.ok(login !== undefined)
  assert.match(login.detail, /从来没有完成过/)
})

test('诊断措辞里绝不出现令牌本身', () => {
  const snapshot = buildReadiness(
    blockedProbe('C:/tmp/.weibo-cli', {
      network: { state: 'reachable', status: 200 },
      credential: { refreshLock: { present: true, ageMs: 1_000, stale: false } },
    }),
  )
  const serialized = JSON.stringify(snapshot)
  // 这两串来自测试夹具；它们出现在任何输出里都说明字段被原样带出去了。
  assert.equal(serialized.includes('fixture-access-token'), false)
  assert.equal(serialized.includes('fixture-refresh-token'), false)
})

test('真实的凭据引用文件：只读白名单字段，令牌字段不进诊断', () => {
  const presence = withConfigDir(
    'production',
    (dir) => writeRef(dir),
    () => probeCredentialPresence(),
  )
  assert.equal(presence.state, 'recorded')
  assert.equal(presence.username, '矿哥')
  const serialized = JSON.stringify(presence)
  assert.equal(serialized.includes('fixture-access-token'), false)
  assert.equal(serialized.includes('fixture-refresh-token'), false)
})

test('锁文件的年龄由 mtime 决定，不读内容（内容里可能有别人的 pid）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-lock-'))
  const dir = join(home, '.weibo-cli')
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, '.refresh-lock-default')
  writeFileSync(lock, JSON.stringify({ lock_id: 'secret-ish', pid: 4242, created_at: 'x' }))
  const old = new Date(Date.now() - 40_000)
  utimesSync(lock, old, old)

  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const presence = probeCredentialPresence()
    assert.ok(presence.refreshLock !== undefined)
    assert.equal(presence.refreshLock.present, true)
    assert.equal(presence.refreshLock.stale, true)
    // lock_id 与 pid 都没被带出来。
    const serialized = JSON.stringify(presence)
    assert.equal(serialized.includes('secret-ish'), false)
    assert.equal(serialized.includes('4242'), false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
  }
})
