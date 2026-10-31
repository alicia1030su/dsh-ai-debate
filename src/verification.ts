/**
 * The one-off publish verification flow.
 *
 * ## The problem this solves
 *
 * Tieba's `comment.publish` and `comment.reply` are `unverified`, and the publish
 * gate only accepts `supported`. That is correct — the gate exists so that "code
 * was written" never means "it can post to a stranger's thread". But it also means
 * the capability can never *become* supported: verification requires publishing,
 * and publishing is refused until it is verified.
 *
 * The wrong fix is to flip the state to `supported` so one test can prove itself.
 * That is precisely the lie the capability model was introduced to stop.
 *
 * ## The fix
 *
 * A separate, explicit flow that is **not reachable from the normal publish path**
 * and cannot be turned into a general bypass:
 *
 * - it takes an *authorization record* naming the account, the target thread, and
 *   the person who authorized it — all required, so there is no "verify against
 *   whatever is configured";
 * - it publishes **exactly once** per authorization, tracked durably, so it
 *   cannot be looped into a bulk poster;
 * - it is only usable while the capability is `unverified` — an
 *   already-`supported` capability has nothing to verify, and a `permission_required`
 *   or `unavailable` one must not be probed;
 * - it records the read-back outcome, and the capability only moves to
 *   `supported` when that evidence is complete.
 *
 * ## What it deliberately does not do
 *
 * - It does not touch the ordinary `assertCapability` gate. A thread the owner
 *   wants to argue in still needs a verified capability, and this flow does not
 *   change that for anyone.
 * - It does not retry. A failed verification (403, captcha, rate limit) leaves the
 *   capability `unverified`, because the honest reading of "the platform refused"
 *   is "we still do not know whether publishing works".
 * - It does not accept a capability it cannot verify. Asking to verify
 *   `thread.read` here is a caller error, not something to accommodate.
 */

import type { PlatformId } from './types.js'
import type { CapabilityName, CapabilityState } from './platforms/contracts.js'

/** Which capabilities this flow is allowed to verify. */
export const VERIFIABLE_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  'comment.publish',
  'comment.reply',
])

/**
 * The owner's explicit authorization for one verification publish.
 *
 * Every field is required, and none has a default. A flow that can invent its own
 * target is a flow that can post somewhere nobody approved.
 */
export interface VerificationAuthorization {
  readonly platform: PlatformId
  /** The account the owner says may be used. Checked against the live session. */
  readonly authorizedAccountId: string
  /** The thread the owner says is theirs or has permission to use. */
  readonly authorizedThreadId: string
  /** Who authorized it, for the audit record. Free text, e.g. the owner's handle. */
  readonly authorizedBy: string
  /** Which capability this run is meant to prove. */
  readonly capability: CapabilityName
  /**
   * For `comment.reply`: the floor the reply must be attached under.
   *
   * Required for a reply and meaningless for a new comment, because the read-back has to check
   * the **parent**, and "wherever it ended up" is not something the owner authorized. Left
   * optional at the type level so a `comment.publish` authorization does not have to invent a
   * value; `checkVerification` refuses a reply authorization that leaves it empty.
   */
  readonly authorizedFloorId?: string
  /**
   * For `comment.reply`: the exact comment being answered (楼中楼).
   *
   * Same reasoning as `authorizedFloorId`: without it the read-back can only confirm "a reply
   * exists somewhere under the floor", which is the weaker claim this flow must not accept.
   */
  readonly replyToPostId?: string
  /**
   * The exact reply text, pre-approved by the owner.
   *
   * Required rather than generated: the point of verification is to observe what
   * the platform does with a known payload, and a generated text would make the
   * two confounded.
   */
  readonly approvedText: string
}

/** Why a verification request was refused before touching the network. */
export type VerificationRefusal =
  /** The capability cannot be verified by this flow at all. */
  | 'not_verifiable'
  /** The capability is not in the only state this flow may test. */
  | 'wrong_state'
  /** This authorization has already been used. */
  | 'already_used'
  /** A required authorization field is empty. */
  | 'incomplete_authorization'
  /** The live session is not the authorized account. */
  | 'account_mismatch'
  /** The target is not the authorized thread. */
  | 'thread_mismatch'
  /** The text is empty or too long for the platform. */
  | 'text_rejected'

