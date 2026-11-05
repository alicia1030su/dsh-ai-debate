/**
 * v0.2.30 §三：CLI 授权就绪诊断的八个状态。
 *
 * ## 这个文件在防什么
 *
 * 一个布尔。具体地说，防的是这几种把八种「不能」压成一种「不能」的写法：
 *
 * - `canRead: false` 而没有下一步 → 用户只能一个个试；
 * - 把「没登录」和「没开通服务」报成同一项 → 后者要去控制台，而前者只需一条命令；
 * - CLI 没装就把登录状态报成 `blocked` → 那是一个关于账号的断言，而当时没有任何证据。
 *
 * ## 每个断言都要有对应的「凭什么」
 *
 * 测试里除了断言 `state`，还断言 `detail` 里出现了那条证据（版本号、doctor 的步骤
 * 标签、错误原文）。只断状态的话，一个把所有项都写死成 `blocked` 的实现也能通过。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CAUSAL_ORDER,
  READINESS_ORDER,
  buildReadiness,
  describeReadiness,
  isInstallFailure,
  type ReadinessProbe,
} from '../lib/platforms/weibo/readiness.js'

/** 八项全绿的基线。每一项的测试只改自己关心的那一个字段。 */
function healthy(): ReadinessProbe {
  return {
    cliInstalled: true,
    cliVersion: '0.9.8',
    commands: { ok: true, count: 12 },
    doctorSteps: [
      { label: '注册或登录', ok: true },
      { label: '完成开发者认证', ok: true },
      { label: '开通服务', ok: true },
    ],
    doctorExitCode: 0,
    quota: { known: true, detail: '剩余额度 500 次' },
    lastRead: { ok: true, at: '2026-11-06T00:00:00Z', stage: 'thread', message: '返回了正文' },
  }
}

function stateOf(probe: ReadinessProbe, id: string): string {
  const snapshot = buildReadiness(probe)
  const check = snapshot.checks.find((entry) => entry.id === id)
  assert.ok(check !== undefined, `应当有 ${id} 这一项`)
  return check.state
}

test('八项 0：顺序固定，八项一个不少', () => {
  const snapshot = buildReadiness(healthy())
  assert.equal(snapshot.checks.length, 8)
  assert.deepEqual(
    snapshot.checks.map((check) => check.id),
    [...READINESS_ORDER],
  )
})

test('八项 1：全绿时 canRead 为真，且没有 blocking', () => {
  const snapshot = buildReadiness(healthy())
  assert.equal(snapshot.canRead, true)
  assert.equal(snapshot.blocking, undefined)
  assert.equal(snapshot.summary, undefined)
  assert.ok(snapshot.checks.every((check) => check.state === 'ready'))
})

test('八项 2：CLI 没装时只有「安装」是 blocked，其余是 unknown', () => {
  const probe: ReadinessProbe = {
    cliInstalled: false,
    commands: { ok: false, reason: 'not found' },
  }
  const snapshot = buildReadiness(probe)
  assert.equal(stateOf(probe, 'installed'), 'blocked')
  // 「CLI 没装」是唯一可以直接行动的结论。
  assert.equal(snapshot.blocking, 'installed')
  // 其余各项必须说「不知道」，而不是「未完成」——后者是关于账号的断言，
  // 而当时一次 doctor 都没跑过。
  for (const id of ['version', 'commands', 'login', 'certification', 'activation'] as const) {
    assert.equal(stateOf(probe, id), 'unknown', `${id} 应当是 unknown 而不是 blocked`)
  }
})

test('八项 3：没登录与没开通服务是两个独立状态，措辞不同', () => {
  const probe: ReadinessProbe = {
    ...healthy(),
    doctorSteps: [
      { label: '注册或登录', ok: false },
      { label: '完成开发者认证', ok: false },
      { label: '开通服务', ok: false },
    ],
    doctorExitCode: 0,
  }
  const snapshot = buildReadiness(probe)
  const login = snapshot.checks.find((check) => check.id === 'login')!
  const cert = snapshot.checks.find((check) => check.id === 'certification')!
  const activation = snapshot.checks.find((check) => check.id === 'activation')!
  assert.equal(login.state, 'blocked')
  assert.equal(cert.state, 'blocked')
  assert.equal(activation.state, 'blocked')
  assert.notEqual(login.detail, activation.detail, '三者的说明必须能区分开')
  // 每一项的「下一步」指向不同动作。
  assert.match(login.next.join(' '), /auth login/)
  assert.match(activation.next.join(' '), /服务|积分/)
  assert.equal(snapshot.canRead, false)
  // 最早的那一项是 `login`（顺序在认证与开通之前）。
  assert.equal(snapshot.blocking, 'login')
})

