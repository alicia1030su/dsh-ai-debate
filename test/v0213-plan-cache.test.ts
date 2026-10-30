/**
 * v0.2.13 §二：读取计划缓存的失效与恢复。
 *
 * ## 这个文件防的是什么
 *
 * v0.2.12 把第一次探测的 promise 永久缓存了。用发布产物复现：
 *
 *     第一次 CLI 未安装  → cli_missing
 *     随后 CLI 变为可用
 *     同一个 Adapter 再读 → 仍然是 cli_missing
 *     新建 Adapter       → ok
 *
 * 也就是说：主人装好了 CLI、登录了账号，**界面还是显示旧的失败**，除非重启整个 DSH。
 *
 * 这里的断言分成三组：
 * 1. 可恢复失败不会永久缓存（到期会重新探测）
 * 2. 不可恢复失败不做无意义的重试
 * 3. 强制刷新与并发不会互相踩（旧结果不能覆盖新结果）
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __setCliInvocation } from '../lib/platforms/weibo/cli.js'
import {
  __setPlanCacheTimings,
  createPlanCache,
  isRecoverable,
  FAILED_BACKOFF_MS,
  READY_TTL_MS,
} from '../lib/platforms/weibo/plan-cache.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'
import { parseWeiboUrl } from '../lib/platforms/weibo/url.js'

const NODE = process.execPath
const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')

/** Install a fake CLI that answers from `rules`. */
function installFake(rules: readonly unknown[]): void {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'))
  writeFileSync(join(dir, 'script.json'), JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = join(dir, 'script.json')
  process.env.FAKE_CLI_LOG = join(dir, 'calls.log')
  __setCliInvocation({ file: NODE, prefixArgs: [SCRIPT] })
}

function resetAll(): void {
  __setCliInvocation(undefined)
  __setPlanCacheTimings(undefined)
  delete process.env.FAKE_CLI_SCRIPT
  delete process.env.FAKE_CLI_LOG
}

const MISSING = [{ match: 'version', stderr: 'command not found\n', exit: 1 }]

/**
 * The catalog rows use `group` + `action`, matching the official CLI.
 *
 * v0.2.12's fixture used a single `statuses/show` name, which the real CLI cannot accept: it
 * reads `rest[0]` as the group and `rest[1]` as the action. The fixture was therefore part of
 * the bug — it made an impossible call look correct.
 */
const READY = [
  { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
  { match: 'doctor', stdout: 'ok\n' },
  {
    match: 'commands show statuses show_batch/biz',
    stdout: JSON.stringify({ group: 'statuses', action: 'show_batch/biz', flags: [{ name: 'ids', required: true }] }),
  },
  {
    match: 'commands show comments show/biz',
    stdout: JSON.stringify({
      group: 'comments',
      action: 'show/biz',
      flags: [
        { name: 'id', required: true },
        { name: 'page' },
        { name: 'count' },
        { name: 'cid' },
      ],
    }),
  },
  {
    match: 'commands list',
    stdout: JSON.stringify({
      commands: [
        { group: 'statuses', action: 'show_batch/biz' },
        { group: 'comments', action: 'show/biz' },
      ],
      total: 2,
    }),
  },
  {
    match: 'statuses show_batch/biz --ids',
    stdout: JSON.stringify({ idstr: '4331051486294436', text: '正文', user: { idstr: '111', screen_name: '主人' } }),
  },
]

const REF = (() => {
  const ref = parseWeiboUrl('https://m.weibo.cn/detail/4331051486294436')
  return { platform: 'weibo' as const, threadId: ref.threadId, url: ref.url }
})()

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

// ---------------------------------------------------------------------------
// 1. 可恢复失败会过期
// ---------------------------------------------------------------------------

test('缓存：cli_missing 是可恢复失败，不是永久结论', () => {
  assert.equal(isRecoverable('cli_missing'), true)
  assert.equal(isRecoverable('not_authenticated'), true)
  assert.equal(isRecoverable('service_inactive'), true)
  assert.equal(isRecoverable('command_unavailable'), true)
  assert.equal(isRecoverable('quota_exhausted'), true)
  // An unparseable response will not become parseable by waiting.
  assert.equal(isRecoverable('ok'), false)
})

test('缓存：同一个 Adapter 在 CLI 恢复后能自行恢复（§二 核心要求）', async () => {
  // The task book's acceptance: the same adapter works after the service recovers, without
  // restarting DSH.
  __setPlanCacheTimings({ backoffMs: 0 })
  installFake(MISSING)
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const first = await adapter.getThread(REF).then(
      () => 'ok',
      (error: { code?: string }) => error.code,
    )
    assert.equal(first, 'cli_missing', `第一次应为 cli_missing，实际 ${first}`)

    await settle()
    installFake(READY)
    const second = await adapter.getThread(REF).then(
      () => 'ok',
      (error: { code?: string }) => error.code,
    )
    assert.equal(second, 'ok', `同一个 Adapter 应能恢复，实际 ${second}`)
  } finally {
    resetAll()
  }
})

test('缓存：成功结果有 TTL，过期后会重新探测', async () => {
  // A success is cached so one analysis does not re-probe per comment page, but the entry
  // expires: a permission revoked in the console must be noticed without a restart.
  __setPlanCacheTimings({ readyMs: 0, backoffMs: 0 })
  let calls = 0
  const cache = createPlanCache(async () => {
    calls += 1
    return { plan: { value: calls }, status: 'ok' as const }
  })
  try {
    const first = await cache.get()
    assert.equal(first.source, 'probed')
    const second = await cache.get()
    // TTL is zero, so the second call re-probes rather than serving the cache.
    assert.equal(second.source, 'probed', `实际 ${second.source}`)
    assert.equal(calls, 2)
  } finally {
    resetAll()
  }
})

test('缓存：TTL 内的成功结果被复用，不会每次都跑 CLI', async () => {
  __setPlanCacheTimings({ readyMs: 60_000 })
  let calls = 0
  const cache = createPlanCache(async () => {
    calls += 1
    return { plan: calls, status: 'ok' as const }
  })
  try {
    await cache.get()
    const second = await cache.get()
    assert.equal(second.source, 'cached')
    assert.equal(calls, 1, 'TTL 内不应重复探测')
  } finally {
    resetAll()
  }
})

test('缓存：失败在退避窗口内快速返回已有结论，窗口后重新探测', async () => {
  // ## Two sources, one behaviour
  //
  // Within the window a caller must not spawn another process. The entry it gets is either
  // `cached` (the failure is within its backoff, still fresh) or `backoff` (an unrecoverable
  // failure, which will not improve by waiting). Both answer instantly with the known reason;
  // the distinction only matters for the diagnostic, which should not invite a retry it knows
  // is pointless.
  __setPlanCacheTimings({ backoffMs: 60_000 })
  let calls = 0
  const cache = createPlanCache(async () => {
    calls += 1
    return { plan: calls, status: 'cli_missing' as const }
  })
  try {
    await cache.get()
    const second = await cache.get()
    assert.equal(
      ['cached', 'backoff'].includes(second.source),
      true,
      `窗口内不应重新探测，实际 source=${second.source}`,
    )
    assert.equal(calls, 1, '窗口内不应重复探测')
    assert.equal(second.status, 'cli_missing', '结论要如实带出来')
  } finally {
    resetAll()
  }
})

test('缓存：退避窗口过后会再探（失败不是终点）', async () => {
  __setPlanCacheTimings({ backoffMs: 0 })
  let calls = 0
  const cache = createPlanCache(async () => {
    calls += 1
    return { plan: calls, status: 'cli_missing' as const }
  })
  try {
    await cache.get()
    await settle()
    const second = await cache.get()
    assert.equal(second.source, 'probed', `窗口已过应重新探测，实际 ${second.source}`)
    assert.equal(calls, 2)
  } finally {
    resetAll()
  }
})

// ---------------------------------------------------------------------------
// 2. 强制刷新与并发
// ---------------------------------------------------------------------------

test('缓存：force 会忽略已有缓存立即探测（诊断刷新按钮用这条）', async () => {
  __setPlanCacheTimings({ readyMs: 60_000 })
  let calls = 0
  const cache = createPlanCache(async () => {
    calls += 1
    return { plan: calls, status: 'ok' as const }
  })
  try {
    await cache.get()
    assert.equal(calls, 1)
    const forced = await cache.get({ force: true })
    assert.equal(forced.source, 'probed')
    assert.equal(calls, 2, 'force 必须真的重新探测')
  } finally {
    resetAll()
  }
})

test('缓存：并发请求共享一次探测，不会启动多个 CLI 进程（§二.6）', async () => {
  // One analysis reads a thread and several comment pages. Without joining, each would spawn
  // `version` + `doctor` + `commands list`.
  let calls = 0
  const cache = createPlanCache(async () => {
    calls += 1
    // Deliberately slow, so the concurrent calls arrive while it is in flight.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { plan: calls, status: 'ok' as const }
  })
  try {
    const results = await Promise.all([cache.get(), cache.get(), cache.get(), cache.get()])
    assert.equal(calls, 1, `并发四次应只探测一次，实际 ${calls}`)
    assert.equal(results.filter((result) => result.source === 'joined').length, 3)
  } finally {
    resetAll()
  }
})

test('缓存：并发失败的请求同样只探测一次', async () => {
  let calls = 0
  const cache = createPlanCache(async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { plan: calls, status: 'cli_missing' as const }
  })
  try {
    await Promise.all([cache.get(), cache.get(), cache.get()])
    assert.equal(calls, 1, `实际 ${calls}`)
  } finally {
    resetAll()
  }
})