/** The outcome of asking whether a verification run may proceed. */
export interface VerificationDecision {
  readonly ok: boolean
  readonly refusal?: VerificationRefusal
  /** Human-readable reason, shown to the owner. */
  readonly message: string
}

/**
 * The durable record of one verification attempt.
 *
 * Written *before* the network call and updated after, so a crash mid-publish
 * leaves a record saying "this was attempted and the outcome is unknown" rather
 * than no record at all. An unknown outcome must not be retried automatically:
 * the reply may already be on the platform.
 */
export interface VerificationRecord {
  /** Stable key: one attempt per authorization. */
  readonly key: string
  readonly platform: PlatformId
  readonly capability: CapabilityName
  readonly authorizedAccountId: string
  readonly authorizedThreadId: string
  readonly authorizedBy: string
  readonly approvedText: string
  readonly startedAt: string
  /**
   * The adapter build this attempt ran against.
   *
   * Stamped at attempt time, not looked up later: replacing the publish method must not inherit
   * the previous adapter's evidence, and the only moment that knows which build actually ran is
   * this one. Without it, `capability-evidence.ts` has nothing to compare and would either
   * over-promote (old success, new code) or refuse to promote at all.
   */
  readonly adapterVersion?: string
  readonly outcome: 'pending' | 'succeeded' | 'failed' | 'uncertain'
  /** The post id the platform returned, when it returned one. */
  readonly publishedPostId?: string
  /** The read-back evidence, when the publish was confirmed. */
  readonly readBack?: VerificationReadBack
  /** Why it failed, when it did. */
  readonly failure?: string
}

/** What the read-back observed after publishing. */
export interface VerificationReadBack {
  /** The thread re-read still contains the new post. */
  readonly postFound: boolean
  /** The post's author matched the authorized account. */
  readonly authorMatched: boolean
  /** The post's text matched the approved text. */
  readonly textMatched: boolean
  /** For a reply: the parent was the authorized floor/comment. */
  readonly parentMatched: boolean
  /** Notes about anything that could not be checked. */
  readonly notes: readonly string[]
}

/** The key for one authorization, so a second run is detectable. */
export function authorizationKey(auth: VerificationAuthorization): string {
  // The parent is part of the key for a reply: authorizing "reply to floor 3" must not be
  // silently reusable for "reply to floor 4" in the same thread.
  return [
    auth.platform,
    auth.capability,
    auth.authorizedAccountId,
    auth.authorizedThreadId,
    auth.capability === 'comment.reply' ? (auth.authorizedFloorId ?? '') : '',
    auth.capability === 'comment.reply' ? (auth.replyToPostId ?? '') : '',
  ].join('\u0000')
}

/**
 * Decide whether a verification may start.
 *
 * All the checks run before the caller touches the network, so a refusal costs
 * nothing and cannot half-publish.
 *
 * @param input.authorization what the owner approved
 * @param input.capabilityState the platform's current declaration
 * @param input.liveAccountId the account the live session belongs to, if known
 * @param input.usedKeys keys of attempts already recorded
 */
