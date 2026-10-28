/**
 * The session state machine and its guard rails.
 *
 * A task moves through a fixed lifecycle. Transitions are validated rather than
 * assigned, because the expensive failures here are not typos — they are a
 * *retry after an ambiguous publish* and a *second publish for one trigger*.
 * Both are prevented structurally: the machine refuses the transition, and the
 * publisher consults the store instead of trusting its own memory.
 */

import { PlatformError } from './types.js'
import type { TaskState } from './store.js'

/**
 * The allowed transitions. Every other move is a programming error.
 *
 * `ANALYZING → GENERATING` exists because generation is a real stage with a model
 * call in it: without this edge the only way into READY from analysis was a
 * direct jump, which is exactly the shortcut the machine should forbid.
 */
const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DETECTED: ['AUTHORIZED', 'NEEDS_CONFIRMATION', 'CANCELLED', 'FAILED'],
  AUTHORIZED: ['COLLECTING', 'PAUSED', 'CANCELLED', 'FAILED'],
  COLLECTING: ['ANALYZING', 'PAUSED', 'FAILED', 'CANCELLED', 'NEEDS_CONFIRMATION'],
  ANALYZING: ['GENERATING', 'PAUSED', 'FAILED', 'CANCELLED', 'NEEDS_CONFIRMATION'],
  GENERATING: ['REVIEWING', 'READY', 'PAUSED', 'FAILED', 'CANCELLED', 'NEEDS_CONFIRMATION'],
  REVIEWING: ['READY', 'GENERATING', 'CANCELLED', 'FAILED', 'NEEDS_CONFIRMATION'],
  // READY → NEEDS_CONFIRMATION matters: a target can move while a candidate sits
  // waiting for approval, and that has to demote the session rather than be ignored.
  // Without this edge the demotion silently kept READY, so the next attempt looked
  // fine while its target had actually changed.
  READY: ['PUBLISHING', 'REVIEWING', 'CANCELLED', 'FAILED', 'PAUSED', 'NEEDS_CONFIRMATION'],
  PUBLISHING: ['PUBLISHED', 'NEEDS_CONFIRMATION', 'FAILED', 'PAUSED'],
  PUBLISHED: [],
  FAILED: ['AUTHORIZED', 'CANCELLED'],
  PAUSED: ['AUTHORIZED', 'CANCELLED', 'FAILED'],
  CANCELLED: [],
  NEEDS_CONFIRMATION: ['READY', 'GENERATING', 'REVIEWING', 'CANCELLED', 'FAILED', 'PAUSED'],
}

/** True when a transition is legal. */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to)
}

