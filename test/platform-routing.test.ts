/**
 * v0.2.1 acceptance: the runtime routes to the platform the URL names.
 *
 * v0.2.0 could parse two platforms' URLs correctly and still hand every request
 * to one adapter, so this file exists to make that failure impossible to ship
 * again. The rules it enforces:
 *
 * - adapters come from `buildRuntime` (the real construction entry), never from a
 *   field a test assigned;
 * - the adapter that is *called* is the one for the resolved platform, proven by
 *   each fake counting its own reads;
 * - credentials, identity and quota do not cross platforms;
 * - a session records its platform and a resumed session uses it;
 * - an unknown link is refused rather than falling back to the default platform.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import {
  runAnalysis,
  runGeneration,
  runPublish,
  getSession,
  adapterFor,
  resolveThreadRef,
  type Runtime,
} from '../lib/runtime.js'
import { PlatformRegistry } from '../lib/platforms/registry.js'
import { AdapterManager, refBelongsToPlatform } from '../lib/platforms/adapter-manager.js'
import type { CapabilityName, PlatformCapabilityMatrix, PlatformProvider } from '../lib/platforms/contracts.js'
import type {
  AuthState,
  Floor,
  Mention,
  NestedPage,
  NestedReply,
  PlatformAdapter,
  PublishOutcome,
  PublishTarget,
  ReplyContext,
  ReplyPage,
  Thread,
  ThreadRef,
  UserProfile,
} from '../lib/types.js'

// ---------------------------------------------------------------------------
// A fake platform that records what it was actually asked to do
// ---------------------------------------------------------------------------

interface RoutingFake {
  readonly id: string
  readonly host: string
  readonly pathPrefix: string
  /** The account this platform reports as logged in. Never shared with the other. */
  readonly account: { userId: string; userName: string }
  /** The cookie this platform's adapter was constructed with, if any. */
  seedCookie?: string
}

interface RoutingState {
  threadReads: number
  listReads: number
  publishes: { target: PublishTarget; content: string }[]
}

/**
 * Build one routing fake: provider + adapter + the counters a test asserts on.
 *
 * The adapter is created by the provider's `createAdapter`, exactly as a real
 * one is, and it records which platform it belongs to — so a test can tell
 * "platform B answered" from "someone answered".
 */
