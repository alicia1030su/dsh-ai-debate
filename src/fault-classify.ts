/**
 * Why a platform request failed, in terms the owner can act on (v0.2.22 §六).
 *
 * ## Why a classifier instead of another error message
 *
 * "Read failed: 403" is true and useless. The same status code covers at least five situations
 * with five different remedies — a session that expired, an endpoint this account may not read,
 * a rate limit, an anti-bot page, and a platform decision — and telling the owner the wrong one
 * sends them to fix the wrong thing. This module turns the observable facts (status, error code,
 * body markers, whether the platform's *own* host answered) into exactly one category plus the
 * next step that is safe to take.
 *
 * ## What it refuses to conclude
 *
 * - **Reachability of `www.baidu.com` says nothing about `tieba.baidu.com`.** They are different
 *   hosts with different protections; the observed block on this deployment hits the forum host
 *   while the portal answers 200. `reachability` is therefore derived from the platform host
 *   only, and an unreachable host is reported as such rather than "the internet is down".
 * - **It never suggests a workaround that evades a platform control.** No captcha bypass, no
 *   proxy rotation, no header spoofing. The advice for an anti-bot block is "stop, and read
 *   later from a normal session" — the same thing a person would do.
 * - **It does not claim a cause it cannot see.** Ambiguous evidence lands on `unknown` with the
 *   facts attached, because a confident wrong answer here costs more than "I do not know".
 */

import type { PlatformErrorCode } from './types.js'

/**
 * One failure category.
 *
 * The values are deliberately few and mutually exclusive: a UI that has to render eight
 * overlapping states ends up collapsing them, and the collapse is where "uncertain" becomes
 * "failed" or, worse, "fine".
 */
export type FaultKind =
  /** The platform host itself did not answer (DNS, TCP, TLS, timeout). */
  | 'unreachable'
  /** The request reached the platform and it refused the credentials. */
  | 'session_invalid'
  /** No credentials configured at all — nothing was sent. */
  | 'not_logged_in'
  /** Authenticated, but this account may not read/do this. */
  | 'permission_denied'
  /** Too many requests; back off. */
  | 'rate_limited'
  /** An anti-bot page (captcha / verification), not a normal response. */
  | 'challenge'
  /** The platform answered and said no, for a reason outside the categories above. */
  | 'platform_refused'
  /** The response was structurally wrong: the platform changed shape. */
  | 'malformed'
  /** Not enough information to decide. */
  | 'unknown'

/** What the caller observed. Every field is optional: a classifier that demands fields gets fed lies. */
export interface FaultEvidence {
  /** HTTP status, when the request got a response. */
  readonly status?: number
  /** The normalized error code from `PlatformError`, when one was raised. */
  readonly code?: PlatformErrorCode
  /** Raw error text, searched for well-known platform markers. */
  readonly message?: string
  /** Whether *the platform's own host* answered at TCP/HTTP level. */
  readonly hostReachable?: boolean
  /** Whether any credential was configured for this platform. */
  readonly hasCredential?: boolean
  /** Whether the adapter believed its session was valid before the request. */
  readonly sessionKnownGood?: boolean
}

/** A classification plus the safe next step. */
export interface FaultReport {
  readonly kind: FaultKind
  /** Short label for a badge. */
  readonly label: string
  /** Why, in terms of the evidence actually observed. */
  readonly reason: string
  /** What the owner can safely do next. Never a way around a platform control. */
  readonly nextStep: string
  /** Whether retrying the same request later could plausibly help. */
  readonly retryable: boolean
}

/** Anti-bot page markers. Matched case-insensitively against the error text. */
const CHALLENGE_MARKERS = [
  /captcha/i,
  /验证码/,
  /安全验证/,
  /人机验证/,
  /verify you are (a )?human/i,
  /异常流量/,
  /访问受限/,
]

/** Session-expired markers. */
const SESSION_MARKERS = [
  /登录已过期/,
  /未登录/,
  /请先登录/,
  /session expired/i,
  /not logged in/i,
  /passport\.baidu\.com/i,
]

/** Platform-refusal markers that are not a session problem. */
const REFUSAL_MARKERS = [/该内容已被删除/, /不存在/, /已删除/, /没有权限/, /访问权限/]

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * Classify one failure.
 *
 * Order matters and is documented because it encodes precedence:
 *
 * 1. **No host answer** wins over everything: if the platform was never reached, no other fact
 *    about the response exists, and reporting "session invalid" for a DNS failure is a guess.
 * 2. **No credential** beats status codes: a 403 with no cookie is not a permission problem.
 * 3. **Challenge** beats 403: an anti-bot page is also a 403, and it is the one case where
 *    "try harder" is the wrong advice.
 * 4. **429 / rate_limited**, then **401/403**, then structural problems.
 */
