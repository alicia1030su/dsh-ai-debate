/**
 * Test helpers: a fake Tieba adapter backed by real captured pages.
 *
 * The point of this file is that tests never invent platform data. Where a
 * scenario needs a synthetic thread (500 floors, a three-person argument), the
 * fixture is generated from the *same parsed structures* the live adapter
 * produces, so the code under test sees exactly the shapes it will see in
 * production.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  AuthState,
  Floor,
  Mention,
  NestedPage,
  NestedReply,
  PlatformCapabilities,
  PlatformAdapter,
  PublishOutcome,
  PublishTarget,
  ReplyContext,
  ReplyPage,
  Thread,
  ThreadRef,
  UserProfile,
} from '../lib/types.js'
import { parseWapFloors, parseWapPageMeta, parseWapThreadMeta } from '../lib/platforms/tieba/parse.js'

/** Root of the captured fixtures. */
export const FIXTURES = join(import.meta.dirname, 'fixtures')

/** Read a fixture as UTF-8. */
export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/** Read a fixture as raw bytes. */
export function fixtureBytes(name: string): Uint8Array {
  return readFileSync(join(FIXTURES, name))
}

/** Read one captured pagination page. */
export function pagedPage(page: number): string {
  return fixture(join('paged', `page-${page}.html`))
}

/** The captured thread's paging metadata. */
export function pagedMeta(): { tid: string; totalPages: number; totalNum: number } {
  return JSON.parse(fixture(join('paged', 'meta.json'))) as {
    tid: string
    totalPages: number
    totalNum: number
  }
}

/** A thread built from the real captured pages. */
export function realThread(): { thread: Thread; floors: readonly Floor[]; totalPages: number } {
  const html = pagedPage(1)
  const meta = parseWapThreadMeta(html)
  const pageMeta = parseWapPageMeta(html)
  const parsed = parseWapFloors(html)
  const first = parsed[0]!.floor
  return {
    thread: {
      platform: 'tieba',
      forum: { platform: 'tieba', id: meta.forumId, name: meta.forumName ?? '未知贴吧' },
      id: pagedMeta().tid,
      title: meta.title ?? '',
      content: first.content,
      authorId: first.authorId,
      authorName: first.authorName,
      createdAt: first.createdAt,
      url: `https://tieba.baidu.com/p/${pagedMeta().tid}`,
      declaredReplyCount: pageMeta.totalCount,
      images: first.images,
    },
    floors: parsed.map((entry) => entry.floor),
    totalPages: pageMeta.totalPages ?? 1,
  }
}

/** Build a synthetic floor. */
export function makeFloor(input: {
  floorNumber: number
  postId: string
  authorId: string
  authorName: string
  content: string
  createdAt?: string
  nestedCount?: number
}): Floor {
  return {
    platform: 'tieba',
    floorNumber: input.floorNumber,
    postId: input.postId,
    authorId: input.authorId,
    authorName: input.authorName,
    content: input.content,
    createdAt: input.createdAt ?? '2024-1-1',
    images: [],
    nestedCount: input.nestedCount,
  }
}

/** Build a synthetic nested reply. */
export function makeNested(input: {
  postId: string
  parentPostId: string
  authorId: string
  authorName: string
  content: string
  replyToName?: string
  createdAt?: string
}): NestedReply {
  return {
    platform: 'tieba',
    postId: input.postId,
    parentPostId: input.parentPostId,
    authorId: input.authorId,
    authorName: input.authorName,
    replyToName: input.replyToName,
    content: input.content,
    createdAt: input.createdAt ?? '2024-1-1',
  }
}

/** A fully in-memory adapter, for pipeline tests. */
export class FakeAdapter implements PlatformAdapter {
  readonly id = 'tieba' as const
  readonly displayName = '百度贴吧（测试）'

  constructor(
    private readonly data: {
      thread: Thread
      /** Additional threads this fake can resolve, for cross-thread tests. */
      extraThreads?: readonly Thread[]
      floors: readonly Floor[]
      nested?: Readonly<Record<string, readonly NestedReply[]>>
      /** Pages returned before a fake error, to test partial reads. */
      failAtPage?: number
      /** Declared total, when it should differ from what is readable. */
      declaredTotal?: number
      /**
       * Make every nested page declare itself incomplete, as the inlined-copy
       * fallback does when the paginated endpoint is rate-limited.
       */
      nestedDegraded?: boolean
      auth?: AuthState
      publish?: (target: PublishTarget, content: string) => PublishOutcome
    },
  ) {}

