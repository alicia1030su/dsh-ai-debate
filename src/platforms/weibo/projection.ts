/**
 * Turn the official CLI's payloads into `Thread` / `Floor` / `NestedReply`.
 *
 * ## Why this is a separate module from the invocation layer
 *
 * `cli.ts` knows how to run a command and validate its argument shape. It deliberately
 * knows **nothing** about what a Weibo status body looks like. Keeping the projection
 * apart means:
 *
 * - it is testable against captured shapes without a CLI at all;
 * - a change in Weibo's field names touches one file;
 * - the mapping decisions (what is `stated` vs `inferred`, what counts as complete) are
 *   visible in one place instead of scattered through request code.
 *
 * ## The core rule
 *
 * A field that was not present stays absent. This module never invents a floor number, a
 * title, an author id, or an image list. Where the platform genuinely has no such concept
 * (Weibo has no 楼层), the field is omitted rather than filled with a placeholder — that
 * is exactly the mistake v0.2.1 had to undo.
 */

import type { Floor, NestedReply, Thread } from '../../types.js'

/** The numeric id the CLI uses for a status. */
export interface WeiboStatusPayload {
  readonly id?: unknown
  readonly idstr?: unknown
  readonly mid?: unknown
  readonly text?: unknown
  readonly created_at?: unknown
  readonly user?: unknown
  readonly pic_urls?: unknown
  readonly pic_ids?: unknown
  readonly comments_count?: unknown
  readonly reposts_count?: unknown
  readonly retweeted_status?: unknown
  readonly long_text?: unknown
  readonly is_long_text?: unknown
}

/** The numeric id the CLI uses for a comment. */
export interface WeiboCommentPayload {
  readonly id?: unknown
  readonly idstr?: unknown
  readonly text?: unknown
  readonly created_at?: unknown
  readonly user?: unknown
  readonly reply_comment?: unknown
  readonly reply_comment_total?: unknown
  readonly like_counts?: unknown
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * The status id, preferring the string form.
 *
 * `idstr` is a string and `id` may be a number that has already lost precision by the time
 * it reaches JavaScript. Preferring the string is what keeps a 16-digit mid exact.
 */
export function statusIdOf(payload: WeiboStatusPayload): string | undefined {
  return textOf(payload.idstr) ?? textOf(payload.mid) ?? textOf(payload.id)
}

/** The author, split into the two shapes the core expects. */
export function authorOf(user: unknown): { readonly id?: string; readonly name?: string } {
  if (typeof user !== 'object' || user === null) return {}
  const record = user as Record<string, unknown>
  const id = textOf(record.idstr) ?? textOf(record.id)
  const name =
    textOf(record.screen_name) ?? textOf(record.name) ?? textOf(record.screenName) ?? undefined
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
  }
}

/**
 * Image URLs, only when the payload actually carried them.
 *
 * Weibo returns either `pic_urls: [{thumbnail_pic}]` or `pic_ids: [string]`. A bare
 * `pic_ids` entry is not a URL, so it is only used to build the documented large-image
 * URL when it looks like an id; anything else is dropped rather than guessed.
 */
export function imagesOf(payload: WeiboStatusPayload | WeiboCommentPayload): string[] {
  const record = payload as Record<string, unknown>
  const urls: string[] = []
  const picUrls = record.pic_urls
  if (Array.isArray(picUrls)) {
    for (const entry of picUrls) {
      if (typeof entry === 'string') {
        urls.push(entry)
        continue
      }
      if (typeof entry === 'object' && entry !== null) {
        const thumbnail = (entry as Record<string, unknown>).thumbnail_pic
        if (typeof thumbnail === 'string' && thumbnail !== '') urls.push(thumbnail)
      }
    }
  }
  return urls
}

/** Whether the payload carries a long-text body we should prefer over the truncated one. */
export function longTextOf(payload: WeiboStatusPayload): string | undefined {
  return textOf(payload.long_text)
}

/**
 * Project one status into a `Thread`.
 *
 * The forum is `undefined`-shaped because a microblog has no 吧; `ForumRef` allows a
 * missing `id`, and inventing a forum name would be a claim about the platform.
 */
