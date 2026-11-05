/**
 * v0.2.28 P0-6：微博读取失败的十一类场景，全部走真实的解析器 / Provider / Runtime。
 *
 * ## 这个文件与 v0228-weibo-read-chain 的分工
 *
 * `v0228-weibo-read-chain.test.ts` 证明**正向链路通**：一条微博能被读进来、正文进入
 * 时间线、主人被认出来、对手被选出来。这个文件证明**负向分支各自不同**：十一类失败
 * 必须被区分开，而且每一类都指向一个不同的、主人可以采取的行动。
 *
 * 合在一起才算「读取可用」——只会走通顺路径的实现，在真实环境里第一次遇到限流就会
 * 报「未知错误」，而主人根本不知道该去装 CLI、去登录、去开通服务，还是去充值。
 *
 * ## 十一类，以及为什么是这十一类
 *
 * 它们不是列举出来的功能点，而是**微博官方 CLI 真的会返回的失败原因**，按主人要做
 * 的事分组：
 *
 * | # | 场景 | 主人要做什么 |
 * | --- | --- | --- |
 * | 1 | CLI 未安装 | 装 CLI |
 * | 2 | 未登录 / 凭证过期 | 登录 |
 * | 3 | 开发者未认证 | 去扫脸认证 |
 * | 4 | 服务未开通 / 体验已领 | 领体验或买积分包 |
 * | 5 | 额度用完 | 充值 / 等次日 |
 * | 6 | 命令不在账号的可用列表里 | 换账号或买对应套餐 |
 * | 7 | 返回的不是请求的那条微博 | 检查链接是否过期 |
 * | 8 | 正文结构无法解析 | 报告 bug |
 * | 9 | 网络位置被拒（IP_GEO_DENIED） | 换回常用网络 |
 * | 10 | 分页信号自相矛盾 | 缩窄范围重试 |
 * | 11 | 评论读取被限流 | 降低频率 |
 *
 * ## 红线
 *
 * 这个文件**不**声明任何一条是「真实 API 实测通过」。全部证据来自一个模拟可执行文件，
 * 它证明的是「我们这样判断」，不是「微博这样返回」。真实读取从未在这台机器上发生，
 * 报告里必须如实写「未实测」。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildCommentList } from '../lib/comment-list.js'
import { buildTimeline, collectThread } from '../lib/collector.js'
import { classifyCommands, probeWeiboCli, scrubCredentials } from '../lib/platforms/weibo/cli.js'
import { __setCliInvocation } from '../lib/platforms/weibo/cli.js'
import { __setPlanCacheTimings } from '../lib/platforms/weibo/plan-cache.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'

const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')
const STATUS_ID = '5021243409116023'

const REF = {
  platform: 'weibo' as const,
  threadId: STATUS_ID,
  url: `https://m.weibo.cn/detail/${STATUS_ID}`,
}

const GOOD_STATUS = {
  idstr: STATUS_ID,
  text: '正文。',
  user: { idstr: '7788', screen_name: '博主' },
  comments_count: 1,
}

const GOOD_COMMENTS = {
  data: [
    {
      idstr: '6001',
      text: '评论。',
      user: { idstr: '1001', screen_name: '评论者' },
      reply_comment_total: 0,
    },
  ],
  has_more: false,
}

/** What the fake CLI should answer, and what the adapter must make of it. */
interface Scenario {
  readonly name: string
  /** The rule table handed to the fake executable. */
  readonly rules: readonly unknown[]
  /**
   * What the adapter must end up reporting.
   *
   * For a *probe* scenario this is the readiness status; for a *read* scenario it is the
   * error code. Either way the assertion is on a machine-readable field, never on prose.
   */
  readonly expected: string
  /** Which call to make. */
  readonly kind: 'probe' | 'thread' | 'replies'
}

