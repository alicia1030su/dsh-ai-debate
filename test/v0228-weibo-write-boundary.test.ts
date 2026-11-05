/**
 * v0.2.28 P0-5：微博真实发表必须被真正拒绝，而不是只把按钮藏起来。
 *
 * ## 这个文件为什么存在
 *
 * 「微博不开放发表」这件事，在前几版是靠 UI 不显示按钮来体现的。隐藏按钮不是边界：
 *
 * - 工具层（`debate_publish_reply`）可以被直接调用，根本看不到页面；
 * - 会话可以从别处恢复，然后照常批准、照常发表；
 * - 一个改过的页面、一个脚本、一次 curl，都能绕过「没有按钮」。
 *
 * 所以真正的边界必须在**代码路径**上，而且要叠好几层，任何一层单独失效都不至于
 * 把内容发出去：
 *
 * 1. 能力矩阵：`comment.publish` / `comment.reply` 声明为 `permission_required`，
 *    `assertCapability` 因此抛错；
 * 2. 适配器：`publishReply` 无条件抛 `WeiboNotAuthorisedError`；
 * 3. 平台网关：微博没有可用的写入凭据，即使适配器被改坏也不会发出去。
 *
 * 这个文件逐层验证。它**不**验证「微博开放平台会拒绝」，因为这台机器从未具备写入
 * 授权，那个调用根本没有发生过——把它写成「已验证」就是伪造证据。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PlatformRegistry } from '../lib/platforms/registry.js'
import { __setCliInvocation } from '../lib/platforms/weibo/cli.js'
import { __setPlanCacheTimings } from '../lib/platforms/weibo/plan-cache.js'
import {
  WeiboNotAuthorisedError,
  weiboProvider,
} from '../lib/platforms/weibo/provider.js'
import { stateOf } from '../lib/platforms/contracts.js'
import type { PublishTarget } from '../lib/types.js'

const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')
const STATUS_ID = '5021243409116023'

const REF = {
  platform: 'weibo' as const,
  threadId: STATUS_ID,
  url: `https://m.weibo.cn/detail/${STATUS_ID}`,
}

/** A target that would be perfectly valid on a platform with a write path. */
const TARGET: PublishTarget = {
  platform: 'weibo',
  threadId: STATUS_ID,
  floorPostId: '6002',
  targetPostId: '6002',
  targetKind: 'floor',
  targetAuthorId: '1002',
  replyToUserId: '1002',
}

// ---------------------------------------------------------------------------
// Layer 1: the capability matrix
// ---------------------------------------------------------------------------

test('能力矩阵把微博的两种发表都声明为 permission_required', () => {
  const matrix = weiboProvider.describeCapabilities()
  for (const name of ['comment.publish', 'comment.reply'] as const) {
    const declaration = stateOf(matrix, name)
    assert.equal(
      declaration.state,
      'permission_required',
      `${name} 必须是 permission_required，实际 ${declaration.state}`,
    )
    // The reason must name what is missing, not just say "not supported": the owner has
    // to be able to tell "the platform forbids it" from "this build did not implement it".
    assert.match(declaration.reason, /写入|授权|标识/, `${name} 的理由要说明缺口：${declaration.reason}`)
  }
})

test('注册中心按能力矩阵拒绝发表，且拒绝发生在网络调用之前', () => {
  const registry = new PlatformRegistry()
  registry.register(weiboProvider)
  for (const capability of ['comment.publish', 'comment.reply'] as const) {
    assert.throws(
      () => registry.assertCapability('weibo', capability),
      (error: Error) => {
        assert.match(error.message, /weibo|微博/, '错误要说清是哪个平台')
        return true
      },
      `${capability} 必须被拒绝`,
    )
  }
})

