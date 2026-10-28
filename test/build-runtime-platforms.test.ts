/**
 * v0.2.6 acceptance: platform selection through the *real* construction entry.
 *
 * `platform-routing.test.ts` proves the routing rules but builds its Runtime by
 * hand — its own header comment says adapters come from `buildRuntime`, and they
 * do not: it assembles a `Runtime` object from an `AdapterManager`. So the file
 * that claims to test the production entry point never called it.
 *
 * This file closes that gap. Every assertion below runs against the object
 * `buildRuntime()` actually returns, with two fake platforms registered through
 * the real `PlatformRegistry`. Nothing here reaches into `runtime.adapter` to
 * install an adapter; if `buildRuntime` stopped routing by platform, these tests
 * fail and the hand-built-double ones could still pass.
 *
 * It also pins the v0.2.6 default-platform fix: a registry holding only
 * non-Tieba platforms used to make `runtime.adapter`, `healthCheck` and
 * `checkLogin` throw `平台「tieba」没有注册`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildRuntime } from '../lib/index.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { PlatformRegistry } from '../lib/platforms/registry.js'
import { adapterFor, healthCheck, resolveThreadRef } from '../lib/runtime.js'
import { checkLogin, collectDiagnostics } from '../lib/diagnostics.js'
import type { PlatformProvider } from '../lib/platforms/contracts.js'
import type { PlatformAdapter, ThreadRef } from '../lib/types.js'

interface Probe {
  readonly provider: PlatformProvider
  /** What the adapter was actually asked to do. */
  readonly state: { threadReads: number; seenSettings?: Readonly<Record<string, unknown>> }
}

/**
 * One recorded fake platform.
 *
 * `settingsSeen` is recorded at construction so a test can prove the manager
 * handed this platform its own settings and no cookie belonging to the other.
 */
function probePlatform(input: {
  id: string
  displayName: string
  host: string
  pathPrefix: string
  canPublish?: boolean
}): Probe {
  const state: { threadReads: number; seenSettings?: Readonly<Record<string, unknown>> } = { threadReads: 0 }
  const canPublish = input.canPublish ?? true

  const adapter: PlatformAdapter = {
    id: input.id,
    displayName: input.displayName,
    getCapabilities: () => ({
      thread: true,
      replies: true,
      nestedReplies: true,
      userProfile: false,
      mentions: false,
      publish: canPublish,
      authCheck: true,
    }),
    checkAuthentication: async () => ({
      authenticated: true,
      userId: `${input.id}-ai`,
      userName: `${input.displayName}小号`,
    }),
    getThread: async () => {
      state.threadReads += 1
      return {
        platform: input.id,
        forum: { platform: input.id, id: '1', name: '测试区' },
        id: `${input.id}-t1`,
        title: `${input.displayName}的帖子`,
        content: '正文',
        authorId: 'host-1',
        authorName: '楼主',
        createdAt: '2024-1-1',
        url: `https://${input.host}${input.pathPrefix}${input.id}-t1`,
        declaredReplyCount: 0,
        images: [],
      }
    },
    getReplies: async () => ({ floors: [], hasMore: false, declaredTotal: 0 }),
    getNestedReplies: async () => ({ floors: [], hasMore: false, declaredTotal: 0 }),
    getUserProfile: async () => ({ userId: 'host-1', userName: '楼主' }),
    getMentions: async () => [],
    getReplyContext: async () => ({ floors: [] }),
    publishReply: async () => ({ status: 'failed', reason: '不可用' }),
  }

  const provider: PlatformProvider = {
    id: input.id,
    displayName: input.displayName,
    shape: 'other',
    canHandleUrl: (url: string) => {
      try {
        const parsed = new URL(url.includes('://') ? url : `https://${url}`)
        return parsed.host === input.host
      } catch {
        return false
      }
    },
    parseUrl: (url: string): ThreadRef => {
      const parsed = new URL(url.includes('://') ? url : `https://${url}`)
      const found = new RegExp(`${input.pathPrefix}([^/?#]+)`).exec(parsed.pathname)
      if (found === null) throw new Error(`${input.id}: 链接里没有帖子 id`)
      return {
        platform: input.id,
        threadId: found[1]!,
        url: `https://${input.host}${input.pathPrefix}${found[1]}`,
      }
    },
    describeCapabilities: () => ({
      platform: input.id,
      declaredAt: new Date().toISOString(),
      capabilities: {
        'thread.read': { state: 'unverified' as const, reason: '假平台' },
        'comment.publish': { state: 'unverified' as const, reason: '假平台' },
      },
    }),
    createAdapter: (context) => {
      state.seenSettings = context.settings
      return adapter
    },
  }

  return { provider, state }
}