function useRig(rules: readonly unknown[]): { close: () => void; calls: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'weibo-11-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'calls.log')
  writeFileSync(scriptPath, JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = scriptPath
  process.env.FAKE_CLI_LOG = logPath
  __setCliInvocation({ file: process.execPath, prefixArgs: [SCRIPT] })
  // Zero TTL so each scenario really probes; a cached plan from the previous scenario
  // would make this whole file assert nothing.
  __setPlanCacheTimings({ readyMs: 0, backoffMs: 0 })
  return {
    close: () => {
      __setCliInvocation(undefined)
      __setPlanCacheTimings(undefined)
      delete process.env.FAKE_CLI_SCRIPT
      delete process.env.FAKE_CLI_LOG
    },
    calls: () => {
      try {
        return require('node:fs').readFileSync(logPath, 'utf8') as string
      } catch {
        return ''
      }
    },
  }
}

/** The catalog a logged-in, entitled account would report. */
const CATALOG = {
  commands: [
    { group: 'statuses', action: 'show_batch/biz', access: 'allowed' },
    { group: 'comments', action: 'list/biz', access: 'allowed' },
  ],
}

const THREAD_SCHEMA = {
  group: 'statuses',
  action: 'show_batch/biz',
  flags: [{ name: 'ids', required: true }],
}
const COMMENT_SCHEMA = {
  group: 'comments',
  action: 'list/biz',
  flags: [
    { name: 'id', required: true },
    { name: 'page', required: false },
    { name: 'count', required: false },
  ],
}

/** A CLI whose readiness probe is healthy; individual reads then fail however `extra` says. */
function healthyRules(extra: readonly unknown[]): unknown[] {
  return [
    { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
    { match: 'doctor', stdout: '√ 注册或登录\n√ 完成开发者认证\n√ 开通服务\n' },
    { match: 'commands list', stdout: JSON.stringify(CATALOG) },
    { match: 'commands show statuses show_batch/biz', stdout: JSON.stringify(THREAD_SCHEMA) },
    { match: 'commands show comments list/biz', stdout: JSON.stringify(COMMENT_SCHEMA) },
    ...extra,
  ]
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: '1. CLI 未安装',
    kind: 'probe',
    expected: 'cli_missing',
    rules: [
      // A missing binary has empty stderr; `error.code === 'ENOENT'` is the only evidence.
      // Pointing the layer at a nonexistent program reproduces that faithfully.
    ],
  },
  {
    name: '2. 未登录',
    kind: 'probe',
    expected: 'not_authenticated',
    rules: [
      { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
      { match: 'doctor', stdout: '× 注册或登录\n× 完成开发者认证\n× 开通服务\n' },
    ],
  },
  {
    name: '3. 开发者未认证',
    kind: 'probe',
    expected: 'service_inactive',
    rules: [
      { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
      { match: 'doctor', stdout: '√ 注册或登录\n× 完成开发者认证\n× 开通服务\n' },
    ],
  },
  {
    name: '4. 服务未开通',
    kind: 'probe',
    expected: 'service_inactive',
    rules: [
      { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
      { match: 'doctor', stdout: '√ 注册或登录\n√ 完成开发者认证\n× 开通服务\n' },
    ],
  },
  {
    name: '5. 额度用完（官方错误码）',
    kind: 'thread',
    expected: 'quota_exhausted',
    rules: healthyRules([
      {
        match: 'statuses show_batch/biz',
        stderr: JSON.stringify({
          success: false,
          status: 429,
          code: 'TRIAL_API_QUOTA_EXCEEDED',
          message: '体验服务接口次数已用完',
        }),
        exit: 1,
      },
    ]),
  },
  {
    name: '6. 命令不在账号可用列表里',
    kind: 'thread',
    // The probe answers "is the CLI installed and logged in" — it is, so `ok` there is
    // correct and says nothing about whether a *read* is possible. The catalog is a
    // separate question, and it is the plan (not the probe) that answers it. Asserting on
    // the read is what keeps the two answers from being conflated: the owner needs a
    // different service package, not another login.
    expected: 'command_unavailable',
    rules: [
      { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
      { match: 'doctor', stdout: '√ 注册或登录\n√ 完成开发者认证\n√ 开通服务\n' },
      {
        match: 'commands list',
        stdout: JSON.stringify({
          commands: [{ group: 'friendships', action: 'friends/biz', access: 'allowed' }],
        }),
      },
    ],
  },
  {
    name: '7. 返回的不是请求的那条微博',
    kind: 'thread',
    expected: 'target_mismatch',
    rules: healthyRules([
      {
        match: 'statuses show_batch/biz',
        stdout: JSON.stringify({ idstr: '9999999999999999', text: '另一条微博。' }),
      },
    ]),
  },
  {
    name: '8. 正文结构无法解析',
    kind: 'thread',
    expected: 'malformed_response',
    rules: healthyRules([
      // The right id, but nothing projectable: no text, no user, no images.
      { match: 'statuses show_batch/biz', stdout: JSON.stringify({ idstr: STATUS_ID }) },
    ]),
  },
  {
    name: '9. 网络位置被拒',
    kind: 'thread',
    expected: 'not_authenticated',
    rules: healthyRules([
      {
        match: 'statuses show_batch/biz',
        stderr: JSON.stringify({
          success: false,
          status: 403,
          code: 'IP_GEO_DENIED',
          message: 'IP 不在允许的地理位置',
        }),
        exit: 1,
      },
    ]),
  },
  {
    name: '10. 分页状态完全读不出来',
    kind: 'replies',
    expected: 'incomplete',
    rules: healthyRules([
      { match: 'statuses show_batch/biz', stdout: JSON.stringify(GOOD_STATUS) },
      {
        match: 'comments list/biz',
        // Neither `has_more` nor a cursor nor a total. The caller cannot tell whether
        // another page exists, so "this is everything" would be a guess. `has_more: true`
        // alone is NOT this case — that is a platform saying there *is* more, which is
        // ordinary pagination, and treating it as degradation was the v0.2.11 bug.
        stdout: JSON.stringify({ data: GOOD_COMMENTS.data }),
      },
    ]),
  },
  {
    name: '11. 评论读取被限流',
    kind: 'replies',
    expected: 'quota_exhausted',
    rules: healthyRules([
      { match: 'statuses show_batch/biz', stdout: JSON.stringify(GOOD_STATUS) },
      {
        match: 'comments list/biz',
        stderr: JSON.stringify({
          success: false,
          status: 429,
          code: 'QUOTA_EXCEEDED',
          message: '积分余额不足',
        }),
        exit: 1,
      },
    ]),
  },
]

test('十一类读取失败各自可识别，且不是同一个结果', async () => {
  const seen = new Map<string, string>()

  for (const scenario of SCENARIOS) {
    // The "missing CLI" scenario is special: it must fail to *find* the program, so it is
    // given a stand-in path that does not exist rather than a rule table.
    const rig =
      scenario.rules.length === 0
        ? (() => {
            const dir = mkdtempSync(join(tmpdir(), 'weibo-missing-'))
            __setCliInvocation({ file: join(dir, 'no-such-weibo-cli'), prefixArgs: [] })
            __setPlanCacheTimings({ readyMs: 0, backoffMs: 0 })
            return { close: () => { __setCliInvocation(undefined); __setPlanCacheTimings(undefined) }, calls: () => '' }
          })()
        : useRig(scenario.rules)
    try {
      const adapter = weiboProvider.createAdapter({ settings: {} })
      if (scenario.kind === 'probe') {
        const readiness = await probeWeiboCli().catch((error: unknown) => ({
          status: (error as { code?: string }).code ?? 'threw',
          message: String(error),
        }))
        assert.equal(
          readiness.status,
          scenario.expected,
          `${scenario.name}：期望 ${scenario.expected}，实际 ${readiness.status}（${readiness.message}）`,
        )
        seen.set(scenario.name, readiness.status)
        continue
      }

      const call =
        scenario.kind === 'thread' ? adapter.getThread(REF) : adapter.getReplies(REF, 1)
      const outcome = await call.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error: error as { code?: string; message: string } }),
      )

      if (scenario.expected === 'incomplete') {
        // This one is not an error: the read succeeded but must be marked degraded.
        assert.equal(outcome.ok, true, `${scenario.name}：应当读成功并标记不完整，实际抛错 ${String((outcome as { error?: Error }).error?.message)}`)
        const page = (outcome as { value: { incomplete?: boolean } }).value
        assert.equal(page.incomplete, true, `${scenario.name}：分页信号矛盾时必须标 incomplete`)
        seen.set(scenario.name, 'incomplete')
        continue
      }

      assert.equal(outcome.ok, false, `${scenario.name}：必须失败，实际返回了数据`)
      const code = (outcome as { error: { code?: string; message: string } }).error.code
      assert.equal(
        code,
        scenario.expected,
        `${scenario.name}：期望 ${scenario.expected}，实际 ${String(code)}（${(outcome as { error: { message: string } }).error.message}）`,
      )
      seen.set(scenario.name, String(code))
    } finally {
      rig.close()
    }
  }

  // ## The point of the whole file
  //
  // Eleven scenarios, and the *distinct* outcomes must be more than one. An implementation
  // that collapsed everything into "failed" would satisfy every individual assertion above
  // only by accident — this one makes the collapse itself a failure.
  const distinct = new Set(seen.values())
  assert.ok(
    distinct.size >= 6,
    `十一类场景只有 ${distinct.size} 种不同结果（${[...distinct].join('、')}）：` +
      '主人无法据此判断该装 CLI、去登录、去认证、去买套餐还是换网络',
  )
  // And the three that most often get conflated must stay apart.
  assert.notEqual(
    seen.get('1. CLI 未安装'),
    seen.get('2. 未登录'),
    '「装个工具」和「去登录」是两个动作，不能合并',
  )
  assert.notEqual(
    seen.get('2. 未登录'),
    seen.get('4. 服务未开通'),
    '「去登录」和「买套餐」是两个动作，不能合并',
  )
})

test('错误信息里不出现凭据，即使 CLI 把它回显在 stderr 里', async () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9abcdefghij'
  const rig = useRig(
    healthyRules([
      {
        match: 'statuses show_batch/biz',
        stderr: `Authorization: Bearer ${token}\naccess_token=${token}&code=SEKRET\n`,
        exit: 1,
      },
    ]),
  )
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const error = (await adapter.getThread(REF).catch((caught: unknown) => caught)) as Error
    assert.ok(error !== undefined)
    assert.equal(error.message.includes(token), false, `凭据泄漏进了错误信息：${error.message}`)
    assert.equal(error.message.includes('SEKRET'), false, 'code 参数也必须脱敏')
    assert.equal(scrubCredentials(`Bearer ${token}`).includes(token), false)
  } finally {
    rig.close()
  }
})

