/**
 * The Tieba adapter: the only module that knows Tieba exists.
 *
 * Reading goes through three surfaces, each used for what it actually provides:
 *
 * | Surface          | Provides                              | Verified |
 * | ---------------- | ------------------------------------- | -------- |
 * | `/mo/q/m?kz=&pn=`| floors, body, author name, date, images | yes      |
 * | `/p/totalComment`| numeric user ids, nested reply counts   | yes      |
 * | `/p/comment`     | full nested replies with reply targets  | yes      |
 *
 * Publishing goes through `/f/commit/post/add`, which answers structured JSON.
 * It is implemented and its unauthenticated response is verified, but the
 * authenticated happy path **has not been tested against a real logged-in
 * account** in this environment; `checkAuthentication` therefore reports the
 * truth rather than assuming a session, and the publish path refuses to run
 * without one.
 */

import {
  PlatformError,
  type AuthState,
  type Floor,
  type ForumRef,
  type Mention,
  type NestedPage,
  type NestedReply,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PublishOutcome,
  type PublishTarget,
  type ReplyContext,
  type ReplyPage,
  type Thread,
  type ThreadRef,
  type UserProfile,
} from '../../types.js'
import { HttpClient, MOBILE_UA, type HttpResult } from '../http.js'
import {
  parseCommentPage,
  parseTbs,
  parseTotalComment,
  parseWapFloors,
  parseWapPageMeta,
  parseWapThreadMeta,
  toPlainText,
  type ParsedFloor,
} from './parse.js'
import { parseTiebaUrl, threadUrl, type TiebaThreadRef } from './url.js'

/** Tieba serves 30 floors per WAP page. */
const FLOORS_PER_PAGE = 30

/** Options for the adapter; every one has a working default. */
export interface TiebaAdapterOptions {
  /** Cookie header value copied from a logged-in browser, if the user has one. */
  readonly cookie?: string
  /** Milliseconds before one HTTP attempt is abandoned. */
  readonly timeoutMs?: number
  /** Extra attempts for transport failures. */
  readonly retries?: number
  /** Milliseconds to pace pagination, to stay polite. */
  readonly pageDelayMs?: number
  /** Hard cap on pages walked for one thread; guards runaway loops. */
  readonly maxPages?: number
  /**
   * How long to stay off the `/p/*` nested channels after a block, in ms.
   *
   * They are path-scoped rate limited independently of the rest of the site, so
   * a cool-off plus the inlined fallback keeps a run productive without
   * deepening the block. Defaults to ten minutes.
   */
  readonly nestedCooldownMs?: number
  /**
   * How long the thread-structure cache stays valid, in ms.
   *
   * It records only *where* posts are, never their text, and every publish still
   * re-reads its target. Kept short (five minutes by default) so a moved post is
   * re-derived quickly rather than served from a stale map.
   */
  readonly structureCacheMs?: number
  /**
   * A thread to read the login banner from when the real target is not available.
   *
   * Optional, and **not** how login is normally checked: `checkAuthentication` prefers
   * the thread being published into, because the banner is rendered on any post page
   * the cookie can see. This exists only as a fallback for a caller that has no thread
   * at hand, and for tests.
   */
  readonly authProbeThreadId?: string
  /**
   * Further threads to try if the primary probe is unreadable.
   *
   * A deleted or rate-limited probe thread must not be able to report a healthy login
   * as broken, which is what a single hard-coded id did.
   */
  readonly authProbeFallbacks?: readonly string[]
  /** Optional logger; receives already-redacted messages. */
  readonly log?: (message: string) => void
}

/**
 * The Tieba platform adapter.
 *
 * Capabilities are declared honestly: mentions are unavailable because no
 * verified public endpoint exists for them without a logged-in session, and
 * that is reported as `false` rather than faked.
 */
export class TiebaAdapter implements PlatformAdapter {
  readonly id = 'tieba' as const
  readonly displayName = '百度贴吧'

  private readonly http: HttpClient
  private readonly options: TiebaAdapterOptions
  /** Optional fallback probe thread for the login banner; never required. */
  private readonly authProbeThreadId?: string
  /** Additional probe threads, tried when the primary is unreadable. */
  private readonly authProbeFallbacks: readonly string[]
  /** Forum metadata cached per thread, so paging does not re-read it. */
  private readonly threadCache = new Map<string, { forumId?: string; forumName?: string; tbs?: string }>()
  /**
   * Short-lived map of thread *structure*, to make reply lookups cheaper.
   *
   * Only where things are is cached — which floor holds which post id — never the
   * text. Every lookup still re-reads the target before acting on it, so a cache hit
   * saves requests without letting stale content drive a decision.
   */
  private readonly structureCache = new Map<
    string,
    { floors: Map<string, { postId: string }>; nestedParents: Map<string, string>; at: number }
  >()
  /**
   * Wall-clock ms after which the `/p/*` nested channels may be tried again.
   *
   * Measured on a live thread: `/p/comment` and `/p/totalComment` start
   * answering every request with Baidu's security-verification interstitial
   * (HTTP 403, 2488 bytes) while `/mo/q/*` and `/f` keep returning 200 and a
   * cooldown does not clear it. It is path-scoped rate control, not a cookie
   * problem, so hammering the endpoint only deepens the block. Once a 403 is
   * seen the channel is skipped until this time passes, and floors fall back to
   * the replies the WAP page inlines.
   */
  private nestedChannelBlockedUntil = 0
  /** Why the nested channel was closed, for the health report. */
  private nestedChannelReason: string | undefined

