/**
 * One generation per session at a time, and no stale result may land.
 *
 * ## The two failures this exists to prevent
 *
 * 1. **Double click.** Two clicks a second apart start two model calls. Both finish, both
 *    append a candidate, and the owner pays twice for two drafts that differ only by
 *    sampling noise. Worse, the second one retires the first one's approval, so a person
 *    who approved one candidate while the other was still running sees the approval
 *    silently vanish.
 * 2. **A late answer to an abandoned question.** The owner switches the reply target while
 *    a call is in flight. The old call returns several seconds later and appends a
 *    candidate aimed at the *previous* target. Nothing in the store would refuse it — the
 *    candidate is internally consistent, it simply answers a question nobody is asking
 *    anymore — and the page then shows two targets' worth of drafts with no way to tell
 *    which is current.
 *
 * ## Why this is an in-memory guard and not a stored field
 *
 * The condition is "a request is in flight *in this process*". A stored field would have to
 * be cleaned up after a crash, and a crash means the request is gone anyway. Keeping it in
 * memory makes the invariant true by construction: when the process dies, so does the
 * claim.
 *
 * ## Why a new target supersedes instead of waiting
 *
 * `begin` refuses a duplicate for the *same* target, because that is a double click and the
 * right answer is "the one already running will answer you". A *different* target is a
 * decision, and a decision must take effect immediately: the new call supersedes the old
 * one, and the old one is marked stale so its result is discarded rather than stored.
 */

/** One in-flight generation. */
export interface GenerationClaim {
  /** Monotonic per guard, compared with `===` to detect supersession. */
  readonly token: number
  readonly targetPostId: string
  readonly startedAt: number
  /**
   * 这次生成依赖的输入指纹（目标 + 人格 + 上下文摘要，v0.2.36 §8）。
   *
   * ## 为什么仅比目标不够
   *
   * 两次调用可以目标相同、人格不同。那时「同目标」的判定会把它当成重复点击拒绝掉，
   * 而用户的意图明明是「换个人格再来一次」。反过来，人格改了、目标没改，旧请求
   * 回来时也不能算有效 —— 它回答的是另一个问题。
   *
   * 指纹把「这次要生成什么」变成可比较的东西。空串表示调用方没提供指纹，
   * 此时退化为只比目标（与 v0.2.35 行为一致）。
   */
  readonly inputKey?: string
}

/** Why a claim could not be started. */
export interface GenerationBusy {
  readonly ok: false
  readonly active: GenerationClaim
}

/** A started claim. */
export interface GenerationStarted {
  readonly ok: true
  readonly claim: GenerationClaim
}

/**
 * 两次调用是不是「同一次」。
 *
 * 规则写在这里而不是散在 `begin` 里：
 * - 没给指纹（旧调用方）→ 只比目标；
 * - 给了指纹 → 目标与指纹都要相同。
 *
 * 为什么不比「人格」这种具体字段而是比指纹：以后新增影响因素（上下文压缩档位、
 * 主人的额外指示）时，只要把它算进指纹，这里一个字都不用改。
 */
function sameInput(
  a: { readonly targetPostId: string; readonly inputKey?: string },
  b: { readonly targetPostId: string; readonly inputKey?: string },
): boolean {
  if (a.targetPostId !== b.targetPostId) return false
  if (a.inputKey === undefined || b.inputKey === undefined) return true
  return a.inputKey === b.inputKey
}

/** The guard itself. One per runtime instance. */
export class GenerationGuard {
  private sequence = 0
  private readonly active = new Map<string, GenerationClaim>()
  /**
   * The newest token ever issued for a session.
   *
   * ## Why a finished claim must not make an older one look current
   *
   * The first version answered `isStale` by comparing against the *active* claim. When the
   * newer request finished first, it released its claim — and the older request then saw
   * "no active claim", concluded it was fine, and wrote its result. Which is exactly the
   * late answer this class exists to discard.
   *
   * Keeping the highest token ever issued makes the comparison monotonic: a claim is stale
   * for the rest of the session's life once anything newer has started, whether or not that
   * newer thing is still running.
   */
  private readonly latest = new Map<string, number>()

  /**
   * Claim the right to generate for this session.
   *
   * Returns `ok: false` only when the *same* target is already being generated — the
   * double-click case. A different target supersedes the previous claim.
   */
  begin(
    sessionId: string,
    targetPostId: string,
    now: number = Date.now(),
    inputKey?: string,
  ): GenerationStarted | GenerationBusy {
    const current = this.active.get(sessionId)
    if (current !== undefined && sameInput(current, { targetPostId, inputKey })) {
      return { ok: false, active: current }
    }
    this.sequence += 1
    const claim: GenerationClaim = {
      token: this.sequence,
      targetPostId,
      startedAt: now,
      ...(inputKey === undefined ? {} : { inputKey }),
    }
    this.active.set(sessionId, claim)
    this.latest.set(sessionId, claim.token)
    return { ok: true, claim }
  }

  /** Release the claim, but only if it is still the active one. */
  finish(sessionId: string, claim: GenerationClaim): void {
    const current = this.active.get(sessionId)
    if (current !== undefined && current.token === claim.token) this.active.delete(sessionId)
  }

  /**
   * True when a newer claim has taken over.
   *
   * Checked twice on purpose: once before composing the candidate (so an abandoned request
   * does not spend the security gate's work) and once inside the store write (so the answer
   * is about the document being written, not about a moment a few milliseconds earlier).
   */
  isStale(sessionId: string, claim: GenerationClaim): boolean {
    const newest = this.latest.get(sessionId)
    return newest !== undefined && newest !== claim.token
  }

  /** The claim currently held, for diagnostics. */
  activeClaim(sessionId: string): GenerationClaim | undefined {
    return this.active.get(sessionId)
  }

  /** Drop every claim. Used when a runtime is torn down. */
  clear(): void {
    this.active.clear()
    this.latest.clear()
  }
}

/**
 * Per-runtime guards.
 *
 * A `WeakMap` rather than a field on `Runtime` so the many tests that build a bare runtime
 * object keep compiling, and so two runtimes in one process (the GUI's own and a test's)
 * cannot share a claim.
 */
const guards = new WeakMap<object, GenerationGuard>()

/** The guard for this runtime, created on first use. */
export function generationGuardOf(owner: object): GenerationGuard {
  let guard = guards.get(owner)
  if (guard === undefined) {
    guard = new GenerationGuard()
    guards.set(owner, guard)
  }
  return guard
}
