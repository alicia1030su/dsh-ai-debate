/**
 * Cross-platform contract tests.
 *
 * The point of this file is the v0.2.0 acceptance criterion, stated as code:
 *
 *   **Adding a read-only simulated platform must not require editing Runtime,
 *   Publisher, Generator or Analyzer.**
 *
 * So `FakePlatformA` and `FakePlatformB` below are built only from the public
 * platform contract in `lib/platforms/contracts.js`. They know nothing about
 * Tieba, import nothing from `lib/platforms/tieba/`, and use their own id
 * namespace, their own URL syntax, their own id scheme, their own pagination
 * size and their own reply nesting depth. Then the *same* core functions
 * (`runAnalysis` → `runGeneration` → `runPublish` → read-back) are driven over
 * both of them.
 *
 * If any test here needed `if (platform === 'tieba')` in the core, the
 * decoupling would have failed — the whole file is the check for that.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { runAnalysis, runGeneration, runPublish, getSession, type Runtime } from '../lib/runtime.js'
import { PlatformRegistry } from '../lib/platforms/registry.js'
import {
  PermissionRequiredError,
  UnsupportedCapabilityError,
  matrixFromLegacy,
  stateOf,
  type CapabilityName,
  type PlatformContext,
  type PlatformProvider,
} from '../lib/platforms/contracts.js'
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
// A shared fake platform, parameterized so two instances differ structurally
// ---------------------------------------------------------------------------

/** How one fake platform behaves. Everything that varies lives here. */
interface FakePlatformShape {
  readonly id: string
  readonly displayName: string
  readonly host: string
  /** Path segment before the thread id, e.g. `/p/` or `/status/`. */
  readonly pathPrefix: string
  /** Floors/comments per page. The two fakes use different sizes on purpose. */
  readonly pageSize: number
  /** Replies per nested page. */
  readonly nestedPageSize: number
  /** Whether `comment.nested` is usable. */
  readonly supportsNested: boolean
  /** Whether publishing is allowed at all. */
  readonly canPublish: boolean
  /** Prefix for generated post ids, so two fakes cannot collide. */
  readonly idPrefix: string
  /** The account this platform reports as logged in. */
  readonly account: { userId: string; userName: string }
}

/** One synthetic conversation, in platform-neutral terms. */
interface FakeConversation {
  readonly thread: Thread
  readonly floors: readonly Floor[]
  readonly nested: Readonly<Record<string, readonly NestedReply[]>>
}

/**
 * Build a fake platform: a provider, plus an adapter that behaves like a real
 * one (paging, publish then read-back, honest capability errors).
 */