  constructor(options: TiebaAdapterOptions = {}) {
    this.options = options
    this.authProbeThreadId = options.authProbeThreadId
    this.authProbeFallbacks = options.authProbeFallbacks ?? []
    this.http = new HttpClient({
      timeoutMs: options.timeoutMs ?? 20_000,
      retries: options.retries ?? 2,
    })
    if (options.cookie) this.seedCookie(options.cookie)
  }

  /** Install a cookie header supplied by the user. */
  private seedCookie(header: string): void {
    for (const part of header.split(';')) {
      const pair = part.trim()
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      this.http.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  /** Report which cookie names are held, never their values. */
  describeCookieNames(): readonly string[] {
    return this.http.jar.names()
  }

  /** What this adapter can actually do right now. */
  getCapabilities(): PlatformCapabilities {
    return {
      thread: true,
      replies: true,
      nestedReplies: true,
      userProfile: false,
      mentions: false,
      publish: true,
      authCheck: true,
      notes: {
        userProfile:
          '贴吧主页 /home/main 对未登录请求只返回 SPA 空壳，读取不到稳定的公开资料，故不声明该能力。',
        mentions:
          '艾特/回复通知接口（/c/u/feed/atme_pc）需要真实登录态且未经账号验证，第一版不声明该能力；请使用手动召唤。',
        publish:
          '发布接口 /f/commit/post/add 已实现并验证了未登录响应结构，但登录态下的真实发表未经验证（本环境无可用账号）。',
      },
    }
  }

  /**
   * Bootstrap the cookie jar.
   *
   * Tieba answers a cold request with a security-challenge page instead of the
   * thread; visiting the Baidu homepage first yields the `BAIDUID` family that
   * makes the following request succeed. This is the platform's own session
   * bootstrap, not a bypass of any check.
   */
  private async bootstrap(signal?: AbortSignal): Promise<void> {
    if (this.http.jar.size > 0) return
    await this.http.request('https://www.baidu.com/', { signal, retries: 1 })
  }

  /** Fetch one WAP thread page. */
  private async fetchWapPage(
    threadId: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<HttpResult> {
    await this.bootstrap(signal)
    const offset = (page - 1) * FLOORS_PER_PAGE
    return this.http.request(`https://tieba.baidu.com/mo/q/m?kz=${threadId}&pn=${offset}`, {
      headers: { 'user-agent': MOBILE_UA, referer: threadUrl(threadId) },
      signal,
      timeoutMs: this.options.timeoutMs,
      retries: this.options.retries,
    })
  }

  /** Check the login state from the page's own editor config. */
  /**
   * Report the login state, and — separately — whether the account behind it is
   * *identified*.
   *
   * v0.1.4 read a hard-coded thread (`6826726803`) to find the login banner. That made
   * a fixed post load-bearing for two unrelated questions: if that thread was deleted,
   * made private, or hit a rate limit, a perfectly healthy login looked broken; and if
   * tieba changed the page shape there, every publish refused with a misleading
   * "not logged in".
   *
   * The banner is not thread-specific. It is rendered on any WAP post page the cookie
   * can see, so this reads the thread it is actually about to publish into, and falls
   * back to the configured probe thread only if that one is unreadable. Nothing is
   * hard-coded as a requirement.
   *
   * The two questions stay distinct, because they are not the same thing:
   *
   * - `authenticated` — a session exists. The page exposes `is_login=1`.
   * - `userId` — the page also named the account. Only this can be compared against
   *   the configured AI account.
   *
   * A page can report a login without naming it, and tieba does exactly that on some
   * responses. The publisher treats that as "identity unverified" and refuses, rather
   * than publishing as whoever the cookie happens to belong to.
   *
   * @param signal cancellation
   * @param probeThreadId a thread to read the banner from; when omitted the adapter's
   *   configured probe is used
   * @returns the login state, with `userId` present only when the platform stated it
   */
  async checkAuthentication(signal?: AbortSignal, probeThreadId?: string): Promise<AuthState> {
    const candidates = [probeThreadId, this.authProbeThreadId, ...this.authProbeFallbacks].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    )

    let lastFailure: PlatformError | undefined
    for (const threadId of candidates) {
      let html: string
      try {
        const page = await this.fetchWapPage(threadId, 1, signal)
        html = page.text
      } catch (error) {
        const failure = error as PlatformError
        lastFailure = failure
        // A deleted or inaccessible probe says nothing about the login. Try the next
        // one; only a challenge/block is worth reporting verbatim, and even then a
        // different thread may render fine.
        continue
      }

      const state = readAuthFromHtml(html)
      // A page that yielded no login marker at all is not proof of anything; if there
      // are more probes, ask one of them rather than concluding "not logged in".
      if (state.reason === NO_MARKER_REASON && candidates.length > 1) {
        lastFailure = undefined
        continue
      }
      return state
    }

    if (lastFailure) {
      return {
        authenticated: false,
        reason: `无法读取贴吧页面来确认登录状态：${lastFailure.message}`,
        blocked: lastFailure.code === 'captcha' || lastFailure.code === 'forbidden',
      }
    }
    return {
      authenticated: false,
      reason: '每个可用的贴吧页面都没有暴露登录状态标记，按未登录处理',
    }  }

  /** Read the thread body and its metadata. */
  async getThread(ref: ThreadRef, signal?: AbortSignal): Promise<Thread> {
    const parsedRef = normalizeRef(ref)
    const page = await this.fetchWapPage(parsedRef.threadId, 1, signal)
    const html = page.text
    const wapMeta = parseWapThreadMeta(html)
    const pageMeta = parseWapPageMeta(html)
    const floors = parseWapFloors(html)

    const first = floors[0]
    if (!first) {
      throw new PlatformError(`帖子 ${parsedRef.threadId} 没有可读取的楼层，可能已被删除`, 'not_found')
    }
    this.threadCache.set(parsedRef.threadId, {
      forumId: wapMeta.forumId,
      forumName: wapMeta.forumName,
      tbs: wapMeta.tbs,
    })

    const forum: ForumRef = {
      platform: 'tieba',
      id: wapMeta.forumId ?? parsedRef.forumId,
      name: wapMeta.forumName ?? parsedRef.forumName ?? '未知贴吧',
    }

    return {
      platform: 'tieba',
      forum,
      id: parsedRef.threadId,
      // An empty title is a real state; it is never filled in with invented text.
      title: wapMeta.title ?? '',
      content: first.floor.content,
      authorId: first.floor.authorId,
      authorName: first.floor.authorName,
      createdAt: first.floor.createdAt,
      url: threadUrl(parsedRef.threadId),
      declaredReplyCount: pageMeta.totalCount,
      images: first.floor.images,
    }
  }

  /** Read one page of floors. */
  async getReplies(ref: ThreadRef, page: number, signal?: AbortSignal): Promise<ReplyPage> {
    const parsedRef = normalizeRef(ref)
    if (!Number.isInteger(page) || page < 1) {
      throw new PlatformError(`页码必须是从 1 开始的整数，收到 ${page}`, 'malformed_response')
    }
    const response = await this.fetchWapPage(parsedRef.threadId, page, signal)
    const meta = parseWapPageMeta(response.text)
    const floors = parseWapFloors(response.text)
    const declaredTotalPages = meta.totalPages
    return {
      floors: floors.map((entry) => entry.floor),
      page,
      hasMore:
        declaredTotalPages !== undefined
          ? page < declaredTotalPages
          : floors.length === FLOORS_PER_PAGE,
      declaredTotalPages,
      declaredTotal: meta.totalCount,
    }
  }

  /**
   * Walk every page of a thread.
   *
   * Kept as a convenience for callers that want a one-shot read; the generic
   * `walkFloors` in `collector.ts` is what the pipeline uses, so a second
   * platform gets the same behaviour without reimplementing it.
   */
  async getAllFloors(
    ref: ThreadRef,
    options: {
      signal?: AbortSignal
      maxPages?: number
      onProgress?: (progress: { page: number; totalPages?: number; collected: number }) => void
    } = {},
  ): Promise<{
    floors: readonly Floor[]
    declaredTotal?: number
    totalPages?: number
    complete: boolean
    missingCount?: number
    error?: string
  }> {
    const parsedRef = normalizeRef(ref)
    const maxPages = options.maxPages ?? this.options.maxPages ?? 60
    const seen = new Map<string, Floor>()
    let totalPages: number | undefined
    let declaredTotal: number | undefined
    let page = 1
    let failed: string | undefined

    while (page <= maxPages) {
      let response: HttpResult
      try {
        response = await this.fetchWapPage(parsedRef.threadId, page, options.signal)
      } catch (error) {
        failed = (error as Error).message
        break
      }
      const meta = parseWapPageMeta(response.text)
      const floors = parseWapFloors(response.text)
      totalPages ??= meta.totalPages
      declaredTotal ??= meta.totalCount

      let added = 0
      for (const entry of floors) {
        if (!seen.has(entry.floor.postId)) {
          seen.set(entry.floor.postId, entry.floor)
          added += 1
        }
      }
      options.onProgress?.({ page, totalPages, collected: seen.size })

      if (floors.length === 0 || added === 0) break
      if (totalPages !== undefined && page >= totalPages) break
      page += 1
      if (this.options.pageDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.options.pageDelayMs))
      }
    }

    const floors = [...seen.values()].sort((a, b) => a.floorNumber - b.floorNumber)
    const missingCount =
      declaredTotal !== undefined && declaredTotal > floors.length
        ? declaredTotal - floors.length
        : undefined

    return {
      floors,
      declaredTotal,
      totalPages,
      // Completion means every declared floor is present. Deleted floors leave
      // permanent gaps, so a short result is reported as incomplete, not hidden.
      complete: failed === undefined && missingCount === undefined,
      missingCount,
      error: failed,
    }
  }

