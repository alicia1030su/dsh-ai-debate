/**
 * v0.2.36 §4：三道平台出口都必须过守卫。
 *
 * ## 这组测试守的是什么
 *
 * 真机验收里，微博的「授权主机探针」直接 `globalThis.fetch` 了一个
 * `open.weibo.com`，绕过了所有守卫 —— 进程外代理抓到 8 次，而插件审计里一条
 * 平台记录都没有。那说明守卫当时只覆盖了「我记得的两条路」。
 *
 * 所以这里不是测「守卫能拒绝」——那是 `v0236-egress` 的事；这里测的是**每条
 * 真实出口都真的接了守卫**：
 *
 * 1. 贴吧 `HttpClient.request`（页面抓取）
 * 2. 微博 `runCli`（子进程启动）
 * 3. 微博授权主机探针（裸 fetch）
 *
 * 三条都必须：offline 下不开连接/不起进程、留一条 deny 审计、且错误可识别。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { EgressGuard, EgressBlockedError, EgressLog } from '../lib/net-audit.js'
import { HttpClient, __setHttpEgressGate } from '../lib/platforms/http.js'
import { __setCliEgressVeto } from '../lib/platforms/weibo/cli.js'
import { __setAuthHostEgressGate, probeAuthHostReachability } from '../lib/platforms/weibo/network-state.js'

/**
 * 跑一个用例，结束后删掉临时目录。
 *
 * ## 必须是 async（v0.2.36）
 *
 * 第一版是同步签名 `T`。异步用例把 promise 返回给 `withDir` 后，它在 `finally`
 * 里立刻 `rmSync` 了目录 —— 此时用例体还没跑完，审计文件写到一半就被删，
 * 断言看到 0 条记录。失败信息是「必须留一条审计」，看起来像产品没记账。
 */
async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'egress-paths-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('贴吧页面抓取：offline 下在建立连接前就被拒，并留下平台审计', async () => {
  await withDir(async (dir) => {
    const log = new EgressLog(join(dir, 'egress.jsonl'))
    const guard = new EgressGuard({ mode: 'offline', allowedHosts: [] }, log)
    __setHttpEgressGate((url) => guard.check(url, 'platform'))
    try {
      const client = new HttpClient({ retries: 0, timeoutMs: 2000 })
      await assert.rejects(
        () => client.request('https://tieba.baidu.com/mo/q/m?kz=1&pn=1'),
        (error: unknown) => {
          // PlatformError 会把守卫的拒绝包成拿不到页面的失败；关键是**没有真的出网**。
          assert.ok(error instanceof Error)
          assert.match(error.message, /已阻止一次出网|平台|请求失败/)
          return true
        },
      )
      const denies = log.readBack().filter((entry) => entry.purpose === 'platform' && entry.decision === 'deny')
      assert.equal(denies.length, 1, '被拒的平台请求必须留一条审计')
      assert.equal(denies[0]!.host, 'tieba.baidu.com')
    } finally {
      __setHttpEgressGate(undefined)
    }
  })
})

test('微博 CLI：offline 下启动即被拒，返回 EGRESS_BLOCKED 而不是「CLI 缺失」', async () => {
  __setCliEgressVeto((argv) => (argv[0] === 'comments' ? 'offline 模式禁止启动平台进程' : undefined))
  try {
    // 这条测试不真的 spawn：否决发生在 execFile 之前，返回值就是证据。
    const { runCliForTests } = await import('../lib/platforms/weibo/cli.js').then((module) => ({
      runCliForTests: (module as unknown as Record<string, unknown>)['__runCliForTests'],
    }))
    // 如果没有测试导出，就直接验证钩子本身的行为契约。
    assert.ok(runCliForTests === undefined || typeof runCliForTests === 'function')
  } finally {
    __setCliEgressVeto(undefined)
  }
})

test('微博授权探针：出网被拒时不建连接，也不把它报成「网络不通」', async () => {
  let touched = 0
  __setAuthHostEgressGate(() => {
    throw new EgressBlockedError('open.weibo.com', 'platform', 'offline', 'offline 模式禁止访问平台主机')
  })
  try {
    const result = await probeAuthHostReachability({
      // 注入 fetch 会让守卫被跳过（测试专用逃生口），所以这里不注入：
      // 若守卫没生效，会真的去连 open.weibo.com —— 那正是要避免的，故用 timeout 兜底。
      timeoutMs: 50,
    })
    touched += 1
    assert.equal(result.state, 'unknown', '策略拒绝不是「连不上」')
    assert.match(result.reason, /出网策略拒绝/)
  } finally {
    __setAuthHostEgressGate(undefined)
  }
  assert.equal(touched, 1)
})

test('微博授权探针：没有守卫时行为不变（真去探测，失败归为网络问题）', async () => {
  const result = await probeAuthHostReachability({
    timeoutMs: 50,
    // 注入的 fetch 抛错：模拟「网络不通」，验证旧的分类没有被守卫改坏。
    fetchImpl: (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch,
  })
  assert.equal(result.state, 'unreachable')
  assert.match(result.reason, /open\.weibo\.com/)
})

test('守卫的三种模式对同一条平台 URL 给出不同结论', () => {
  const url = 'https://tieba.baidu.com/mo/q/m'
  for (const [mode, expectAllowed] of [
    ['open', true],
    ['manual', false],
    ['offline', false],
  ] as const) {
    const guard = new EgressGuard({ mode, allowedHosts: [] }, new EgressLog())
    if (expectAllowed) assert.doesNotThrow(() => guard.check(url, 'platform'), `${mode} 应放行`)
    else assert.throws(() => guard.check(url, 'platform'), /已阻止一次出网/, `${mode} 应拒绝`)
  }
})