// ---------------------------------------------------------------------------
// 3. 旧结果不能覆盖新结果
// ---------------------------------------------------------------------------

test('缓存：慢探测不得覆盖期间发生的 invalidate（§二.7）', async () => {
  // The race the generation counter exists for: a probe started before a refresh finishes
  // after it and would otherwise resurrect an outdated verdict.
  let resolveSlow: ((value: { plan: string; status: 'ok' }) => void) | undefined
  let calls = 0
  const cache = createPlanCache(async () => {
    calls += 1
    if (calls === 1) {
      // The first probe hangs until the test releases it.
      return new Promise((resolve) => {
        resolveSlow = resolve as (value: { plan: string; status: 'ok' }) => void
      })
    }
    return { plan: 'fresh', status: 'ok' as const }
  })
  try {
    const pending = cache.get()
    // Invalidate while the first probe is still running.
    cache.invalidate()
    // Release the stale probe afterwards.
    await new Promise((resolve) => setTimeout(resolve, 10))
    resolveSlow?.({ plan: 'stale', status: 'ok' })
    const staleResult = await pending
    // Its own caller gets a definite answer, so no hang.
    assert.equal(staleResult.source, 'probed')

    // But the cache must not hold "stale".
    const after = await cache.peek()
    assert.notEqual(after?.value, 'stale', '被作废的探测结果不能留在缓存里')
  } finally {
    resetAll()
  }
})