function makeFakePlatform(shape: FakePlatformShape, conversation: FakeConversation): {
  provider: PlatformProvider
  adapter: PlatformAdapter
  published: { target: PublishTarget; content: string }[]
  pagesRead: number
} {
  const published: { target: PublishTarget; content: string }[] = []
  /** Replies this fake has "posted", so a read-back finds them. */
  const posted: NestedReply[] = []
  let pagesRead = 0

  const adapter: PlatformAdapter = {
    id: shape.id,
    displayName: shape.displayName,

    getCapabilities() {
      return {
        thread: true,
        replies: true,
        nestedReplies: shape.supportsNested,
        userProfile: false,
        mentions: false,
        publish: shape.canPublish,
        authCheck: true,
      }
    },

    async checkAuthentication(): Promise<AuthState> {
      return { authenticated: true, userId: shape.account.userId, userName: shape.account.userName }
    },

    async getThread(): Promise<Thread> {
      return conversation.thread
    },

    async getReplies(ref: ThreadRef, page: number): Promise<ReplyPage> {
      pagesRead += 1
      assert.equal(ref.platform, shape.id, '重算时必须带上正确的平台 id')
      const start = (page - 1) * shape.pageSize
      const slice = conversation.floors.slice(start, start + shape.pageSize)
      const declaredTotalPages = Math.max(1, Math.ceil(conversation.floors.length / shape.pageSize))
      return {
        floors: slice,
        page,
        hasMore: page < declaredTotalPages,
        declaredTotalPages,
        declaredTotal: conversation.floors.length,
      }
    },

    async getNestedReplies(ref: ThreadRef, floor: Floor, page: number): Promise<NestedPage> {
      assert.equal(ref.platform, shape.id)
      if (!shape.supportsNested) {
        // A platform that genuinely cannot do this answers honestly rather than
        // returning an empty page that would read as "there are no replies".
        throw new UnsupportedCapabilityError(shape.id, 'comment.nested')
      }
      const all = conversation.nested[floor.postId] ?? []
      const start = (page - 1) * shape.nestedPageSize
      const slice = all.slice(start, start + shape.nestedPageSize)
      const totalPages = Math.max(1, Math.ceil(all.length / shape.nestedPageSize))
      return {
        replies: slice,
        page,
        hasMore: page < totalPages,
        declaredTotalPages: totalPages,
        declaredTotal: all.length,
      }
    },

    async getUserProfile(): Promise<UserProfile> {
      throw new Error('测试平台不提供用户资料')
    },

    async getMentions(): Promise<readonly Mention[]> {
      throw new Error('测试平台不提供艾特通知')
    },

    async getReplyContext(
      ref: ThreadRef,
      postId: string,
      _signal?: AbortSignal,
      options?: { forceFresh?: boolean },
    ): Promise<ReplyContext> {
      assert.equal(ref.platform, shape.id)
      assert.equal(options?.forceFresh, true, '发布与回读必须绕过缓存')
      const thread = conversation.thread
      const floor = conversation.floors.find((entry) => entry.postId === postId)
      if (floor) return { thread, floor, ancestors: [], siblings: [] }
      const mine = posted.find((entry) => entry.postId === postId)
      if (mine) {
        const parent = conversation.floors.find((entry) => entry.postId === mine.parentPostId)!
        return { thread, floor: parent, nested: mine, ancestors: [], siblings: posted }
      }
      for (const candidate of conversation.floors) {
        const nested = conversation.nested[candidate.postId] ?? []
        const target = nested.find((entry) => entry.postId === postId)
        if (target) {
          return { thread, floor: candidate, nested: target, ancestors: [], siblings: nested }
        }
      }
      throw new Error(`找不到回复 ${postId}`)
    },

    async publishReply(
      ref: ThreadRef,
      target: PublishTarget,
      content: string,
    ): Promise<PublishOutcome> {
      assert.equal(ref.platform, shape.id)
      published.push({ target, content })
      const postId = `${shape.idPrefix}-new-${published.length}`
      posted.push({
        platform: shape.id,
        postId,
        parentPostId: target.floorPostId ?? conversation.floors[0]!.postId,
        ...(target.nestedReplyId ? { replyToPostId: target.nestedReplyId } : {}),
        authorId: shape.account.userId,
        authorName: shape.account.userName,
        content,
      })
      return { status: 'confirmed', postId }
    },
  }

  const provider: PlatformProvider = {
    id: shape.id,
    displayName: shape.displayName,
    shape: 'other',
    canHandleUrl(url: string): boolean {
      if (typeof url !== 'string') return false
      const raw = url.trim()
      if (raw.length === 0) return false
      if (new RegExp(`^${shape.id}:`).test(raw)) return true
      try {
        const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
        return parsed.hostname === shape.host
      } catch {
        return false
      }
    },
    parseUrl(url: string): ThreadRef {
      const raw = url.trim()
      // This platform's second URL syntax: `<id>:<threadId>`. Deliberately not a
      // URL at all, to prove the registry does not assume http(s).
      const prefixed = new RegExp(`^${shape.id}:([^\\s/?#]+)`).exec(raw)
      if (prefixed) {
        return { platform: shape.id, threadId: prefixed[1]!, url: raw }
      }
      const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
      // `[^/?#]+` rather than `\w+`: this platform's ids contain dashes, and a
      // parser that quietly truncated them would read the wrong thread.
      const found = new RegExp(`${shape.pathPrefix}([^/?#]+)`).exec(parsed.pathname)
      if (!found) throw new Error(`${shape.displayName} 链接里没有帖子 id：${raw}`)
      const postId = parsed.searchParams.get('c') ?? undefined
      return {
        platform: shape.id,
        threadId: found[1]!,
        url: `https://${shape.host}${shape.pathPrefix}${found[1]}`,
        ...(postId === undefined ? {} : { postId }),
      }
    },
    describeCapabilities() {
      return matrixFromLegacy(shape.id, {
        thread: true,
        replies: true,
        nestedReplies: shape.supportsNested,
        userProfile: false,
        mentions: false,
        publish: shape.canPublish,
        authCheck: true,
      })
    },
    createAdapter(_context: PlatformContext): PlatformAdapter {
      return adapter
    },
  }

  return {
    provider,
    adapter,
    published,
    get pagesRead() {
      return pagesRead
    },
  }
}

