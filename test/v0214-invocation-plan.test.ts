/**
 * v0.2.14 §三 / §四 / §五：命令调用计划。
 *
 * ## 为什么这里断言的是 argv 而不是内部字段
 *
 * v0.2.13 的两个分页缺陷都能"内部看着对、实际发错"。审计复现：
 *
 * | 命令声明 | v0.2.13 实际发出 | 正确 |
 * | --- | --- | --- |
 * | `id`、`count` | `--id … --page 2 --count 20` | 不该发 `--page`（未声明 → CLI 直接报错） |
 * | `id`、`page` | `--id …` | 应发 `--page 2`（声明了却漏发） |
 *
 * 所以每个用例都读**真正 spawn 出去的 argv**。检查 `plan.pageFlag` 是否存在是不够的：
 * 那正是「测试检查内部变量、不检查真实执行参数」的形态。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __setCliInvocation } from '../lib/platforms/weibo/cli.js'
import { __setPlanCacheTimings } from '../lib/platforms/weibo/plan-cache.js'
import { buildInvocationPlan } from '../lib/platforms/weibo/invocation-plan.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'

const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')
const TARGET = '4331051486294436'
const REF = {
  platform: 'weibo' as const,
  threadId: TARGET,
  url: 'https://m.weibo.cn/detail/4331051486294436',
}

// ---------------------------------------------------------------------------
// A. Pure plan logic
// ---------------------------------------------------------------------------

function planWith(flags: readonly string[]) {
  return buildInvocationPlan({
    group: 'comments',
    action: 'show/biz',
    name: 'comments show/biz',
    schemaVerified: true,
    parameters: flags.map((name) => ({ name, required: name === 'id' })),
    kind: 'comments',
  })
}

test('调用计划：只声明 count 时不发送 --page（§三.8）', () => {
  const plan = planWith(['id', 'count'])
  const invocation = plan.argsFor({ threadId: TARGET, page: 2, pageSize: 20 })
  assert.equal(invocation.args.includes('--page'), false, `不该发 --page：${invocation.args.join(' ')}`)
  assert.equal(invocation.args.includes('--count'), true)
  // The caller asked for page 2 and cannot get it: it must be told, not silently downgraded.
  assert.equal(invocation.pagingUnsupported, true, '不支持翻页时必须如实报告')
})

test('调用计划：只声明 page 时不发送 --count（§三.7）', () => {
  const plan = planWith(['id', 'page'])
  const invocation = plan.argsFor({ threadId: TARGET, page: 2, pageSize: 20 })
  assert.equal(invocation.args.includes('--count'), false, `不该发 --count：${invocation.args.join(' ')}`)
  assert.equal(invocation.args.includes('--page'), true, '声明了页码就要发')
})

test('调用计划：page 与 count 同时声明时都发送', () => {
  const plan = planWith(['id', 'page', 'count'])
  const invocation = plan.argsFor({ threadId: TARGET, page: 3, pageSize: 20 })
  const text = invocation.args.join(' ')
  assert.match(text, /--page 3/)
  assert.match(text, /--count 20/)
  assert.equal(invocation.pagingUnsupported, false)
})

test('调用计划：都没有声明时两者都不发', () => {
  const plan = planWith(['id'])
  const invocation = plan.argsFor({ threadId: TARGET, page: 2, pageSize: 20 })
  assert.equal(invocation.args.includes('--page'), false)
  assert.equal(invocation.args.includes('--count'), false)
  assert.equal(invocation.pagingUnsupported, true)
})

test('调用计划：第 1 页不发 --page（那是服务端默认）', () => {
  const plan = planWith(['id', 'page', 'count'])
  const invocation = plan.argsFor({ threadId: TARGET, page: 1, pageSize: 20 })
  assert.equal(invocation.args.includes('--page'), false)
  assert.equal(invocation.pagingUnsupported, false, '第 1 页不需要翻页，不算不支持')
})

test('调用计划：页大小被夹到手册上限 20', () => {
  const plan = planWith(['id', 'count'])
  const huge = plan.argsFor({ threadId: TARGET, page: 1, pageSize: 500 })
  const at = huge.args.indexOf('--count')
  assert.notEqual(at, -1)
  assert.equal(huge.args[at + 1], '20', '超过上限会被服务端以 COUNT_EXCEEDS_MAX 拒绝')
})

test('调用计划：schema 读不出来时什么都不声明', () => {
  const plan = buildInvocationPlan({
    group: 'comments',
    action: 'show/biz',
    name: 'comments show/biz',
    schemaVerified: false,
    parameters: [],
    kind: 'comments',
  })
  assert.equal(plan.capabilities.readComments.available, false)
  assert.equal(plan.capabilities.readComments.state, 'unverified')
  assert.equal(plan.capabilities.readNested.available, false)
})

// ---------------------------------------------------------------------------
// B. Nested capability (§四)
// ---------------------------------------------------------------------------

test('子评论能力：没有父评论参数时如实声明不可用（§四.2）', () => {
  const plan = planWith(['id', 'page', 'count'])
  assert.equal(plan.capabilities.readNested.available, false)
  assert.equal(plan.capabilities.readNested.state, 'unavailable')
  assert.match(plan.capabilities.readNested.reason, /父评论|筛选/)
})

test('子评论能力：有 cid 但无配套参数时只报 unverified，不声明可用（§四.4）', () => {
  // A bare `cid` might mean a client id. The task book forbids inferring meaning from a name.
  const plan = planWith(['id', 'cid'])
  assert.equal(plan.capabilities.readNested.available, false)
  assert.equal(plan.capabilities.readNested.state, 'unverified')
  assert.match(plan.capabilities.readNested.reason, /无法确认|不等于语义/)
})

test('子评论能力：cid 与分页参数同时存在才算 verified（§四.5）', () => {
  const plan = planWith(['id', 'cid', 'page'])
  assert.equal(plan.capabilities.readNested.available, true)
  assert.equal(plan.capabilities.readNested.state, 'verified')
})

test('子评论能力：评论列表可用不蕴含子评论可用（§四.3）', () => {
  const plan = planWith(['id', 'page'])
  assert.equal(plan.capabilities.readComments.available, true, '评论列表可用')
  assert.equal(plan.capabilities.readNested.available, false, '但不能推出子评论也可用')
})

// ---------------------------------------------------------------------------
// C. Real argv (§三 / §四)
// ---------------------------------------------------------------------------

interface Rig {
  readonly logPath: string
  readonly reset: () => void
  readonly calls: () => string[][]
}

function useFakeCli(rules: readonly unknown[]): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'calls.log')
  writeFileSync(scriptPath, JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = scriptPath
  process.env.FAKE_CLI_LOG = logPath
  __setCliInvocation({ file: process.execPath, prefixArgs: [SCRIPT] })
  return {
    logPath,
    reset: () => {
      __setCliInvocation(undefined)
      delete process.env.FAKE_CLI_SCRIPT
      delete process.env.FAKE_CLI_LOG
    },
    calls: () => {
      const text = readFileSync(logPath, 'utf8')
      return text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as string[])
    },
  }
}

function rulesFor(commentFlags: readonly string[], commentBody: unknown = { comments: [], has_more: false }): unknown[] {
  return [
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    {
      match: 'commands list',
      stdout: JSON.stringify({
        commands: [
          { group: 'statuses', action: 'show_batch/biz', access: 'allowed' },
          { group: 'comments', action: 'show/biz', access: 'allowed' },
        ],
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
        flags: commentFlags.map((name) => ({ name, required: name === 'id' })),
      }),
    },
    {
      match: 'statuses show_batch/biz',
      stdout: JSON.stringify({ idstr: TARGET, text: '正文', user: { idstr: '1', screen_name: 'u' } }),
    },
    { match: 'comments show/biz', stdout: JSON.stringify(commentBody) },
  ]
}

test('真实 argv：只声明 count 的命令收到请求时不会带 --page', async () => {
  const rig = useFakeCli(rulesFor(['id', 'count']))
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    await adapter.getReplies(REF, 1).catch(() => undefined)
    const argv = rig.calls().find((entry) => entry[0] === 'comments')
    assert.notEqual(argv, undefined, '应发起评论读取')
    assert.equal(argv!.includes('--page'), false, `不该出现 --page：${JSON.stringify(argv)}`)
    assert.equal(argv!.includes('--count'), true, '声明了 count 就该发')
  } finally {
    rig.reset()
  }
})

test('真实 argv：只声明 page 的命令收到第 2 页请求时带上页码', async () => {
  const rig = useFakeCli(rulesFor(['id', 'page']))
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    await adapter.getReplies(REF, 2).catch(() => undefined)
    const argv = rig.calls().find((entry) => entry[0] === 'comments')
    assert.notEqual(argv, undefined)
    assert.equal(argv!.includes('--page'), true, `声明了页码就该发：${JSON.stringify(argv)}`)
    assert.equal(argv!.includes('--count'), false, '没声明 count 就不该发')
  } finally {
    rig.reset()
  }
})

test('真实 argv：命令完全没有分页参数时，第 2 页降级为不完整而不是重复第一页', async () => {
  const rig = useFakeCli(rulesFor(['id']))
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const page = await adapter.getReplies(REF, 2)
    assert.equal(page.floors.length, 0, '不能把第一页重复当成第 2 页')
    assert.equal(page.incomplete, true, '必须标记为读不全')
    assert.equal(page.hasMore, true, '不能声称已经读完')
  } finally {
    rig.reset()
  }
})

test('真实 argv：子评论同时带微博 id 与评论 id，两者不能混用', async () => {
  const rig = useFakeCli(
    rulesFor(['id', 'cid', 'page'], {
      comments: [
        { id: 6001, idstr: '6001', text: '回复', user: { id: 2, idstr: '2', screen_name: 'r' } },
      ],
      has_more: false,
    }),
  )
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    await adapter
      .getNestedReplies(
        REF,
        { platform: 'weibo', postId: '5001', content: '', images: [] },
        1,
      )
      .catch(() => undefined)
    const argv = rig.calls().find((entry) => entry[0] === 'comments')
    assert.notEqual(argv, undefined, '应发起子评论读取')
    const idAt = argv!.indexOf('--id')
    const cidAt = argv!.indexOf('--cid')
    assert.notEqual(idAt, -1, `应带 --id：${JSON.stringify(argv)}`)
    assert.notEqual(cidAt, -1, `应带 --cid：${JSON.stringify(argv)}`)
    assert.equal(argv![idAt + 1], TARGET, '--id 必须是微博 id')
    assert.equal(argv![cidAt + 1], '5001', '--cid 必须是评论 id')
  } finally {
    rig.reset()
  }
})

// ---------------------------------------------------------------------------
// D. Command selection (§五)
// ---------------------------------------------------------------------------

test('命令选择：locked 的命令不会被探测或执行（§五.2）', async () => {
  const rig = useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    {
      match: 'commands list',
      stdout: JSON.stringify({
        commands: [
          // The only status command is locked: the read must be unavailable, and this row must
          // never be inspected (an inspection is a real invocation).
          { group: 'statuses', action: 'show_batch/biz', access: 'locked' },
        ],
      }),
    },
  ])
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const error = await adapter.getThread(REF).then(
      () => undefined,
      (caught: { code?: string }) => caught,
    )
    assert.notEqual(error, undefined, '没有可用命令时必须失败')
    const calls = rig.calls()
    assert.equal(
      calls.some((entry) => entry[0] === 'commands' && entry[1] === 'show'),
      false,
      `locked 命令不该被 commands show 探测：${JSON.stringify(calls)}`,
    )
    assert.equal(
      calls.some((entry) => entry[0] === 'statuses'),
      false,
      'locked 命令更不该被调用',
    )
  } finally {
    rig.reset()
  }
})

test('命令选择：第一个候选不可用时检查下一个合法候选（§五.5）', async () => {
  const rig = useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    {
      match: 'commands list',
      stdout: JSON.stringify({
        commands: [
          // First candidate: a status read whose required parameter we cannot fill.
          { group: 'statuses', action: 'show/biz', access: 'allowed' },
          // Second candidate: the batch read, which we can drive.
          { group: 'statuses', action: 'show_batch/biz', access: 'allowed' },
        ],
      }),
    },
    {
      match: 'commands show statuses show/biz',
      stdout: JSON.stringify({
        group: 'statuses',
        action: 'show/biz',
        // `token` is required and nothing here can supply it.
        flags: [{ name: 'token', required: true }],
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
      match: 'statuses show_batch/biz',
      stdout: JSON.stringify({ idstr: TARGET, text: '正文', user: { idstr: '1', screen_name: 'u' } }),
    },
  ])
  try {
    const thread = await weiboProvider.createAdapter({ settings: {} }).getThread(REF)
    assert.equal(thread.id, TARGET, '第二个候选应当被选中并成功读取')
    const inspected = rig
      .calls()
      .filter((entry) => entry[0] === 'commands' && entry[1] === 'show')
      .map((entry) => entry.slice(2, 4).join(' '))
    assert.equal(inspected.includes('statuses show/biz'), true, '第一个候选要被检查过')
    assert.equal(inspected.includes('statuses show_batch/biz'), true, '第二个候选也要被检查')
  } finally {
    rig.reset()
  }
})

test('命令选择：探测次数有上限，不会把整份目录都跑一遍（§五.8）', async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    group: 'statuses',
    action: `show/variant${index}`,
    access: 'allowed',
  }))
  const rig = useFakeCli([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    { match: 'commands list', stdout: JSON.stringify({ commands: many }) },
    // Every candidate is unusable.
    {
      match: 'commands show statuses show/',
      stdout: JSON.stringify({
        group: 'statuses',
        action: 'show/variant',
        flags: [{ name: 'token', required: true }],
      }),
    },
  ])
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    await adapter.getThread(REF).catch(() => undefined)
    const inspections = rig
      .calls()
      .filter((entry) => entry[0] === 'commands' && entry[1] === 'show').length
    assert.equal(inspections <= 4, true, `最多检查 4 个候选，实际 ${inspections}`)
  } finally {
    rig.reset()
  }
})