test('未登录时读取被拒绝，而不是返回一条空评论列表', async () => {
  const rig = useRig([
    { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
    { match: 'doctor', stdout: '× 注册或登录\n× 完成开发者认证\n× 开通服务\n' },
  ])
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const page = await adapter.getReplies(REF, 1).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error as Error }),
    )
    assert.equal(page.ok, false, '「读不到」不能变成「没有评论」：必须抛错')
    assert.match((page as { error: Error }).error.message, /登录|认证|开通/)
  } finally {
    rig.close()
  }
})

test('命令清单里的可用性由命令名决定，不是由「有没有命令」决定', () => {
  // Pure function, no CLI: this is the coarse classifier the diagnosis panel renders
  // before any schema inspection. It answers "is there a row that *looks* like a read
  // command", and the plan then verifies the schema — a name is a candidate, not a
  // permission.
  const none = classifyCommands([])
  assert.equal(none.statuses, false)
  assert.equal(none.comments, false)
  const unrelated = classifyCommands([
    { group: 'friendships', action: 'friends', name: 'friendships friends', access: 'allowed' },
  ] as never)
  assert.equal(unrelated.statuses, false, '关注列表不是正文读取')
  assert.equal(unrelated.comments, false, '关注列表不是评论读取')
  const readable = classifyCommands([
    { group: 'statuses', action: 'show_batch/biz', name: 'statuses show_batch/biz', access: 'allowed' },
    { group: 'comments', action: 'list/biz', name: 'comments list/biz', access: 'allowed' },
  ] as never)
  assert.equal(readable.statuses, true)
  assert.equal(readable.comments, true)
})