  /** Records every publish attempt, so tests can assert on counts. */
  readonly publishes: { target: PublishTarget; content: string }[] = []
  /** Number of floor pages read, to assert pagination actually happened. */
  pagesRead = 0
  /**
   * Replies this fake has "posted", so a read-back finds them.
   *
   * The previous fake returned a post id without adding anything to the thread, so the
   * read-back verification could never succeed against it — the fake was less capable
   * than the platform. Recording published replies makes it behave like one: `publish`
   * then `getReplyContext` returns what was sent.
   */
  private readonly posted: NestedReply[] = []

  getCapabilities(): PlatformCapabilities {
    return {
      thread: true,
      replies: true,
      nestedReplies: true,
      userProfile: false,
      mentions: false,
      publish: true,
      authCheck: true,
    }
  }

  async checkAuthentication(): Promise<AuthState> {
    return this.data.auth ?? { authenticated: true, userId: '1001', userName: 'ai-account' }
  }

  async getThread(): Promise<Thread> {
    return this.data.thread
  }

  async getReplies(ref: ThreadRef, page: number): Promise<ReplyPage> {
    this.pagesRead += 1
    if (this.data.failAtPage !== undefined && page >= this.data.failAtPage) {
      throw new Error(`模拟第 ${page} 页读取失败`)
    }
    const pageSize = 30
    const start = (page - 1) * pageSize
    const slice = this.data.floors.slice(start, start + pageSize)
    const declaredTotalPages = Math.ceil(this.data.floors.length / pageSize)
    return {
      floors: slice,
      page,
      hasMore: page < declaredTotalPages,
      declaredTotalPages,
      // Real platforms declare the thread's full floor count, which can exceed
      // what is readable when floors were deleted. Tests rely on this to prove
      // the gap is reported rather than hidden.
      declaredTotal: this.data.declaredTotal ?? this.data.floors.length,
    }
  }

  async getNestedReplies(ref: ThreadRef, floor: Floor, page: number): Promise<NestedPage> {
    const all = this.data.nested?.[floor.postId] ?? []
    if (all.length === 0) {
      // A floor the platform says has replies but which the fake has none for:
      // an empty page with no more, exactly what a deleted-comment floor gives.
      return { replies: [], page, hasMore: false, declaredTotal: 0, declaredTotalPages: 0 }
    }
    const pageSize = 9
    const start = (page - 1) * pageSize
    const slice = all.slice(start, start + pageSize)
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize))
    return {
      replies: slice,
      page,
      hasMore: page < totalPages,
      declaredTotalPages: totalPages,
      declaredTotal: all.length,
      ...(this.data.nestedDegraded ? { incomplete: true } : {}),
    }
  }

  async getUserProfile(): Promise<UserProfile> {
    throw new Error('测试适配器不提供用户资料')
  }

  async getMentions(): Promise<readonly Mention[]> {
    throw new Error('测试适配器不提供艾特通知')
  }

  async getReplyContext(ref: ThreadRef, postId: string): Promise<ReplyContext> {
    // A fake may hold several threads; resolve against the one asked for so a
    // target read for thread B does not silently return thread A.
    const thread =
      this.data.thread.id === ref.threadId
        ? this.data.thread
        : this.data.extraThreads?.find((entry) => entry.id === ref.threadId)
    if (!thread) throw new Error(`找不到帖子 ${ref.threadId}`)
    const floor = this.data.floors.find((entry) => entry.postId === postId)
    if (floor) return { thread, floor, ancestors: [], siblings: [] }
    // Replies this fake posted come first: a just-published reply must be readable,
    // which is what the real platform does.
    const posted = this.posted.find((entry) => entry.postId === postId)
    if (posted) {
      const parent = this.data.floors.find((entry) => entry.postId === posted.parentPostId)!
      return { thread, floor: parent, nested: posted, ancestors: [], siblings: this.posted }
    }
    for (const candidate of this.data.floors) {
      const nested = this.data.nested?.[candidate.postId] ?? []
      const target = nested.find((entry) => entry.postId === postId)
      if (target) {
        return {
          thread,
          floor: candidate,
          nested: target,
          ancestors: [],
          siblings: nested,
        }
      }
    }
    throw new Error(`找不到回复 ${postId}`)
  }

  async publishReply(
    ref: ThreadRef,
    target: PublishTarget,
    content: string,
  ): Promise<PublishOutcome> {
    this.publishes.push({ target, content })
    if (this.data.publish) return this.data.publish(target, content)
    const postId = `new-${this.publishes.length}`
    // Record it the way the platform would: the reply now exists in the thread, under
    // the floor it was sent to, authored by the bound account.
    this.posted.push({
      platform: 'tieba',
      postId,
      parentPostId: target.floorPostId ?? this.data.floors[0]!.postId,
      ...(target.nestedReplyId ? { replyToPostId: target.nestedReplyId } : {}),
      authorId: this.data.auth?.userId ?? '1001',
      authorName: this.data.auth?.userName ?? 'ai-account',
      content,
    })
    return { status: 'confirmed', postId }
  }
}

