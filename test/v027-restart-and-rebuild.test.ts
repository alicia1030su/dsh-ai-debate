/**
 * 覆盖缺口的两条永久回归测试（v0.2.7 §一.6）。
 *
 * 这两件事在 v0.2.6 是**行为正确但没有任何测试固定**：我用临时脚本实测过，
 * 然后就丢掉了。临时脚本不是回归测试——它不在 CI 里，下一个人改动时没有任何
 * 东西会失败。这个文件把它们补上。
 *
 * 1. 会话跨重启（新实例、同目录）仍带着自己的平台 id；
 * 2. 平台请求参数变化后适配器按指纹重建，旧实例被丢弃。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { AdapterManager } from '../lib/platforms/adapter-manager.js'
import { PlatformRegistry } from '../lib/platforms/registry.js'
import type { PlatformAdapter } from '../lib/types.js'
import type { PlatformProvider } from '../lib/platforms/contracts.js'

function withTempDir(name: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `debate-${name}-`))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function sessionOn(platform: string, id: string) {
  const now = new Date().toISOString()
  return {
    id,
    platform,
    threadId: `${platform}-t1`,
    threadUrl: `https://${platform}.example/t1`,
    threadTitle: '帖子',
    forumName: '版块',
    ownerKey: 'o',
    disputeFloorPostId: 'n1',
    disputeFloorNumber: 1,
    triggerPostId: 'n2',
    state: 'READY' as const,
    statusText: '',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: now,
    updatedAt: now,
  }
}

// ---------------------------------------------------------------------------
// 1. 跨重启恢复正确平台
// ---------------------------------------------------------------------------

test('会话跨重启恢复：新实例从同一目录读到原来的 platform', async () => {
  const { dir, done } = withTempDir('restart-platform')
  try {
    const first = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    await first.ready()
    await first.mutate((data) => ({
      ...data,
      sessions: [...data.sessions, sessionOn('weibo', 'sess-weibo'), sessionOn('tieba', 'sess-tieba')],
    }))

    // A real restart: same directory, brand-new instance, nothing shared in memory.
    const second = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    await second.ready()

    assert.equal(second.getSession('sess-weibo')?.platform, 'weibo', '微博会话必须还是微博')
    assert.equal(second.getSession('sess-tieba')?.platform, 'tieba', '贴吧会话必须还是贴吧')
    assert.notEqual(
      second.getSession('sess-weibo')!.platform,
      second.getSession('sess-tieba')!.platform,
      '两个平台的会话不能在重启后串成一个',
    )
  } finally {
    done()
  }
})

test('会话跨重启：凭空捏造平台会保持原样，不会回落到默认平台', async () => {
  const { dir, done } = withTempDir('restart-unknown')
  try {
    const first = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    await first.ready()
    await first.mutate((data) => ({
      ...data,
      sessions: [...data.sessions, sessionOn('some-future-platform', 'sess-x')],
    }))

    const second = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    await second.ready()
    // The store is a record, not a router: it keeps what was written. What matters is
    // that it does NOT quietly rewrite the platform to 'tieba', which would make a
    // resumed session publish to the wrong site.
    assert.equal(second.getSession('sess-x')?.platform, 'some-future-platform')
  } finally {
    done()
  }
})

// ---------------------------------------------------------------------------
// 2. 配置变化后适配器重建
// ---------------------------------------------------------------------------

function probeProvider(counts: { built: number; settingsSeen: Readonly<Record<string, unknown>>[] }): PlatformProvider {
  // A *fresh* adapter per `createAdapter` call. Returning one shared instance would
  // make `assert.notEqual(before, after)` meaningless: the object identity would be
  // equal even when the manager correctly rebuilt.
  const makeAdapter = (): PlatformAdapter =>
    ({
      id: 'board',
      displayName: '板块',
      getCapabilities: () => ({ thread: true, replies: true, nestedReplies: true, userProfile: false, mentions: false, publish: false, authCheck: true }),
      checkAuthentication: async () => ({ authenticated: false }),
      getThread: async () => {
        throw new Error('unused')
      },
      getReplies: async () => ({ floors: [], hasMore: false, declaredTotal: 0 }),
      getNestedReplies: async () => ({ floors: [], hasMore: false, declaredTotal: 0 }),
      getUserProfile: async () => ({ userName: 'x' }),
      getMentions: async () => [],
      getReplyContext: async () => ({ floors: [] }),
      publishReply: async () => ({ status: 'failed' }),
    }) as unknown as PlatformAdapter

  return {
    id: 'board',
    displayName: '板块',
    shape: 'other',
    canHandleUrl: () => false,
    parseUrl: () => ({ platform: 'board', threadId: 'x', url: 'https://b.example/x' }),
    describeCapabilities: () => ({
      platform: 'board',
      declaredAt: new Date().toISOString(),
      capabilities: {},
    }),
    createAdapter: (context) => {
      counts.built += 1
      counts.settingsSeen.push(context.settings)
      return makeAdapter()
    },
  }
}

test('适配器按配置指纹缓存：配置没变就复用同一实例', () => {
  const counts = { built: 0, settingsSeen: [] as Readonly<Record<string, unknown>>[] }
  const registry = new PlatformRegistry()
  registry.register(probeProvider(counts))
  const manager = new AdapterManager({
    registry,
    settingsFor: () => ({ timeoutMs: 1000, cookie: 'A' }),
  })

  const first = manager.adapterFor('board')
  const again = manager.adapterFor('board')
  assert.equal(first, again, '配置没变时必须是同一个实例')
  assert.equal(counts.built, 1)
})

test('配置变化后必须重建适配器：不能让旧 cookie 继续发帖', () => {
  const counts = { built: 0, settingsSeen: [] as Readonly<Record<string, unknown>>[] }
  const registry = new PlatformRegistry()
  registry.register(probeProvider(counts))

  let settings: Readonly<Record<string, unknown>> = { timeoutMs: 1000, cookie: 'A' }
  const manager = new AdapterManager({ registry, settingsFor: () => settings })

  const before = manager.adapterFor('board')
  settings = { timeoutMs: 1000, cookie: 'B' }
  const after = manager.adapterFor('board')

  assert.notEqual(before, after, 'cookie 变了必须换一个新适配器')
  assert.equal(counts.built, 2)
  assert.equal(counts.settingsSeen[0]?.cookie, 'A')
  assert.equal(counts.settingsSeen[1]?.cookie, 'B', '新适配器拿到的是新值')
})

test('只改与平台无关的字段也会重建（宁可多建一次，也不让旧值继续用）', () => {
  // The fingerprint is over the whole platform-scoped settings object. That is the
  // conservative choice: rebuild costs an object, whereas serving a stale adapter
  // after a credential rotation publishes under the old identity.
  const counts = { built: 0, settingsSeen: [] as Readonly<Record<string, unknown>>[] }
  const registry = new PlatformRegistry()
  registry.register(probeProvider(counts))

  let settings: Readonly<Record<string, unknown>> = { timeoutMs: 1000 }
  const manager = new AdapterManager({ registry, settingsFor: () => settings })
  manager.adapterFor('board')
  settings = { timeoutMs: 2000 }
  manager.adapterFor('board')
  assert.equal(counts.built, 2)
})

test('平台各自独立缓存：一个平台重建不影响另一个', () => {
  const a = { built: 0, settingsSeen: [] as Readonly<Record<string, unknown>>[] }
  const b = { built: 0, settingsSeen: [] as Readonly<Record<string, unknown>>[] }
  const registry = new PlatformRegistry()
  registry.register(probeProvider(a))
  registry.register({ ...probeProvider(b), id: 'micro', displayName: '微型' })

  let boardSettings: Readonly<Record<string, unknown>> = { k: 1 }
  const manager = new AdapterManager({
    registry,
    settingsFor: (platform) => (platform === 'board' ? boardSettings : { k: 1 }),
  })

  manager.adapterFor('board')
  manager.adapterFor('micro')
  assert.equal(a.built, 1)
  assert.equal(b.built, 1)

  boardSettings = { k: 2 }
  manager.adapterFor('board')
  manager.adapterFor('micro')
  assert.equal(a.built, 2, '板块重建了')
  assert.equal(b.built, 1, '微型不该跟着重建')
})
