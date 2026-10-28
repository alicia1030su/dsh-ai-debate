/**
 * Context collection: turn a thread reference into a complete, structured
 * conversation graph.
 *
 * Design rule this module exists to enforce: **the model never reads raw HTML
 * and never sees a page it was not given**. Collection happens first, in code,
 * and everything afterwards works on typed records. That is what lets a small
 * model succeed — it receives a compact, already-correct structure instead of
 * being asked to reconstruct who replied to whom from a wall of text.
 *
 * Pagination lives here, on the *generic* adapter interface, not inside the
 * Tieba adapter. A second platform then gets correct paging, deduplication and
 * partial-result reporting for free, and cannot quietly implement "read page 1
 * and call it done".
 */

import {
  PlatformError,
  type Floor,
  type NestedReply,
  type PlatformAdapter,
  type ReplyContext,
  type Thread,
  type ThreadRef,
} from './types.js'

/** How much of a thread to collect. */
export interface CollectOptions {
  /** Hard cap on floor pages walked. */
  readonly maxPages?: number
  /** Safety cap on floors kept. */
  readonly maxFloors?: number
  /** How many floors get their nested replies fetched. */
  readonly nestedFloorLimit?: number
  /** Fetch nested replies only for floors this predicate accepts. */
  readonly wantNested?: (floor: Floor) => boolean
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: CollectProgress) => void
}

/** Progress of a collection run. */
export interface CollectProgress {
  readonly stage: 'thread' | 'floors' | 'nested' | 'done'
  readonly message: string
  readonly current?: number
  readonly total?: number
}

/**
 * The four independent things "complete" used to mean, separated.
 *
 * v0.2.1 had one boolean `complete`, and it answered every question at once. The
 * problem is that they genuinely differ: a thread can be read perfectly from the
 * platform and then trimmed to the first floor by `maxFloors`, and the old flag
 * stayed `true` — the data handed to the model was *not* the thread, while the
 * plugin said the read was complete.
 *
 * Reproduced before this change: a platform returns 3 floors, `maxFloors: 1`, and
 * `complete` was still `true`.
 *
 * Keeping them apart is what lets each one be honest:
 *
 * | field | question it answers |
 * | --- | --- |
 * | `sourceComplete` | did the platform's own evidence prove we saw all of it? |
 * | `retainedComplete` | did we *keep* everything we read? |
 * | `analysisComplete` | is the dispute chain we need actually present? |
 * | `nestedComplete` | were the sub-comments under each floor fully read? |
 *
 * `sourceComplete` can be true while `retainedComplete` is false (read 3, kept 1
 * by cap) — that combination is exactly what v0.2.1 could not express, and it is
 * the one that matters most: the model must be told that replies exist which it
 * has not seen, so it cannot invent them.
 */
export interface CompletenessReport {
  /** The platform's evidence proves the floor list was read in full. */
  readonly sourceComplete: boolean
  /** Everything read was kept; no cap, trim or sampling dropped anything. */
  readonly retainedComplete: boolean
  /** The argument chain needed to answer is present, so publishing is safe. */
  readonly analysisComplete: boolean
  /** Every floor's nested replies were read to the platform's declared count. */
  readonly nestedComplete: boolean
  /** Floors the platform declares that could not be read (usually deleted). */
  readonly missingCount?: number
  /** Floors dropped locally by `maxFloors`, stated so nothing is silently lost. */
  readonly droppedByCap?: number
  /** Fraction of declared floors retained, when a total was declared. */
  readonly retainedRatio?: number
  /** Why any of the above is false, phrased for a human. */
  readonly reasons: readonly string[]
}