export function checkVerification(input: {
  authorization: VerificationAuthorization
  capabilityState: CapabilityState
  liveAccountId?: string
  usedKeys: ReadonlySet<string>
}): VerificationDecision {
  const { authorization, capabilityState, liveAccountId, usedKeys } = input

  if (!VERIFIABLE_CAPABILITIES.includes(authorization.capability)) {
    return {
      ok: false,
      refusal: 'not_verifiable',
      message: `${authorization.capability} 不能通过一次性验收流程验证；这个流程只用于「发表」与「回复」`,
    }
  }

  // Only `unverified` is worth testing. `supported` has evidence already,
  // `permission_required` would test the wrong thing, and `unavailable` is a
  // statement about the platform, not about this account.
  if (capabilityState !== 'unverified') {
    return {
      ok: false,
      refusal: 'wrong_state',
      message:
        capabilityState === 'supported'
          ? '该能力已经是 supported，无需再验收'
          : `该能力当前是 ${capabilityState}，不是 unverified；这次验收证明不了任何东西`,
    }
  }

  const missing: string[] = []
  if (authorization.authorizedAccountId.trim() === '') missing.push('授权账号')
  if (authorization.authorizedThreadId.trim() === '') missing.push('授权帖子')
  if (authorization.authorizedBy.trim() === '') missing.push('授权人')
  if (authorization.approvedText.trim() === '') missing.push('已批准的正文')
  // A reply needs a specific parent. Without one the read-back can only confirm "a reply
  // exists", which is exactly the weaker claim this flow must not accept.
  if (authorization.capability === 'comment.reply') {
    if ((authorization.authorizedFloorId ?? '').trim() === '') missing.push('要回复的楼层 id')
    if ((authorization.replyToPostId ?? '').trim() === '') missing.push('要回复的那条评论 id')
  }
  if (missing.length > 0) {
    return {
      ok: false,
      refusal: 'incomplete_authorization',
      message: `验收缺少授权信息：${missing.join('、')}。这些信息必须由主人明确提供，插件不会自行填写`,
    }
  }

  if (usedKeys.has(authorizationKey(authorization))) {
    return {
      ok: false,
      refusal: 'already_used',
      message:
        '这份授权已经用过一次。一次性验收的设计就是只发一条——' +
        '如果需要再验，请由主人重新指定并授权，而不是重复使用同一份授权',
    }
  }

  // The live identity must be the authorized one. Publishing from a different
  // logged-in account would post as someone who never consented.
  if (liveAccountId !== undefined && liveAccountId !== authorization.authorizedAccountId) {
    return {
      ok: false,
      refusal: 'account_mismatch',
      message:
        `当前登录的账号是 ${liveAccountId}，而授权使用的账号是 ` +
        `${authorization.authorizedAccountId}。验收必须用主人授权的那个账号`,
    }
  }

  return { ok: true, message: '授权检查通过，只会发表一条' }
}

/**
 * Decide whether the capability may be upgraded to `supported`.
 *
 * Requires *all four* read-back facts. A publish that returned a post id but whose
 * text could not be confirmed is not evidence that publishing works correctly —
 * it is evidence that something was written somewhere.
 */
export function decideCapabilityUpgrade(
  record: VerificationRecord,
): { readonly upgrade: boolean; readonly reason: string } {
  if (record.outcome !== 'succeeded') {
    return {
      upgrade: false,
      reason: `验收结果是 ${record.outcome}，只有在成功的情况下才有证据`,
    }
  }
  const readBack = record.readBack
  if (readBack === undefined) {
    return { upgrade: false, reason: '没有回读证据，无法确认这条回复真的出现在平台上' }
  }
  const missing: string[] = []
  if (!readBack.postFound) missing.push('帖子没有在回读中出现')
  if (!readBack.authorMatched) missing.push('作者不符')
  if (!readBack.textMatched) missing.push('正文不符')
  if (!readBack.parentMatched) missing.push('父级位置不符')
  if (missing.length > 0) {
    return { upgrade: false, reason: `回读证据不完整：${missing.join('、')}` }
  }
  return { upgrade: true, reason: '回读确认了平台、作者、正文与父级位置，可以标记为 supported' }
}

/**
 * The authorization template shown to the owner.
 *
 * Written out so the required fields are visible before anything is attempted,
 * rather than being discovered one refusal at a time.
 */
export function describeAuthorizationRequirements(platform: string): string {
  return [
    `为验证「${platform}」的真实发表能力，需要主人明确提供以下四项：`,
    '1. 一个你自己有权使用的测试账号（发表会以这个账号的身份进行）',
    '2. 一个你自己控制或已获许可的测试帖子链接',
    '3. 由谁授权（写清你的身份，用于留痕）',
    '4. 要发表的那一条回复正文（预先批准，不会由模型现场生成）',
    '插件只会发表一条，并在发表后回读确认平台、作者、正文与父级位置。',
    '如果平台返回 403、429、验证码或权限不足，验收会直接停止，能力保持 unverified。',
  ].join('\n')
}
