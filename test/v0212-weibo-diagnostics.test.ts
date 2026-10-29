/**
 * v0.2.12 §二：微博诊断必须区分每一种状态，不得用 `unverified` 掩盖未实现。
 *
 * ## 这个文件守的是「诊断能不能指导动作」
 *
 * 一个把七种情况都显示成「不可用」的诊断面板没有价值——主人看到它不知道该装东西、去登录、
 * 去开通服务，还是去查额度。所以这里的每条断言都落在**状态的区分度**上：不同原因必须
 * 得出不同 state，而且状态里必须带着可执行的下一步。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { diagnosisOfStatus, buildDiagnosticLines, createDiagnosticRecorder } from '../lib/platforms/weibo/diagnostics.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'

test('诊断：CLI 的六种状态映射到不同的诊断状态', () => {
  // Same-count, distinct-value mapping. A collapse here is what makes a panel useless.
  const mapping = {
    ok: 'read_ok',
    cli_missing: 'cli_missing',
    not_authenticated: 'not_authorised',
    service_inactive: 'service_inactive',
    command_unavailable: 'permission_insufficient',
    quota_exhausted: 'quota_exhausted',
    failed: 'failed',
  } as const
  for (const [cli, expected] of Object.entries(mapping)) {
    assert.equal(
      diagnosisOfStatus(cli as keyof typeof mapping),
      expected,
      `${cli} 应映射为 ${expected}`,
    )
  }
  // And they must all be distinct — a mapping that funnels several states into one would pass
  // the loop above only if the values were wrong.
  assert.equal(new Set(Object.values(mapping)).size, Object.keys(mapping).length)
})

test('诊断：CLI 未安装时，未检查项显示「未知」而不是「未完成」', () => {
  // The distinction matters: "未完成" implies we looked and found it missing. When the CLI is
  // absent, `doctor` never ran, so we have no evidence at all — and claiming otherwise sends
  // the owner hunting for a login problem that may not exist.
  const lines = buildDiagnosticLines({
    cliInstalled: false,
    oauthLoggedIn: false,
    serviceActive: false,
    readinessState: 'cli_missing',
    readinessMessage: '没有安装 weibo-cli。',
    readinessSteps: [],
  })
  const oauth = lines.find((line) => line.message.startsWith('OAuth 登录'))
  assert.ok(oauth !== undefined)
  assert.equal(oauth!.state, 'not_implemented', `实际 ${oauth!.state}: ${oauth!.message}`)
  assert.match(oauth!.message, /未知/)
  assert.equal(/未完成/.test(oauth!.message), false, '不能声称未完成')
})

test('诊断：CLI 已装但未登录 → not_authorised，并给出登录步骤', () => {
  const lines = buildDiagnosticLines({
    cliInstalled: true,
    cliVersion: 'weibo-cli 1.0.0',
    oauthLoggedIn: false,
    serviceActive: false,
    readinessState: 'not_authorised',
    readinessMessage: '尚未登录。',
    readinessSteps: [],
  })
  const oauth = lines.find((line) => line.message.startsWith('OAuth 登录'))!
  assert.equal(oauth.state, 'not_authorised')
  assert.match(oauth.message, /未完成/)
  assert.equal(oauth.steps.some((step) => /auth login/.test(step)), true, '必须给出登录命令')
})

test('诊断：已登录但服务未开通 → service_inactive', () => {
  const lines = buildDiagnosticLines({
    cliInstalled: true,
    oauthLoggedIn: true,
    serviceActive: false,
    readinessState: 'service_inactive',
    readinessMessage: '服务未开通。',
    readinessSteps: [],
  })
  const service = lines.find((line) => line.message.startsWith('开发者认证'))!
  assert.equal(service.state, 'service_inactive')
  assert.equal(service.steps.length >= 2, true, '应给出认证与领取服务两步')
})

test('诊断：命令校验失败 → permission_insufficient，并带上具体原因', () => {
  const lines = buildDiagnosticLines({
    cliInstalled: true,
    oauthLoggedIn: true,
    serviceActive: true,
    threadProblem: '命令 statuses/show 要求必填参数 uid',
    readinessState: 'read_ok',
    readinessMessage: '就绪。',
    readinessSteps: [],
  })
  const thread = lines.find((line) => line.message.startsWith('正文读取命令'))!
  assert.equal(thread.state, 'permission_insufficient')
  assert.match(thread.message, /uid/, '必须把具体原因带出来')
})

test('诊断：从未读取过时明确标为 not_implemented，不写成成功也不写成失败', () => {
  const lines = buildDiagnosticLines({
    cliInstalled: false,
    oauthLoggedIn: false,
    serviceActive: false,
    readinessState: 'cli_missing',
    readinessMessage: '没有安装。',
    readinessSteps: [],
  })
  const lastRead = lines.find((line) => line.message.startsWith('最近一次真实读取'))!
  assert.equal(lastRead.state, 'not_implemented')
  assert.match(lastRead.message, /不代表失败/)
})

test('诊断：记录器保存最近一次读取与错误，互不覆盖', () => {
  const recorder = createDiagnosticRecorder()
  recorder.recordRead(true, 'thread', '返回了正文')
  recorder.recordError('quota_exhausted', '积分不足')
  const snapshot = recorder.snapshot()
  assert.equal(snapshot.lastRead?.ok, true)
  assert.equal(snapshot.lastRead?.stage, 'thread')
  assert.equal(snapshot.lastError?.state, 'quota_exhausted')
  // Both survive: a successful read followed by an error is the realistic sequence.
  assert.equal(snapshot.lastRead !== undefined && snapshot.lastError !== undefined, true)
})

test('诊断：本机真实探测——状态可区分且给出下一步', async () => {
  // Runs against the real machine. No CLI is installed here, so the whole chain must report
  // the *first* blocker clearly rather than a generic failure.
  const adapter = weiboProvider.createAdapter({ settings: {} }) as unknown as {
    describeDiagnostics: () => Promise<{
      cliInstalled: boolean
      cliVersion?: string
      oauthLoggedIn: boolean
      serviceActive: boolean
      threadCommand?: string
      commentCommand?: string
      quota: { state: string; message: string }
      lastRead?: unknown
      lastError?: unknown
      lines: readonly { state: string; message: string; steps: readonly string[] }[]
    }>
  }
  const diag = await adapter.describeDiagnostics()

  assert.equal(typeof diag.cliInstalled, 'boolean')
  assert.equal(Array.isArray(diag.lines), true)
  assert.equal(diag.lines.length > 0, true, '必须有可读的诊断行')

  // Every line must carry a state and a non-empty message.
  for (const line of diag.lines) {
    assert.equal(typeof line.state, 'string')
    assert.equal(line.message.length > 0, true)
  }

  // On this machine the CLI is absent, so this is the expected branch. If a future run has it
  // installed, the other branches are covered by the unit tests above.
  if (!diag.cliInstalled) {
    const missing = diag.lines.find((line) => line.state === 'cli_missing')
    assert.ok(missing !== undefined, '未安装必须有一条 cli_missing 行')
    assert.equal(
      diag.lines.some((line) => line.steps.some((step) => /npm install -g @weibo-ai\/weibo-cli/.test(step))),
      true,
      '必须给出安装命令',
    )
    assert.equal(diag.threadCommand, undefined, '没装 CLI 就不该有可用命令')
    assert.equal(diag.commentCommand, undefined)
  }

  // Quota is never faked: this build does not read the balance.
  assert.equal(diag.quota.state, 'not_implemented')
  assert.match(diag.quota.message, /不读取|账户管理/)

  // And no token may leak into a diagnostic string.
  const all = diag.lines.map((line) => line.message).join('\n')
  assert.equal(/Bearer\s+[A-Za-z0-9]{8,}/.test(all), false)
})