/** Everything collected for one thread. */
export interface CollectedThread {
  readonly thread: Thread
  readonly floors: readonly FloorWithNested[]
  /**
   * True when every declared floor was read *and* kept.
   *
   * Kept as a single flag for v0.2.x callers. v0.2.2 made it strictly stronger
   * than before: it is now the conjunction of `sourceComplete` and
   * `retainedComplete`, so a capped read no longer reports `true`. New code
   * should read {@link completeness} instead, which says which part failed.
   */
  readonly complete: boolean
  /** The separated verdicts. Always present on a v0.2.2 or later read. */
  readonly completeness: CompletenessReport
  /** Floors the platform declares but that were not readable (usually deleted). */
  readonly missingCount?: number
  /** Why the floor walk stopped, so callers can distinguish causes. */
  readonly stopReason?: StopReason
  /** True when more pages were known to remain. */
  readonly truncated?: boolean
  /** True when any floor's nested replies were read incompletely. */
  readonly nestedIncomplete?: boolean
  /** Non-fatal problems, phrased for a human. */
  readonly issues: readonly string[]
}

/** A floor plus whatever nested replies were collected under it. */
export interface FloorWithNested {
  readonly floor: Floor
  readonly nested: readonly NestedReply[]
  /** True when the platform's own count was reached. */
  readonly nestedComplete: boolean
}

/**
 * Why a walk stopped.
 *
 * These are deliberately distinct: "the platform says that was the last page" and
 * "I hit my own page cap" produce the same short floor list but mean opposite
 * things about trustworthiness, and the UI has to be able to say which happened.
 *
 * **Only `confirmed_end` is positive evidence that the read is complete.** Every
 * other value means the walk ended without proving there was nothing more —
 * including `empty_page` and `repeated_page`, which v0.2.0 treated as a normal
 * end. That was the bug: a platform that returned nothing on page 1, or repeated
 * the same rows until the walk gave up, produced `complete: true` on the strength
 * of having read no data at all.
 */
export type StopReason =
  /** The platform stated this was the last page, or the declared total was reached. */
  | 'confirmed_end'
  /** A page came back empty, with no declared total to corroborate it. */
  | 'empty_page'
  /** A page contained only rows already seen, with no declared total to corroborate it. */
  | 'repeated_page'
  /** The walk's own `maxPages` was reached while more pages existed. */
  | 'page_cap'
  /** A request failed outright. */
  | 'request_error'
  /** The platform rate-limited the channel. */
  | 'rate_limited'
  /** A degraded source returned fewer rows than it claimed. */
  | 'degraded'
  /** The platform reports the content as deleted or unavailable. */
  | 'deleted_or_unavailable'
  /**
   * The platform's own pagination signals contradict each other.
   *
   * v0.2.2: a platform that declares `declaredTotalPages: 8` and then answers
   * page 1 with `hasMore: false` used to be taken at its word — the walk stopped
   * with `pagesRead: 1, complete: true, stopReason: 'confirmed_end'`. Two
   * mutually exclusive claims ("there are 8 pages" / "page 1 was the last") were
   * resolved in favour of whichever field the code happened to read first.
   *
   * Neither claim can be trusted alone once they conflict, so the read is neither
   * complete nor failed: it is *inconsistent*, and saying so is the only honest
   * answer. The data read so far is kept.
   */
  | 'inconsistent_pagination'
  /** The walk ended for a reason this module cannot classify. */
  | 'unknown'

/** The outcome of walking every floor page. */
export interface FloorWalk {
  readonly floors: readonly Floor[]
  readonly declaredTotal?: number
  readonly totalPages?: number
  readonly pagesRead: number
  readonly complete: boolean
  readonly missingCount?: number
  readonly error?: string
  /** Why the walk ended; `page_cap` means the read is incomplete by definition. */
  readonly stopReason: StopReason
  /** True when more pages were known to remain when the walk stopped. */
  readonly truncated: boolean
  /**
   * Human-readable notes about coverage, including signal contradictions.
   *
   * v0.2.2: the walk can end while platform signals disagree, and that fact is
   * worth keeping even though `stopReason` already names it, because the caller
   * has to be able to tell the user *which* numbers disagreed.
   */
  readonly issues: readonly string[]
}

/** Append a note without repeating one that is already there. */
function appendIssue(issues: readonly string[], note: string): string[] {
  return issues.includes(note) ? [...issues] : [...issues, note]
}

/**
 * Walk every floor page of a thread through the generic adapter interface.
 *
 * Stops on any of: an error, an empty page, a page of only already-seen floors,
 * the declared last page, or the page cap. Deduplication is by post id, so a
 * platform that repeats the last floor on every page cannot inflate the count.
 */