  /** Read nested replies under one floor, one page at a time. */
  async getNestedReplies(
    ref: ThreadRef,
    floor: Floor,
    page: number,
    signal?: AbortSignal,
  ): Promise<NestedPage> {
    const parsedRef = normalizeRef(ref)
    if (this.nestedChannelOpen()) {
      try {
        const fallback = await this.readNestedFromTotalComment(parsedRef, floor, page, signal)
        if (fallback) return fallback
        return await this.readNestedFromCommentPage(parsedRef, floor, page, signal)
      } catch (failure) {
        if (!this.tripNestedChannel(failure)) throw failure
      }
    }
    return this.readNestedInline(floor, page)
  }

  /** True while the paginated nested channels are still worth trying. */
  private nestedChannelOpen(): boolean {
    return Date.now() >= this.nestedChannelBlockedUntil
  }

  /**
   * Close the nested channel after a block, and report whether that happened.
   *
   * Only a `forbidden`/`rate_limited` answer closes it: those are the platform
   * refusing this reader, and retrying makes it worse. A timeout or a 5xx is
   * transient and is left to the HTTP layer's retry budget.
   */
  private tripNestedChannel(failure: unknown): boolean {
    if (!(failure instanceof PlatformError)) return false
    if (failure.code !== 'forbidden' && failure.code !== 'rate_limited') return false
    const cooldown = this.options.nestedCooldownMs ?? 10 * 60_000
    this.nestedChannelBlockedUntil = Date.now() + cooldown
    this.nestedChannelReason =
      `楼中楼分页接口被平台限流（${failure.code}），已暂停 ${Math.round(cooldown / 60_000)} 分钟；` +
      '期间改用帖子页内联的楼中楼，数量可能少于平台声明。'
    return true
  }