test('八项 4：只差开发者认证时 blocking 指向认证，不是登录', () => {
  const probe: ReadinessProbe = {
    ...healthy(),
    doctorSteps: [
      { label: '注册或登录', ok: true },
      { label: '完成开发者认证', ok: false },
      { label: '开通服务', ok: true },
    ],
    doctorExitCode: 0,
  }
  const snapshot = buildReadiness(probe)
  assert.equal(snapshot.blocking, 'certification')
  assert.equal(snapshot.canRead, false)
})

test('八项 5：doctor 输出解析不出步骤时报 unknown，不报通过', () => {
  const probe: ReadinessProbe = {
    ...healthy(),
    doctorSteps: [],
    doctorExitCode: 1,
  }
  const snapshot = buildReadiness(probe)
  assert.equal(snapshot.checks.find((check) => check.id === 'login')!.state, 'unknown')
  // 关键：解析不出 ≠ 通过。如果这三项被当成 ready，canRead 会是 true。
  assert.equal(snapshot.canRead, false)
  const login = snapshot.checks.find((check) => check.id === 'login')!
  assert.match(login.detail, /没有可识别的步骤行/)
  assert.match(login.detail, /退出码 1/)
})

test('八项 6：命令清单读不到时报 blocked 并带上原因', () => {
  const probe: ReadinessProbe = {
    ...healthy(),
    commands: { ok: false, reason: '调用超时' },
  }
  const snapshot = buildReadiness(probe)
  const check = snapshot.checks.find((entry) => entry.id === 'commands')!
  assert.equal(check.state, 'blocked')
  assert.match(check.detail, /调用超时/)
})

test('八项 7：命令清单读到但一条都没有，也是 blocked', () => {
  const probe: ReadinessProbe = { ...healthy(), commands: { ok: true, count: 0 } }
  const check = buildReadiness(probe).checks.find((entry) => entry.id === 'commands')!
  assert.equal(check.state, 'blocked')
  assert.match(check.detail, /一条可用命令都没有/)
})

test('八项 8：额度未知不阻断 canRead', () => {
  const probe: ReadinessProbe = {
    ...healthy(),
    quota: { known: false, reason: '本进程没有查询额度' },
  }
  const snapshot = buildReadiness(probe)
  assert.equal(snapshot.checks.find((check) => check.id === 'quota')!.state, 'unknown')
  assert.equal(snapshot.canRead, true, '额度未知是「没查」，不是「不能读」')
})

test('八项 9：额度未知的 detail 说清「没查」而不是「查不到」', () => {
  const probe: ReadinessProbe = {
    ...healthy(),
    quota: { known: false, reason: '本进程没有查询额度：属于账户管理操作' },
  }
  const check = buildReadiness(probe).checks.find((entry) => entry.id === 'quota')!
  assert.match(check.detail, /没有查询额度/)
  assert.doesNotMatch(check.detail, /不可用|不能/)
})

test('八项 10：从没读过时「最近一次读取」是 unknown，不是失败', () => {
  const probe: ReadinessProbe = { ...healthy() }
  delete (probe as { lastRead?: unknown }).lastRead
  const snapshot = buildReadiness(probe)
  const check = snapshot.checks.find((entry) => entry.id === 'last_read')!
  assert.equal(check.state, 'unknown')
  assert.match(check.detail, /不代表失败/)
  assert.equal(snapshot.canRead, true, '没读过不代表不能读')
})

test('八项 11：最近一次读取失败时给出失败原因', () => {
  const probe: ReadinessProbe = {
    ...healthy(),
    lastRead: { ok: false, at: '2026-11-06T00:00:00Z', stage: 'comments', message: 'HTTP 502' },
    lastError: { at: '2026-11-06T00:00:00Z', state: 'failed', message: '上游返回 502' },
  }
  const check = buildReadiness(probe).checks.find((entry) => entry.id === 'last_read')!
  assert.equal(check.state, 'blocked')
  assert.match(check.detail, /HTTP 502/)
  assert.match(check.next.join(' '), /上游返回 502/)
})