export async function walkFloors(
  adapter: PlatformAdapter,
  ref: ThreadRef,
  options: { maxPages?: number; signal?: AbortSignal; onPage?: (page: number, collected: number) => void } = {},
): Promise<FloorWalk> {
  const maxPages = options.maxPages ?? 60
  const seen = new Map<string, Floor>()
  let declaredTotal: number | undefined
  let totalPages: number | undefined
  let pagesRead = 0
  let page = 1
  let failed: string | undefined
  // Tracked separately from `page` because the loop can end for several reasons
  // at the same page number, and only some of them mean "nothing left to read".
  let stopped: StopReason = 'unknown'
  let truncated = false
  // Contradictions and coverage notes found while walking. Kept here rather than
  // in `collectThread` because the walk is what observes them, and a caller that
  // reads `stopReason` needs the explanation next to it.
  let issues: string[] = []

  while (page <= maxPages) {
    let result
    try {
      result = await adapter.getReplies(ref, page, options.signal)
    } catch (error) {
      failed = (error as Error).message
      // A rate-limit is not the same fact as a transport error: one says "slow
      // down and the data is still there", the other says "the read failed".
      const code = (error as { code?: unknown }).code
      stopped =
        code === 'rate_limited'
          ? 'rate_limited'
          : code === 'not_found' || code === 'forbidden'
            ? 'deleted_or_unavailable'
            : 'request_error'
      break
    }
    pagesRead += 1
    // The platform declares the thread's full floor count and page count; keep
    // the first values reported, since later pages repeat them.
    declaredTotal ??= result.declaredTotal
    totalPages ??= result.declaredTotalPages

    let added = 0
    for (const floor of result.floors) {
      if (!seen.has(floor.postId)) {
        seen.set(floor.postId, floor)
        added += 1
      }
    }
    options.onPage?.(page, seen.size)

    // A declared total is corroboration: when the platform tells us how many
    // floors exist, reaching that number is proof, and falling short is evidence
    // of a gap. Without one, an empty or repeating page proves only that the walk
    // has stopped producing new data — not that there is none.
    //
    // `>` rather than `===` because over-running the declared total is its own
    // contradiction: a platform that says "10 floors" and then serves 12 has
    // demonstrated that its own count is wrong, so that count cannot be used to
    // certify anything. Treating "≥ declared" as proof of completeness would let
    // the very number that just proved unreliable certify the read.
    const declaredTotalOverrun =
      declaredTotal !== undefined && declaredTotal > 0 && seen.size > declaredTotal
    if (declaredTotalOverrun) {
      stopped = 'inconsistent_pagination'
      issues = appendIssue(
        issues,
        `平台分页信号自相矛盾：声明共 ${declaredTotal} 楼，实际读到 ${seen.size} 楼。` +
          '平台给出的楼层总数已经不可信，无法据此断言已读完整；数据保留，完整性不成立。',
      )
      break
    }
    const reachedDeclaredTotal =
      declaredTotal !== undefined && declaredTotal > 0 && seen.size === declaredTotal

    if (result.floors.length === 0) {
      stopped = reachedDeclaredTotal ? 'confirmed_end' : 'empty_page'
      break
    }
    if (added === 0) {
      // The page held rows, but every one was already seen. That is the "platform
      // repeats the last page forever" case.
      stopped = reachedDeclaredTotal ? 'confirmed_end' : 'repeated_page'
      break
    }
    // The two "declared limits reached" branches below are the *reverse* of the
    // `hasMore: false` conflict further down, and v0.2.2 initially missed them:
    // the platform says `hasMore: true` ("there is another page") while its own
    // count says this was the last one. Stopping there and calling it
    // `confirmed_end` silently dropped the page the platform just promised.
    //
    // `hasMore: true` is the more direct claim — it is about the data that
    // exists right now, whereas a declared total is a summary that can go stale.
    // So a contradiction is reported rather than resolved: neither signal is
    // trusted to certify completeness.
    if (reachedDeclaredTotal || (totalPages !== undefined && page >= totalPages)) {
      if (result.hasMore) {
        stopped = 'inconsistent_pagination'
        issues = appendIssue(
          issues,
          `平台分页信号自相矛盾：${reachedDeclaredTotal ? `声明共 ${declaredTotal} 楼` : `声明共 ${totalPages} 页`}，` +
            `按此已读到最后，但平台同时说还有更多内容。已读取的 ${seen.size} 条保留，` +
            '但无法断定已读完整（平台承诺的下一页没有读取）。',
        )
        break
      }
      stopped = 'confirmed_end'
      break
    }
    if (!result.hasMore) {
      // `hasMore: false` is the platform's own word that this was the last page.
      // But it can *contradict* its other declaration: v0.2.1 read this branch
      // first and returned `complete: true` for a thread the platform had just
      // described as 8 pages long. Two exclusive claims cannot both be evidence,
      // so when they disagree the walk reports the disagreement instead of
      // picking a winner.
      const contradictsPageCount =
        totalPages !== undefined && pagesRead < totalPages
      if (contradictsPageCount) {
        stopped = 'inconsistent_pagination'
        issues = appendIssue(
          issues,
          `平台分页信号自相矛盾：声明共 ${totalPages} 页，但第 ${pagesRead} 页就报告没有更多了。` +
            `已读取的 ${seen.size} 条保留，但无法据此断定已读完整。`,
        )
        break
      }
      // A declared floor total that has not been reached is the same kind of
      // contradiction one level up: "there are N floors" versus "no more pages".
      const contradictsFloorTotal =
        declaredTotal !== undefined && declaredTotal > 0 && seen.size < declaredTotal
      if (contradictsFloorTotal) {
        stopped = 'inconsistent_pagination'
        issues = appendIssue(
          issues,
          `平台分页信号自相矛盾：声明共 ${declaredTotal} 层，但读完后只有 ${seen.size} 层且平台说没有更多页了。` +
            `可能是评论被删除，也可能是分页提前结束；已读取的数据保留，完整性不成立。`,
        )
        break
      }
      stopped = 'confirmed_end'
      break
    }
    // The page cap is a self-imposed limit. Hitting it while the platform still
    // reports more pages means the read is short, and saying "complete" would be
    // a lie about coverage.
    if (page >= maxPages) {
      stopped = 'page_cap'
      truncated = true
      break
    }
    page += 1
  }

  const floors = [...seen.values()].sort((a, b) => (a.floorNumber ?? 0) - (b.floorNumber ?? 0))
  const missingCount =
    declaredTotal !== undefined && declaredTotal > floors.length ? declaredTotal - floors.length : undefined

  // Completeness requires positive evidence, not merely the absence of an error.
  //
  // Every one of these must hold:
  // 1. the walk ended because the platform said so (`confirmed_end`);
  // 2. nothing failed on the way (`failed === undefined`);
  // 3. where a total was declared, every declared floor is actually here;
  // 4. the platform's own signals did not contradict each other.
  //
  // (4) is v0.2.2. `confirmed_end` used to be reachable through the `hasMore:
  // false` branch *even when* the same response had declared eight pages, so a
  // contradictory response still produced a confident "complete". A contradiction
  // is now its own stop reason, which is not `confirmed_end`, so this expression
  // already rejects it — the explicit check below documents the intent and keeps
  // it from regressing if the branches are ever reordered.
  const complete =
    failed === undefined &&
    stopped === 'confirmed_end' &&
    missingCount === undefined &&
    !truncated

  return {
    floors,
    declaredTotal,
    totalPages,
    pagesRead,
    complete,
    missingCount,
    error: failed,
    stopReason: stopped,
    truncated,
    issues,
  }
}