export function classifyFault(evidence: FaultEvidence): FaultReport {
  const text = evidence.message ?? ''
  const status = evidence.status

  if (evidence.hostReachable === false) {
    return {
      kind: 'unreachable',
      label: '无法连通',
      reason: '这个平台的主机没有应答（DNS 解析、TCP 连接或 TLS 握手失败）。',
      nextStep:
        '先确认本机到该平台域名的网络是否可用。注意：其它域名能打开不代表这个域名能打开 —— ' +
        '每个平台的主机与防护策略是独立的，请单独测试它自己的地址。',
      retryable: true,
    }
  }

  if (evidence.hasCredential === false) {
    return {
      kind: 'not_logged_in',
      label: '未配置登录态',
      reason: '这个平台还没有配置凭据，请求根本没有带上登录身份。',
      nextStep: '在「贴吧账号」里保存一份已登录浏览器的凭据，再回来重试。',
      retryable: false,
    }
  }

  if (evidence.code === 'captcha' || matches(CHALLENGE_MARKERS, text)) {
    return {
      kind: 'challenge',
      label: '平台要求人机验证',
      reason: '平台返回了验证页，而不是正常内容 —— 这是反爬控制，不是登录失效。',
      nextStep:
        '停下来，不要连续重试：连续请求只会延长限制。过一段时间用普通浏览器正常访问该页面，' +
        '按它的要求完成验证；本插件不会绕过验证码，也不会代替你完成验证。',
      retryable: false,
    }
  }

  if (evidence.code === 'rate_limited' || status === 429) {
    return {
      kind: 'rate_limited',
      label: '被限流',
      reason: '平台明确表示请求过于频繁（429 / rate_limited）。',
      nextStep: '等一段时间再试，并把并发与翻页间隔调大。这不是账号问题，也不该靠换 IP 解决。',
      retryable: true,
    }
  }

  if (evidence.code === 'auth_required' || status === 401 || matches(SESSION_MARKERS, text)) {
    return {
      kind: 'session_invalid',
      label: '登录态失效',
      reason: '凭据存在，但平台不认它了 —— 通常是会话过期或被登出。',
      nextStep: '重新从浏览器取一份当前有效的凭据并保存。发表前请先在「验收」里确认登录账号。',
      retryable: false,
    }
  }

  if (evidence.code === 'forbidden' || status === 403) {
    if (matches(REFUSAL_MARKERS, text)) {
      return {
        kind: 'permission_denied',
        label: '没有读取权限',
        reason: '平台明确表示这条内容不可访问（可能已删除、仅作者可见，或该账号无权查看）。',
        nextStep: '换一条公开可访问的帖子。这不是登录问题，重试同一个目标不会变好。',
        retryable: false,
      }
    }
    return {
      kind: 'platform_refused',
      label: '平台拒绝访问',
      reason:
        '平台对这个请求返回了 403，但没有给出可识别的原因（不是验证码页，也不是明确的权限说明）。',
      nextStep:
        '先在这个平台自己的域名上确认是否被拦截（例如用浏览器打开同一个帖子），' +
        '不要用别的站点的可访问性来推断这里。确认是平台侧限制后，改用只读模拟或稍后再试。',
      retryable: true,
    }
  }

  if (evidence.code === 'malformed_response') {
    return {
      kind: 'malformed',
      label: '返回结构异常',
      reason: '平台应答了，但内容不是预期结构 —— 页面改版或返回了错误模板。',
      nextStep: '这属于适配器需要更新的情况，请把这条诊断报告附在问题里。',
      retryable: false,
    }
  }

  if (evidence.code === 'network' || evidence.code === 'timeout' || evidence.code === 'dns') {
    return {
      kind: 'unreachable',
      label: '网络异常',
      reason: `请求在网络层失败（${evidence.code}）。`,
      nextStep: '网络恢复后重试。同样的请求随后再来一次是安全的 —— 读操作没有副作用。',
      retryable: true,
    }
  }

  return {
    kind: 'unknown',
    label: '原因不明',
    reason:
      '没有足够证据判断原因：' +
      `status=${status === undefined ? '无' : status}、` +
      `code=${evidence.code ?? '无'}、` +
      `主机可达=${evidence.hostReachable === undefined ? '未知' : String(evidence.hostReachable)}。`,
    nextStep: '把这条记录原样保留（它不含凭据），再决定是否换目标或稍后重试。',
    retryable: true,
  }
}

/**
 * Whether the fault means "this deployment cannot publish at all right now".
 *
 * Used by the workbench to decide whether the publish button may be offered. It is a separate
 * question from `retryable`: a malformed response is not retryable but also does not forbid
 * publishing forever, while a challenge page does forbid a publish today.
 */
export function blocksPublishing(report: FaultReport): boolean {
  return (
    report.kind === 'challenge' ||
    report.kind === 'session_invalid' ||
    report.kind === 'not_logged_in' ||
    report.kind === 'unreachable'
  )
}
