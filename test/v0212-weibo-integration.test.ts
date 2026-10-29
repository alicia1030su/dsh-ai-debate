/**
 * v0.2.12 §一：证明「CLI 适配层」与「Provider」之间是断的。
 *
 * ## 这个文件先写成红的
 *
 * 任务书要求先写一个**能证伪**的集成测试，再动代码。所以这里断言的是**目标行为**，
 * 不是现状：
 *
 * - 装了 CLI、授权也通过了 → `getThread()` 应该真的返回 Thread；
 * - 没装 CLI → `getThread()` 应该抛一个**能区分原因**的错误（`cli_missing`），
 *   而不是笼统的「未授权」。
 *
 * 在 v0.2.11 上跑这个文件，第一条会失败，因为 `provider.ts` 的每个读取方法都写死
 * 抛 `WeiboNotAuthorisedError`，`cli.ts` 一行都没被调用过。
 *
 * ## 为什么要用假 CLI
 *
 * 本机没有 `weibo-cli`，也没有开发者认证与 OAuth。真实读取**无法验证**。但「Provider
 * 有没有接上 CLI」这件事完全可以验证——把 CLI 替换成一个按脚本应答的假可执行文件，
 * 观察 Provider 是否真的去调用了它、是否用了正确的参数、是否把输出正确转换成了
 * `Thread` / `ReplyPage`。
 *
 * 这是**命令级**测试，不是端到端真实读取。报告里必须区分这两件事。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { weiboProvider } from '../lib/platforms/weibo/provider.js'
import { parseWeiboUrl } from '../lib/platforms/weibo/url.js'

/** Build an adapter the way the registry would. */
function adapter(): ReturnType<typeof weiboProvider.createAdapter> {
  return weiboProvider.createAdapter({ settings: {} })
}

const REF = (() => {
  const ref = parseWeiboUrl('https://m.weibo.cn/detail/4331051486294436')
  return { platform: 'weibo' as const, threadId: ref.threadId, url: ref.url }
})()

// ---------------------------------------------------------------------------
// 断点本身：现在就会红的断言
// ---------------------------------------------------------------------------

test('断点：getThread 不得永远抛「未授权」——它必须先问 CLI 状态（v0.2.12）', async () => {
  // ## 这个断言在 v0.2.11 上失败，那是它的用途
  //
  // v0.2.11 的 getThread 无条件 `notAuthorised('读取微博正文')`。本机确实没装 CLI，
  // 所以**拒绝本身是对的**；错的是**拒绝的理由**：它说「需要开放平台授权」，而真实
  // 原因是「这台机器上没有 weibo-cli」。
  //
  // 这两句话对主人意味着完全不同的动作：前者是「去申请权限」，后者是「去装个命令」。
  // 所以这里断言错误里要能区分出 CLI 缺失，而不是笼统的授权错误。
  const a = adapter()
  const error = await a.getThread(REF).then(
    () => undefined,
    (reason: unknown) => reason as Error & { code?: string },
  )
  assert.ok(error !== undefined, '没装 CLI 时必须失败，不能假装读到了')
  // The provider must have consulted the CLI layer, which yields a specific code.
  assert.notEqual(
    error!.code,
    'weibo_not_authorised',
    `不该笼统报「未授权」；实际 code=${error!.code} message=${error!.message}`,
  )
  assert.equal(
    ['cli_missing', 'not_authenticated', 'service_inactive'].includes(error!.code ?? ''),
    true,
    `错误码应能指向具体环节，实际 ${error!.code}`,
  )
})

test('断点：适配器不得声明自己能读（能力必须来自 CLI 实测，不是常量）', async () => {
  // v0.2.11 的 getCapabilities() 返回一个写死的全 false 字面量。那在没装 CLI 时恰好
  // 正确，但它不是「测出来的」，而是「猜的」——装了 CLI 也不会变。
  //
  // v0.2.12 要求：能力状态必须由 probe 结果推导。这里断言 `notes` 里带着真实原因，
  // 而不是空。
  const a = adapter()
  const caps = a.getCapabilities()
  assert.equal(caps.thread, false, '本机没 CLI，仍不可读')
  assert.ok(
    caps.notes !== undefined && Object.keys(caps.notes).length > 0,
    '能力缺失必须带可读原因，不能只是 false',
  )
  assert.match(
    Object.values(caps.notes!).join(' '),
    /cli|CLI|命令|授权|服务/,
    `原因应指向具体环节，实际：${JSON.stringify(caps.notes)}`,
  )
})

// ---------------------------------------------------------------------------
// 映射契约：即便暂时无法真实读取，接口形状也必须定下来
// ---------------------------------------------------------------------------

test('契约：getThread 返回的 Thread 必须带 platform=weibo 与 url', async () => {
  // These assertions describe the target shape. They are skipped only when the adapter
  // cannot read at all, so the file stays honest on a machine without a CLI while still
  // pinning the contract for the machine that has one.
  const a = adapter()
  const thread = await a.getThread(REF).catch(() => undefined)
  if (thread === undefined) return // 本机无 CLI：真实读取未验证，契约无法执行
  assert.equal(thread.platform, 'weibo')
  assert.equal(thread.id, REF.threadId)
  assert.equal(typeof thread.url, 'string')
  assert.equal(thread.url.length > 0, true)
  assert.equal(Array.isArray(thread.images), true)
})

test('契约：getReplies 的分页必须自报完整性，不得默认 complete', async () => {
  const a = adapter()
  const page = await a.getReplies(REF, 1).catch(() => undefined)
  if (page === undefined) return
  assert.equal(typeof page.hasMore, 'boolean', 'hasMore 必须是布尔，不能是 undefined')
  assert.equal(Array.isArray(page.floors), true)
  assert.equal(page.page, 1)
})

test('契约：未认证时必须 fail-closed，绝不返回空数组冒充「没有评论」', async () => {
  // The failure mode this prevents: returning `[]` makes "we could not read" look like
  // "there is nothing there", and the analyzer then concludes the opponent said nothing.
  const a = adapter()
  const result = await a.getReplies(REF, 1).then(
    (page) => ({ ok: true as const, page }),
    (reason: unknown) => ({ ok: false as const, error: reason as Error & { code?: string } }),
  )
  if (result.ok) {
    // If it somehow read, the page must be a real page — not an empty stand-in.
    assert.equal(Array.isArray(result.page.floors), true)
    return
  }
  assert.equal(
    ['cli_missing', 'not_authenticated', 'service_inactive', 'weibo_not_authorised'].includes(
      result.error.code ?? '',
    ),
    true,
    `错误码必须可识别，实际 ${result.error.code}`,
  )
})
