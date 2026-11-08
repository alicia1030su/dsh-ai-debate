/**
 * v0.2.34 §2.2：会解析令牌的 CLI 调用必须**排队**，不能并发。
 *
 * ## 这一条推翻的是 v0.2.33 的一个优化
 *
 * v0.2.33 把 `probeWeiboCli()` 与 `listAvailableCommands()` 改成并发，理由是
 * 「两条探测互不依赖」。理由没错，但实测**收益为零、代价真实**：
 *
 * `@weibo-ai/weibo-cli@0.9.8` 的访问令牌缓存是**进程内**的。每启动一个
 * `weibo-cli`，它都要自己解析一次令牌：拿文件锁 → 读保管库 → POST → 写保管库。
 * 本机实测这一步持锁约 5.5 秒（`keychainGet` 1876ms + `keychainSet` 3597ms），
 * 而 CLI 自己的等锁上限是 15 秒。三个进程同时要令牌，第三个正好等到超时，
 * `getAccessToken` 在超时分支 `catch` 掉异常返回 null，CLI 于是打印
 * 「缺少登录令牌」—— 主人看到的是**登录状态消失**。
 *
 * 受控实验（8 进程、假 OAuth 服务、一次性 refresh token）：
 * 并发时服务端收到 8 次刷新、7 次 `invalid_grant`；串行后 0 次。
 *
 * ## 这个测试怎么证伪
 *
 * 用一个**会睡 250ms** 的替身可执行文件。三次并发调用：
 *
 * - 如果真排了队 → 墙钟 ≥ 约 750ms；
 * - 如果偷偷并发了 → 墙钟 ≈ 250ms。
 *
 * 断言取下界 600ms（留 20% 给调度抖动），上界不设 —— 机器慢只会更慢，
 * 而「更慢」不会把并发误判成串行。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __needsTokenForTest,
  __resetCliMetrics,
  __setCliInvocation,
  cliMetrics,
  inspectCommand,
} from '../lib/platforms/weibo/cli.js'

/** 一个只会睡觉、然后吐一个空 JSON 的替身。 */
const SLEEP_MS = 250

function sleepInvocation(): { file: string; prefixArgs: readonly string[] } {
  return {
    file: process.execPath,
    prefixArgs: ['-e', `setTimeout(() => { process.stdout.write('{}') }, ${SLEEP_MS})`],
  }
}

test('三条会解析令牌的调用并发发起时，墙钟接近三倍单次 —— 说明真的排了队', async () => {
  __setCliInvocation(sleepInvocation())
  __resetCliMetrics()
  try {
    const startedAt = Date.now()
    // `inspectCommand` 走 `runCli(['commands','show',…])`，属于要令牌的那一类。
    await Promise.all([
      inspectCommand({ group: 'statuses', action: 'show' }),
      inspectCommand({ group: 'statuses', action: 'show' }),
      inspectCommand({ group: 'statuses', action: 'show' }),
    ])
    const elapsed = Date.now() - startedAt

    assert.ok(
      elapsed >= SLEEP_MS * 3 * 0.8,
      `三次并发调用只花了 ${elapsed}ms（单次 ${SLEEP_MS}ms）：没有排队，` +
        '并发的刷新会在 CLI 的 15 秒锁上限那里变成「登录状态消失」',
    )

    const metrics = cliMetrics()
    assert.ok(metrics.invocations >= 3, `应当真的起了至少 3 个子进程，实际 ${metrics.invocations}`)
    // 队列等待必须是可观测的量：它是「慢在排队还是慢在 CLI」的唯一证据。
    assert.ok(metrics.queueWaitMs > 0, '排队发生过，queueWaitMs 不该是 0')
  } finally {
    __setCliInvocation(undefined)
    __resetCliMetrics()
  }
})

test('version / help 不排队：它们不解析令牌', () => {
  /**
   * 这条守的是「诊断面板的响应速度」。
   *
   * `version` 与 `help` 不碰令牌，所以不该被一次 6 秒的 `doctor` 堵在队列里。
   * 断言的是**白名单**语义：列出来的两条免排队，其余一律排队 —— 新增子命令
   * 默认受保护，不会因为忘了加一行就悄悄并发。
   */
  assert.equal(__needsTokenForTest(['version']), false)
  assert.equal(__needsTokenForTest(['help']), false)
  assert.equal(__needsTokenForTest(['doctor']), true)
  assert.equal(__needsTokenForTest(['commands', 'list', '--available']), true)
  assert.equal(__needsTokenForTest(['statuses', 'show', '123']), true)
  assert.equal(__needsTokenForTest(['auth', 'whoami']), true)
})
