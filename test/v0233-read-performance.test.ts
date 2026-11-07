/**
 * v0.2.33 §七：读取路径的子进程次数与并发结构。
 *
 * ## 为什么这一组断言「次数」，而不是「秒数」
 *
 * 秒数随机器负载浮动：同一份代码在这台机器上 8 秒、在 CI 上 40 秒，断言它等于某个
 * 数字只会变成一个需要放宽的阈值。而**子进程次数是结构性的**：
 *
 *     version + doctor + commands list + N×commands show + 真实读取
 *
 * 每一次都要创建进程、读一次系统凭据库（本机实测每个 0.6～3.6 秒）。这个数字
 * 可以直接对着代码审查，也不会因为机器快慢而变——所以它才是能钉住的量。
 *
 * ## 这一版把次数从多少降到多少
 *
 * 起点（v0.2.32 的读取路径）：
 *
 *     version ∥ doctor → 串行 2 次
 *     commands list    → 1 次
 *     正文候选 inspect → 1～4 次
 *     评论候选 inspect → 1～4 次
 *
 * 后两段是串行等待的，所以最坏情况是「2 + 1 + 4 + 4 = 11 次调用，全部首尾相接」。
 *
 * v0.2.33 做了两件改变**结构**的事：
 *
 * 1. `probeWeiboCli` 与 `commands list` 并发（互不依赖）；
 * 2. 正文候选与评论候选并发（各自仍按顺序，但两条链之间不再等待）。
 *
 * 并发不减少调用次数，它减少的是**等待窗口个数**。所以这里断言两件事：
 * 调用次数没有变多，以及**没有把同一次读取拆成两轮探测**。
 *
 * ## 一次读取只探测一次
 *
 * 这条最容易被破坏：`getThread`、`getReplies`、`getNestedReplies` 各自都会
 * `requirePlan()`，而它是走缓存的。如果哪天有人改成「每次都重新探测」，
 * 一次翻页读取会变成 N 倍的进程数——那正是 40 秒的来源之一。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __setCliInvocation } from '../lib/platforms/weibo/cli.js'
import { __setPlanCacheTimings } from '../lib/platforms/weibo/plan-cache.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'
import { parseWeiboUrl } from '../lib/platforms/weibo/url.js'

const NODE = process.execPath
const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')

interface Rig {
  readonly calls: () => string[][]
  readonly reset: () => void
}

function installFake(rules: readonly unknown[]): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'perf-'))
  const logPath = join(dir, 'calls.log')
  writeFileSync(join(dir, 'script.json'), JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = join(dir, 'script.json')
  process.env.FAKE_CLI_LOG = logPath
  __setCliInvocation({ file: NODE, prefixArgs: [SCRIPT] })
  return {
    calls: () => {
      let text = ''
      try {
        text = readFileSync(logPath, 'utf8')
      } catch {
        // 还没有调用
      }
      return text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as string[])
    },
    reset: () => {
      __setCliInvocation(undefined)
      __setPlanCacheTimings(undefined)
      delete process.env.FAKE_CLI_SCRIPT
      delete process.env.FAKE_CLI_LOG
    },
  }
}

/** 一个「能读正文、能读评论、能分页」的最小可用目录。 */
const RULES = [
  { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
  { match: 'doctor', stdout: '✓ 注册或登录\n✓ 完成开发者认证\n✓ 开通服务\n' },
  {
    match: 'commands list',
    stdout: JSON.stringify({
      commands: [
        { group: 'statuses', action: 'show_batch/biz' },
        { group: 'comments', action: 'show/biz' },
      ],
      total: 2,
      available_count: 2,
    }),
  },
  {
    match: 'commands show statuses show_batch/biz',
    stdout: JSON.stringify({
      group: 'statuses',
      action: 'show_batch/biz',
      flags: [{ name: 'ids', required: true }],
    }),
  },
  {
    match: 'commands show comments show/biz',
    stdout: JSON.stringify({
      group: 'comments',
      action: 'show/biz',
      flags: [{ name: 'id', required: true }, { name: 'page' }, { name: 'count' }],
    }),
  },
  {
    match: 'statuses show_batch/biz --ids',
    stdout: JSON.stringify({
      idstr: '4331051486294436',
      text: '正文',
      user: { idstr: '111', screen_name: '主人' },
      comments_count: 2,
    }),
  },
  {
    match: 'comments show/biz --id 4331051486294436',
    stdout: JSON.stringify({
      comments: [
        { id: 9001, text: '对手一', user: { idstr: '222', screen_name: '对手' }, floor_number: 1 },
        { id: 9002, text: '对手二', user: { idstr: '333', screen_name: '路人' }, floor_number: 2 },
      ],
      next_cursor: 0,
      total_number: 2,
    }),
  },
]

const REF = (() => {
  const ref = parseWeiboUrl('https://m.weibo.cn/detail/4331051486294436')
  return { platform: 'weibo' as const, threadId: ref.threadId, url: ref.url }
})()


/**
 * 微博适配器带一个可选成员 `describeDiagnostics`，它不在 `PlatformAdapter`
 * 接口里（那个接口描述每个平台都必须做的事）。测试要读诊断就得自己声明形状，
 * 与 `v0213-plan-cache.test.ts` 用同一套写法。
 */
interface DiagnosableAdapter {
  readonly describeDiagnostics: (options?: { refresh?: boolean }) => Promise<{
    cliInstalled: boolean
    threadCommand?: string
    commentCommand?: string
    readTrace?: {
      readonly startedAt: string
      readonly checkedAt: string
      readonly totalMs: number
      readonly cliInvocations: number
      readonly cliMs: number
      readonly phases: readonly { readonly name: string; readonly ms: number; readonly detail?: string }[]
    }
  }>
}

const diagnosable = (adapter: unknown): DiagnosableAdapter => adapter as DiagnosableAdapter

test('一次读取的探测次数是固定的：version/doctor/list/inspect 各一次', async () => {
  const rig = installFake(RULES)
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    await adapter.getThread(REF)
    const calls = rig.calls()
    const count = (predicate: (argv: string[]) => boolean): number => calls.filter(predicate).length

    assert.equal(count((argv) => argv[0] === 'version'), 1, 'version 只该跑一次')
    assert.equal(count((argv) => argv[0] === 'doctor'), 1, 'doctor 只该跑一次')
    assert.equal(
      count((argv) => argv[0] === 'commands' && argv[1] === 'list'),
      1,
      '命令清单只该读一次',
    )
    assert.equal(
      count((argv) => argv[0] === 'commands' && argv[1] === 'show'),
      2,
      '正文与评论各 inspect 一次，不该重复读同一份 schema',
    )
  } finally {
    rig.reset()
  }
})

