/**
 * v0.2.7 §五/§六：微博只读 provider 的诚实边界。
 *
 * 这一轮**没有**取得微博开放平台授权，也从未对线上接口发过请求。所以这里的断言
 * 全部是「不许假装」：
 *
 * - 没有任何能力可以被声明成 supported（没有真实验证就不能这么写）；
 * - 也不能声明成 unverified（那意味着「代码写了、只是没验证」，而这里连能跑的
 *   网络代码都没有）；
 * - 每个读方法抛的是可识别的授权错误，不是空数组——空数组会让「读不到」和
 *   「本来就没有」变得无法区分；
 * - 链接解析与 ID 规范化是真的能用的，这是本阶段真正交付的部分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { weiboProvider, WeiboNotAuthorisedError } from '../lib/platforms/weibo/provider.js'
import { PlatformRegistry } from '../lib/platforms/registry.js'
import type { CapabilityName } from '../lib/platforms/contracts.js'

const MATRIX = weiboProvider.describeCapabilities()

test('微博 provider 的 id / 名称 / 形状', () => {
  assert.equal(weiboProvider.id, 'weibo')
  assert.equal(weiboProvider.displayName, '微博')
  assert.equal(weiboProvider.shape, 'microblog')
})

test('没有任何能力被声明为 supported（没有真实验证就没有这个资格）', () => {
  for (const [name, row] of Object.entries(MATRIX.capabilities)) {
    assert.notEqual(row.state, 'supported', `${name} 不能是 supported：本构建从未对微博发过请求`)
    assert.equal(
      (row as { lastVerifiedAt?: string }).lastVerifiedAt,
      undefined,
      `${name} 不能有 lastVerifiedAt：那个日期只能是编的`,
    )
  }
})

test('读取能力是 unverified，写入能力不是（v0.2.11 起分开）', () => {
  // ## Why this test changed in v0.2.11
  //
  // v0.2.7 asserted that **no** row could be `unverified`, because there was no runnable
  // code at all: the adapter threw on every method. That was the right assertion then.
  //
  // v0.2.11 adds a real CLI adapter (`platforms/weibo/cli.ts`): it detects the binary,
  // discovers commands, parses JSON, classifies failures and scrubs credentials. That is
  // code which *would* run — so `unverified` ("implemented, never confirmed against the
  // platform") is now the accurate label for reads, and `permission_required` would
  // understate it.
  //
  // What must NOT happen is a row silently becoming `supported`. That is still asserted
  // above, and the write rows are still `permission_required` because no write code
  // exists at all.
  const reads: CapabilityName[] = [
    'thread.read',
    'comment.list',
    'comment.paginate',
    'comment.nested',
    'comment.locate',
    'identity.verify',
    'user.profile',
  ]
  for (const name of reads) {
    assert.equal(
      MATRIX.capabilities[name].state,
      'unverified',
      `${name} 有 CLI 适配代码但从未真跑，应是 unverified`,
    )
  }
  for (const name of ['comment.publish', 'comment.reply'] as CapabilityName[]) {
    assert.notEqual(
      MATRIX.capabilities[name].state,
      'unverified',
      `${name} 没有任何写入实现，不能标成 unverified`,
    )
  }
})

test('写能力必须是 permission_required，并写明需要什么授权', () => {
  for (const name of ['comment.publish', 'comment.reply'] as CapabilityName[]) {
    const row = MATRIX.capabilities[name]
    assert.equal(row.state, 'permission_required', `${name} 必须等授权`)
    assert.ok((row.requiredPermissions ?? []).length > 0, `${name} 要写明需要哪些权限`)
  }
})

test('艾特通知：明确不可用，而不是「等授权」', () => {
  // Claiming "permission required" would tell the owner that granting something
  // makes mentions work. It does not: the interface is not offered to third parties.
  const row = MATRIX.capabilities['event.mentions']
  assert.equal(row.state, 'unavailable')
  assert.match(row.reason, /不对外开放|手动/)
})

test('每一行都有非空理由（supported 没有证据就只是猜测）', () => {
  for (const [name, row] of Object.entries(MATRIX.capabilities)) {
    assert.ok(row.reason.trim().length > 0, `${name} 缺少原因`)
  }
})

test('每个读方法都失败并给出可识别的错误码，而不是返回空数据', async () => {
  // ## What this test used to assert, and why it changed in v0.2.12
  //
  // v0.2.7–v0.2.11 threw `WeiboNotAuthorisedError` (`weibo_not_authorised`) from every
  // method, unconditionally. The **property** that test protected is still the important
  // one: a read must fail loudly, never return `[]`, because an empty list makes "we could
  // not read it" indistinguishable from "there is nothing there".
  //
  // v0.2.12 wires the adapter to the CLI layer, so on a machine without `weibo-cli` the
  // code is now `cli_missing` — which is *more* accurate: it tells the owner to install a
  // tool rather than to obtain a permission that would not help. Pinning the old literal
  // would have frozen the less useful message.
  //
  // So the assertion is on the property: every read rejects, and every rejection carries a
  // code from the known set. `publishReply` keeps its own class, because writing is not a
  // missing-read situation.
  const adapter = weiboProvider.createAdapter({ settings: {} })
  const reads = [
    () => adapter.getThread({ platform: 'weibo', threadId: '1' } as never),
    () => adapter.getReplies({ platform: 'weibo', threadId: '1' } as never, 1),
    () => adapter.getNestedReplies({ platform: 'weibo', threadId: '1' } as never, { platform: 'weibo', postId: 'c1' } as never, 1),
    () => adapter.getUserProfile('u1'),
    () => adapter.getMentions(),
    () => adapter.getReplyContext({ platform: 'weibo', threadId: '1' } as never, 'c1'),
  ]
  const KNOWN = [
    'cli_missing',
    'not_authenticated',
    'service_inactive',
    'quota_exhausted',
    'command_unavailable',
    'malformed_response',
    'failed',
  ]
  for (const call of reads) {
    await assert.rejects(call, (error: unknown) => {
      const code = (error as { code?: string }).code
      assert.equal(
        KNOWN.includes(code ?? ''),
        true,
        `读失败必须带可识别错误码，实际 code=${code} message=${(error as Error).message}`,
      )
      return true
    })
  }

  // Writing is a different refusal, and it must not drift into "temporarily unavailable":
  // this build has no Weibo write path at all.
  await assert.rejects(
    () => adapter.publishReply({ platform: 'weibo', threadId: '1' } as never, 'nested', 'x'),
    (error: unknown) => {
      assert.ok(error instanceof WeiboNotAuthorisedError, '发表必须是授权错误，不是别的')
      assert.equal((error as WeiboNotAuthorisedError).code, 'weibo_not_authorised')
      return true
    },
  )
})

test('登录检查返回状态，不抛异常（v0.2.12：它现在是探测，不是拒绝）', async () => {
  // `checkAuthentication` used to throw. It is a read-only probe of the local CLI, and a
  // caller asking "am I logged in?" needs the answer `false` with a reason, not an
  // exception — that is what the settings page renders.
  const adapter = weiboProvider.createAdapter({ settings: {} })
  const state = await adapter.checkAuthentication()
  assert.equal(typeof state.authenticated, 'boolean')
  assert.equal(state.authenticated, false, '本机没有 CLI，未认证')
  assert.equal(typeof state.reason, 'string', '必须说明为什么')
  assert.match(state.reason ?? '', /CLI|cli|安装|授权/, `原因应可读：${state.reason}`)
})

test('适配器自己的能力牌是「全都不能」，与矩阵一致', () => {
  const adapter = weiboProvider.createAdapter({ settings: {} })
  const capabilities = adapter.getCapabilities()
  assert.equal(capabilities.thread, false)
  assert.equal(capabilities.replies, false)
  assert.equal(capabilities.publish, false)
  assert.equal(capabilities.authCheck, false)
})

test('适配器自带的 parseUrl 是纯函数：能解析，不联网', () => {
  const adapter = weiboProvider.createAdapter({ settings: {} })
  const ref = (adapter as { parseUrl?: (url: string) => { platform: string; threadId: string } }).parseUrl?.(
    'https://m.weibo.cn/detail/5012345678901234',
  )
  assert.ok(ref !== undefined)
  assert.equal(ref!.platform, 'weibo')
  assert.equal(ref!.threadId, '5012345678901234')
})

test('注册进注册中心后：微博链接归微博，贴吧链接不归它', () => {
  const registry = new PlatformRegistry()
  registry.register(weiboProvider)
  assert.equal(registry.resolveFromUrl('https://weibo.com/123/AbCdEf123')?.id, 'weibo')
  assert.equal(registry.resolveFromUrl('https://tieba.baidu.com/p/1'), undefined)
})

test('注册中心的能力闸门对微博写能力 fail-closed', () => {
  const registry = new PlatformRegistry()
  registry.register(weiboProvider)
  // The gate treats anything that is not `supported` as a refusal. Asserting this is
  // the concrete form of "没有取得权限的功能不会被假装为已实现".
  //
  // Match on `授权` too: the gate's own prefix is "需要授权", and the reason text is
  // allowed to phrase the requirement as an authorisation rather than a prohibition.
  // v0.2.11's reason says "需要评论写入授权", which is a refusal in the same sense —
  // pinning only 不能/尚未 made this test reject a correct message.
  for (const name of ['comment.publish', 'comment.reply'] as const) {
    assert.throws(
      () => registry.assertCapability('weibo', name),
      /不能|尚未|权限|授权/,
      `${name} 必须被闸门拒绝`,
    )
  }
})