const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} } as never

/** Build a Runtime through the production entry with `storeDir` pointed at a temp dir. */
function realRuntime(input: { registry: PlatformRegistry; storeDir: string; overrides?: Record<string, unknown> }) {
  const config = {
    ...DEFAULT_CONFIG,
    storeDir: input.storeDir,
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
    ...input.overrides,
  }
  return buildRuntime(() => resolveConfig(config), quietLog, input.registry)
}

function withTempDir(name: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `debate-${name}-`))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
// Acceptance 1: the URL's platform decides which adapter the real runtime uses
// ---------------------------------------------------------------------------

test('真实入口：两个假平台注册进 buildRuntime，各自的链接造出各自的适配器', async () => {
  const { dir, done } = withTempDir('real-two')
  try {
    const board = probePlatform({
      id: 'board',
      displayName: '板块',
      host: 'board.example',
      pathPrefix: '/thread/',
    })
    const micro = probePlatform({
      id: 'micro',
      displayName: '微型',
      host: 'micro.example',
      pathPrefix: '/status/',
    })
    const registry = new PlatformRegistry()
    registry.register(board.provider)
    registry.register(micro.provider)

    const runtime = realRuntime({ registry, storeDir: dir })

    // The production resolver, not a test-local one.
    const refBoard = resolveThreadRef(runtime, 'https://board.example/thread/board-t1')
    const refMicro = resolveThreadRef(runtime, 'https://micro.example/status/micro-t1')
    assert.equal(refBoard.platform, 'board')
    assert.equal(refMicro.platform, 'micro')

    // Identity of the adapter, not its name.
    const boardAdapter = adapterFor(runtime, refBoard.platform)
    const microAdapter = adapterFor(runtime, refMicro.platform)
    assert.equal(boardAdapter.id, 'board')
    assert.equal(microAdapter.id, 'micro')
    assert.notEqual(boardAdapter, microAdapter, '两个平台必须是两个不同的适配器实例')

    // Reading through the real runtime hits exactly one fake each time.
    await boardAdapter.getThread(refBoard)
    assert.equal(board.state.threadReads, 1, '板块适配器应被调用')
    assert.equal(micro.state.threadReads, 0, '微博适配器不应被板块的请求调用')

    await microAdapter.getThread(refMicro)
    assert.equal(micro.state.threadReads, 1)
    assert.equal(board.state.threadReads, 1, '板块计数不应因微博的读取而增加')
  } finally {
    done()
  }
})

test('真实入口：每个平台的适配器只拿到自己的设置，拿不到别家的 cookie', () => {
  const { dir, done } = withTempDir('real-settings')
  try {
    const board = probePlatform({
      id: 'board',
      displayName: '板块',
      host: 'board.example',
      pathPrefix: '/thread/',
    })
    const micro = probePlatform({
      id: 'micro',
      displayName: '微型',
      host: 'micro.example',
      pathPrefix: '/status/',
    })
    const registry = new PlatformRegistry()
    registry.register(board.provider)
    registry.register(micro.provider)

    const runtime = realRuntime({ registry, storeDir: dir })
    runtime.platforms.adapterFor('board')
    runtime.platforms.adapterFor('micro')

    // `platformSettingsOf` gives Tieba's own cookie field to Tieba only; the two
    // fakes are other platforms, so neither should receive a cookie at all.
    assert.equal('cookie' in (board.state.seenSettings ?? {}), false, '板块（非贴吧）不应收到 cookie 字段')
    assert.equal('cookie' in (micro.state.seenSettings ?? {}), false, '微型不应收到 cookie 字段')
    // The neutral request tuning is shared, which is the point of it being neutral.
    assert.equal(board.state.seenSettings?.timeoutMs, micro.state.seenSettings?.timeoutMs)
  } finally {
    done()
  }
})