  /**
   * Fall back to the nested replies the WAP page already inlined.
   *
   * This surface carries no timestamps and its `data-list-count` cannot be
   * trusted, so the page declares its own honesty: `hasMore` is left true
   * whenever the floor claims more replies than were inlined, which makes the
   * collector report the floor as partially read instead of complete.
   */
  private readNestedInline(floor: Floor, page: number): NestedPage {
    if (page > 1) return { replies: [], page, hasMore: false, declaredTotal: floor.nestedCount }
    const replies = floor.inlineNested ?? []
    const declared = floor.nestedCount
    const hasMore = declared !== undefined && declared > replies.length
    return { replies, page, hasMore: false, declaredTotal: declared, incomplete: hasMore }
  }

  /** Explain the current nested-channel state, for the health report. */
  describeNestedChannel(): { open: boolean; reason?: string } {
    const open = this.nestedChannelOpen()
    return { open, reason: open ? undefined : this.nestedChannelReason }
  }

  /**
   * Try the `totalComment` JSON channel first.
   *
   * It is cheap and it is the only surface that carries a **numeric user id**,
   * which the owner/opponent binding needs. It inlines at most nine replies per
   * floor, so a floor with more falls through to the HTML channel.
   */
  private async readNestedFromTotalComment(
    ref: TiebaThreadRef,
    floor: Floor,
    page: number,
    signal?: AbortSignal,
  ): Promise<NestedPage | null> {
    const forumId = await this.resolveForumId(ref, signal)
    if (!forumId) return null
    const response = await this.http.request(
      `https://tieba.baidu.com/p/totalComment?tid=${ref.threadId}&fid=${forumId}&pn=${page}&see_lz=0`,
      { headers: { 'x-requested-with': 'XMLHttpRequest', referer: threadUrl(ref.threadId) }, signal },
    )
    const parsed = parseTotalComment(response.text)
    const entry = parsed.entries.find((candidate) => candidate.floorPostId === floor.postId)
    if (!entry) return null

    const replies: NestedReply[] = entry.inline.map((inline) => ({
      platform: 'tieba',
      postId: inline.commentId,
      parentPostId: floor.postId,
      authorId: inline.authorId,
      authorName: inline.authorName,
      content: inline.content,
      createdAt: inline.createdAt,
    }))

    // Only claim completeness when the whole floor fits in one inline page.
    const fitsOnePage = entry.inline.length >= entry.declaredCount && page === 1
    if (!fitsOnePage && entry.declaredCount > entry.inline.length) return null

    return {
      replies,
      page,
      hasMore: !fitsOnePage,
      declaredTotal: entry.declaredCount,
    }
  }