/** Build a simple synthetic three-party thread for analyzer tests. */
export function threePartyThread(ids?: { threadId?: string; floorPostId?: string; postPrefix?: string }): {
  thread: Thread
  floors: readonly Floor[]
  nested: Readonly<Record<string, readonly NestedReply[]>>
} {
  // Ids are overridable so a test can build two distinct threads that both
  // exist in the fake adapter — publishers now verify a target really exists.
  const floorPostId = ids?.floorPostId ?? '900000000001'
  const threadId = ids?.threadId ?? '900000000000'
  // Post ids must be unique across threads, or resolving `n5` in one thread
  // finds the other one's reply and the cross-thread check fires for the wrong
  // reason.
  const p = (id: string): string => `${ids?.postPrefix ?? ''}${id}`
  const nested: readonly NestedReply[] = [
    makeNested({
      postId: p('n1'),
      parentPostId: floorPostId,
      authorId: 'owner-1',
      authorName: '主人',
      content: '这个方案我认为不可行，成本会翻倍。',
    }),
    makeNested({
      postId: p('n2'),
      parentPostId: floorPostId,
      authorId: 'opp-1',
      authorName: '对手B',
      content: '回复 主人 :你凭什么说成本会翻倍？有数据吗？',
      replyToName: '主人',
    }),
    makeNested({
      postId: p('n3'),
      parentPostId: floorPostId,
      authorId: 'other-1',
      authorName: '路人C',
      content: '路过，我觉得都行吧，看情况。',
    }),
    makeNested({
      postId: p('n4'),
      parentPostId: floorPostId,
      authorId: 'owner-1',
      authorName: '主人',
      content: '回复 对手B :前面贴过报价了，翻倍是按去年两次采购价算的。',
      replyToName: '对手B',
    }),
    makeNested({
      postId: p('n5'),
      parentPostId: floorPostId,
      authorId: 'opp-1',
      authorName: '对手B',
      content: '回复 主人 :那报价是同型号吗？你拿别的型号比没意义吧。',
      replyToName: '主人',
    }),
    makeNested({
      postId: p('n6'),
      parentPostId: floorPostId,
      authorId: 'other-1',
      authorName: '路人C',
      content: '我倒觉得可以试试看，反正也没多少钱。',
    }),
    makeNested({
      postId: p('n7'),
      parentPostId: floorPostId,
      authorId: 'owner-1',
      authorName: '主人',
      content: '@吵架小号 过来帮我说两句，这人一直绕。',
    }),
  ]

  const thread: Thread = {
    platform: 'tieba',
    forum: { platform: 'tieba', id: '1', name: '测试吧' },
    id: threadId,
    title: '测试主题：这个方案到底能不能上',
    content: '大家看看这个方案值不值得做。',
    authorId: 'author-1',
    authorName: '楼主',
    createdAt: '2024-1-1',
    url: `https://tieba.baidu.com/p/${threadId}`,
    declaredReplyCount: 1,
    images: [],
  }

  return {
    thread,
    floors: [
      makeFloor({
        floorNumber: 1,
        postId: floorPostId,
        authorId: 'author-1',
        authorName: '楼主',
        content: '大家看看这个方案值不值得做。',
        nestedCount: nested.length,
      }),
    ],
    nested: { [floorPostId]: nested },
  }
}

/** Build a large synthetic thread with `count` floors. */
export function largeThread(count: number): {
  thread: Thread
  floors: readonly Floor[]
} {
  const floors: Floor[] = []
  for (let index = 1; index <= count; index += 1) {
    floors.push(
      makeFloor({
        floorNumber: index,
        postId: `p${100000000000 + index}`,
        authorId: `u${index % 20}`,
        authorName: `用户${index % 20}`,
        content: `第 ${index} 楼的发言内容。`,
      }),
    )
  }
  return {
    thread: {
      platform: 'tieba',
      forum: { platform: 'tieba', id: '2', name: '大帖吧' },
      id: '700000000000',
      title: '大帖',
      content: '大帖正文',
      url: 'https://tieba.baidu.com/p/700000000000',
      declaredReplyCount: count,
      images: [],
    },
    floors,
  }
}

/** A temporary directory that removes itself. */
export function tempDir(prefix: string): string {
  const base = join(
    process.env.TEMP ?? process.env.TMPDIR ?? '.',
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  return base
}