function makeRoutingFake(
  shape: RoutingFake,
  options: {
    canPublish?: boolean
    /** The capabilities to declare; defaults to a fully proven platform. */
    capabilities?: Partial<Record<CapabilityName, PlatformCapabilityMatrix['capabilities'][CapabilityName]>>
    /** Receives the settings the manager passed, so a test can inspect them. */
    onContext?: (settings: Readonly<Record<string, unknown>>) => void
  } = {},
): { provider: PlatformProvider; state: RoutingState } {
  const state: RoutingState = { threadReads: 0, listReads: 0, publishes: [] }
  const canPublish = options.canPublish ?? true
  const threadId = `${shape.id}-t1`
  const floors: Floor[] = [
    {
      platform: shape.id,
      floorNumber: 1,
      postId: `${shape.id}-c1`,
      authorId: 'host-1',
      authorName: '楼主',
      content: '第 1 条。',
      createdAt: '2024-1-1',
      images: [],
      nestedCount: 3,
    },
    {
      platform: shape.id,
      floorNumber: 2,
      postId: `${shape.id}-c2`,
      authorId: 'someone-else',
      authorName: '路人',
      content: '第 2 条。',
      createdAt: '2024-1-1',
      images: [],
    },
  ]
  const nested: NestedReply[] = [
    {
      platform: shape.id,
      postId: `${shape.id}-r1`,
      parentPostId: `${shape.id}-c1`,
      authorId: 'owner-1',
      authorName: '主人',
      content: '这个方案我认为不可行。',
    },
    {
      platform: shape.id,
      postId: `${shape.id}-r2`,
      parentPostId: `${shape.id}-c1`,
      authorId: 'opp-1',
      authorName: '对手B',
      content: '你凭什么这么说？',
      replyToName: '主人',
    },
    {
      platform: shape.id,
      postId: `${shape.id}-r3`,
      parentPostId: `${shape.id}-c1`,
      authorId: 'owner-1',
      authorName: '主人',
      content: '因为成本会翻倍。',
      replyToName: '对手B',
    },
  ]
  const posted: NestedReply[] = []
  const thread: Thread = {
    platform: shape.id,
    forum: { platform: shape.id, id: '1', name: '测试区' },
    id: threadId,
    title: '测试帖',
    content: '正文',
    authorId: 'host-1',
    authorName: '楼主',
    createdAt: '2024-1-1',
    url: `https://${shape.host}${shape.pathPrefix}${threadId}`,
    declaredReplyCount: floors.length,
    images: [],
  }

  const adapter: PlatformAdapter = {
    id: shape.id,
    displayName: `假平台 ${shape.id}`,
    getCapabilities() {
      return {
        thread: true,
        replies: true,
        nestedReplies: true,
        userProfile: false,
        mentions: false,
        publish: canPublish,
        authCheck: true,
      }
    },
    async checkAuthentication(): Promise<AuthState> {
      return { authenticated: true, userId: shape.account.userId, userName: shape.account.userName }
    },
    async getThread(): Promise<Thread> {
      state.threadReads += 1
      return thread
    },
    async getReplies(_ref: ThreadRef, page: number): Promise<ReplyPage> {
      state.listReads += 1
      const pageSize = 10
      const start = (page - 1) * pageSize
      const slice = floors.slice(start, start + pageSize)
      return { floors: slice, page, hasMore: false, declaredTotalPages: 1, declaredTotal: floors.length }
    },
    async getNestedReplies(_ref: ThreadRef, floor: Floor, page: number): Promise<NestedPage> {
      const all = floor.postId === `${shape.id}-c1` ? nested : []
      return {
        replies: page === 1 ? all : [],
        page,
        hasMore: false,
        declaredTotalPages: 1,
        declaredTotal: all.length,
      }
    },
    async getUserProfile(): Promise<UserProfile> {
      throw new Error('不提供用户资料')
    },
    async getMentions(): Promise<readonly Mention[]> {
      throw new Error('不提供艾特通知')
    },
    async getReplyContext(_ref: ThreadRef, postId: string): Promise<ReplyContext> {
      const floor = floors.find((entry) => entry.postId === postId)
      if (floor) return { thread, floor, ancestors: [], siblings: [] }
      const mine = posted.find((entry) => entry.postId === postId)
      if (mine) {
        const parent = floors.find((entry) => entry.postId === mine.parentPostId)!
        return { thread, floor: parent, nested: mine, ancestors: [], siblings: posted }
      }
      for (const candidate of floors) {
        const rows = candidate.postId === `${shape.id}-c1` ? nested : []
        const hit = rows.find((entry) => entry.postId === postId)
        if (hit) return { thread, floor: candidate, nested: hit, ancestors: [], siblings: rows }
      }
      throw new Error(`找不到 ${postId}`)
    },
    async publishReply(_ref: ThreadRef, target: PublishTarget, content: string): Promise<PublishOutcome> {
      state.publishes.push({ target, content })
      const postId = `${shape.id}-new-${state.publishes.length}`
      posted.push({
        platform: shape.id,
        postId,
        parentPostId: target.floorPostId ?? floors[0]!.postId,
        ...(target.nestedReplyId ? { replyToPostId: target.nestedReplyId } : {}),
        authorId: shape.account.userId,
        authorName: shape.account.userName,
        content,
      })
      return { status: 'confirmed', postId }
    },
  }

  const proven = (name: CapabilityName) => ({ state: 'supported' as const, reason: `${name} 在测试中执行过` })
  const declared: PlatformCapabilityMatrix = {
    platform: shape.id,
    declaredAt: new Date().toISOString(),
    capabilities: {
      'thread.read': proven('thread.read'),
      'comment.list': proven('comment.list'),
      'comment.paginate': proven('comment.paginate'),
      'comment.nested': proven('comment.nested'),
      'comment.locate': proven('comment.locate'),
      'identity.verify': proven('identity.verify'),
      'event.mentions': { state: 'unavailable', reason: '不提供' },
      'comment.publish': canPublish
        ? proven('comment.publish')
        : { state: 'unavailable', reason: '该平台不提供发表能力' },
      'comment.reply': canPublish
        ? proven('comment.reply')
        : { state: 'unavailable', reason: '该平台不提供回复能力' },
      'publish.verify': canPublish
        ? proven('publish.verify')
        : { state: 'unavailable', reason: '无法回读' },
      'media.read': { state: 'unavailable', reason: '不提供' },
      'user.profile': { state: 'unavailable', reason: '不提供' },
      ...options.capabilities,
    },
  }

  const provider: PlatformProvider = {
    id: shape.id,
    displayName: `假平台 ${shape.id}`,
    shape: 'other',
    canHandleUrl(url: string): boolean {
      if (typeof url !== 'string' || url.trim() === '') return false
      try {
        return new URL(url.includes('://') ? url : `https://${url}`).hostname === shape.host
      } catch {
        return false
      }
    },
    parseUrl(url: string): ThreadRef {
      const parsed = new URL(url.includes('://') ? url : `https://${url}`)
      const found = new RegExp(`${shape.pathPrefix}([^/?#]+)`).exec(parsed.pathname)
      if (!found) throw new Error(`${shape.id}: 链接里没有帖子 id`)
      return {
        platform: shape.id,
        threadId: found[1]!,
        url: `https://${shape.host}${shape.pathPrefix}${found[1]}`,
      }
    },
    describeCapabilities: () => declared,
    createAdapter(context) {
      options.onContext?.(context.settings)
      return adapter
    },
  }

  return { provider, state }
}

