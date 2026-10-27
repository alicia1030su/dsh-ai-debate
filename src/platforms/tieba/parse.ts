/**
 * HTML/JSON parsing for the Tieba reading surface.
 *
 * Pure functions only: a string in, structures out. No network, no state, no
 * clock. Every selector here was observed against the live site and is pinned
 * by a fixture in `test/fixtures/`, because a scraper that is only validated
 * against markup someone typed from memory is worse than no scraper at all.
 *
 * ## What Tieba actually exposes
 *
 * - The WAP thread page (`/mo/q/m?kz=<tid>&pn=<offset>`) is UTF-8 and carries
 *   the floor list: post id, floor number, author *username*, display name,
 *   body, date and image URLs.
 * - It does **not** carry a numeric user id for floors. The only stable handle
 *   the markup gives is the `un` (username) plus `portrait` token. Numeric ids
 *   appear only in the `totalComment` JSON, so identity binding has to accept
 *   either form.
 * - The thread title lives in `.post_title_embed`, and is empty for threads
 *   whose first post has no title. It is never fabricated.
 * - Nested replies are **not** inline on the WAP page. The floor only reports
 *   `data-list-count`; the actual replies come from `/p/comment`.
 */

import type { Floor, NestedReply } from '../../types.js'

/** Decode the entities Tieba emits inside attributes and text nodes. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** `String.fromCodePoint` that survives a malformed entity instead of throwing. */
function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** Strip tags and collapse whitespace, producing the plain text a reader sees. */
export function toPlainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The `page: {...}` metadata the WAP page embeds in a script. */
export interface WapPageMeta {
  readonly currentPage?: number
  readonly totalPages?: number
  readonly totalCount?: number
  readonly pageSize?: number
  readonly offset?: number
}