export function projectThread(payload: WeiboStatusPayload, threadId: string, url: string): Thread {
  const author = authorOf(payload.user)
  const body = longTextOf(payload) ?? textOf(payload.text) ?? ''
  const createdAt = textOf(payload.created_at)
  const comments = payload.comments_count
  const declared =
    typeof comments === 'number' && Number.isFinite(comments)
      ? comments
      : typeof comments === 'string' && /^\d+$/.test(comments)
        ? Number(comments)
        : undefined

  return {
    platform: 'weibo',
    // `ForumRef` requires a name because every Tieba thread lives in a 吧. A Weibo post
    // does not live in any 吧, and inventing a forum name would be a claim about the
    // platform. The empty string is the honest representation; the UI already falls back
    // to the platform label when the name is empty.
    forum: { platform: 'weibo', name: '' },
    id: threadId,
    // A Weibo post has no title. The first line of the body is the closest thing, and the
    // core already handles a thread whose title is empty.
    title: '',
    content: body,
    ...(author.id === undefined ? {} : { authorId: author.id }),
    ...(author.name === undefined ? {} : { authorName: author.name }),
    ...(createdAt === undefined ? {} : { createdAt }),
    url,
    ...(declared === undefined ? {} : { declaredReplyCount: declared }),
    images: imagesOf(payload),
  }
}

/**
 * An id we are willing to place on a command line.
 *
 * ## Why this is validated here (v0.2.12 audit)
 *
 * The id comes from the platform's payload, so it is **untrusted input**. It is passed to the
 * CLI as a separate argv element, which prevents *shell* injection — but not *argument*
 * injection: a value like `--output` is a perfectly valid argv element, and the CLI would read
 * it as a flag rather than as an id. The audit demonstrated exactly that:
 *
 *     projectCommentAsFloor({ idstr: '--output' })  →  postId '--output'
 *
 * which would become `comments/list <mid> --comment --output --page 1 --output json`.
 *
 * Both Weibo ids and comment ids are alphanumeric, so requiring `[0-9A-Za-z_]` costs nothing
 * real and closes the hole at the boundary where the value enters our data model.
 */
function safeId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return /^[0-9A-Za-z_]{1,64}$/.test(value) ? value : undefined
}

/**
 * Project one comment into a `Floor`.
 *
 * A comment is a first-level "floor" in the core's model even though Weibo does not number
 * it. `floorNumber` is therefore absent — the core addresses by `postId`.
 */
export function projectCommentAsFloor(payload: WeiboCommentPayload): Floor | undefined {
  const postId = safeId(textOf(payload.idstr) ?? textOf(payload.id))
  if (postId === undefined) return undefined
  const author = authorOf(payload.user)
  const body = textOf(payload.text) ?? ''
  const createdAt = textOf(payload.created_at)
  const nested = payload.reply_comment_total
  const nestedCount =
    typeof nested === 'number' && Number.isFinite(nested)
      ? nested
      : typeof nested === 'string' && /^\d+$/.test(nested)
        ? Number(nested)
        : undefined
  return {
    platform: 'weibo',
    postId,
    ...(author.id === undefined ? {} : { authorId: author.id }),
    ...(author.name === undefined ? {} : { authorName: author.name }),
    content: body,
    ...(createdAt === undefined ? {} : { createdAt }),
    images: imagesOf(payload),
    ...(nestedCount === undefined ? {} : { nestedCount }),
  }
}

/**
 * Project one comment as a nested reply under a floor.
 *
 * Used for `reply_comment` (the comment this one answers) and for comment-level replies
 * when a read returns them nested rather than as top-level comments.
 */
export function projectCommentAsNested(
  payload: WeiboCommentPayload,
  parentPostId: string,
): NestedReply | undefined {
  const postId = safeId(textOf(payload.idstr) ?? textOf(payload.id))
  if (postId === undefined) return undefined
  const author = authorOf(payload.user)
  const body = textOf(payload.text) ?? ''
  const createdAt = textOf(payload.created_at)
  // The payload carries a structured pointer at the comment being answered. v0.2.10 parsed it
  // and then discarded it with `void`, which left every Weibo reply edge missing even though
  // the platform states it outright — a strictly better source than Tieba's name guessing.
  const repliedTo = payload.reply_comment as Record<string, unknown> | undefined
  const replyToPostId = safeId(textOf(repliedTo?.idstr) ?? textOf(repliedTo?.id))
  const replyToName = authorOf(repliedTo?.user).name
  return {
    platform: 'weibo',
    postId,
    parentPostId,
    ...(author.id === undefined ? {} : { authorId: author.id }),
    ...(author.name === undefined ? {} : { authorName: author.name }),
    content: body,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(replyToPostId === undefined ? {} : { replyToPostId }),
    ...(replyToName === undefined ? {} : { replyToName }),
  }
}

