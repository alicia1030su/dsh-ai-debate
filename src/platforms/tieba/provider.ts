/**
 * Tieba as a registered platform.
 *
 * This file is the *only* place that connects Tieba to the registry. The adapter
 * itself (`../tieba/adapter.js`) is unchanged from v0.1.13 — it was already a
 * competent `PlatformAdapter`, so the migration wraps it instead of rewriting
 * it.
 *
 * Everything platform-specific about Tieba lives on this side of the boundary:
 * its URL syntax, its host names, its capability matrix and its adapter options.
 * Nothing here is imported by `runtime.ts`, `publisher.ts` or `target.ts`.
 */

import type { PlatformAdapter, ThreadRef } from '../../types.js'
import type {
  LegacyCapabilityFlags,
  PlatformCapabilityMatrix,
  PlatformContext,
  PlatformProvider,
} from '../contracts.js'
import { TiebaAdapter } from './adapter.js'
import { parseTiebaUrl } from './url.js'

/** The registry id. Must equal the adapter's `id` and the config namespace. */
export const TIEBA_PLATFORM_ID = 'tieba'

/**
 * Hosts Tieba links use.
 *
 * Checked as a suffix match against the parsed hostname, so `tieba.baidu.com`,
 * `www.tieba.baidu.com` and a share subdomain all match, while
 * `nottieba.baidu.com.evil.example` does not.
 */
const TIEBA_HOSTS: readonly string[] = ['tieba.baidu.com', 'baidu.com']

/** True when the hostname belongs to Tieba (or Baidu, where its links live). */
function isTiebaHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return TIEBA_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))
}

/**
 * Can this URL be handled by Tieba?
 *
 * Never throws: junk, empty strings and non-URL input all answer `false`, because
 * the registry asks every provider in turn and one malformed link must not stop
 * the others from being tried.
 */
export function tiebaCanHandleUrl(url: string): boolean {
  if (typeof url !== 'string') return false
  const raw = url.trim()
  if (raw.length === 0) return false
  // A bare thread id is how users paste from the app.
  if (/^\d{4,}$/.test(raw)) return true
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return isTiebaHost(parsed.hostname)
  } catch {
    return false
  }
}