/** Read the WAP paging metadata. */
export function parseWapPageMeta(html: string): WapPageMeta {
  const block = /\bpage:\s*\{([^}]*)\}/.exec(html)?.[1]
  if (!block) return {}
  const read = (key: string): number | undefined => {
    const found = new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`).exec(block)
    return found ? Number(found[1]) : undefined
  }
  return {
    currentPage: read('current_page'),
    totalPages: read('total_page'),
    totalCount: read('total_num'),
    pageSize: read('page_size'),
    offset: read('offset'),
  }
}

/** Thread-level metadata embedded in the WAP page. */
export interface WapThreadMeta {
  readonly forumId?: string
  readonly forumName?: string
  readonly title?: string
  readonly tbs?: string
}

/**
 * Read forum id/name, thread title and the CSRF token from a WAP page.
 *
 * The title comes from `.post_title_embed`; an empty one means the thread has
 * no title, which is a real state on Tieba (many threads are body-only).
 */
export function parseWapThreadMeta(html: string): WapThreadMeta {
  const forumId = /\bfid:\s*["']?(\d+)/.exec(html)?.[1]
  const forumName =
    /\bforum_name:\s*"([^"]*)"/.exec(html)?.[1] ??
    /\bfname:\s*"([^"]*)"/.exec(html)?.[1] ??
    /<a[^>]*class="post_title_text"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1]
  const embed = /<div class="post_title_embed">([\s\S]*?)<\/div>/.exec(html)?.[1]
  const confTitle = /\bconf:\s*\{[\s\S]{0,600}?'title':\s*"([^"]*)"/.exec(html)?.[1]
  const rawTitle = embed !== undefined ? toPlainText(embed) : confTitle ? decodeEntities(confTitle) : ''
  const tbs = /\bitb_tbs:\s*'([0-9a-fA-F]+)'/.exec(html)?.[1]
  return {
    forumId,
    forumName: forumName ? decodeEntities(forumName).trim() : undefined,
    title: rawTitle.trim(),
    tbs,
  }
}

/** One floor block located in the raw page, with its own byte range. */
interface FloorAnchor {
  readonly start: number
  readonly end: number
}

/**
 * Locate every first-level floor block.
 *
 * Nested `<li>` elements exist inside floors, so the split anchors on the
 * floor's own opening tag — the only one carrying `tid=` *and* `fn=`.
 */
export function findFloorAnchors(html: string): readonly FloorAnchor[] {
  const starts: number[] = []
  const re = /<li\s+tid="\d+"\s+data-tid="\d+"\s+fn="\d+"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) starts.push(match.index)
  return starts.map((start, index) => ({
    start,
    end: index + 1 < starts.length ? (starts[index + 1] as number) : html.length,
  }))
}

/** Parse a floor's `data-info` attribute into its JSON object. */
function readDataInfo(block: string): Record<string, unknown> {
  const raw = /data-info="([\s\S]*?)"/.exec(block)?.[1]
  if (!raw) return {}
  try {
    return JSON.parse(decodeEntities(raw)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Read the floor's own opening-tag numbers. */
function readFloorIdentity(block: string): { postId: string; floorNumber: number } | null {
  const open = /<li\s+tid="(\d+)"\s+data-tid="\d+"\s+fn="(\d+)"/.exec(block)
  if (!open) return null
  return { postId: open[1] as string, floorNumber: Number(open[2]) }
}

/** Cut a floor block at its nested-reply panel, keeping only its own markup. */
function headOf(block: string): string {
  let cut = block.length
  for (const marker of ['j_floor_panel', '<div class="fr_list']) {
    const at = block.indexOf(marker)
    if (at >= 0 && at < cut) cut = at
  }
  return block.slice(0, cut)
}

/**
 * Extract the inner HTML of the first element whose opening tag matches.
 *
 * A regex cannot do this: floor bodies contain nested `<div>`s (image strips,
 * link cards), so the naive `([\s\S]*?)</div>` stops at the first inner close
 * and leaks markup into the text. This counts `div` depth instead.
 */
function innerHtmlOf(html: string, openingTag: RegExp): string | undefined {
  const open = openingTag.exec(html)
  if (!open) return undefined
  const start = open.index + open[0].length
  let depth = 1
  let cursor = start
  const tagRe = /<div\b|<\/div>/gi
  tagRe.lastIndex = start
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(html)) !== null) {
    if (match[0].toLowerCase() === '<div') {
      depth += 1
    } else {
      depth -= 1
      if (depth === 0) {
        cursor = match.index
        return html.slice(start, cursor)
      }
    }
  }
  return html.slice(start)
}

/** Extract image URLs, preferring the full-size `data-url` over thumbnails. */
function extractImages(block: string): readonly string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  const push = (raw: string): void => {
    const url = decodeEntities(raw)
    if (!/^https?:\/\//.test(url) || seen.has(url)) return
    seen.add(url)
    urls.push(url)
  }
  for (const match of block.matchAll(/class="pb_img_item"[^>]*data-url='([^']+)'/g)) {
    push(match[1] as string)
  }
  for (const match of block.matchAll(/<img[^>]+(?:data-original|src)="([^"]+)"/g)) {
    const url = match[1] as string
    if (!/tieba|bdstatic|baidu/i.test(url)) continue
    if (/portrait|sys\/portrait|avatar/i.test(url)) continue
    push(url)
  }
  return urls
}

/** Read the floor body from `.content`, excluding image scaffolding. */
function readFloorContent(block: string): string {
  const head = headOf(block)
  const inner = innerHtmlOf(head, /<div class="content"[^>]*>/)
  if (inner === undefined) return ''
  // Image strips and the app banner are scaffolding, not prose.
  const trimmed = inner
    .replace(/<div id="pb_less_imgs"[\s\S]*?(?=<div class="pb_img_item"|$)/g, '')
    .replace(/<div class="pb_img_item"[\s\S]*?<\/div>/g, '')
    .replace(/<div id="diversBanner"[\s\S]*?<\/div>/g, '')
  return toPlainText(trimmed)
}

/** Read the floor's displayed date. */
function readFloorTime(block: string): string | undefined {
  const raw = /<span class="list_item_time">([^<]*)<\/span>/.exec(headOf(block))?.[1]
  const text = raw ? decodeEntities(raw).trim() : ''
  return text || undefined
}

/** Read the author's username (`un`) and display name. */
function readFloorAuthor(block: string, info: Record<string, unknown>): {
  authorId?: string
  authorName?: string
} {
  const un = typeof info.un === 'string' && info.un ? info.un : undefined
  const nameShow = typeof info.name_show === 'string' && info.name_show ? info.name_show : undefined
  const rendered = /<a href="javascript:;" class="user_name">([\s\S]*?)<\/a>/.exec(headOf(block))?.[1]
  return {
    authorId: un,
    authorName: rendered ? toPlainText(rendered) || nameShow : nameShow,
  }
}

/** Read the platform's own nested-reply counter for this floor. */
function readNestedCount(block: string): number | undefined {
  const panel = /j_floor_panel"[^>]*data-list-count="(\d+)"/.exec(block)?.[1]
  if (panel !== undefined) return Number(panel)
  const label = headOf(block)
  // Some layouts render "N条回复" next to the reply button instead.
  const rendered = /(\d+)\s*条回复/.exec(block.slice(0, block.length))
  return rendered ? Number(rendered[1]) : label ? undefined : undefined
}

/** One parsed floor. */
export interface ParsedFloor {
  readonly floor: Floor
  /** Portrait token, used as a secondary identity handle. */
  readonly portrait?: string
}

/**
 * Parse every floor in a WAP page, in platform display order.
 *
 * @param html the WAP thread page body
 * @returns parsed floors; floors whose opening tag cannot be read are skipped
 *   rather than guessed at
 */
export function parseWapFloors(html: string): readonly ParsedFloor[] {
  const out: ParsedFloor[] = []
  const seen = new Set<string>()
  for (const anchor of findFloorAnchors(html)) {
    const block = html.slice(anchor.start, anchor.end)
    const identity = readFloorIdentity(block)
    if (!identity || seen.has(identity.postId)) continue
    seen.add(identity.postId)
    const info = readDataInfo(block)
    const author = readFloorAuthor(block, info)
    const inlineNested = parseInlineNested(block, identity.postId)
    out.push({
      floor: {
        platform: 'tieba',
        floorNumber: identity.floorNumber,
        postId: identity.postId,
        authorId: author.authorId,
        authorName: author.authorName,
        content: readFloorContent(block),
        createdAt: readFloorTime(block),
        images: extractImages(block),
        nestedCount: readNestedCount(block),
        ...(inlineNested.length > 0
          ? { inlineNested: inlineNested.map((entry) => entry.reply) }
          : {}),
      },
      portrait: typeof info.portrait === 'string' ? info.portrait : undefined,
    })
  }
  return out
}

/** One nested reply parsed from `/p/comment` or read inline from a floor page. */
export interface ParsedNested {
  readonly reply: NestedReply
  readonly portrait?: string
}

/**
 * Read the nested replies that the WAP floor page inlines.
 *
 * The page is not a reliable full copy: measured on a live 219-floor thread it
 * inlined 21 of the 36 replies the platform declared, and its
 * `data-list-count` attribute often reported 0 for floors that do have replies.
 * So this is a *degraded* source that is used only when the paginated channel is
 * unreachable, and the caller must compare against {@link readNestedCount} to
 * learn whether anything is missing.
 *
 * The relation is read the same way as the HTML channel: from the "回复 X :"
 * prefix inside `.floor_content`. The `user_name` anchor that precedes it is the
 * author of *this* reply, never the person being answered.
 *
 * @param block one floor's raw markup
 * @param floorPostId the floor these replies hang under
 * @returns the replies in display order; empty when the floor inlines none
 */
export function parseInlineNested(block: string, floorPostId: string): readonly ParsedNested[] {
  const panel = /<ul class="flist">([\s\S]*?)<\/ul>/.exec(block)
  if (!panel) return []

  const out: ParsedNested[] = []
  const items = panel[1] as string
  const starts = [...items.matchAll(/<li\b[^>]*\bpid="\d+"/g)].map((match) => match.index as number)
  for (let index = 0; index < starts.length; index += 1) {
    const slice = items.slice(starts[index], starts[index + 1] ?? items.length)
    const pid = /<li\b[^>]*\bpid="(\d+)"/.exec(slice)?.[1]
    if (!pid) continue

    const info = readNestedInfo(slice)
    const author = typeof info.un === 'string' ? info.un : undefined
    // `<a ... class="user_name ">NAME:</a><span class="floor_content">BODY</span>`
    const anchor = /<a[^>]*class="user_name[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(slice)?.[1] ?? ''
    const authorName = toPlainText(anchor).replace(/[:：]\s*$/, '') || author
    const body = /<span class="floor_content">([\s\S]*?)<\/span>/.exec(slice)?.[1] ?? ''
    const content = toPlainText(body.replace(/<img\b[^>]*>/gi, ''))

    // "回复 X：" / "回复 X:" — the only relation signal this surface provides.
    const target = /^\s*回复\s*([^:：]+)[:：]/.exec(content)
    const replyToName = target ? (target[1] as string).trim() : undefined

    out.push({
      reply: {
        platform: 'tieba',
        postId: pid,
        parentPostId: floorPostId,
        authorId: author,
        authorName,
        replyToName,
        content: replyToName ? content.slice(target ? (target[0] as string).length : 0).trim() : content,
        // The inline copy carries no timestamp, and the reply target is a name
        // rather than an id, so a relation keyed on it is explicitly uncertain.
        relationUncertain: replyToName !== undefined,
      },
    })
  }
  return out
}

/** Read a nested `<li>`'s `data-info` object. */
function readNestedInfo(slice: string): Record<string, unknown> {
  const raw = /data-info='([\s\S]*?)'/.exec(slice)?.[1]
  if (!raw) return {}
  try {
    return JSON.parse(decodeEntities(raw)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Result of one `/p/comment` page. */
export interface ParsedCommentPage {
  readonly replies: readonly ParsedNested[]
  readonly total: number
  readonly totalPages: number
}

/** One `<a>` element split into its attribute string and inner HTML. */
interface Anchor {
  readonly attrs: string
  readonly inner: string
}

/**
 * Enumerate every `<a>` element in a fragment.
 *
 * Attribute order in Tieba's markup is not stable — `username` sometimes leads
 * `class`, sometimes trails it — so a regex pinning a fixed sequence silently
 * fails to match. Reading the whole attribute string and pulling values out of
 * it afterwards is order-independent.
 */
function findAnchors(html: string): readonly Anchor[] {
  const out: Anchor[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    out.push({ attrs: match[1] ?? '', inner: match[2] ?? '' })
  }
  return out
}

/** Read one attribute value out of a raw attribute string. */
function attr(attrs: string, name: string): string | undefined {
  const found = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)
  if (!found) return undefined
  const value = decodeEntities(found[1] as string).trim()
  return value || undefined
}

/**
 * Parse a `/p/comment` page.
 *
 * ## Reading reply relations honestly
 *
 * The markup gives two different names, and they mean opposite things:
 *
 * - The leading `<a class="at j_user_card">DISPLAY</a>:` before the body names
 *   the **author of this reply** (its `username` is that author's account).
 *   Treating it as the reply target would make every conversation look like
 *   people answering themselves — a real bug this parser had and now pins
 *   with a fixture-based test.
 * - The body prefix `回复 <a class="at">NAME</a> :` names the user actually
 *   answered. Only that is a reply target.
 *
 * So a reply with no such prefix is a direct reply to the floor: a certain
 * relation, not an unknown one. A reply that carries the prefix but whose name
 * cannot be read keeps `relationUncertain`, and downstream code must ask
 * rather than guess.
 */
export function parseCommentPage(html: string, floorPostId: string): ParsedCommentPage {
  const decodedCounters = decodeEntities(html)
  const counters = /"total_num":(\d+)[\s\S]{0,200}?"total_page":(\d+)/.exec(decodedCounters)
  const total = counters ? Number(counters[1]) : 0
  const totalPages = counters ? Number(counters[2]) : 0

  const replies: ParsedNested[] = []
  const seen = new Set<string>()
  const blocks = html.split(/<li[^>]*class="[^"]*lzl_single_post[^"]*"/).slice(1)
  for (const block of blocks) {
    const fieldRaw = /data-field='([\s\S]*?)'/.exec(block)?.[1]
    let field: Record<string, unknown> = {}
    if (fieldRaw) {
      try {
        field = JSON.parse(decodeEntities(fieldRaw)) as Record<string, unknown>
      } catch {
        field = {}
      }
    }
    const postId =
      typeof field.spid === 'number'
        ? String(field.spid)
        : typeof field.spid === 'string'
          ? field.spid
          : undefined
    if (!postId || seen.has(postId)) continue
    seen.add(postId)

    const bodyHtml = /<span class="lzl_content_main"[^>]*>([\s\S]*?)<\/span>/.exec(block)?.[1] ?? ''
    const bodyAt = block.indexOf('<span class="lzl_content_main"')
    const leadHtml = bodyAt > 0 ? block.slice(0, bodyAt) : ''

    // The reply target is the anchor inside the body's 回复 prefix, never the
    // lead anchor that simply labels the author.
    const bodyText = toPlainText(bodyHtml)
    let replyToName: string | undefined
    let relationUncertain = false
    if (/^\s*回复\s*/.test(bodyText)) {
      const anchors = findAnchors(bodyHtml)
      const named = anchors.find((anchor) => attr(anchor.attrs, 'username') !== undefined || /\bclass="[^"]*\bat\b[^"]*"/.test(anchor.attrs))
      replyToName = named ? toPlainText(named.inner).replace(/[:：]\s*$/, '').trim() || undefined : undefined
      relationUncertain = replyToName === undefined
    }

    const leadAnchors = findAnchors(leadHtml)
    const authorAnchor = leadAnchors.find((anchor) => /\bclass="[^"]*\bat\b[^"]*"/.test(anchor.attrs))
    const authorId = authorAnchor ? attr(authorAnchor.attrs, 'username') : undefined
    const authorName =
      (authorAnchor ? toPlainText(authorAnchor.inner).trim() || undefined : undefined) ??
      (typeof field.showname === 'string' && field.showname ? field.showname : undefined) ??
      (typeof field.user_name === 'string' && field.user_name ? field.user_name : undefined)

    const time = /<span class="lzl_time">([^<]*)<\/span>/.exec(block)?.[1]

    replies.push({
      reply: {
        platform: 'tieba',
        postId,
        parentPostId: floorPostId,
        authorId: authorId ?? (typeof field.user_name === 'string' && field.user_name ? field.user_name : undefined),
        authorName,
        replyToName,
        content: bodyText,
        createdAt: time ? decodeEntities(time).trim() : undefined,
        relationUncertain,
      },
      portrait: typeof field.portrait === 'string' ? field.portrait : undefined,
    })
  }
  return { replies, total, totalPages }
}

/** One entry of the `totalComment` JSON response. */
export interface TotalCommentEntry {
  readonly floorPostId: string
  readonly declaredCount: number
  readonly inline: readonly InlineComment[]
}

/** One inline comment from `totalComment`, which does carry numeric ids. */
export interface InlineComment {
  readonly commentId: string
  readonly postId: string
  readonly authorId?: string
  readonly authorName?: string
  readonly content: string
  readonly createdAt?: string
}

/** Parse a `totalComment` JSON body. */
export function parseTotalComment(raw: string): {
  readonly entries: readonly TotalCommentEntry[]
  readonly userNames: ReadonlyMap<string, string>
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [], userNames: new Map() }
  }
  const root = parsed as {
    errno?: number
    data?: {
      comment_list?: Record<string, { comment_num?: number; comment_info?: unknown[] }>
      user_list?: Record<string, { user_name?: string; name_show?: string }>
    }
  }
  if (root.errno !== undefined && root.errno !== 0) return { entries: [], userNames: new Map() }

  const userNames = new Map<string, string>()
  for (const [id, value] of Object.entries(root.data?.user_list ?? {})) {
    const name = value?.name_show || value?.user_name
    if (name) userNames.set(id, name)
  }

  const entries: TotalCommentEntry[] = []
  for (const [floorPostId, value] of Object.entries(root.data?.comment_list ?? {})) {
    const inline: InlineComment[] = []
    for (const item of value?.comment_info ?? []) {
      const row = item as {
        comment_id?: number | string
        post_id?: number | string
        user_id?: number | string
        username?: string
        content?: string
        now_time?: number
      }
      const commentId = row.comment_id === undefined ? undefined : String(row.comment_id)
      if (!commentId) continue
      inline.push({
        commentId,
        postId: row.post_id === undefined ? floorPostId : String(row.post_id),
        authorId: row.user_id === undefined ? undefined : String(row.user_id),
        authorName: row.username || (row.user_id === undefined ? undefined : userNames.get(String(row.user_id))),
        content: row.content ?? '',
        createdAt: row.now_time ? new Date(row.now_time * 1000).toISOString() : undefined,
      })
    }
    entries.push({
      floorPostId,
      declaredCount: typeof value?.comment_num === 'number' ? value.comment_num : inline.length,
      inline,
    })
  }
  return { entries, userNames }
}

/** Extract the CSRF token from any page that carries one. */
export function parseTbs(html: string): string | undefined {
  return (
    /\bitb_tbs:\s*'([0-9a-fA-F]+)'/.exec(html)?.[1] ??
    /"tbs"\s*:\s*"([0-9a-fA-F]+)"/.exec(html)?.[1] ??
    /\btbs\s*=\s*"([0-9a-fA-F]+)"/.exec(html)?.[1]
  )
}