test('十一类场景的读取都没有发出写请求', async () => {
  // "Read the platform" must never become "do something to the platform". The fake CLI
  // logs every argv, so this is measured rather than promised.
  for (const scenario of SCENARIOS) {
    if (scenario.rules.length === 0) continue
    const rig = useRig(scenario.rules)
    try {
      const adapter = weiboProvider.createAdapter({ settings: {} })
      if (scenario.kind === 'probe') {
        await probeWeiboCli().catch(() => undefined)
      } else if (scenario.kind === 'thread') {
        await adapter.getThread(REF).catch(() => undefined)
      } else {
        await adapter.getReplies(REF, 1).catch(() => undefined)
      }
      for (const line of rig.calls().split(/\r?\n/)) {
        if (line.trim() === '') continue
        const argv = JSON.parse(line) as string[]
        assert.doesNotMatch(
          argv.join(' '),
          /(create|update|destroy|repost|remove|delete|publish|send)\b/i,
          `${scenario.name}：读取路径上出现了写操作 ${argv.join(' ')}`,
        )
      }
    } finally {
      rig.close()
    }
  }
})

test('微博读进来的数据不含楼层号：这是平台事实，不是缺省值', async () => {
  const rig = useRig(
    healthyRules([
      { match: 'statuses show_batch/biz', stdout: JSON.stringify(GOOD_STATUS) },
      {
        match: 'comments list/biz',
        stdout: JSON.stringify({
          data: [
            ...GOOD_COMMENTS.data,
            {
              idstr: '6002',
              text: '第二条评论。',
              user: { idstr: '1002', screen_name: '另一个评论者' },
              reply_comment_total: 0,
            },
          ],
          has_more: false,
        }),
      },
    ]),
  )
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const collected = await collectThread(adapter, REF, { maxPages: 2 })
    const timeline = buildTimeline(collected)
    for (const entry of timeline) {
      assert.equal(
        entry.floorNumber,
        undefined,
        `${entry.postId} 被塞了一个楼层号 ${entry.floorNumber}：微博没有楼层`,
      )
    }
    const list = buildCommentList(collected)
    for (const row of list.comments) {
      assert.equal(row.floorNumber, undefined, `${row.postId} 的楼层号应当是空的`)
    }
    // And the body is listed first, so 「回复微博本身」 is expressible at all.
    assert.equal(list.comments[0]?.postId, STATUS_ID)
  } finally {
    rig.close()
  }
})