/** Build a conversation with `floorCount` comments, one of which holds replies. */
function makeConversation(
  shape: FakePlatformShape,
  floorCount: number,
  threadIdOverride?: string,
): FakeConversation {
  const threadId = threadIdOverride ?? `${shape.id}-thread-1`
  const floors: Floor[] = []
  for (let index = 1; index <= floorCount; index += 1) {
    floors.push({
      platform: shape.id,
      // A fake platform has no floor numbers in the Tieba sense; the field still
      // exists because the core sorts by it, but it is the platform's own order.
      floorNumber: index,
      postId: `${shape.id}-c${index}`,
      authorId: index === 1 ? 'host-1' : `user-${index}`,
      authorName: index === 1 ? '楼主' : `用户${index}`,
      content: `第 ${index} 条发言。`,
      createdAt: '2024-1-1',
      images: [],
    })
  }
  const floorPostId = floors[0]!.postId
  const nested: NestedReply[] = [
    {
      platform: shape.id,
      postId: `${shape.id}-r1`,
      parentPostId: floorPostId,
      authorId: 'owner-1',
      authorName: '主人',
      content: '这个方案我认为不可行，成本会翻倍。',
    },
    {
      platform: shape.id,
      postId: `${shape.id}-r2`,
      parentPostId: floorPostId,
      authorId: 'opp-1',
      authorName: '对手B',
      content: '你凭什么说成本会翻倍？有数据吗？',
      replyToName: '主人',
    },
    {
      platform: shape.id,
      postId: `${shape.id}-r3`,
      parentPostId: floorPostId,
      authorId: 'owner-1',
      authorName: '主人',
      content: '前面贴过报价了，翻倍是按去年两次采购价算的。',
      replyToName: '对手B',
    },
  ]
  // The collector only fetches nested replies for floors whose `nestedCount` says
  // they have some — the platform's own count is what it pages against. A fake
  // that omits it is not exercising the real path.
  floors[0] = { ...floors[0]!, nestedCount: shape.supportsNested ? nested.length : 0 }
  return {
    thread: {
      platform: shape.id,
      forum: { platform: shape.id, id: '1', name: '测试版块' },
      id: threadId,
      title: '测试主题：这个方案到底能不能上',
      content: '大家看看这个方案值不值得做。',
      authorId: 'host-1',
      authorName: '楼主',
      createdAt: '2024-1-1',
      url: `https://${shape.host}${shape.pathPrefix}${threadId}`,
      declaredReplyCount: floorCount,
      images: [],
    },
    floors,
    nested: { [floorPostId]: nested },
  }
}

/** Two fakes that differ in every structural dimension the core could assume. */
const SHAPE_A: FakePlatformShape = {
  id: 'fakea',
  displayName: '假平台A',
  host: 'a.example',
  pathPrefix: '/topic/',
  pageSize: 3,
  nestedPageSize: 2,
  supportsNested: true,
  canPublish: true,
  idPrefix: 'a',
  account: { userId: 'a-ai-1', userName: 'A小号' },
}

const SHAPE_B: FakePlatformShape = {
  id: 'fakeb',
  displayName: '假平台B',
  host: 'b.example',
  pathPrefix: '/post/',
  pageSize: 7,
  nestedPageSize: 5,
  supportsNested: true,
  canPublish: true,
  idPrefix: 'b',
  account: { userId: 'b-ai-1', userName: 'B小号' },
}

