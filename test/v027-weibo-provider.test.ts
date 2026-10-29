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

test('也没有任何能力被声明为 unverified（那意味着有能跑的代码）', () => {
  // `unverified` means "the code exists and would run, nobody proved it against a
  // real account". There is no network code here at all, so claiming `unverified`
  // would be the same lie one step quieter.
  for (const [name, row] of Object.entries(MATRIX.capabilities)) {
    assert.notEqual(row.state, 'unverified', `${name} 不能是 unverified：没有可运行的发帖/读取实现`)
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

test('每个读方法都抛 WeiboNotAuthorisedError，而不是返回空数据', async () => {
  const adapter = weiboProvider.createAdapter({ settings: {} })
  const calls = [
    () => adapter.checkAuthentication(),
    () => adapter.getThread({ platform: 'weibo', threadId: '1' } as never),
    () => adapter.getReplies({ platform: 'weibo', threadId: '1' } as never, 1),
    () => adapter.getNestedReplies({ platform: 'weibo', threadId: '1' } as never, { platform: 'weibo', postId: 'c1' } as never, 1),
    () => adapter.getUserProfile('u1'),
    () => adapter.getMentions(),
    () => adapter.getReplyContext({ platform: 'weibo', threadId: '1' } as never, 'c1'),
    () => adapter.publishReply({ platform: 'weibo', threadId: '1' } as never, 'nested', 'x'),
  ]
  for (const call of calls) {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof WeiboNotAuthorisedError, '必须是可识别的授权错误，不是随便的 Error')
      assert.equal((error as WeiboNotAuthorisedError).code, 'weibo_not_authorised')
      assert.match((error as Error).message, /不会尝试/)
      return true
    })
  }
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
  assert.throws(() => registry.assertCapability('weibo', 'comment.publish'), /不能|尚未|权限/)
  assert.throws(() => registry.assertCapability('weibo', 'comment.reply'), /不能|尚未|权限/)
})