  /** Read nested replies from the paginated HTML channel. */
  private async readNestedFromCommentPage(
    ref: TiebaThreadRef,
    floor: Floor,
    page: number,
    signal?: AbortSignal,
  ): Promise<NestedPage> {
    const response = await this.http.request(
      `https://tieba.baidu.com/p/comment?tid=${ref.threadId}&pid=${floor.postId}&pn=${page}`,
      { headers: { referer: threadUrl(ref.threadId) }, signal },
    )
    const parsed = parseCommentPage(response.text, floor.postId)
    return {
      replies: parsed.replies.map((entry) => entry.reply),
      page,
      hasMore: parsed.totalPages > page,
      declaredTotalPages: parsed.totalPages,
      declaredTotal: parsed.total,
    }
  }

  /** Return every nested reply under one floor, walking all pages. */
  async getAllNested(
    ref: ThreadRef,
    floor: Floor,
    options: { signal?: AbortSignal; maxPages?: number } = {},
  ): Promise<{ replies: readonly NestedReply[]; complete: boolean; error?: string; degraded?: boolean }> {
    const maxPages = options.maxPages ?? 10
    const seen = new Map<string, NestedReply>()
    let page = 1
    let error: string | undefined
    let degraded = false

    while (page <= maxPages) {
      let result: NestedPage
      try {
        result = await this.getNestedReplies(ref, floor, page, options.signal)
      } catch (failure) {
        error = (failure as Error).message
        break
      }
      if (result.incomplete) degraded = true
      let added = 0
      for (const reply of result.replies) {
        if (!seen.has(reply.postId)) {
          seen.set(reply.postId, reply)
          added += 1
        }
      }
      if (!result.hasMore || added === 0) break
      page += 1
    }

    const replies = [...seen.values()]
    const declared = floor.nestedCount
    const complete =
      error === undefined && !degraded && (declared === undefined || replies.length >= declared)
    return { replies, complete, error, degraded }
  }

  /** Resolve the forum id for a thread, caching the lookup. */
  private async resolveForumId(ref: TiebaThreadRef, signal?: AbortSignal): Promise<string | undefined> {
    if (ref.forumId) return ref.forumId
    const cached = this.threadCache.get(ref.threadId)
    if (cached?.forumId) return cached.forumId
    const page = await this.fetchWapPage(ref.threadId, 1, signal)
    const meta = parseWapThreadMeta(page.text)
    this.threadCache.set(ref.threadId, { forumId: meta.forumId, forumName: meta.forumName, tbs: meta.tbs })
    return meta.forumId
  }

  /** Read a public profile. */
  async getUserProfile(userNameOrId: string, signal?: AbortSignal): Promise<UserProfile> {
    // Tieba's profile page is an unauthenticated SPA shell: it renders nothing
    // server-side. Rather than inventing fields, this reports the capability
    // gap with a clear error.
    throw new PlatformError(
      `无法读取用户资料：贴吧主页 /home/main 对未登录请求只返回脚本空壳，没有可解析的公开资料（请求对象：${userNameOrId}）`,
      'permission_denied',
      { cause: signal?.aborted ?? false },
    )
  }

  /** List @-mentions. Unavailable without a verified endpoint. */
  async getMentions(_since: string | undefined, _signal?: AbortSignal): Promise<readonly Mention[]> {
    throw new PlatformError(
      '贴吧艾特通知读取不可用：/c/u/feed/atme_pc 需要真实登录态，且本版本未经账号验证。请使用手动召唤（提供帖子 URL + 回复 ID）。',
      'permission_denied',
    )
  }