test('缓存：invalidate 之后下一次读取会重新探测', async () => {
  __setPlanCacheTimings({ readyMs: 60_000 })
  let calls = 0
  const cache = createPlanCache(async () => {
    calls += 1
    return { plan: calls, status: 'ok' as const }
  })
  try {
    await cache.get()
    cache.invalidate()
    const after = await cache.get()
    assert.equal(after.source, 'probed')
    assert.equal(calls, 2)
  } finally {
    resetAll()
  }
})

// ---------------------------------------------------------------------------
// 4. 诊断入口
// ---------------------------------------------------------------------------

test('诊断：refresh 为 true 时会真的重新探测', async () => {
  __setPlanCacheTimings({ readyMs: 60_000 })
  installFake(MISSING)
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} }) as unknown as {
      describeDiagnostics: (options?: { refresh?: boolean }) => Promise<{
        cliInstalled: boolean
        lines: readonly { state: string; message: string }[]
      }>
    }
    const first = await adapter.describeDiagnostics()
    assert.equal(first.cliInstalled, false)

    installFake(READY)
    // Without refresh the cached verdict is served…
    const cached = await adapter.describeDiagnostics()
    assert.equal(cached.cliInstalled, false, 'TTL 内应命中缓存')
    // …with refresh it re-probes and sees the new reality.
    await settle()
    const refreshed = await adapter.describeDiagnostics({ refresh: true })
    assert.equal(refreshed.cliInstalled, true, 'refresh 必须重新探测')
  } finally {
    resetAll()
  }
})

test('缓存：默认时长是生产值（防止测试把窗口改成 0 后忘记恢复）', () => {
  assert.equal(READY_TTL_MS, 60_000)
  assert.equal(FAILED_BACKOFF_MS, 15_000)
})
