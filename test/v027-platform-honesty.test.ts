/**
 * v0.2.7 §八：设置页的平台状态必须与实际能力一致。
 *
 * 具体要防的是这一种谎：把微博 provider 注册进注册中心后，页面把它画成绿色的
 * 「已实现」——而微博的每个网络方法都因为缺少开放平台授权而抛错。注册了不等于
 * 能用了，这个区别必须在数据里，不在文案里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../lib/config.js'
import { EMPTY_OVERLAY } from '../lib/secrets.js'
import { viewOfSettings, type PlatformView, type SettingsRouteDeps } from '../lib/settings-routes.js'

/** The minimum a deps object needs for `viewOfSettings` to run. */
function makeDeps(platforms: readonly PlatformView[]): SettingsRouteDeps {
  return {
    authorize: () => 'ok',
    config: () => resolveConfig({}),
    credentials: () => ({
      async describe() {
        return { configured: false, writable: true }
      },
      async resolve() {
        return undefined
      },
      async set() {},
      async unset() {},
    }),
    overlay: () => EMPTY_OVERLAY,
    refreshSecrets: async () => undefined,
    settings: () => ({ writable: true, update: async () => undefined, mutate: async () => undefined }),
    namespace: () => 'dsh-ai-debate',
    platforms: () => platforms,
  } as unknown as SettingsRouteDeps
}

async function platformsOf(rows: readonly PlatformView[]): Promise<readonly PlatformView[]> {
  const view = await viewOfSettings(makeDeps(rows))
  return view['platforms'] as readonly PlatformView[]
}

test('平台视图原样透传 implemented，页面据此决定绿/黄', async () => {
  const rows = await platformsOf([
    { id: 'tieba', displayName: '贴吧', shape: 'forum-thread', implemented: true, active: true, capabilities: [] },
    { id: 'weibo', displayName: '微博', shape: 'microblog', implemented: false, active: false, capabilities: [] },
  ])
  assert.equal(rows.find((row) => row.id === 'tieba')!.implemented, true)
  assert.equal(rows.find((row) => row.id === 'weibo')!.implemented, false, '微博没有可用能力，不能显示成已实现')
})

test('未实现的平台必须带上「为什么还没实现」，否则页面只能说「计划中」', async () => {
  const rows = await platformsOf([
    {
      id: 'weibo',
      displayName: '微博',
      shape: 'microblog',
      implemented: false,
      active: false,
      capabilities: [],
      research: 'documented',
      prerequisites: ['拿到开放平台授权'],
      constraints: ['没有授权前不发任何请求'],
      authModel: 'OAuth 2.0',
      urlShapes: ['https://weibo.com/<uid>/<mid>'],
    },
  ])
  const row = rows.find((entry) => entry.id === 'weibo')!
  assert.ok((row.prerequisites ?? []).length > 0)
  assert.ok((row.constraints ?? []).length > 0)
  assert.equal(row.research, 'documented')
  assert.match(String(row.authModel), /OAuth/)
})

test('平台区不会把「有 provider」当成「能工作」', async () => {
  // The concrete regression: a registered-but-unimplemented platform once rendered
  // green purely because its provider object existed.
  const rows = await platformsOf([
    {
      id: 'weibo',
      displayName: '微博',
      shape: 'microblog',
      implemented: false,
      active: false,
      capabilities: [{ name: 'comment.publish', state: 'permission_required', mark: '!', reason: '缺授权' }],
    },
  ])
  const row = rows.find((entry) => entry.id === 'weibo')!
  assert.equal(row.implemented, false)
  assert.equal(row.capabilities[0]?.state, 'permission_required')
})

test('平台区不带任何凭据值（它只是状态）', async () => {
  const view = await viewOfSettings(
    makeDeps([{ id: 'tieba', displayName: '贴吧', shape: 'forum-thread', implemented: true, active: true, capabilities: [] }]),
  )
  const serialized = JSON.stringify(view['platforms'])
  for (const needle of ['ST=', 'BDUSS', 'SUB=', 'token=']) {
    assert.equal(serialized.includes(needle), false, `平台区不应出现 ${needle}`)
  }
})