test('真实入口：未知链接被拒绝，不会落到任一已注册平台', () => {
  const { dir, done } = withTempDir('real-unknown')
  try {
    const board = probePlatform({
      id: 'board',
      displayName: '板块',
      host: 'board.example',
      pathPrefix: '/thread/',
    })
    const registry = new PlatformRegistry()
    registry.register(board.provider)
    const runtime = realRuntime({ registry, storeDir: dir })

    assert.throws(
      () => resolveThreadRef(runtime, 'https://unknown.example/thread/x'),
      (error: Error) => /无法识别/.test(error.message) && /board/.test(error.message),
      '未知平台必须报错，并列出已注册平台',
    )
  } finally {
    done()
  }
})

// ---------------------------------------------------------------------------
// v0.2.6: the default-platform fallback must not be frozen to 'tieba'
// ---------------------------------------------------------------------------

test('没有贴吧的部署：runtime.adapter 回落到已注册平台，而不是抛「tieba 没有注册」', () => {
  const { dir, done } = withTempDir('real-default')
  try {
    const board = probePlatform({
      id: 'board',
      displayName: '板块',
      host: 'board.example',
      pathPrefix: '/thread/',
    })
    const registry = new PlatformRegistry()
    registry.register(board.provider)
    const runtime = realRuntime({ registry, storeDir: dir })

    // v0.2.5 threw `平台「tieba」没有注册` here.
    const fallback = runtime.adapter
    assert.equal(fallback.id, 'board', '默认平台应回落到唯一注册的平台')
  } finally {
    done()
  }
})

test('没有贴吧的部署：healthCheck 与 checkLogin 可运行且不崩溃', async () => {
  const { dir, done } = withTempDir('real-health')
  try {
    const board = probePlatform({
      id: 'board',
      displayName: '板块',
      host: 'board.example',
      pathPrefix: '/thread/',
    })
    const registry = new PlatformRegistry()
    registry.register(board.provider)
    const runtime = realRuntime({ registry, storeDir: dir })

    const health = await healthCheck(runtime)
    assert.equal(typeof health.ok, 'boolean', 'healthCheck 应返回报告而不是抛错')
    assert.equal(health.capabilities.publish, true, '能力应来自回落平台自己的适配器')

    const login = await checkLogin(runtime)
    assert.equal(login.ok, true, '回落平台的登录态应被读到：' + login.message)
    assert.equal(login.authenticated, true)

    const diag = await collectDiagnostics(runtime, runtime.config())
    assert.notEqual(diag, undefined, 'collectDiagnostics 应可运行')
  } finally {
    done()
  }
})

test('贴吧在场时默认平台仍是贴吧，不被注册顺序左右', () => {
  const { dir, done } = withTempDir('real-order')
  try {
    const micro = probePlatform({
      id: 'micro',
      displayName: '微型',
      host: 'micro.example',
      pathPrefix: '/status/',
    })
    const tiebaish = probePlatform({
      id: 'tieba',
      displayName: '贴吧',
      host: 'tieba.example',
      pathPrefix: '/p/',
    })
    const registry = new PlatformRegistry()
    // Registered first on purpose: order must not decide the default.
    registry.register(micro.provider)
    registry.register(tiebaish.provider)

    const runtime = realRuntime({ registry, storeDir: dir })
    assert.equal(runtime.adapter.id, 'tieba', '贴吧在场时默认平台必须是贴吧')
  } finally {
    done()
  }
})

test('空注册中心：默认平台给出明确错误，而不是 TypeError', () => {
  const { dir, done } = withTempDir('real-empty')
  try {
    const registry = new PlatformRegistry()
    const runtime = realRuntime({ registry, storeDir: dir })
    assert.throws(
      () => runtime.adapter,
      (error: Error) => /平台注册中心是空的/.test(error.message),
      '空注册中心必须给出可读的原因',
    )
  } finally {
    done()
  }
})