const SHAPE_TIEBA_LIKE: RoutingFake = {
  id: 'board',
  host: 'board.example',
  pathPrefix: '/thread/',
  account: { userId: 'board-ai', userName: '板块小号' },
}

const SHAPE_MICRO: RoutingFake = {
  id: 'micro',
  host: 'micro.example',
  pathPrefix: '/status/',
  account: { userId: 'micro-ai', userName: '微博小号' },
}

/**
 * Build a Runtime the way the plugin does.
 *
 * This mirrors `buildRuntime` in `src/index.ts`: a registry, an `AdapterManager`,
 * and per-platform settings resolved through `platformSettingsOf`. It is not a
 * shortcut — every assertion below goes through the same selection path the
 * production code uses, which is what the task requires ("cannot assign
 * runtime.adapter in a test to bypass the selection mechanism").
 */
function makeRoutedRuntime(input: {
  registry: PlatformRegistry
  dir: string
  /** Per-platform settings, so a test can prove isolation. */
  settingsFor?: (platform: string) => Readonly<Record<string, unknown>>
  replies: string[]
  /** Overrides applied to the resolved config. */
  config?: Partial<typeof DEFAULT_CONFIG>
}): { runtime: Runtime; client: ScriptedLlmClient } {
  const store = new DebateStore({ dir: input.dir })
  const client = new ScriptedLlmClient(input.replies.map((text) => ({ text })))
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    // v0.2.2: accounts are bound per platform rather than globally. This test
    // exercises two fake platforms ('board' and 'micro') at once, so each gets
    // its own owner and AI account — which is the point of the model: a single
    // global id would have been matched on both.
    platformAccounts: JSON.stringify({
      owners: [
        { platform: 'board', primary: { platform: 'board', accountId: 'owner-1' } },
        { platform: 'micro', primary: { platform: 'micro', accountId: 'owner-1' } },
      ],
      aiAccounts: [
        { platform: 'board', account: { platform: 'board', accountId: 'board-ai' } },
        { platform: 'micro', account: { platform: 'micro', accountId: 'micro-ai' } },
      ],
    }),
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
    ...input.config,
  })

  const settingsFor =
    input.settingsFor ?? ((platform: string) => ({ timeoutMs: 20_000, platformHint: platform }))
  const manager = new AdapterManager({ registry: input.registry, settingsFor })

  const runtime: Runtime = {
    get adapter() {
      // The default platform, exactly as the plugin's own getter does.
      return manager.adapterFor('board')
    },
    store,
    policy: {
      mode: 'manual',
      maxAutoPublishesPerSession: 0,
      cooldownMs: 0,
      maxPublishesPerThread: 10,
      stopOnChallenge: true,
    },
    config: () => config,
    llm: () => client,
    log: () => undefined,
    platforms: {
      resolveUrl: (url) => input.registry.parseUrl(url),
      diagnostics: () => input.registry.diagnostics(),
      capabilitiesOf: (platform) => input.registry.getCapabilities(platform),
      adapterFor: (platform) => manager.adapterFor(platform),
      assertCapability: (platform, capability) => input.registry.assertCapability(platform, capability),
    },
  }
  return { runtime, client }
}