test('同一适配器的第二次读取不再探测：计划缓存承担这件事', async () => {
  const rig = installFake(RULES)
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    await adapter.getThread(REF)
    const afterFirst = rig.calls().length
    await adapter.getReplies(REF, 1)
    const calls = rig.calls()

    // 第二次只该多出「读评论」这一个子进程。
    assert.equal(
      calls.length,
      afterFirst + 1,
      `第二次读取应只多一次调用，实际多 ${calls.length - afterFirst} 次：${JSON.stringify(calls.slice(afterFirst))}`,
    )
    assert.equal(
      calls.filter((argv) => argv[0] === 'doctor').length,
      1,
      'doctor 不该在第二次读取时重跑',
    )
  } finally {
    rig.reset()
  }
})

test('并发探测不改变结论：同一份输入得到同一份计划', async () => {
  const rig = installFake(RULES)
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const diagnostics = await diagnosable(adapter).describeDiagnostics()
    assert.equal(diagnostics.cliInstalled, true)
    assert.equal(diagnostics.threadCommand, 'statuses show_batch/biz')
    assert.equal(diagnostics.commentCommand, 'comments show/biz')
  } finally {
    rig.reset()
  }
})

test('读取耗时账里能看到 probe / read / project 三段，且次数与实际调用一致', async () => {
  const rig = installFake(RULES)
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    await adapter.getThread(REF)
    const diagnostics = await diagnosable(adapter).describeDiagnostics()
    const trace = diagnostics.readTrace
    assert.ok(trace !== undefined, '读过一次之后必须留下耗时账')

    const names = trace.phases.map((phase) => phase.name)
    assert.ok(names.includes('probe'), `应有 probe 阶段，实际 ${names.join(',')}`)
    assert.ok(names.includes('read'), `应有 read 阶段，实际 ${names.join(',')}`)
    assert.ok(names.includes('project'), `应有 project 阶段，实际 ${names.join(',')}`)

    // 子进程次数是这次读取的实测值：version/doctor/list/2×show/正文读取。
    const calls = rig.calls()
    assert.equal(
      trace.cliInvocations,
      calls.length,
      `耗时账记的子进程次数应与实际调用一致：账上 ${trace.cliInvocations}，日志 ${calls.length}`,
    )
    assert.ok(trace.totalMs >= 0)
    assert.match(trace.checkedAt, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    rig.reset()
  }
})

test('读取失败时也留下耗时账：慢在哪比「失败了」有用', async () => {
  const rig = installFake([
    ...RULES,
    // 让正文读取失败，覆盖「有耗时账但没有成功结果」这条路径。
    { match: 'statuses show_batch/biz --ids', stderr: '{"success":false,"code":"RATE_LIMITED","message":"太快了"}', exit: 1 },
  ])
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    await adapter.getThread(REF).catch(() => undefined)
    const diagnostics = await diagnosable(adapter).describeDiagnostics()
    const trace = diagnostics.readTrace
    assert.ok(trace !== undefined, '失败也要留下耗时账')
    assert.ok(trace.phases.some((phase) => phase.name === 'read'))
  } finally {
    rig.reset()
  }
})