test('八项 12：版本号不可识别时 version 是 blocked，不是 ready', () => {
  const probe: ReadinessProbe = { ...healthy(), cliVersion: 'unknown-build' }
  const check = buildReadiness(probe).checks.find((entry) => entry.id === 'version')!
  assert.equal(check.state, 'blocked')
  assert.match(check.detail, /unknown-build/)
})

test('八项 13：每一项都有 title 与 detail，且 detail 非空', () => {
  const probes: ReadinessProbe[] = [
    { cliInstalled: false },
    healthy(),
    { ...healthy(), doctorSteps: [], doctorExitCode: 1 },
    { ...healthy(), commands: { ok: false, reason: 'x' } },
  ]
  for (const probe of probes) {
    for (const check of buildReadiness(probe).checks) {
      assert.ok(check.title.length > 0, `${check.id} 缺 title`)
      assert.ok(check.detail.length > 0, `${check.id} 缺 detail`)
    }
  }
})

test('八项 14：blocked 的项必须给出至少一条下一步', () => {
  const probes: ReadinessProbe[] = [
    { cliInstalled: false },
    { ...healthy(), commands: { ok: false, reason: 'x' } },
    { ...healthy(), cliVersion: 'nope' },
    {
      ...healthy(),
      doctorSteps: [{ label: '注册或登录', ok: false }],
      doctorExitCode: 1,
    },
  ]
  for (const probe of probes) {
    for (const check of buildReadiness(probe).checks) {
      if (check.state !== 'blocked') continue
      assert.ok(check.next.length > 0, `${check.id} 是 blocked 但没告诉用户能做什么`)
    }
  }
})

test('八项 15：describeReadiness 不返回「已就绪/未就绪」两个值', () => {
  const ok = describeReadiness(buildReadiness(healthy()))
  assert.match(ok, /八项全部通过/)
  const bad = describeReadiness(
    buildReadiness({ ...healthy(), cliInstalled: false }),
  )
  assert.match(bad, /未通过/)
  // 关键：失败时说清是哪一项，而不是一句「未就绪」。
  assert.match(bad, /CLI/)
})

test('八项 16：命令清单缺失（undefined）与读取失败（ok:false）不同', () => {
  const noProbe: ReadinessProbe = { ...healthy() }
  delete (noProbe as { commands?: unknown }).commands
  assert.equal(stateOf(noProbe, 'commands'), 'unknown')
  assert.equal(stateOf({ ...healthy(), commands: { ok: false, reason: 'x' } }, 'commands'), 'blocked')
})

test('八项 17：isInstallFailure 只认 cli_missing', () => {
  assert.equal(isInstallFailure('cli_missing'), true)
  for (const status of ['ok', 'not_authenticated', 'service_inactive', 'quota_exhausted', 'command_unavailable', 'failed'] as const) {
    assert.equal(isInstallFailure(status), false, `${status} 不该被当成「没装」`)
  }
})

// ---------------------------------------------------------------------------
// 真实环境回归（2026-11 在 Windows 上用 @weibo-ai/weibo-cli@0.9.8 实测）
// ---------------------------------------------------------------------------

/**
 * 这一组不是构造出来的场景，是**实测记录的原始状态**：
 *
 * ```
 * $ weibo-cli.cmd doctor
 * 使用准备检查
 * ✓ 注册或登录: 一个天真的矿哥
 * × 完成开发者认证
 * × 开通服务
 *
 * $ weibo-cli.cmd commands list --available --output json
 * { "service_status": "none", "total": 75, "available_count": 0, "commands": [] }
 * ```
 *
 * 它抓到过一个只在真实环境里才暴露的缺陷：`blocking` 按**展示顺序**取第一个
 * 阻断项，于是得到「命令清单不可用」。而命令清单为空是认证与服务缺失的
 * **结果**——用户会去排查一个不是原因的现象，真正的下一步（扫脸认证）反而藏着。
 *
 * 展示顺序与因果顺序必须分开。这条测试锁住因果顺序。
 */