/** Build a runtime over one registered fake platform. */
function makeRuntime(input: {
  platform: ReturnType<typeof makeFakePlatform>
  registry: PlatformRegistry
  replies: string[]
}): { runtime: Runtime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'debate-contract-'))
  const store = new DebateStore({ dir })
  // The scripted client returns whole model responses, so the text has to be
  // wrapped the way the real API would.
  const client = new ScriptedLlmClient(input.replies.map((text) => ({ text })))
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    ownerUserId: 'owner-1',
    aiAccountUserId:
      input.platform.adapter.id === SHAPE_A.id ? SHAPE_A.account.userId : SHAPE_B.account.userId,
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
  })
  const runtime: Runtime = {
    adapter: input.platform.adapter,
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
    },
  }
  return { runtime, dir }
}

/** A model answer aimed at the fake conversation's opponent. */
function modelReply(postId: string): string {
  return JSON.stringify({
    status: 'ok',
    owner_position: '成本会翻倍',
    opponent_position: '缺少依据',
    main_dispute: '成本问题',
    latest_argument: '你凭什么说成本会翻倍',
    response_target_id: postId,
    strategy: 'demand_evidence',
    confidence: 0.8,
    uncertainties: [],
    reply: '前面已经把报价贴出来了，要反驳就拿出同型号的价格。',
  })
}

// ---------------------------------------------------------------------------
// Contract: the registry
// ---------------------------------------------------------------------------

test('两个假平台可以同时注册，并各自解析自己的链接', () => {
  const a = makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 5))
  const b = makeFakePlatform(SHAPE_B, makeConversation(SHAPE_B, 5))
  const registry = new PlatformRegistry()
  registry.register(a.provider)
  registry.register(b.provider)

  assert.deepEqual(registry.listIds(), ['fakea', 'fakeb'])
  assert.equal(registry.resolveFromUrl('https://a.example/topic/xyz')?.id, 'fakea')
  assert.equal(registry.resolveFromUrl('https://b.example/post/xyz')?.id, 'fakeb')
  // The non-URL syntax only platform A accepts.
  assert.equal(registry.resolveFromUrl('fakea:xyz')?.id, 'fakea')
  // Neither platform claims a stranger's URL.
  assert.equal(registry.resolveFromUrl('https://c.example/x'), undefined)
})

test('没有平台认领链接时抛出的错误列出了已注册的平台', () => {
  const registry = new PlatformRegistry()
  registry.register(makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 3)).provider)
  assert.throws(
    () => registry.parseUrl('https://unknown.example/p/1'),
    (error: Error) => {
      assert.match(error.message, /无法识别/)
      assert.match(error.message, /fakea/, '错误里应列出已注册平台，否则用户无从修正')
      return true
    },
  )
})

test('重复注册同一个 id 会被拒绝，而不是静默替换处理器', () => {
  const registry = new PlatformRegistry()
  registry.register(makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 2)).provider)
  assert.throws(
    () => registry.register(makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 2)).provider),
    /已经注册过/,
  )
  // The original is untouched.
  assert.equal(registry.listIds().length, 1)
})

test('注销后链接不再被认领，且注销是幂等的', () => {
  const registry = new PlatformRegistry()
  const disposer = registry.register(makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 2)).provider)
  assert.notEqual(registry.resolveFromUrl('https://a.example/topic/x'), undefined)
  disposer()
  assert.equal(registry.resolveFromUrl('https://a.example/topic/x'), undefined)
  // Running the disposer twice must not throw: a failed mount can run it twice.
  disposer()
  assert.equal(registry.unregister('fakea'), false)
})

test('一个平台的 canHandleUrl 抛错不影响另一个平台解析', () => {
  const registry = new PlatformRegistry()
  registry.register({
    ...makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 2)).provider,
    canHandleUrl: () => {
      throw new Error('故意炸掉')
    },
  })
  registry.register(makeFakePlatform(SHAPE_B, makeConversation(SHAPE_B, 2)).provider)
  // A throws, B still answers.
  assert.equal(registry.resolveFromUrl('https://b.example/post/xyz')?.id, 'fakeb')
})

test('注册中心不允许空 id', () => {
  const registry = new PlatformRegistry()
  assert.throws(() => registry.register({ ...makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 1)).provider, id: '  ' }), /不能为空/)
})