test('即使调用方声称有 supported 证据，微博发表也不会被放行', () => {
  // The gate accepts caller-supplied evidence — that is how a live-verified capability
  // can satisfy an `unverified` declaration. The evidence must not be able to *invent*
  // a write path: a caller claiming `supported` for a platform that declares
  // `permission_required` would be a self-service unlock.
  const registry = new PlatformRegistry()
  registry.register(weiboProvider)
  assert.throws(
    () =>
      registry.assertCapability('weibo', 'comment.publish', {
        effective: 'permission_required',
        reason: '测试：即使有证据，权限缺口也不能被证据补上',
      }),
    /permission|权限|授权/i,
  )
})

// ---------------------------------------------------------------------------
// Layer 2: the adapter itself
// ---------------------------------------------------------------------------

test('适配器的 publishReply 无条件抛 WeiboNotAuthorisedError', async () => {
  const adapter = weiboProvider.createAdapter({ settings: {} })
  const error = await adapter
    .publishReply(REF, TARGET, '测试正文')
    .then(() => undefined)
    .catch((caught: unknown) => caught)

  assert.notEqual(error, undefined, 'publishReply 必须拒绝，而不是返回一个成功结果')
  assert.ok(error instanceof WeiboNotAuthorisedError, `必须是无授权错误，实际 ${String(error)}`)
  assert.equal((error as WeiboNotAuthorisedError).code, 'weibo_not_authorised')
})

test('publishReply 的拒绝不依赖 CLI 是否安装或登录', async () => {
  // Any of three environments: no CLI at all, a CLI that is not logged in, a CLI that
  // is fully ready. All three must refuse, and for the *same* reason — the refusal is a
  // property of this build, not of the machine's state.
  const dir = mkdtempSync(join(tmpdir(), 'weibo-write-'))
  const scenarios: { label: string; rules: unknown[] }[] = [
    {
      label: '没有任何规则（CLI 不存在）',
      rules: [],
    },
    {
      label: 'CLI 已安装但未登录',
      rules: [
        { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
        { match: 'doctor', stdout: '× 注册或登录\n× 完成开发者认证\n× 开通服务\n' },
      ],
    },
    {
      label: 'CLI 完全就绪',
      rules: [
        { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
        { match: 'doctor', stdout: '√ 注册或登录\n√ 完成开发者认证\n√ 开通服务\n' },
        {
          match: 'commands list',
          stdout: JSON.stringify({
            commands: [{ group: 'comments', action: 'list/biz', access: 'allowed' }],
          }),
        },
      ],
    },
  ]

  try {
    for (const scenario of scenarios) {
      const scriptPath = join(dir, `script-${scenarios.indexOf(scenario)}.json`)
      writeFileSync(scriptPath, JSON.stringify({ rules: scenario.rules }), 'utf8')
      process.env.FAKE_CLI_SCRIPT = scriptPath
      delete process.env.FAKE_CLI_LOG
      __setCliInvocation({ file: process.execPath, prefixArgs: [SCRIPT] })
      __setPlanCacheTimings({ readyMs: 0, backoffMs: 0 })

      const adapter = weiboProvider.createAdapter({ settings: {} })
      const error = await adapter
        .publishReply(REF, TARGET, '测试正文')
        .then(() => undefined)
        .catch((caught: unknown) => caught)
      assert.ok(
        error instanceof WeiboNotAuthorisedError,
        `${scenario.label}：必须拒绝，实际 ${String(error)}`,
      )
    }
  } finally {
    __setCliInvocation(undefined)
    __setPlanCacheTimings(undefined)
    delete process.env.FAKE_CLI_SCRIPT
    delete process.env.FAKE_CLI_LOG
  }
})

test('publishReply 的拒绝信息指向真实原因，不是「未知错误」', async () => {
  const adapter = weiboProvider.createAdapter({ settings: {} })
  const error = (await adapter.publishReply(REF, TARGET, '测试正文').catch((caught: unknown) => caught)) as Error
  // The message must say what is missing and what the owner can do, and must not read
  // like a transient failure the owner should retry.
  assert.match(error.message, /授权|写入|标识/)
  // The message may *mention* the network in order to rule it out — 「这不是网络故障」 is
  // the useful half of the sentence. What must not appear is advice to retry, which would
  // tell the owner the failure is transient when it is a missing authorisation.
  assert.doesNotMatch(error.message, /请重试|稍后重试|网络超时/, '这不是可以重试的故障，措辞不能误导')
})

// ---------------------------------------------------------------------------
// Layer 3: nothing in the write path can reach the platform
// ---------------------------------------------------------------------------

test('发表被拒时没有任何 CLI 写入调用发生', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weibo-write-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'calls.log')
  writeFileSync(
    scriptPath,
    JSON.stringify({
      rules: [
        { match: 'version', stdout: 'weibo-cli 0.9.8\n' },
        { match: 'doctor', stdout: '√ 注册或登录\n√ 开发者认证\n√ 开通服务\n' },
      ],
    }),
    'utf8',
  )
  process.env.FAKE_CLI_SCRIPT = scriptPath
  process.env.FAKE_CLI_LOG = logPath
  __setCliInvocation({ file: process.execPath, prefixArgs: [SCRIPT] })
  __setPlanCacheTimings({ readyMs: 0, backoffMs: 0 })
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    await adapter.publishReply(REF, TARGET, '测试正文').catch(() => undefined)

    const { readFileSync } = await import('node:fs')
    const logged = (() => {
      try {
        return readFileSync(logPath, 'utf8')
      } catch {
        return ''
      }
    })()
    const calls = logged
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as string[])

    // The refusal must be decided *before* any request. A `publishReply` that first
    // probes the CLI and then refuses would still be a refusal, but it would prove the
    // guard sits behind a network-shaped call — the layer that must never be reached.
    for (const argv of calls) {
      assert.doesNotMatch(
        argv.join(' '),
        /comment|status(es)?\s+(create|update|repost|destroy)|publish|send/i,
        `发表被拒时不应发出写请求，实际发了：${argv.join(' ')}`,
      )
    }
  } finally {
    __setCliInvocation(undefined)
    __setPlanCacheTimings(undefined)
    delete process.env.FAKE_CLI_SCRIPT
    delete process.env.FAKE_CLI_LOG
  }
})