/** Tieba's adapter options, read from platform-scoped settings. */
function adapterOptionsOf(settings: Readonly<Record<string, unknown>>): {
  cookie?: string
  timeoutMs?: number
  retries?: number
  pageDelayMs?: number
  maxPages?: number
  authProbeThreadId?: string
  authProbeFallbacks?: readonly string[]
} {
  const num = (key: string): number | undefined => {
    const value = settings[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const str = (key: string): string | undefined => {
    const value = settings[key]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  }
  const list = (key: string): readonly string[] | undefined => {
    const value = settings[key]
    if (Array.isArray(value)) {
      const kept = value.filter((entry): entry is string => typeof entry === 'string')
      return kept.length > 0 ? kept : undefined
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.split(/[,\s]+/).filter((entry) => entry.length > 0)
    }
    return undefined
  }
  return {
    ...(str('cookie') === undefined ? {} : { cookie: str('cookie') }),
    ...(num('timeoutMs') === undefined ? {} : { timeoutMs: num('timeoutMs') }),
    ...(num('retries') === undefined ? {} : { retries: num('retries') }),
    ...(num('pageDelayMs') === undefined ? {} : { pageDelayMs: num('pageDelayMs') }),
    ...(num('maxPages') === undefined ? {} : { maxPages: num('maxPages') }),
    ...(str('authProbeThreadId') === undefined
      ? {}
      : { authProbeThreadId: str('authProbeThreadId') }),
    ...(list('authProbeFallbacks') === undefined
      ? {}
      : { authProbeFallbacks: list('authProbeFallbacks') }),
  }
}

/**
 * Tieba's capability matrix.
 *
 * Hand-written rather than derived from the legacy booleans, because Tieba is the
 * one platform whose behaviour has actually been measured — and the measurements
 * are not flattering. In particular:
 *
 * - `comment.publish` is `unverified`: the request shape and the logged-out
 *   refusal were verified, but a real logged-in publish never was.
 * - `event.mentions` is `unavailable`: no verified endpoint exists.
 * - `media.read` is `unavailable`: images are linked, never fetched.
 *
 * Writing these as `supported` would be the exact failure this version is meant
 * to prevent.
 */
export function tiebaCapabilities(declaredAt = new Date().toISOString()): PlatformCapabilityMatrix {
  return {
    platform: TIEBA_PLATFORM_ID,
    declaredAt,
    capabilities: {
      'thread.read': {
        state: 'supported',
        reason: 'WAP 帖子页可解析标题、正文、作者与时间；已在真实帖子上跑通。',
        lastVerifiedAt: '2026-10-27',
      },
      'comment.list': {
        state: 'supported',
        reason: '楼层列表可按页读取，并按 postId 去重。',
        lastVerifiedAt: '2026-10-27',
      },
      'comment.paginate': {
        state: 'supported',
        reason: '分页读取到平台声明的最后一页，缺失楼层如实报告。',
        limits: ['单帖读取页数受 maxFloorPages 限制，达到上限会标记为不完整。'],
        lastVerifiedAt: '2026-10-27',
      },
      'comment.nested': {
        state: 'degraded',
        reason:
          '楼中楼优先走 /p/comment 与 /p/totalComment，但这两个通道会被贴吧按路径限流；' +
          '限流期间降级为帖子页内联副本，数量少于平台声明，结果中会明确标注。',
        limits: ['内联副本只含一部分楼中楼。', '限流冷却期内不再尝试分页通道。'],
        lastVerifiedAt: '2026-10-27',
      },
      'comment.locate': {
        state: 'supported',
        reason: '可按 postId 定位楼层或楼中楼，并返回其上下文。',
        lastVerifiedAt: '2026-10-27',
      },
      'identity.verify': {
        state: 'supported',
        reason: '登录横幅可从要发表的帖子读取；无登录标记与未登录可区分。',
        limits: ['未登录页没有帐号 ID 时只报告「已登录但无法识别」。'],
        lastVerifiedAt: '2026-10-27',
      },
      'event.mentions': {
        state: 'unavailable',
        reason:
          '艾特通知接口 /c/u/feed/atme_pc 需要真实登录态且未经账号验证，' +
          '没有可用的公开接口。请使用手动链接召唤。',
        requiredPermissions: ['真实登录态', '该接口的访问权限'],
      },
      'comment.publish': {
        state: 'unverified',
        reason:
          '发布接口 /f/commit/post/add 已实现，并验证了未登录时的拒绝响应结构；' +
          '登录态下的真实发表从未在可用账号上验证过。',
        limits: ['本环境无可用贴吧账号，因此不能声称发表可用。'],
        lastVerifiedAt: '2026-10-27',
      },
      'comment.reply': {
        state: 'unverified',
        reason: '楼中楼回复走同一发布接口，参数含 reply_id 与 comment_id，同样未经真实账号验证。',
        limits: ['目标快照与楼层/楼中楼区分已测试，但真实投递未验证。'],
      },
      'publish.verify': {
        state: 'supported',
        reason: '发表后回读目标帖子，核对正文、楼层类型、父楼层、被回复对象与作者；不一致会如实报告。',
        lastVerifiedAt: '2026-10-27',
      },
      'media.read': {
        state: 'unavailable',
        reason: '图片以 URL 形式保留，没有做内容读取或识别；不声明该能力。',
      },
      'user.profile': {
        state: 'unavailable',
        reason: '贴吧主页 /home/main 对未登录请求只返回 SPA 空壳，读不到稳定的公开资料。',
      },
    },
    notes: [
      '本机 IP 自 0.1.3 起持续收到贴吧 403（拦截页 2469 字节），因此 0.1.4 之后未在真实平台重新端到端验证。',
      '「supported」只表示该能力在真实帖子上被实际跑通过；「unverified」表示代码存在但没有证据。',
    ],
  }
}

/** Tieba's legacy boolean flags, for any caller still reading the old shape. */
export function tiebaLegacyCapabilities(): LegacyCapabilityFlags {
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
 * Build a Tieba adapter from a platform context.
 *
 * Kept here rather than in `runtime.ts` so the orchestration layer never imports
 * a concrete adapter class.
 */
export function createTiebaAdapter(context: PlatformContext): PlatformAdapter {
  return new TiebaAdapter(adapterOptionsOf(context.settings))
}

/** Tieba as the registry sees it. */
export const tiebaProvider: PlatformProvider = {
  id: TIEBA_PLATFORM_ID,
  displayName: '百度贴吧',
  shape: 'forum-thread',
  canHandleUrl: tiebaCanHandleUrl,
  parseUrl: (url: string): ThreadRef => parseTiebaUrl(url),
  describeCapabilities: () => tiebaCapabilities(),
  createAdapter: (context) => createTiebaAdapter(context),
}
