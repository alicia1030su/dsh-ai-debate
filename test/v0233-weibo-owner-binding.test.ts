/**
 * v0.2.33：微博主人绑定在设置页里必须真的能填。
 *
 * ## 这个文件防的是什么
 *
 * 一个只有真实桌面能暴露的缺陷：`platformAccounts` 是接第二个平台的**唯一**入口
 * （旧的 `ownerUserId` 一律解释为贴吧的），但它既不在 `EDITABLE_FIELDS` 里，
 * 也不在设置页的字段里，也不在 `publicConfig()` 的回传里。
 *
 * 三处缺一处都不行：
 *
 * - 没有输入框 → 用户看不到该填什么；
 * - 不在 `EDITABLE_FIELDS` → 保存被 400 拒绝，页面显示「保存失败」；
 * - 不回传 → 编辑永远从空开始，保存一次就把已有绑定覆盖掉。
 *
 * 后果不是「少一个开关」，是**桌面端没有任何一条路能读微博**：填了「主人账号
 * 名称」，微博那一侧仍然是未绑定，`runAnalysis` 直接抛出「还没有绑定主人」。
 *
 * ## 为什么这些断言写在 trait 层而不是 DOM 层
 *
 * 「字段可写」「字段会回传」都是路由层的事实，用请求就能验；用 DOM 验需要
 * 起一个宿主，而宿主坏掉时会同时红两处，分不清是哪一处坏了。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'

test('platformAccounts 是可解析的配置字段，默认空字符串', () => {
  assert.equal(DEFAULT_CONFIG.platformAccounts, '')
  const resolved = resolveConfig({ platformAccounts: '  ' })
  assert.equal(resolved.platformAccounts, '', '空白字符串应归一成空')
})

test('platformAccounts 能表达「微博主人 + 微博 AI 小号」两项', () => {
  const raw = JSON.stringify({
    owners: [{ platform: 'weibo', primary: { platform: 'weibo', accountId: '1911858642', idStrength: 'stable' } }],
    aiAccounts: [{ platform: 'weibo', account: { platform: 'weibo', accountId: '1999999999' } }],
  })
  const resolved = resolveConfig({ platformAccounts: raw })
  const parsed = JSON.parse(resolved.platformAccounts) as {
    owners: { platform: string; primary: { accountId: string } }[]
    aiAccounts: { platform: string; account: { accountId: string } }[]
  }
  assert.equal(parsed.owners[0]?.platform, 'weibo')
  assert.equal(parsed.owners[0]?.primary.accountId, '1911858642')
  assert.equal(parsed.aiAccounts[0]?.account.accountId, '1999999999')
})

test('旧的全局账号字段不会泄漏成微博的主人', async () => {
  // 这一条是那个缺陷的另一半：用户以为「我填了主人」，实际只填了贴吧的。
  const { ownerIdentity } = await import('../lib/runtime.js')
  const config = resolveConfig({ ownerUserId: '348099763', ownerUserName: '小财神' })
  assert.deepEqual(ownerIdentity(config, 'tieba'), {
    platform: 'tieba',
    userId: '348099763',
    userName: '小财神',
  })
  assert.deepEqual(
    ownerIdentity(config, 'weibo'),
    { platform: 'weibo' },
    '微博没有显式绑定时必须是空身份，绝不能借用贴吧的 uid',
  )
})

test('填了 platformAccounts 之后微博才有主人身份', async () => {
  const { ownerIdentity } = await import('../lib/runtime.js')
  const config = resolveConfig({
    ownerUserId: '348099763',
    platformAccounts: JSON.stringify({
      owners: [{ platform: 'weibo', primary: { platform: 'weibo', accountId: '1911858642', idStrength: 'stable' } }],
      aiAccounts: [],
    }),
  })
  const weibo = ownerIdentity(config, 'weibo')
  assert.equal(weibo.userId, '1911858642')
  assert.equal(ownerIdentity(config, 'tieba').userId, '348099763', '贴吧那一侧不受影响')
})

test('损坏的 platformAccounts 不抛错，按未绑定处理', async () => {
  const { ownerIdentity } = await import('../lib/runtime.js')
  const config = resolveConfig({ platformAccounts: '{这不是 JSON' })
  assert.deepEqual(ownerIdentity(config, 'weibo'), { platform: 'weibo' })
})