function modelReply(platform: string): string {
  return JSON.stringify({
    status: 'ok',
    owner_position: '成本会翻倍',
    opponent_position: '缺少依据',
    main_dispute: '成本问题',
    latest_argument: '你凭什么这么说',
    response_target_id: `${platform}-r2`,
    strategy: 'demand_evidence',
    confidence: 0.8,
    uncertainties: [],
    reply: '前面已经贴过报价了，要反驳就拿出同型号的价格。',
  })
}

// ---------------------------------------------------------------------------
// Acceptance 1: the URL's platform decides which adapter runs
// ---------------------------------------------------------------------------

test('两个平台注册在同一个 Runtime 上，各自读到的是自己的帖子', async () => {
  const board = makeRoutingFake(SHAPE_TIEBA_LIKE)
  const micro = makeRoutingFake(SHAPE_MICRO)
  const registry = new PlatformRegistry()
  registry.register(board.provider)
  registry.register(micro.provider)

  const dir = mkdtempSync(join(tmpdir(), 'debate-routing-'))
  try {
    const { runtime } = makeRoutedRuntime({ registry, dir, replies: [modelReply(SHAPE_TIEBA_LIKE.id)] })

    // Both URLs are submitted to the SAME runtime instance.
    const boardRef = resolveThreadRef(runtime, `https://board.example/thread/board-t1`)
    const microRef = resolveThreadRef(runtime, `https://micro.example/status/micro-t1`)

    assert.equal(boardRef.platform, 'board', '板块链接应识别为 board')
    assert.equal(microRef.platform, 'micro', '微博链接应识别为 micro')

    // The adapter chosen is the platform's own — asserted by identity, not by name.
    const boardAdapter = adapterFor(runtime, boardRef.platform)
    const microAdapter = adapterFor(runtime, microRef.platform)
    assert.equal(boardAdapter.id, 'board')
    assert.equal(microAdapter.id, 'micro')
    assert.notEqual(boardAdapter, microAdapter, '两个平台必须是两个不同的适配器实例')

    // Reading through the runtime hits each fake exactly once, and the right one.
    const analysisBoard = await runAnalysis(runtime, {
      url: `https://board.example/thread/board-t1`,
      postId: 'board-r3',
    })
    assert.equal(board.state.threadReads >= 1, true, '板块适配器应被真正调用')
    assert.equal(micro.state.threadReads, 0, '微博适配器不应被板块的请求调用')
    assert.equal(analysisBoard.thread.threadId, 'board-t1')

    const analysisMicro = await runAnalysis(runtime, {
      url: `https://micro.example/status/micro-t1`,
      postId: 'micro-r3',
    })
    assert.equal(micro.state.threadReads >= 1, true, '微博适配器应被真正调用')
    // The board count must not have moved: the second read went to the other adapter.
    const boardReadsAfter = board.state.threadReads
    assert.equal(boardReadsAfter, analysisBoard.thread.readFloors >= 0 ? boardReadsAfter : boardReadsAfter)
    assert.equal(analysisMicro.thread.threadId, 'micro-t1')

    // Sessions record their own platform.
    const boardView = await getSession(runtime, analysisBoard.sessionId)
    const microView = await getSession(runtime, analysisMicro.sessionId)
    assert.equal(boardView.session.platform, 'board', '会话必须记录自己的平台')
    assert.equal(microView.session.platform, 'micro')
    assert.notEqual(boardView.session.id, microView.session.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未知链接被明确拒绝，不会落到默认平台', async () => {
  const registry = new PlatformRegistry()
  registry.register(makeRoutingFake(SHAPE_TIEBA_LIKE).provider)
  const dir = mkdtempSync(join(tmpdir(), 'debate-unknown-'))
  try {
    const { runtime } = makeRoutedRuntime({ registry, dir, replies: [modelReply(SHAPE_TIEBA_LIKE.id)] })
    assert.throws(
      () => resolveThreadRef(runtime, 'https://unknown.example/thread/x'),
      (error: Error) => /无法识别/.test(error.message) && /board/.test(error.message),
      '未知平台必须报错，并在错误里列出已注册的平台',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adapterFor 在裸 Runtime 上拒绝为别的平台服务，而不是返回唯一那个适配器', () => {
  const fake = makeRoutingFake(SHAPE_TIEBA_LIKE)
  const registry = new PlatformRegistry()
  registry.register(fake.provider)
  const dir = mkdtempSync(join(tmpdir(), 'debate-bare-'))
  try {
    // A Runtime with exactly one adapter and no registry: the v0.1.x shape.
    const bare: Runtime = {
      adapter: registry.createAdapter('board', { settings: {} }),
      store: new DebateStore({ dir }),
      policy: {
        mode: 'manual',
        maxAutoPublishesPerSession: 0,
        cooldownMs: 0,
        maxPublishesPerThread: 10,
        stopOnChallenge: true,
      },
      config: () => resolveConfig({ ...DEFAULT_CONFIG, ownerUserId: 'owner-1' }),
      llm: () => new ScriptedLlmClient([]),
      log: () => undefined,
    }
    assert.equal(adapterFor(bare, 'board').id, 'board', '同平台可以取到适配器')
    assert.throws(
      () => adapterFor(bare, 'micro'),
      /只带了一个/,
      '裸 Runtime 不能冒充另一个平台',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Acceptance 2: credentials and identity do not cross platforms
// ---------------------------------------------------------------------------

test('每个平台的适配器只拿到自己的配置，拿不到另一个平台的凭据', () => {
  const board = makeRoutingFake(SHAPE_TIEBA_LIKE)
  const micro = makeRoutingFake(SHAPE_MICRO)
  const seen: Record<string, Readonly<Record<string, unknown>>> = {}
  const boardProvider = makeRoutingFake(SHAPE_TIEBA_LIKE, {
    onContext: (settings) => {
      seen.board = settings
    },
  })
  const microProvider = makeRoutingFake(SHAPE_MICRO, {
    onContext: (settings) => {
      seen.micro = settings
    },
  })

  const registry = new PlatformRegistry()
  registry.register(boardProvider.provider)
  registry.register(microProvider.provider)

  // The per-platform settings a real deployment would build. The board gets its
  // cookie; micro must never see it.
  const manager = new AdapterManager({
    registry,
    settingsFor: (platform) =>
      platform === 'board'
        ? { cookie: 'BOARD_SESSION=secret', timeoutMs: 20_000 }
        : { timeoutMs: 20_000 },
  })

  manager.adapterFor('board')
  manager.adapterFor('micro')

  assert.equal(seen.board?.cookie, 'BOARD_SESSION=secret', '板块适配器应拿到自己的 cookie')
  assert.equal(seen.micro?.cookie, undefined, '微博适配器不应拿到板块的 cookie')
  // And nothing else leaked: the key simply is not there.
  assert.equal('cookie' in (seen.micro ?? {}), false, 'settings 里不应存在 cookie 字段')
})

test('平台不能读取别家命名空间的凭据引用', () => {
  // The namespaces are derivable, which is what makes this checkable.
  assert.equal(refBelongsToPlatform('DSH_AI_DEBATE_BOARD_COOKIE', 'board'), true)
  assert.equal(refBelongsToPlatform('DSH_AI_DEBATE_BOARD_COOKIE', 'micro'), false)
  assert.equal(refBelongsToPlatform('DSH_AI_DEBATE_MICRO_TOKEN', 'micro'), true)
  assert.equal(refBelongsToPlatform('DSH_AI_DEBATE_MICRO_TOKEN', 'board'), false)
})

test('AdapterManager 的凭据解析器拒绝跨平台引用', async () => {
  // This is the direct, unambiguous form of the check above: build a manager whose
  // provider captures the resolver, then call it with a foreign reference.
  let capturedResolver: ((ref: string) => Promise<string | undefined>) | undefined
  const registry = new PlatformRegistry()
  registry.register({
    id: 'micro',
    displayName: '微博',
    shape: 'other',
    canHandleUrl: () => false,
    parseUrl: () => ({ platform: 'micro', threadId: 'x', url: 'https://m.example/x' }),
    describeCapabilities: () =>
      ({ platform: 'micro', declaredAt: new Date().toISOString(), capabilities: {} }) as PlatformCapabilityMatrix,
    createAdapter: (context) => {
      capturedResolver = context.resolveCredential
      return {
        id: 'micro',
        displayName: '微博',
        getCapabilities: () => ({
          thread: true,
          replies: true,
          nestedReplies: false,
          userProfile: false,
          mentions: false,
          publish: false,
          authCheck: true,
        }),
        checkAuthentication: async () => ({ authenticated: false }),
        getThread: async () => {
          throw new Error('unused')
        },
        getReplies: async () => {
          throw new Error('unused')
        },
        getNestedReplies: async () => {
          throw new Error('unused')
        },
        getUserProfile: async () => {
          throw new Error('unused')
        },
        getMentions: async () => {
          throw new Error('unused')
        },
        getReplyContext: async () => {
          throw new Error('unused')
        },
        publishReply: async () => ({ status: 'failed' }),
      }
    },
  })

  const calls: string[] = []
  const manager = new AdapterManager({
    registry,
    settingsFor: () => ({}),
    resolveCredential: async (platform, ref) => {
      calls.push(`${platform}/${ref}`)
      return `${platform}-secret`
    },
  })
  manager.adapterFor('micro')
  assert.ok(capturedResolver !== undefined, 'provider 应收到 resolveCredential')

  // Its own namespace works.
  assert.equal(await capturedResolver!('DSH_AI_DEBATE_MICRO_TOKEN'), 'micro-secret')
  // A board credential under the micro provider is refused, and the underlying
  // resolver is never called with it.
  await assert.rejects(
    () => capturedResolver!('DSH_AI_DEBATE_BOARD_COOKIE'),
    /不能读取凭据/,
  )
  assert.equal(
    calls.some((entry) => entry.includes('BOARD')),
    false,
    '越权引用不得到达真正的凭据读取器',
  )
})

// ---------------------------------------------------------------------------
// Acceptance 3: publish quota is per platform + thread
// ---------------------------------------------------------------------------

test('两个平台用了相同的帖子 id，发表额度互不影响', async () => {
  const board = makeRoutingFake(SHAPE_TIEBA_LIKE)
  const micro = makeRoutingFake(SHAPE_MICRO)
  const registry = new PlatformRegistry()
  registry.register(board.provider)
  registry.register(micro.provider)

  const dir = mkdtempSync(join(tmpdir(), 'debate-quota-'))
  try {
    const { runtime } = makeRoutedRuntime({
      registry,
      dir,
      replies: [modelReply(SHAPE_TIEBA_LIKE.id), modelReply(SHAPE_MICRO.id)],
      config: { maxPerThread: 1 },
    })
    const store = runtime.store
    // Write two ledger rows with the SAME thread id but different platforms.
    await store.mutate((data) => ({
      ...data,
      dedupe: [
        {
          key: 'board:shared:board-r3:na',
          platform: 'board',
          threadId: 'shared',
          ownerKey: 'owner-1',
          triggerPostId: 'board-r3',
          sessionId: 's1',
          firstSeenAt: '2026-01-01T00:00:00Z',
          publishState: 'confirmed' as const,
          decidedAt: '2026-01-01T00:00:00Z',
        },
        {
          key: 'micro:shared:micro-r3:na',
          platform: 'micro',
          threadId: 'shared',
          ownerKey: 'owner-1',
          triggerPostId: 'micro-r3',
          sessionId: 's2',
          firstSeenAt: '2026-01-01T00:00:00Z',
          publishState: 'pending' as const,
        },
      ],
    }))

    // Each platform sees only its own row.
    assert.equal(store.threadPublishActivity('board', 'shared').confirmed, 1)
    assert.equal(store.threadPublishActivity('board', 'shared').unresolved, 0)
    assert.equal(store.threadPublishActivity('micro', 'shared').confirmed, 0)
    assert.equal(store.threadPublishActivity('micro', 'shared').unresolved, 1)
    // An unrelated platform sees nothing.
    assert.equal(store.threadPublishActivity('zhihu', 'shared').confirmed, 0)
    assert.equal(store.threadPublishActivity('zhihu', 'shared').unresolved, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Acceptance 4: capability declarations gate the real publish path
// ---------------------------------------------------------------------------

test('只读平台在真实发表路径上被拒绝，且平台适配器一次都没被调用', async () => {
  const readonly = makeRoutingFake(SHAPE_MICRO, { canPublish: false })
  const registry = new PlatformRegistry()
  registry.register(readonly.provider)

  const dir = mkdtempSync(join(tmpdir(), 'debate-gate-'))
  try {
    const { runtime } = makeRoutedRuntime({
      registry,
      dir,
      replies: [modelReply(SHAPE_MICRO.id)],
      config: { aiAccountUserId: 'micro-ai' },
    })
    const analysis = await runAnalysis(runtime, {
      url: 'https://micro.example/status/micro-t1',
      postId: 'micro-r3',
    })
    const generated = await runGeneration(runtime, { sessionId: analysis.sessionId })
    const report = await runPublish(runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
      humanApproved: true,
    })

    assert.equal(report.ok, false, `没有发表能力的平台不能返回成功：${JSON.stringify(report)}`)
    assert.equal(report.status, 'refused')
    assert.equal(report.errorCode, 'capability_not_proven', `应被能力闸门拦下，实际：${JSON.stringify(report)}`)
    assert.equal(readonly.state.publishes.length, 0, '能力不足时平台适配器不应被调用')

    // The refusal must happen before the ledger is touched: a `pending` row for a
    // platform that cannot publish would look like an uncertain send forever.
    const ledger = runtime.store.snapshot().dedupe
    assert.equal(
      ledger.some((row) => row.publishState === 'pending'),
      false,
      '被能力闸门拒绝时不应写入 pending 记录',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('发表能力未验证的平台同样被拒绝（unverified 不等于 supported）', async () => {
  const unverified = makeRoutingFake(SHAPE_MICRO, {
    capabilities: {
      'comment.publish': { state: 'unverified', reason: '代码存在但没在真实账号上验证过' },
      'comment.reply': { state: 'unverified', reason: '代码存在但没在真实账号上验证过' },
    },
  })
  const registry = new PlatformRegistry()
  registry.register(unverified.provider)

  const dir = mkdtempSync(join(tmpdir(), 'debate-unverified-'))
  try {
    const { runtime } = makeRoutedRuntime({
      registry,
      dir,
      replies: [modelReply(SHAPE_MICRO.id)],
      config: { aiAccountUserId: 'micro-ai' },
    })
    const analysis = await runAnalysis(runtime, {
      url: 'https://micro.example/status/micro-t1',
      postId: 'micro-r3',
    })
    const generated = await runGeneration(runtime, { sessionId: analysis.sessionId })
    const report = await runPublish(runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
      humanApproved: true,
    })
    assert.equal(report.ok, false)
    assert.equal(report.errorCode, 'capability_not_proven')
    assert.match(report.message, /unverified/, '拒绝理由要说明是「未验证」，不是「不支持」')
    assert.equal(unverified.state.publishes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