// ---------------------------------------------------------------------------
// Contract: capabilities
// ---------------------------------------------------------------------------

test('legacy 布尔能力一律转成 unverified，不会凭空变成 supported', () => {
  // The old model said `publish: true` and nothing else. Upgrading that to
  // `supported` would be inventing evidence.
  const matrix = matrixFromLegacy('x', {
    thread: true,
    replies: true,
    nestedReplies: true,
    userProfile: false,
    mentions: false,
    publish: true,
    authCheck: true,
  })
  assert.equal(stateOf(matrix, 'comment.publish').state, 'unverified')
  assert.equal(stateOf(matrix, 'thread.read').state, 'unverified')
  assert.equal(stateOf(matrix, 'event.mentions').state, 'unavailable')
  assert.equal(stateOf(matrix, 'user.profile').state, 'unavailable')
})

test('未声明的能力按 unavailable 处理，而不是当成可用', () => {
  const matrix = matrixFromLegacy('x', {
    thread: true,
    replies: true,
    nestedReplies: true,
    userProfile: false,
    mentions: false,
    publish: true,
    authCheck: true,
  })
  // `media.read` is never set by the legacy bridge for a true flag, and asking
  // for an unknown name must not silently succeed.
  assert.equal(stateOf(matrix, 'media.read').state, 'unavailable')
  assert.equal(stateOf(matrix, 'media.read' as CapabilityName).state, 'unavailable')
})

test('assertCapability 对 unverified 发帖能力 fail-closed', () => {
  const platform = makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 3))
  const registry = new PlatformRegistry()
  // A provider that declares publish but only as legacy `true` → unverified.
  registry.register(platform.provider)
  assert.throws(
    () => registry.assertCapability('fakea', 'comment.publish'),
    (error: Error) => error instanceof UnsupportedCapabilityError && /unverified/.test(error.message),
  )
})

test('声明 permission_required 的能力抛出 PermissionRequiredError 并带上所需权限', () => {
  const registry = new PlatformRegistry()
  registry.register({
    ...makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 2)).provider,
    describeCapabilities: () => ({
      platform: 'fakea',
      declaredAt: new Date().toISOString(),
      capabilities: {
        ...matrixFromLegacy('fakea', {
          thread: true,
          replies: true,
          nestedReplies: true,
          userProfile: false,
          mentions: false,
          publish: false,
          authCheck: true,
        }).capabilities,
        'comment.publish': {
          state: 'permission_required' as const,
          reason: '需要开放平台写权限',
          requiredPermissions: ['write_comment'],
        },
      } as never,
    }),
  })
  assert.throws(
    () => registry.assertCapability('fakea', 'comment.publish'),
    (error: Error) =>
      error instanceof PermissionRequiredError &&
      error.requiredPermissions.includes('write_comment'),
  )
})

test('能力矩阵出现在注册中心诊断里，且状态没被抹平成布尔', () => {
  const registry = new PlatformRegistry()
  registry.register(makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 2)).provider)
  const diagnostics = registry.diagnostics()
  assert.equal(diagnostics.platforms.length, 1)
  const row = diagnostics.platforms[0]!
  assert.equal(row.id, 'fakea')
  assert.equal(row.order, 0)
  assert.ok(row.capabilities.capabilities['thread.read'], '每一项能力都要有状态与原因')
  assert.equal(row.capabilities.capabilities['thread.read'].state, 'unverified')
})

test('坏掉的 provider 不会阻止其它平台注册', () => {
  const registry = new PlatformRegistry()
  registry.register(makeFakePlatform(SHAPE_A, makeConversation(SHAPE_A, 2)).provider)
  // Simulate a future platform whose factory throws at registration time.
  const broken: PlatformProvider = {
    ...makeFakePlatform(SHAPE_B, makeConversation(SHAPE_B, 2)).provider,
    createAdapter: () => {
      throw new Error('构造失败')
    },
  }
  // Registration itself succeeds (the factory is lazy); it must not take A down.
  registry.register(broken)
  assert.equal(registry.listIds().length, 2)
  assert.equal(registry.resolveFromUrl('https://a.example/topic/x')?.id, 'fakea')
})