/** Walk every page of nested replies under one floor. */
export async function walkNested(
  adapter: PlatformAdapter,
  ref: ThreadRef,
  floor: Floor,
  options: { maxPages?: number; signal?: AbortSignal } = {},
): Promise<{ replies: readonly NestedReply[]; complete: boolean; error?: string; degraded?: boolean }> {
  const maxPages = options.maxPages ?? 10
  const seen = new Map<string, NestedReply>()
  let page = 1
  let error: string | undefined
  let degraded = false

  while (page <= maxPages) {
    let result
    try {
      result = await adapter.getNestedReplies(ref, floor, page, options.signal)
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
  return {
    replies,
    // A page that declares itself incomplete (a degraded source) is never a
    // complete read, even if the counts happen to line up.
    complete: error === undefined && !degraded && (declared === undefined || replies.length >= declared),
    error,
    degraded,
  }
}

/**
 * Collect a thread: metadata, every floor page, then nested replies for the
 * floors that matter.
 *
 * Partial success is a first-class outcome. A thread whose page 5 times out
 * returns everything from pages 1–4 plus an `issue` saying so, because a model
 * asked to help with an argument is better served by "here is most of it, and
 * here is exactly what is missing" than by a hard failure.
 */
export async function collectThread(
  adapter: PlatformAdapter,
  ref: ThreadRef,
  options: CollectOptions = {},
): Promise<CollectedThread> {
  const issues: string[] = []
  options.onProgress?.({ stage: 'thread', message: '正在读取主题帖…' })

  const thread = await adapter.getThread(ref, options.signal)

  options.onProgress?.({ stage: 'floors', message: '正在读取楼层…' })
  const all = await walkFloors(adapter, ref, {
    maxPages: options.maxPages,
    signal: options.signal,
    onPage: (page, collected) => {
      options.onProgress?.({
        stage: 'floors',
        message: `已读取第 ${page} 页，累计 ${collected} 楼`,
        current: page,
      })
    },
  })
  if (all.totalPages !== undefined) {
    options.onProgress?.({
      stage: 'floors',
      message: `共 ${all.totalPages} 页，已读到 ${all.floors.length} 楼`,
      current: all.pagesRead,
      total: all.totalPages,
    })
  }

  if (all.error) {
    issues.push(`楼层读取中断：${all.error}（已收集 ${all.floors.length} 楼）`)
  }
  if (all.stopReason === 'page_cap') {
    // Say it plainly: this is the plugin's own limit, not a deleted floor.
    issues.push(
      `已到达分页上限（${all.pagesRead} 页），但平台还有更多页没有读：` +
        `本次只读到 ${all.floors.length} 楼，不是完整结果。` +
        '可以提高 maxFloorPages，或用更长的运行时间重试。',
    )
  }
  if (all.missingCount !== undefined && all.missingCount > 0) {
    issues.push(
      `平台声明共 ${all.declaredTotal} 楼，实际可读 ${all.floors.length} 楼，` +
        `缺少 ${all.missingCount} 楼（通常是已删除或不可访问的楼层）`,
    )
  }

  let floors = [...all.floors]
  if (options.maxFloors !== undefined && floors.length > options.maxFloors) {
    issues.push(`楼层层数超过上限 ${options.maxFloors}，只保留了前面的 ${options.maxFloors} 楼`)
    floors = floors.slice(0, options.maxFloors)
  }

  // Nested replies are the expensive part: one request per floor per page. Only
  // floors that plausibly matter are fetched, and the caller decides which.
  const wantNested = options.wantNested ?? ((floor: Floor) => (floor.nestedCount ?? 0) > 0)
  const nestedTargets = floors.filter(wantNested)
  const nestedLimit = options.nestedFloorLimit ?? nestedTargets.length
  const withNested: FloorWithNested[] = []
  let nestedDone = 0

  let nestedIncomplete = false
  for (const floor of floors) {
    const targetIndex = nestedTargets.indexOf(floor)
    const shouldFetch = nestedLimit > 0 && targetIndex >= 0 && targetIndex < nestedLimit
    if (!shouldFetch) {
      // A floor whose replies were deliberately not fetched is *not* complete
      // when the platform says it has some: the caller must not read "no nested
      // data" as "no nested replies exist". This holds even when the limit is
      // zero, because the argument may well live in those unread replies.
      const declared = floor.nestedCount ?? 0
      if (declared > 0) nestedIncomplete = true
      withNested.push({ floor, nested: [], nestedComplete: declared === 0 })
      continue
    }
    options.onProgress?.({
      stage: 'nested',
      message: `正在读取 ${floorLabel(floor.floorNumber, floor.postId)} 的楼中楼…`,
      current: nestedDone,
      total: Math.min(nestedTargets.length, nestedLimit),
    })
    const nested = await walkNested(adapter, ref, floor, { signal: options.signal })
    if (nested.error) {
      nestedIncomplete = true
      issues.push(`${floorLabel(floor.floorNumber, floor.postId)} 楼中楼读取失败：${nested.error}`)
    } else if (!nested.complete) {
      nestedIncomplete = true
      // Say which way it is incomplete: a degraded source read fewer replies from
      // a working page, which is a different fact from a page that failed.
      const reason = nested.degraded
        ? '楼中楼分页接口被限流，使用了帖子页内联的不完整副本'
        : '读取到的条数少于平台声明'
      issues.push(
        `${floorLabel(floor.floorNumber, floor.postId)} 楼中楼不完整（${reason}）：平台声明 ${floor.nestedCount ?? '?'} 条，` +
          `读取到 ${nested.replies.length} 条`,
      )
    }
    withNested.push({ floor, nested: nested.replies, nestedComplete: nested.complete })
    nestedDone += 1
  }

  options.onProgress?.({ stage: 'done', message: '读取完成' })

  const completeness = buildCompleteness({
    all,
    keptFloors: withNested.length,
    droppedByCap: all.floors.length - withNested.length,
    nestedIncomplete,
  })

  return {
    thread,
    floors: withNested,
    // v0.2.2: strictly stronger than the old value. `complete` is now the
    // conjunction of "the platform proved we saw it" and "we kept what we saw",
    // so a `maxFloors` cap can no longer report `true` for a partial thread.
    complete: completeness.sourceComplete && completeness.retainedComplete,
    completeness,
    missingCount: all.missingCount,
    stopReason: all.stopReason,
    truncated: all.truncated,
    nestedIncomplete,
    issues,
  }
}

/**
 * Turn the walk facts into the four separate verdicts.
 *
 * Each line below is a distinct question, and the point of this function is that
 * none of them is allowed to answer for another:
 *
 * - **source** asks what the *platform* proved. It is false whenever the walk
 *   stopped without evidence of an end, including the v0.2.2
 *   `inconsistent_pagination` case.
 * - **retained** asks what *we kept*. Only our own trimming can fail it. This is
 *   the one that was missing: reading 3 floors and cutting to 1 by `maxFloors`
 *   left the old single `complete` flag at `true`.
 * - **analysis** asks whether the chain needed to answer is present. It requires
 *   the source to be complete *and* the floors that hold the dispute to have
 *   their replies read — a truncated nested walk can hide the argument even when
 *   every floor was read.
 * - **nested** is the per-floor roll-up of the same nested facts.
 */
function buildCompleteness(input: {
  all: FloorWalk
  keptFloors: number
  droppedByCap: number
  nestedIncomplete: boolean
}): CompletenessReport {
  const { all, keptFloors, droppedByCap, nestedIncomplete } = input
  const reasons: string[] = []

  const sourceComplete = all.complete
  if (!sourceComplete) {
    reasons.push(
      all.stopReason === 'inconsistent_pagination'
        ? '平台分页信号自相矛盾，无法证明来源已读完整'
        : `来源未读完整（${all.stopReason}）`,
    )
  }

  const retainedComplete = droppedByCap === 0
  if (!retainedComplete) {
    reasons.push(
      `本地裁剪丢弃了 ${droppedByCap} 条（保留 ${keptFloors} 条）：模型没有看到这些内容，不能当作已读完`,
    )
  }

  const nestedComplete = !nestedIncomplete
  if (!nestedComplete) {
    reasons.push('部分楼层的楼中楼未读全，争论可能就藏在没读到的回复里')
  }

  // Analysis completeness is deliberately the strictest of the three: the model
  // is about to argue using this data, and "I read most of it" is not a basis for
  // asserting what the opponent did and did not say.
  const analysisComplete = sourceComplete && retainedComplete && nestedComplete
  if (sourceComplete && retainedComplete && !nestedComplete) {
    reasons.push('楼层已读全，但楼中楼缺失会影响对争论链的还原，发表前请确认')
  }

  const declared = all.declaredTotal
  const retainedRatio =
    declared !== undefined && declared > 0 ? Math.min(1, keptFloors / declared) : undefined

  return {
    sourceComplete,
    retainedComplete,
    analysisComplete,
    nestedComplete,
    ...(all.missingCount !== undefined ? { missingCount: all.missingCount } : {}),
    ...(droppedByCap > 0 ? { droppedByCap } : {}),
    ...(retainedRatio !== undefined ? { retainedRatio } : {}),
    reasons,
  }
}

/**
 * Locate the exact post the owner pointed at, and return its neighbourhood.
 *
 * This is the entry point the trigger path uses: a URL with `?pid=` or an
 * explicit reply id resolves here, and an id that cannot be found is an
 * explicit error rather than a fallback to "the last floor".
 */
export async function locateReply(
  adapter: PlatformAdapter,
  ref: ThreadRef,
  postId: string,
  signal?: AbortSignal,
): Promise<ReplyContext> {
  return adapter.getReplyContext(ref, postId, signal)
}

/** Flatten a collected thread into one ordered timeline of posts. */
export interface TimelineEntry {
  readonly kind: 'floor' | 'nested'
  readonly postId: string
  /**
   * The floor this entry belongs to, by the floor post's stable id.
   *
   * v0.2.1: this is the grouping key. It used to be `floorNumber`, which forced
   * any non-forum platform to invent a number so that a microblog post and its
   * comments could be told apart from the next one. The post id already
   * identifies the floor uniquely on every platform and needs no invention, so
   * the core groups on it and `floorNumber` is left for display only.
   */
  readonly floorPostId: string
  /** The number the platform displays for the floor, when it displays one. */
  readonly floorNumber?: number
  readonly authorId?: string
  readonly authorName?: string
  /** Display order within the floor; floors use 0. */
  readonly order: number
  readonly content: string
  readonly createdAt?: string
  readonly replyToName?: string
  readonly relationUncertain?: boolean
}

/** Build the ordered timeline the analyzer reads. */
export function buildTimeline(collected: CollectedThread): readonly TimelineEntry[] {
  const out: TimelineEntry[] = []
  for (const entry of collected.floors) {
    out.push({
      kind: 'floor',
      postId: entry.floor.postId,
      floorPostId: entry.floor.postId,
      floorNumber: entry.floor.floorNumber,
      authorId: entry.floor.authorId,
      authorName: entry.floor.authorName,
      order: 0,
      content: entry.floor.content,
      createdAt: entry.floor.createdAt,
    })
    entry.nested.forEach((reply, index) => {
      out.push({
        kind: 'nested',
        postId: reply.postId,
        floorPostId: entry.floor.postId,
        floorNumber: entry.floor.floorNumber,
        authorId: reply.authorId,
        authorName: reply.authorName,
        order: index + 1,
        content: reply.content,
        createdAt: reply.createdAt,
        replyToName: reply.replyToName,
        relationUncertain: reply.relationUncertain,
      })
    })
  }
  return out
}

/**
 * How to name a floor in human-facing text.
 *
 * v0.2.1: `floorNumber` is optional — a microblog has no 楼层 — so every message
 * that used to interpolate `${floorNumber} 楼` could print "第 undefined 楼".
 * One helper keeps that from coming back: the label is a number when the
 * platform gives one, and the post id when it does not.
 */
export function floorLabel(floorNumber: number | undefined, postId: string): string {
  return floorNumber === undefined ? postId : `第 ${floorNumber} 楼`
}

/** Find an entry in a timeline by post id. */
export function findInTimeline(
  timeline: readonly TimelineEntry[],
  postId: string,
): TimelineEntry | undefined {
  return timeline.find((entry) => entry.postId === postId)
}

/** The floor that contains a timeline entry. */
export function floorOf(
  collected: CollectedThread,
  postId: string,
): FloorWithNested | undefined {
  return collected.floors.find(
    (entry) => entry.floor.postId === postId || entry.nested.some((reply) => reply.postId === postId),
  )
}

/** Throw a normalized error when a thread could not be read at all. */
export function assertCollected(collected: CollectedThread): void {
  if (collected.floors.length === 0) {
    throw new PlatformError('没有读取到任何楼层，该帖子可能已删除或需要登录', 'not_found')
  }
}