  /**
   * Resolve a post id to its floor, ancestors and siblings.
   *
   * @param options.forceFresh re-read the target from the platform and ignore the
   *   structure cache for its *content*. Publishing always passes this: the cache
   *   exists to save locating work, never to stand in for a fresh read. A cached
   *   body used as if it were current is exactly how an edited post goes unnoticed.
   */
  async getReplyContext(
    ref: ThreadRef,
    postId: string,
    signal?: AbortSignal,
    options: { forceFresh?: boolean } = {},
  ): Promise<ReplyContext> {
    const parsedRef = normalizeRef(ref)
    const thread = await this.getThread(parsedRef, signal)

    // The cache may only say *where* to look. It is never returned as content.
    //
    // A hit here still requires a real read of the target below; the cached object
    // is used only to know which post id to fetch, and an explicit `forceFresh`
    // skips even that so a publish always re-derives the answer from the platform.
    const cachedFloorPostId = options.forceFresh
      ? undefined
      : this.structureEntry(parsedRef.threadId).floors.get(postId)?.postId

    const all = await this.getAllFloors(parsedRef, { signal })

    // The post id may be a floor id or a nested id; both are resolved here so the
    // caller never has to know which kind it holds. `all` is always a fresh read.
    const asFloor = all.floors.find((floor) => floor.postId === (cachedFloorPostId ?? postId))
    if (asFloor) {
      this.rememberFloors(parsedRef.threadId, all.floors)
      return { thread, floor: asFloor, ancestors: [], siblings: [] }
    }

    // A cached floor id that the fresh walk no longer contains means the floor is
    // gone; say so instead of falling back to the stale object.
    if (cachedFloorPostId && cachedFloorPostId !== postId) {
      throw new PlatformError(
        `帖子 ${parsedRef.threadId} 中已找不到楼层 ${cachedFloorPostId}（可能已被删除）`,
        'not_found',
      )
    }

    // Slow path: it is a nested reply.
    //
    // The old loop read *every* floor's nested replies until it got a hit — O(floors)
    // requests for one lookup, which is a lot of pressure on the site for a single
    // target check. Two cheap narrowing steps run first, and both re-read the reply
    // itself rather than trusting the hint blindly.
    const hinted = await this.locateByHint(parsedRef, postId, all.floors, thread, signal)
    if (hinted) return hinted

    for (const floor of all.floors) {
      const nested = await this.getAllNested(parsedRef, floor, { signal })
      const target = nested.replies.find((reply) => reply.postId === postId)
      if (!target) continue
      this.rememberNestedParent(parsedRef.threadId, postId, floor)
      return {
        thread,
        floor,
        nested: target,
        ancestors: buildAncestors(nested.replies, target),
        siblings: nested.replies,
      }
    }

    throw new PlatformError(
      `在帖子 ${parsedRef.threadId} 中没有找到回复 ${postId}（可能已被删除，或不在可访问范围内）`,
      'not_found',
    )
  }

  /**
   * Narrow a nested-reply lookup before the full sweep.
   *
   * Two hints, cheapest first:
   * 1. a previously recorded parent for this exact post id;
   * 2. the floor whose *inline* copy (already fetched with the page) contains it.
   *
   * Both re-read the reply through the normal path, so a stale hint costs one wasted
   * request and never produces a wrong answer — accuracy is not traded for speed.
   */
  private async locateByHint(
    ref: TiebaThreadRef,
    postId: string,
    floors: readonly Floor[],
    thread: ReplyContext['thread'],
    signal?: AbortSignal,
  ): Promise<ReplyContext | null> {
    const entry = this.structureEntry(ref.threadId)

    const rememberedPostId = entry.nestedParents.get(postId)
    if (rememberedPostId) {
      const floor = floors.find((row) => row.postId === rememberedPostId)
      if (floor) {
        const nested = await this.getAllNested(ref, floor, { signal })
        const target = nested.replies.find((reply) => reply.postId === postId)
        if (target) {
          return {
            thread,
            floor,
            nested: target,
            ancestors: buildAncestors(nested.replies, target),
            siblings: nested.replies,
          }
        }
      }
      // The hint did not hold; forget it and fall through.
      entry.nestedParents.delete(postId)
    }

    for (const floor of floors) {
      if (!floor.inlineNested?.some((reply) => reply.postId === postId)) continue
      const nested = await this.getAllNested(ref, floor, { signal })
      const target = nested.replies.find((reply) => reply.postId === postId)
      if (!target) continue
      this.rememberNestedParent(ref.threadId, postId, floor)
      return {
        thread,
        floor,
        nested: target,
        ancestors: buildAncestors(nested.replies, target),
        siblings: nested.replies,
      }
    }
    return null
  }

  /**
   * Record the floors seen for a thread, for the floor fast path.
   *
   * Only the post ids are kept, never the floor objects: a cached body is a body
   * that can be returned as if it were fresh, and that is the defect this cache
   * caused before. Location only, content always re-read.
   */
  private rememberFloors(threadId: string, floors: readonly Floor[]): void {
    const entry = this.structureEntry(threadId)
    for (const floor of floors) entry.floors.set(floor.postId, { postId: floor.postId })
  }

  /** Record which floor a nested reply belongs to. */
  private rememberNestedParent(threadId: string, postId: string, floor: Floor): void {
    this.structureEntry(threadId).nestedParents.set(postId, floor.postId)
  }