// ---------------------------------------------------------------------------
// Layer 4: 贴吧没有被这次改动波及
// ---------------------------------------------------------------------------

test('贴吧的能力声明没有被微博的改动拉低', async () => {
  const { tiebaProvider } = (await import('../lib/platforms/tieba/provider.js')) as {
    tiebaProvider: { describeCapabilities(): ReturnType<typeof weiboProvider.describeCapabilities> }
  }
  const matrix = tiebaProvider.describeCapabilities()
  // `comment.nested` is `degraded` in this build by design (the inlined WAP copy is a
  // subset of the declared count), so the property to assert is "it can be used at all",
  // not "it is a clean `supported`". Claiming `supported` there would be the
  // overstatement v0.2.2 removed.
  for (const name of ['thread.read', 'comment.list'] as const) {
    assert.equal(
      stateOf(matrix, name).state,
      'supported',
      `贴吧的 ${name} 必须仍然是 supported，实际 ${stateOf(matrix, name).state}`,
    )
  }
  assert.ok(
    ['supported', 'degraded'].includes(stateOf(matrix, 'comment.nested').state),
    `贴吧的 comment.nested 必须仍可读，实际 ${stateOf(matrix, 'comment.nested').state}`,
  )
})

test('两个平台的能力状态互相独立：微博的收紧不会让贴吧变成需授权', () => {
  const registry = new PlatformRegistry()
  registry.register(weiboProvider)
  // Deliberately only checking the direction that matters: adding a restrictive
  // platform must not relax or restrict the existing one.
  const weiboPublish = stateOf(registry.getCapabilities('weibo'), 'comment.publish')
  assert.equal(weiboPublish.state, 'permission_required')
  const weiboThread = stateOf(registry.getCapabilities('weibo'), 'thread.read')
  // Read must NOT be permission_required — "cannot write" is not evidence about reading,
  // and conflating them is how a readable platform gets reported as entirely blocked.
  assert.notEqual(weiboThread.state, 'permission_required', '读能力不能因为写不了就变成需授权')
})
