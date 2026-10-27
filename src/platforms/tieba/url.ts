/**
 * URL parsing for Tieba.
 *
 * Tieba links arrive in many shapes — `/p/<tid>`, `/mo/q/m?kz=<tid>`,
 * `/f?kw=<forum>` with a `pid` anchor, share links with query junk. Parsing
 * lives here so the adapter never sniffs strings, and so a bad URL produces a
 * clear error instead of a confusing 404 much later.
 */

import { PlatformError, type ThreadRef } from '../../types.js'

/** A successfully parsed Tieba thread reference. */
export interface TiebaThreadRef extends ThreadRef {
  readonly platform: 'tieba'
  /** Forum id, when the URL carried one (`fid=`). */
  readonly forumId?: string
}

/** Pull a numeric thread id out of a Tieba URL. */
export function parseTiebaUrl(input: string): TiebaThreadRef {
  const raw = input.trim()
  if (!raw) throw new PlatformError('帖子 URL 为空', 'malformed_response')

  // A bare number is accepted as a thread id, which is what a user pastes most
  // often after copying from the app.
  if (/^\d{4,}$/.test(raw)) {
    return { platform: 'tieba', threadId: raw, url: `https://tieba.baidu.com/p/${raw}` }
  }

  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    throw new PlatformError(`无法解析帖子 URL：${raw}`, 'malformed_response')
  }
  if (!/(^|\.)tieba\.baidu\.com$/i.test(url.hostname) && !/(^|\.)baidu\.com$/i.test(url.hostname)) {
    throw new PlatformError(`不是贴吧链接：${url.hostname}`, 'malformed_response')
  }

  const params = url.searchParams
  const threadId =
    readNumericPath(url.pathname, /^\/p\/(\d+)/) ??
    params.get('kz') ??
    params.get('tid') ??
    readNumericPath(url.pathname, /\/(\d{6,})/)
  if (!threadId || !/^\d+$/.test(threadId)) {
    throw new PlatformError('链接里没有找到帖子 ID（需要 /p/<tid> 或 ?kz=<tid>）', 'malformed_response')
  }

  const forumId = params.get('fid') ?? undefined
  const forumName = params.get('kw') ? decodeURIComponent(params.get('kw') as string) : undefined
  // `pid` (PC) and `spid`/`postid` (mobile share) all name a specific post.
  const postId = params.get('pid') ?? params.get('spid') ?? params.get('postid') ?? undefined

  return {
    platform: 'tieba',
    threadId,
    forumId,
    forumName,
    postId: postId && /^\d+$/.test(postId) ? postId : undefined,
    url: `https://tieba.baidu.com/p/${threadId}`,
  }
}

/** Match a pathname against a numeric capture group. */
function readNumericPath(pathname: string, pattern: RegExp): string | undefined {
  const found = pattern.exec(pathname)
  return found?.[1]
}

/** Build the canonical shareable URL for a thread. */
export function threadUrl(threadId: string): string {
  return `https://tieba.baidu.com/p/${threadId}`
}

/** Build a link that opens one specific post. */
export function postUrl(threadId: string, postId: string): string {
  return `https://tieba.baidu.com/p/${threadId}?pid=${postId}#${postId}`
}