// ---------------------------------------------------------------------------
// Contract: the full pipeline over two structurally different platforms
// ---------------------------------------------------------------------------

test('假平台A：读取 → 分析 → 生成 → 发表 → 回读 全链路走通用核心', async () => {
  const shape = SHAPE_A
  const conversation = makeConversation(shape, 5)
  const platform = makeFakePlatform(shape, conversation)
  const registry = new PlatformRegistry()
  registry.register(platform.provider)
  const { runtime, dir } = makeRuntime({
    platform,
    registry,
    replies: [modelReply(`${shape.id}-r2`)],
  })
  try {
    const analysis = await runAnalysis(runtime, {
      url: `https://${shape.host}${shape.pathPrefix}${conversation.thread.id}`,
      postId: `${shape.id}-r3`,
    })
    assert.equal(analysis.sessionId.length > 0, true)
    assert.equal(analysis.thread.threadId, conversation.thread.id, '帖子 id 应来自该平台自己的解析器')
    assert.equal(analysis.dispute.owner.displayName, '主人')

    const generated = await runGeneration(runtime, {
      sessionId: analysis.sessionId,
      humanApproved: false,
    })
    assert.equal(generated.text.length > 0, true, '生成阶段必须产出正文')

    const report = await runPublish(runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
      humanApproved: true,
    })
    assert.equal(report.ok, true, report.message)
    assert.equal(report.status, 'published')
    assert.equal(platform.published.length, 1, '平台应当只被调用一次')
    assert.equal(platform.published[0]!.target.platform, shape.id)

    const view = await getSession(runtime, analysis.sessionId)
    assert.equal(view.session.state, 'PUBLISHED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('假平台B：同一套核心、不同分页与 id 方案，全链路同样走通', async () => {
  const shape = SHAPE_B
  const conversation = makeConversation(shape, 9)
  const platform = makeFakePlatform(shape, conversation)
  const registry = new PlatformRegistry()
  registry.register(platform.provider)
  const { runtime, dir } = makeRuntime({
    platform,
    registry,
    replies: [modelReply(`${shape.id}-r2`)],
  })
  try {
    const analysis = await runAnalysis(runtime, {
      url: `https://${shape.host}${shape.pathPrefix}${conversation.thread.id}`,
      postId: `${shape.id}-r3`,
    })
    // 9 floors at 7 per page: the walk must have paged, not stopped at page 1.
    assert.equal(analysis.thread.readFloors, 9, '必须读完所有页，而不是只看第一页')
    assert.equal(platform.pagesRead >= 2, true, `应至少读 2 页，实际 ${platform.pagesRead}`)

    const generated = await runGeneration(runtime, {
      sessionId: analysis.sessionId,
      humanApproved: false,
    })
    const report = await runPublish(runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
      humanApproved: true,
    })
    assert.equal(report.ok, true, report.message)
    assert.equal(platform.published.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两个平台的相同帖子 id 不冲突：去重记录按平台隔离', async () => {
  // The collision case: both platforms use the identical literal thread id, so
  // only the platform column can tell the two ledger rows apart.
  const sharedThreadId = 'same-thread-id'
  const conversationA = makeConversation(SHAPE_A, 3, sharedThreadId)
  const conversationB = makeConversation(SHAPE_B, 3, sharedThreadId)
  assert.equal(conversationA.thread.id, conversationB.thread.id, '两个平台的帖子 id 在字面上相同')
  const a = makeFakePlatform(SHAPE_A, conversationA)
  const b = makeFakePlatform(SHAPE_B, conversationB)
  const registry = new PlatformRegistry()
  registry.register(a.provider)
  registry.register(b.provider)

  const { runtime: runtimeA, dir: dirA } = makeRuntime({
    platform: a,
    registry,
    replies: [modelReply(`${SHAPE_A.id}-r2`)],
  })
  const { runtime: runtimeB, dir: dirB } = makeRuntime({
    platform: b,
    registry,
    replies: [modelReply(`${SHAPE_B.id}-r2`)],
  })
  try {
    const analysisA = await runAnalysis(runtimeA, {
      url: `https://${SHAPE_A.host}${SHAPE_A.pathPrefix}${sharedThreadId}`,
      postId: `${SHAPE_A.id}-r3`,
    })
    const analysisB = await runAnalysis(runtimeB, {
      url: `https://${SHAPE_B.host}${SHAPE_B.pathPrefix}${sharedThreadId}`,
      postId: `${SHAPE_B.id}-r3`,
    })
    // Different sessions even though every visible id matched.
    assert.notEqual(analysisA.sessionId, analysisB.sessionId)
    assert.equal(analysisA.thread.threadId, analysisB.thread.threadId)

    const dedupeA = runtimeA.store.snapshot().dedupe
    const dedupeB = runtimeB.store.snapshot().dedupe
    assert.equal(dedupeA.length, 1)
    assert.equal(dedupeB.length, 1)
    assert.equal(dedupeA[0]!.platform, SHAPE_A.id)
    assert.equal(dedupeB[0]!.platform, SHAPE_B.id)
    // The keys therefore differ even though the thread id is identical.
    assert.notEqual(dedupeA[0]!.key, dedupeB[0]!.key)
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('没有发布能力的平台在读阶段正常，发表阶段被拒绝而不是假装成功', async () => {
  const shape: FakePlatformShape = { ...SHAPE_A, id: 'readonly', displayName: '只读平台', canPublish: false }
  const conversation = makeConversation(shape, 3)
  const platform = makeFakePlatform(shape, conversation)
  const registry = new PlatformRegistry()
  registry.register(platform.provider)
  const { runtime, dir } = makeRuntime({
    platform,
    registry,
    replies: [modelReply('readonly-r2')],
  })
  try {
    const analysis = await runAnalysis(runtime, {
      url: `https://${shape.host}${shape.pathPrefix}${conversation.thread.id}`,
      postId: 'readonly-r3',
    })
    assert.equal(analysis.sessionId.length > 0, true, '只读平台的读分析必须工作')

    // The platform truly cannot publish, so legacy `publish:false` → unavailable.
    assert.equal(platform.adapter.getCapabilities().publish, false)
    assert.equal(stateOf(platform.provider.describeCapabilities(), 'comment.publish').state, 'unavailable')

    const generated = await runGeneration(runtime, {
      sessionId: analysis.sessionId,
      humanApproved: false,
    })
    const report = await runPublish(runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
      humanApproved: true,
    })
    assert.equal(report.ok, false, '没有发布能力时不能返回成功')
    assert.equal(report.status, 'refused', `拒绝才算数，实际是 ${report.status}`)
    assert.equal(platform.published.length, 0, '平台适配器不应被调用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('核心代码里没有平台名字：runtime/publisher/generator/analyzer 都不 import 贴吧', async () => {
  // This is the acceptance criterion expressed as a static check. Reading the
  // compiled output is the only way to prove the *absence* of a dependency, and
  // the check is deliberately about import specifiers and platform literals —
  // not about the word "tieba" appearing in a comment, which is documentation
  // rather than coupling.
  const { readFileSync } = await import('node:fs')
  const { join: joinPath } = await import('node:path')
  const root = joinPath(import.meta.dirname, '..', 'lib')
  const coreFiles = [
    'runtime.js',
    'publisher.js',
    'generator.js',
    'analyzer.js',
    'collector.js',
    'target.js',
  ]
  for (const file of coreFiles) {
    const text = readFileSync(joinPath(root, file), 'utf8')
    // Strip comments first: a doc comment explaining the boundary must not fail
    // the boundary check.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\s\/\/\s.*$/gm, '')
    assert.equal(
      /from\s+['"][^'"]*platforms\/tieba/.test(code),
      false,
      `${file} 不能 import 贴吧实现：平台解耦失败`,
    )
    assert.equal(
      /platform:\s*['"]tieba['"]/.test(code),
      false,
      `${file} 不能写死 platform: 'tieba'：平台解耦失败`,
    )
    assert.equal(
      /(id|platformId)\s*===\s*['"]tieba['"]/.test(code),
      false,
      `${file} 不能对贴吧做特判：平台解耦失败`,
    )
  }
})