test('真实回归 1：登录已通、认证与服务未通时，blocking 指向认证而不是命令清单', () => {
  const probe: ReadinessProbe = {
    cliInstalled: true,
    cliVersion: '0.9.8',
    // 真实输出：total 75，available 0。
    commands: { ok: true, count: 0 },
    doctorSteps: [
      { label: '注册或登录: 一个天真的矿哥', ok: true },
      { label: '完成开发者认证', ok: false },
      { label: '开通服务', ok: false },
    ],
    doctorExitCode: 0,
    quota: { known: false, reason: '本进程没有查询额度（账户管理不由插件执行）。' },
  }
  const snapshot = buildReadiness(probe)

  // 逐项都要对：登录通、认证与服务不通、命令清单不通。
  assert.equal(snapshot.checks.find((c) => c.id === 'installed')!.state, 'ready')
  assert.equal(snapshot.checks.find((c) => c.id === 'version')!.state, 'ready')
  assert.equal(snapshot.checks.find((c) => c.id === 'login')!.state, 'ready')
  assert.equal(snapshot.checks.find((c) => c.id === 'certification')!.state, 'blocked')
  assert.equal(snapshot.checks.find((c) => c.id === 'activation')!.state, 'blocked')
  assert.equal(snapshot.checks.find((c) => c.id === 'commands')!.state, 'blocked')

  // 核心断言：blocking 必须是认证，不是命令清单。
  assert.equal(
    snapshot.blocking,
    'certification',
    'blocking 必须按因果链取第一个阻断项；命令清单为空是认证缺失的结果，不是原因',
  )
  assert.match(snapshot.summary!, /开发者认证/)
  assert.doesNotMatch(snapshot.summary!, /命令清单/)
  assert.equal(snapshot.canRead, false)
})

test('真实回归 2：登录这一行带账号名时仍被认成「登录已通」', () => {
  // doctor 打印的是「注册或登录: 一个天真的矿哥」——冒号后面是账号名。
  // 用词而不是位置匹配，所以带名字也不影响。
  const probe: ReadinessProbe = {
    ...healthy(),
    doctorSteps: [
      { label: '注册或登录: 任意账号名', ok: true },
      { label: '完成开发者认证', ok: true },
      { label: '开通服务', ok: true },
    ],
  }
  assert.equal(stateOf(probe, 'login'), 'ready')
})

test('真实回归 3：能读命令清单但一条都不可用时，blocking 仍指向更早的原因', () => {
  // 「命令清单读到了但 0 条」这一句本身是对的（CLI 确实回了 200 和一个空数组），
  // 它只是不该被当成下一步。
  const probe: ReadinessProbe = {
    cliInstalled: true,
    cliVersion: '0.9.8',
    commands: { ok: true, count: 0 },
    doctorSteps: [
      { label: '注册或登录', ok: false },
      { label: '完成开发者认证', ok: false },
      { label: '开通服务', ok: false },
    ],
    doctorExitCode: 0,
  }
  assert.equal(buildReadiness(probe).blocking, 'login', '没登录时，连认证都无从谈起')
  const detail = buildReadiness(probe).checks.find((c) => c.id === 'commands')!.detail
  assert.match(detail, /一条可用命令都没有/, '命令清单这一项仍然要如实说明自己的状态')
})

test('真实回归 4：全部通过时 blocking 缺席，即使额度未知', () => {
  const probe: ReadinessProbe = {
    cliInstalled: true,
    cliVersion: '0.9.8',
    commands: { ok: true, count: 75 },
    doctorSteps: [
      { label: '注册或登录: 某账号', ok: true },
      { label: '完成开发者认证', ok: true },
      { label: '开通服务', ok: true },
    ],
    doctorExitCode: 0,
    quota: { known: false, reason: '本进程没有查询额度' },
  }
  const snapshot = buildReadiness(probe)
  assert.equal(snapshot.blocking, undefined)
  assert.equal(snapshot.canRead, true)
  assert.equal(snapshot.summary, undefined)
})

test('真实回归 5：展示顺序与因果顺序是两个常量，不能拿前者当后者', () => {
  // 展示顺序里命令清单在登录之前（它与「能不能读」最直接相关）；
  // 因果顺序里命令清单在最后（它由前几项共同决定）。
  assert.ok(
    READINESS_ORDER.indexOf('commands') < READINESS_ORDER.indexOf('login'),
    '展示顺序：命令清单应当排在登录之前，靠近「能不能读」',
  )
  assert.ok(
    CAUSAL_ORDER.indexOf('commands') > CAUSAL_ORDER.indexOf('activation'),
    '因果顺序：命令清单必须排在服务开通之后',
  )
  // 两条链覆盖同一批「会阻断」的项。
  assert.deepEqual([...CAUSAL_ORDER].sort(), [
    'activation',
    'certification',
    'commands',
    'installed',
    'login',
    'version',
  ])
})