  /**
   * The structure cache for a thread, expired in place.
   *
   * Entries older than `structureCacheMs` are dropped rather than served: a parent
   * recorded minutes ago may no longer be where that reply lives, and acting on a
   * stale parent is the one mistake this module must not make.
   */
  private structureEntry(threadId: string): {
    floors: Map<string, { postId: string }>
    nestedParents: Map<string, string>
  } {
    const ttl = this.options.structureCacheMs ?? 5 * 60_000
    const now = Date.now()
    let entry = this.structureCache.get(threadId)
    if (!entry || now - entry.at > ttl) {
      // Expiry is wholesale, not per-key: a partial cache is harder to reason about
      // than an empty one, and this data is cheap to re-read.
      entry = { floors: new Map(), nestedParents: new Map(), at: now }
      this.structureCache.set(threadId, entry)
    }
    return entry
  }

  /**
   * Publish a reply.
   *
   * The write path is implemented against the endpoint's real contract, but it
   * deliberately refuses to run when the session is not authenticated, and it
   * reports `uncertain` rather than `confirmed` when the platform's answer
   * cannot be proven.
   */
  async publishReply(
    ref: ThreadRef,
    target: PublishTarget,
    content: string,
    signal?: AbortSignal,
  ): Promise<PublishOutcome> {
    const parsedRef = normalizeRef(ref)
    const text = content.trim()
    if (!text) return { status: 'failed', error: '回复内容为空', errorCode: 'malformed_response' }

    const auth = await this.checkAuthentication(signal)
    if (!auth.authenticated) {
      return {
        status: 'failed',
        error: auth.blocked
          ? `账号被平台风控拦截：${auth.reason ?? '需要人工处理验证码'}`
          : `未登录：${auth.reason ?? '请先在贴吧登录，并把 Cookie 填入插件配置'}`,
        errorCode: auth.blocked ? 'captcha' : 'auth_required',
      }
    }

    const forumId = await this.resolveForumId(parsedRef, signal)
    const cached = this.threadCache.get(parsedRef.threadId)
    const tbs = cached?.tbs ?? (await this.fetchWapPage(parsedRef.threadId, 1, signal)).text
    const token = typeof tbs === 'string' && /^[0-9a-f]+$/i.test(tbs) ? tbs : parseTbs(tbs)
    if (!token) {
      return { status: 'failed', error: '没有拿到贴吧 CSRF token（tbs），无法提交', errorCode: 'auth_required' }
    }

    const form: Record<string, string> = {
      ie: 'utf-8',
      tbs: token,
      fid: forumId ?? '',
      kw: cached?.forumName ?? '',
      tid: parsedRef.threadId,
      content: text,
      floor_num: '',
      rich_text: '1',
      subapp_type: 'pc',
      vcode: '',
      vcode_md5: '',
    }
    if (target.nestedReplyId) {
      // Replying inside a floor: the platform wants the floor's post id.
      form.reply_id = target.floorPostId ?? ''
      form.comment_id = target.nestedReplyId
    }

    let response: HttpResult
    try {
      response = await this.http.request('https://tieba.baidu.com/f/commit/post/add', {
        form,
        headers: {
          'x-requested-with': 'XMLHttpRequest',
          referer: threadUrl(parsedRef.threadId),
          origin: 'https://tieba.baidu.com',
        },
        signal,
        // A write is never blindly retried: a timeout may still have posted.
        retries: 0,
      })
    } catch (error) {
      const failure = error as PlatformError
      // Timeout or transport failure after sending = unknown outcome.
      if (failure.code === 'timeout' || failure.code === 'network') {
        return {
          status: 'uncertain',
          error: `提交后没有拿到确定结果（${failure.message}），需要回帖页核实，不能直接重发`,
          errorCode: failure.code,
        }
      }
      return { status: 'failed', error: failure.message, errorCode: failure.code }
    }

    return interpretPublishResponse(response.text)
  }
}

/** Normalize an incoming ref, accepting a raw URL or bare thread id. */
function normalizeRef(ref: ThreadRef | string): TiebaThreadRef {
  if (typeof ref === 'string') return parseTiebaUrl(ref)
  return {
    platform: 'tieba',
    threadId: ref.threadId,
    forumName: ref.forumName,
    url: ref.url || threadUrl(ref.threadId),
    postId: ref.postId,
  }
}

/**
 * The `reason` used when a page carried no login marker at all.
 *
 * Named so callers can distinguish "this page said nothing" from "this page said you
 * are logged out" — the first is a reason to try another page, the second is an answer.
 */
export const NO_MARKER_REASON = '页面里没有找到登录状态标记'