/**
 * Pull the status payload out of whatever envelope the CLI wraps it in.
 *
 * ## Validity now means "id *and* body" (v0.2.12 audit)
 *
 * v0.2.11 accepted anything carrying an id. `{"idstr": "5012345678901234"}` therefore projected
 * into a `Thread` with an empty body and no author, and the failure only surfaced much later
 * in `analyzeDispute` as "the owner never spoke here" — a message that points at the wrong
 * problem. Requiring a body moves the failure to the place that can name it: the adapter
 * reports `malformed_response`.
 *
 * The author is still optional: a deleted or privacy-restricted account legitimately has none,
 * and the core already treats a nameless author as `name_only`.
 */
export function unwrapStatus(raw: unknown): WeiboStatusPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>

  const accept = (value: unknown): WeiboStatusPayload | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const candidate = value as WeiboStatusPayload
    if (statusIdOf(candidate) === undefined) return undefined
    if (longTextOf(candidate) === undefined && textOf(candidate.text) === undefined) return undefined
    return candidate
  }

  for (const key of ['status', 'data', 'result']) {
    const inner = accept(record[key])
    if (inner !== undefined) return inner
  }
  return accept(record)
}

/**
 * Pull a comment list out of whatever envelope the CLI wraps it in, plus its paging state.
 *
 * ## Three fixes from the v0.2.12 audit
 *
 * 1. **`{"data": [...]}`** — `typeof [] === 'object'`, so the old container selection picked
 *    the array itself, then every `Array.isArray(container.comments)` missed and the list came
 *    back empty. A perfectly sensible response was read as "zero comments", and the collector
 *    reported "the thread may have been deleted" — a diagnosis pointing at the wrong problem.
 *
 * 2. **Unknown paging state** — the old fallback was `cursor !== undefined`, which is `false`
 *    when neither field is present. The comment above it promised the opposite. That made a
 *    one-page read look like "the platform confirmed the end", so pages 2..N were never
 *    requested and the read claimed to be complete.
 *
 * 3. **`total_number` is not a completeness proof** — the manual says it does not equal the
 *    number of distinct comments after de-duplication. It is returned for comparison only.
 */
export function unwrapComments(raw: unknown): {
  readonly comments: readonly WeiboCommentPayload[]
  readonly declaredTotal?: number
  readonly nextCursor?: string
  readonly hasMore: boolean
  /**
   * `more` / `done` / `unknown`.
   *
   * `unknown` is the state the old code silently collapsed into `done`. Callers that must not
   * claim completeness can branch on it; `hasMore` stays a boolean for the existing contract,
   * and is `true` for `unknown` so a read never stops early on a guess.
   */
  readonly pagingState: 'more' | 'done' | 'unknown'
} {
  const empty = {
    comments: [] as readonly WeiboCommentPayload[],
    hasMore: false,
    pagingState: 'unknown' as const,
  }
  if (typeof raw !== 'object' || raw === null) return empty
  const record = raw as Record<string, unknown>

  // An array under `data` is a *list*, not a container. Checking this before the object
  // branches is what makes the common `{"data": [...]}` envelope work.
  const dataArray = Array.isArray(record.data) ? record.data : undefined
  const container =
    dataArray !== undefined
      ? record
      : typeof record.data === 'object' && record.data !== null
        ? (record.data as Record<string, unknown>)
        : typeof record.result === 'object' && record.result !== null
          ? (record.result as Record<string, unknown>)
          : record

  const list =
    dataArray ??
    (Array.isArray(container.comments) ? container.comments : undefined) ??
    (Array.isArray(container.data) ? container.data : undefined) ??
    (Array.isArray(record.comments) ? record.comments : undefined) ??
    []

  const comments: WeiboCommentPayload[] = []
  for (const entry of list) {
    if (typeof entry === 'object' && entry !== null) comments.push(entry as WeiboCommentPayload)
  }

  const total = container.total_number ?? record.total_number
  const declaredTotal =
    typeof total === 'number' && Number.isFinite(total)
      ? total
      : typeof total === 'string' && /^\d+$/.test(total)
        ? Number(total)
        : undefined

  const cursor = textOf(container.next_cursor) ?? textOf(record.next_cursor)
  const moreFlag = container.has_more ?? record.has_more
  // `has_more` may be a boolean or 0/1/"0"/"1". Anything else is unknown.
  const state: 'more' | 'done' | 'unknown' =
    typeof moreFlag === 'boolean'
      ? moreFlag
        ? 'more'
        : 'done'
      : moreFlag === 1 || moreFlag === '1'
        ? 'more'
        : moreFlag === 0 || moreFlag === '0'
          ? 'done'
          : cursor !== undefined
            ? 'more'
            : 'unknown'

  return {
    comments,
    ...(declaredTotal === undefined ? {} : { declaredTotal }),
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
    // Unknown means "there may be more": stopping early on a guess is the failure this
    // project keeps having to remove.
    hasMore: state !== 'done',
    pagingState: state,
  }
}