/** Apply a transition, throwing when it is illegal. */
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态迁移：${from} → ${to}（允许的目标：${TRANSITIONS[from].join(', ') || '无'}）`)
  }
}

/**
 * A refused transition, reported instead of thrown.
 *
 * Callers in the pipeline want to stop and tell the user *what* was refused, not
 * crash; they use {@link transition} and surface `reason`. Callers that are
 * asserting an invariant use `assertTransition`.
 */
export interface TransitionResult {
  readonly ok: boolean
  readonly state: TaskState
  readonly reason?: string
}

/**
 * Compute the next state, refusing an illegal move.
 *
 * This exists because every module used to assign `state:` directly, which made
 * `assertTransition` dead code: the machine documented what it forbade while
 * nothing consulted it. Routing transitions through here makes the rules real —
 * a `PUBLISHED` session cannot go back to `PUBLISHING`, and `CANCELLED` cannot be
 * resurrected, no matter which module is asking.
 *
 * @param from current state
 * @param to desired state
 * @returns the new state, or the unchanged state plus a reason
 */
export function transition(from: TaskState, to: TaskState): TransitionResult {
  if (from === to) return { ok: true, state: to }
  if (!canTransition(from, to)) {
    return {
      ok: false,
      state: from,
      reason:
        `当前会话状态是 ${from}，不允许转到 ${to}（` +
        `允许的目标：${TRANSITIONS[from].join(', ') || '无'}）`,
    }
  }
  return { ok: true, state: to }
}

/** States that must never publish, whatever else is true. */
export function isPublishable(state: TaskState): boolean {
  return state === 'READY'
}

/** True when the task can still make automatic progress. */
export function isActive(state: TaskState): boolean {
  return !['PUBLISHED', 'FAILED', 'CANCELLED'].includes(state)
}

/** A policy limiting how much the plugin may do on its own. */
export interface InteractionPolicy {
  /** `manual` never publishes without an explicit approval call. */
  readonly mode: 'manual' | 'single_shot' | 'limited_auto'
  /** Maximum automatic publishes per session. */
  readonly maxAutoPublishesPerSession: number
  /** Minimum gap between two automatic publishes, in milliseconds. */
  readonly cooldownMs: number
  /** Maximum publishes per thread across all sessions. */
  readonly maxPublishesPerThread: number
  /** Stop everything when the platform reports a challenge. */
  readonly stopOnChallenge: boolean
}

/** Conservative defaults: nothing is sent without a human click. */
export const DEFAULT_POLICY: InteractionPolicy = {
  mode: 'manual',
  maxAutoPublishesPerSession: 0,
  cooldownMs: 60_000,
  maxPublishesPerThread: 10,
  stopOnChallenge: true,
}

/** The observed state a policy decision is made against. */
export interface PublishAttempt {
  readonly sessionId: string
  readonly threadId: string
  /** Publishes already confirmed in this session. */
  readonly sessionPublishes: number
  /** Publishes already confirmed in this thread. */
  readonly threadPublishes: number
  /** Epoch ms of the last publish anywhere, when known. */
  readonly lastPublishAt?: number
  /** True when the caller holds a verified human approval for this candidate. */
  readonly humanApproved: boolean
  /**
   * The candidate's security verdict.
   *
   * Added in v0.2.5 because its absence was the v0.2.4 defect: without it the policy
   * could not tell a `review` candidate from an `allow` one, so `limited_auto`
   * granted automatic slots to candidates that were supposed to wait for a human.
   *
   * `optional` only so an existing caller keeps compiling; the publisher always
   * passes it, and `undefined` is treated as the strictest reading (see below).
   */
  readonly securityDecision?: 'allow' | 'review' | 'block'
  readonly now: number
}

/** The outcome of a policy check. */
export type PolicyDecision =
  | { readonly allowed: true; readonly reasons: readonly string[] }
  | { readonly allowed: false; readonly code: string; readonly reason: string }

/**
 * Decide whether a publish may proceed.
 *
 * ## The policy matrix (v0.2.5)
 *
 * | verdict | mode | approval | outcome |
 * | --- | --- | --- | --- |
 * | `block` | any | any | refuse — enforced earlier, before this function |
 * | `review` | any | none | refuse — no automatic slot for a flagged candidate |
 * | `review` | any | valid | continue to the rest of the checks |
 * | `allow` | `manual` | required | refuse without it |
 * | `allow` | `single_shot` | any | a one-shot grant is the authorisation |
 * | `allow` | `limited_auto` | optional | still needs budget, cooldown and account |
 *
 * The `review` row is the one this version adds. It is checked here *and* in the
 * publisher: here so every caller gets the same answer, there so a caller that
 * bypassed this function still cannot send.
 *
 * `securityDecision` being `undefined` is read as `review`, not as `allow`: a caller
 * that forgot to pass the verdict has not proven the candidate is clean, and
 * defaulting the other way would turn a missing argument into a permission.
 */
export function checkPublishPolicy(
  policy: InteractionPolicy,
  attempt: PublishAttempt,
): PolicyDecision {
  const reasons: string[] = []
  const verdict = attempt.securityDecision ?? 'review'

  if (verdict === 'block') {
    return {
      allowed: false,
      code: 'security_blocked',
      reason: '这个候选已被安全闸门阻止，任何发表模式都不能发送',
    }
  }

  // A flagged candidate may never spend an automatic slot. With an approval it may
  // continue; without one it stops here regardless of mode.
  if (verdict === 'review' && !attempt.humanApproved) {
    return {
      allowed: false,
      code: 'security_review_required',
      reason:
        '这个候选被标记为「需要人工确认」，没有有效的人工批准不能发表。' +
        '受限自动模式也不能绕过这一条。',
    }
  }

  if (policy.mode === 'manual' && !attempt.humanApproved) {
    return {
      allowed: false,
      code: 'approval_required',
      reason: '当前是手动审核模式：必须由主人确认这一条候选回复后才能发送',
    }
  }

  if (attempt.threadPublishes >= policy.maxPublishesPerThread) {
    return {
      allowed: false,
      code: 'thread_limit',
      reason: `本帖已发表 ${attempt.threadPublishes} 条，达到上限 ${policy.maxPublishesPerThread}，停止自动互动`,
    }
  }

  if (!attempt.humanApproved && policy.mode === 'limited_auto') {
    if (attempt.sessionPublishes >= policy.maxAutoPublishesPerSession) {
      return {
        allowed: false,
        code: 'session_limit',
        reason: `本会话已自动发表 ${attempt.sessionPublishes} 条，达到上限 ${policy.maxAutoPublishesPerSession}`,
      }
    }
    if (attempt.lastPublishAt !== undefined && attempt.now - attempt.lastPublishAt < policy.cooldownMs) {
      const waitMs = policy.cooldownMs - (attempt.now - attempt.lastPublishAt)
      return {
        allowed: false,
        code: 'cooldown',
        reason: `距离上次发表不足冷却时间，还需等待约 ${Math.ceil(waitMs / 1000)} 秒`,
      }
    }
    reasons.push('有限自动互动：本次消耗一次自动额度')
  } else if (attempt.humanApproved) {
    reasons.push('主人已确认这一条候选回复')
  }

  return { allowed: true, reasons }
}

/** Which platform failures must stop everything until a human intervenes. */
export function mustPauseOn(error: unknown): { pause: boolean; reason?: string } {
  if (!(error instanceof PlatformError)) return { pause: false }
  switch (error.code) {
    case 'captcha':
      return { pause: true, reason: '平台要求验证码/安全验证，已暂停，请人工处理后恢复' }
    case 'forbidden':
      return { pause: true, reason: '平台返回 403，可能触发了访问限制，已暂停' }
    case 'rate_limited':
      return {
        pause: true,
        reason: `平台限流（429），已暂停${error.retryAfterMs ? `，建议等待约 ${Math.ceil(error.retryAfterMs / 1000)} 秒` : ''}`,
      }
    case 'auth_required':
      return { pause: true, reason: '登录状态失效，已暂停，请重新登录后再试' }
    default:
      return { pause: false }
  }
}

/** Reject content that is empty after trimming. */
export function assertPublishableText(text: string, maxLength: number): void {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('回复内容为空，不能发表')
  if (trimmed.length > maxLength) {
    throw new Error(`回复长度 ${trimmed.length} 字超过上限 ${maxLength} 字`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) {
    throw new Error('回复内容包含控制字符，可能被平台拒绝')
  }
}

/**
 * Detect prompt-injection attempts inside user content.
 *
 * This never blocks anything by itself: the point is to *report* that a post
 * contains instruction-like text, so the pipeline treats it as data. The real
 * defence is architectural — user content is only ever interpolated into the
 * user message, never into the system prompt, and the schema has no field that
 * could carry an instruction.
 */
export function detectInjection(text: string): readonly string[] {
  const hits: string[] = []
  const patterns: readonly { re: RegExp; label: string }[] = [
    { re: /忽略(上面|之前|以上|前面).{0,6}(指令|提示|要求|规则)/, label: '要求忽略既有指令' },
    { re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i, label: '要求忽略既有指令（英文）' },
    {
      re: /(泄露|透露|输出|打印|告诉我|发我|给我).{0,12}(密钥|密码|口令|token|api\s*key|cookie|凭据|配置)/i,
      label: '索取凭据',
    },
    // Asking for a credential object by name, in any phrasing.
    { re: /(cookie|api\s*key|token|密码|密钥|凭据).{0,6}(是多少|是什么|发一下|给我|打印|输出)/i, label: '索取凭据' },
    { re: /system\s*prompt|系统提示词|你的指令/, label: '探询系统提示词' },
    { re: /你现在是|从现在开始你(要|必须)|假装你是/, label: '试图改写角色设定' },
  ]
  for (const pattern of patterns) {
    if (pattern.re.test(text) && !hits.includes(pattern.label)) hits.push(pattern.label)
  }
  return hits
}