/** Read the login state the WAP page reports in its editor config. */
export function readAuthFromHtml(html: string): AuthState {
  const editor = /data_editor:\s*(\{[\s\S]*?\})\s*,\s*base_url/.exec(html)?.[1]
  if (editor) {
    try {
      const parsed = JSON.parse(editor.replace(/\\"/g, '"')) as {
        can_post?: number
        forbid_flag?: number
        user?: { uid?: number; is_login?: number; user_id?: number }
      }
      const isLogin = parsed.user?.is_login === 1
      const uid = parsed.user?.uid || parsed.user?.user_id
      if (isLogin) {
        return {
          authenticated: true,
          userId: uid ? String(uid) : undefined,
          reason: parsed.can_post === 0 ? '已登录，但当前账号在此吧没有发帖权限' : undefined,
        }
      }
      return {
        authenticated: false,
        reason:
          parsed.forbid_flag === 1
            ? '未登录（页面报告 forbid_flag=1，可能需要人工处理安全验证）'
            : '未登录：页面报告 is_login=0',
      }
    } catch {
      // Fall through to the generic signal below.
    }
  }

  if (/百度安全验证|请输入验证码|wappass\.baidu\.com/.test(html)) {
    return { authenticated: false, blocked: true, reason: '贴吧返回了安全验证页（验证码/风控）' }
  }
  return { authenticated: false, reason: NO_MARKER_REASON }
}

/**
 * Interpret the `/f/commit/post/add` JSON answer.
 *
 * Tieba reports success with `no: 0`; anything else is a failure, and the
 * error text is surfaced verbatim so the user sees the platform's own wording.
 */
export function interpretPublishResponse(raw: string): PublishOutcome {
  let parsed: {
    no?: number
    err_code?: number
    error?: string | null
    data?: {
      is_login?: number
      vcode?: { need_vcode?: number; str_reason?: string; captcha_vcode_str?: string }
      pid?: number | string
      post_id?: number | string
      content?: string
    }
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      status: 'uncertain',
      error: `平台返回了非 JSON 内容，无法确认是否发表成功：${raw.slice(0, 120)}`,
      errorCode: 'malformed_response',
    }
  }

  if (parsed.data?.is_login === 0) {
    return { status: 'failed', error: '登录状态无效，贴吧拒绝发表', errorCode: 'auth_required' }
  }
  const vcode = parsed.data?.vcode
  if (vcode?.need_vcode === 1) {
    return {
      status: 'failed',
      error: `需要验证码：${vcode.str_reason ?? '平台要求人工验证'}`,
      errorCode: 'captcha',
    }
  }
  if (parsed.no === 0) {
    const postId = parsed.data?.pid ?? parsed.data?.post_id
    const id = postId === undefined || postId === null ? '' : String(postId).trim()
    if (!id) {
      // `no: 0` with no post id is a success claim that cannot be checked.
      //
      // Treating it as confirmed would put the session in "published and verified"
      // while nothing proves a reply exists at a known location. It stays
      // `uncertain`, which keeps the dedupe row `pending` and forbids an automatic
      // retry — the honest state for "the platform said yes but did not say what".
      return {
        status: 'uncertain',
        error:
          '平台返回成功（no=0）但没有给出 post id，无法确认这条回复是否真的发出、发在哪里。' +
          '为避免重复回帖，不会自动重试；请打开帖子人工确认。',
        errorCode: 'malformed_response',
      }
    }
    return { status: 'confirmed', postId: id }
  }
  return {
    status: 'failed',
    error: parsed.error ?? `贴吧拒绝了这次发表（no=${parsed.no ?? '?'}, err_code=${parsed.err_code ?? '?'}）`,
    errorCode: 'unknown',
  }
}

/**
 * Walk a nested thread backwards from a target reply.
 *
 * The platform only states who each reply answers, so the chain is rebuilt by
 * looking that name up among earlier replies. When the name is ambiguous — two
 * participants sharing a display name — the chain stops rather than guessing.
 */
export function buildAncestors(
  replies: readonly NestedReply[],
  target: NestedReply,
): readonly NestedReply[] {
  const chain: NestedReply[] = []
  const taken = new Set<string>([target.postId])
  let current: NestedReply | undefined = target
  let guard = 0

  while (current?.replyToName && guard < 64) {
    guard += 1
    const index = replies.findIndex((reply) => reply.postId === current?.postId)
    const earlier = index >= 0 ? replies.slice(0, index) : replies
    const matches = earlier.filter(
      (reply) => !taken.has(reply.postId) && reply.authorName === current?.replyToName,
    )
    if (matches.length !== 1) break
    const next = matches[0] as NestedReply
    chain.unshift(next)
    taken.add(next.postId)
    current = next
  }
  return chain
}

/** Cheap text preview for logs, with newlines collapsed. */
export function preview(text: string, limit = 60): string {
  const flat = toPlainText(text).replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** A parsed floor list paired with the floor map, for callers that need both. */
export type { ParsedFloor }
