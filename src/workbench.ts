/**
 * The publish workbench: what step the owner is on, and what is stopping the next one
 * (v0.2.22 §一/§二/§五/§八).
 *
 * ## Why this is a derivation and not a stored field
 *
 * A `step` column would be a second source of truth: sessions already record a `TaskState`, the
 * candidates record their own version/hash/approval, and the approval ledger records what was
 * authorized for what. A stored step could disagree with all three after a crash, a refresh, or a
 * second plugin instance — and the disagreement would be invisible, because the page would render
 * the stale step as fact.
 *
 * So the step is **computed** from the durable facts every time it is asked for. That is also
 * what makes "refresh the page and continue" correct by construction instead of by extra code:
 * reloading produces the same answer, because the answer was never stored.
 *
 * ## The five result states are not one ladder
 *
 * §五 requires the interface to distinguish "request went out", "read-back verified", "platform
 * refused", "unknown", and "capability not verified". Those are not levels of success — they are
 * different claims, and collapsing any two of them is how "we sent something" gets read as "it
 * worked". `PublishOutcomeView` keeps them separate all the way to the render.
 */

import type { StoredCandidate, StoredSession } from './store.js'

/** Which step of the flow the owner is on. */
export type WorkbenchStep =
  /** Nothing collected yet: the owner pastes a discussion link. */
  | 'link'
  /** A session exists; the owner picks which post to rebut. */
  | 'target'
  /** A target is fixed; generate candidates. */
  | 'generate'
  /** Candidates exist; the owner reads and edits. */
  | 'review'
  /** A candidate is approved and unchanged since. */
  | 'approve'
  /** Approved, not yet sent. */
  | 'publish'
  /** Sent; read-back result below. */
  | 'readback'
  /** Terminal: published and confirmed, or stopped. */
  | 'done'

/** How a publish attempt actually ended. Deliberately five, deliberately distinct. */
export type PublishOutcomeView =
  /** No attempt has been made. */
  | 'not_attempted'
  /** The request left this process, but no evidence of the result exists yet. */
  | 'sent_unconfirmed'
  /** All four read-back facts held. */
  | 'confirmed'
  /** The platform refused it, with a reason. */
  | 'refused'
  /** An attempt exists whose outcome is unknown. Never retried automatically. */
  | 'unknown'

/** One step's presentation. */
export interface WorkbenchStepView {
  readonly id: WorkbenchStep
  readonly title: string
  /** `current` is the one the owner should act on; `done` and `blocked` are informational. */
  readonly status: 'done' | 'current' | 'blocked' | 'pending'
  /** Why this step is blocked, when it is. */
  readonly blockedBy?: string
}

/** A fact the collection could not establish. Rendered as a caveat, never as content. */
export interface MissingEvidence {
  readonly what: string
  readonly detail: string
}

/** Everything the workbench page needs, in one shape. */
export interface WorkbenchState {
  readonly step: WorkbenchStep
  readonly steps: readonly WorkbenchStepView[]
  /** Ordered reasons the *next* irreversible action cannot happen yet. */
  readonly blockers: readonly string[]
  /** Facts the reader must know are missing before trusting the picture. */
  readonly missingEvidence: readonly MissingEvidence[]
  readonly outcome: PublishOutcomeView
  /** Counts, so the owner can see how much was actually read (not how much was claimed). */
  readonly counts: {
    readonly floors: number
    readonly nested: number
    readonly candidates: number
  }
  /** The target the current candidate would land on, when one is fixed. */
  readonly target?: {
    readonly threadId: string
    readonly postId: string
    readonly kind: 'floor' | 'nested'
    readonly authorName?: string
  }
  /** Capability state for the platform, as the gate would read it. */
  readonly capability?: {
    readonly declared: string
    readonly effective: string
    readonly reason: string
  }
  /**
   * The read-back facts behind `outcome`, when a read-back ran.
   *
   * §五 requires the interface to *separately* verify existence, author, body and parent. A
   * single "confirmed" boolean is a summary of those four, and showing only the summary hides
   * which one disagreed — the exact information needed to decide whether the reply is wrong or
   * the check is.
   */
  readonly readBack?: {
    readonly postFound: boolean
    readonly authorMatched: boolean
    readonly textMatched: boolean
    readonly parentMatched: boolean
    readonly notes: readonly string[]
  }
}

/** What the caller must supply. Kept narrow so this stays a pure function of durable facts. */
export interface WorkbenchInput {
  /** The session, or `undefined` before anything has been collected. */
  readonly session?: StoredSession
  /** Whether an approval exists that still binds the candidate as it is now. */
  readonly approvalApplies: boolean
  /** Capability state from the same evidence rules the publish gate uses. */
  readonly capability?: { declared: string; effective: string; reason: string }
  /** Number of nested replies read, when known. */
  readonly nestedCount?: number
  /** Number of first-level floors read, when known. */
  readonly floorCount?: number
  /** Facts the collector reported as unavailable. */
  readonly gaps?: readonly MissingEvidence[]
  /** The last publish attempt for the current candidate, when one exists. */
  readonly lastAttempt?: {
    readonly status: 'confirmed' | 'uncertain' | 'failed'
    readonly reason?: string
    /** The four read-back facts, when a read-back ran and reported them. */
    readonly readBack?: {
      readonly postFound: boolean
      readonly authorMatched: boolean
      readonly textMatched: boolean
      readonly parentMatched: boolean
      readonly notes: readonly string[]
    }
  }
}

const STEP_TITLES: Record<WorkbenchStep, string> = {
  link: '粘贴讨论链接',
  target: '选要反驳的那一条',
  generate: '生成候选',
  review: '预览与编辑',
  approve: '人工批准',
  publish: '发表一次',
  readback: '回读确认',
  done: '完成',
}

/**
 * Derive the workbench state.
 *
 * The ordering below is the entire product rule: you cannot approve before there is text, you
 * cannot publish before the approval matches the bytes, and you cannot call it done before the
 * platform was read back.
 */
export function deriveWorkbenchState(input: WorkbenchInput): WorkbenchState {
  const { session, capability, lastAttempt } = input
  const candidates = session?.candidates ?? []
  const gaps = input.gaps ?? []

  // Ranks let the step list render "done / current / pending" without a second table.
  const order: readonly WorkbenchStep[] = ['link', 'target', 'generate', 'review', 'approve', 'publish', 'readback', 'done']

  // The candidate the page is about: the newest one, because that is the one the owner just
  // generated or edited. Publishing, by contrast, is always driven by an explicit candidate id —
  // "newest" is a display convenience, never a selection rule for the network.
  const current = candidates.length === 0 ? undefined : candidates[candidates.length - 1]

  const outcome = deriveOutcome(session, current, lastAttempt)

  if (session === undefined) {
    return {
      step: 'link',
      steps: buildSteps('link', {}),
      blockers: [],
      missingEvidence: gaps,
      outcome: 'not_attempted',
      counts: { floors: 0, nested: 0, candidates: 0 },
      ...(capability === undefined ? {} : { capability }),
    }
  }

  const hasTarget = session.targetSnapshot !== undefined || current?.targetPostId !== undefined
  const hasCandidates = candidates.length > 0

  let step: WorkbenchStep
  const blockers: string[] = []

  if (!hasTarget) {
    step = 'target'
    blockers.push('还没有确定要反驳哪一条：目标必须由你在讨论结构里点选，插件不会按昵称猜。')
  } else if (!hasCandidates) {
    step = 'generate'
  } else if (outcome === 'confirmed') {
    step = 'done'
  } else if (outcome === 'unknown' || outcome === 'sent_unconfirmed') {
    step = 'readback'
    blockers.push(
      '上一次发表的结果没有确认。为避免重复发出同一条回复，这里不会自动重发，' +
        '请先到原帖人工核对，再决定是否新建一条候选。',
    )
  } else if (outcome === 'refused') {
    step = 'review'
    // A refusal is not fatal: the text may be fine and the platform unhappy for a transient
    // reason. But the owner must see the reason before deciding to try again.
    blockers.push(`平台没有接受这次发表：${lastAttempt?.reason ?? '未说明原因'}。正文没有被改写，可以修改后重新批准。`)
  } else if (!input.approvalApplies) {
    step = 'approve'
    blockers.push(
      current?.approved === true
        ? '候选在批准之后被改过（正文、目标或版本变了），旧批准已失效，需要重新批准。'
        : '这条候选还没有人工批准。所有模式都必须逐条批准，包括有限自动。',
    )
  } else {
    step = 'publish'
  }

  // The capability gate is checked here too, so the button is not offered when the gate would
  // refuse anyway. It never *replaces* the gate: `assertCapability` still runs at publish time.
  if (capability !== undefined && capability.effective !== 'supported' && step !== 'done') {
    blockers.push(
      `平台能力「${capability.effective}」：${capability.reason}` +
        '（证据只能满足 unverified；缺权限或平台不支持，验收也补不上）',
    )
  }

  const doneFlags: Partial<Record<WorkbenchStep, boolean>> = {
    link: true,
    target: hasTarget,
    generate: hasCandidates,
    review: hasCandidates,
    approve: input.approvalApplies,
    publish: outcome === 'confirmed' || outcome === 'sent_unconfirmed' || outcome === 'unknown',
    readback: outcome === 'confirmed',
  }

  return {
    step,
    steps: buildSteps(step, doneFlags),
    blockers,
    missingEvidence: gaps,
    outcome,
    counts: {
      // Counts come from what the collection actually read, never from `declaredReplyCount` —
      // the platform's claim and our coverage are different facts, and showing the claim as
      // coverage is how a truncated read looks complete.
      floors: input.floorCount ?? 0,
      nested: input.nestedCount ?? 0,
      candidates: candidates.length,
    },
    ...(current === undefined
      ? {}
      : {
          target: {
            threadId: session.threadId,
            postId: current.targetPostId,
            kind: session.targetKind ?? 'nested',
            ...(session.opponentName === undefined ? {} : { authorName: session.opponentName }),
          },
        }),
    ...(capability === undefined ? {} : { capability }),
    ...(lastAttempt?.readBack === undefined ? {} : { readBack: lastAttempt.readBack }),
  }

  function buildSteps(currentStep: WorkbenchStep, flags: Partial<Record<WorkbenchStep, boolean>>): WorkbenchStepView[] {
    const currentIndex = order.indexOf(currentStep)
    return order
      .filter((id) => id !== 'done')
      .map((id, index) => ({
        id,
        title: STEP_TITLES[id],
        status:
          index < currentIndex
            ? 'done'
            : index === currentIndex
              ? 'current'
              : flags[id] === true
                ? 'done'
                : 'pending',
      }))
  }
}

/**
 * Map the durable facts onto the five outcome states.
 *
 * Ordering matters: an unresolved attempt wins over "no attempt", because saying
 * "not attempted" about a request that may be on the platform is the sentence that gets it
 * re-sent.
 */
function deriveOutcome(
  session: StoredSession | undefined,
  candidate: StoredCandidate | undefined,
  lastAttempt: WorkbenchInput['lastAttempt'],
): PublishOutcomeView {
  if (session === undefined) return 'not_attempted'
  if (lastAttempt !== undefined) {
    if (lastAttempt.status === 'confirmed') return 'confirmed'
    if (lastAttempt.status === 'uncertain') return 'unknown'
    return 'refused'
  }
  if (candidate?.publishedPostId !== undefined) {
    // A post id proves the platform accepted something. Whether it is *this* reply is the
    // read-back's question, so this is "sent", not "confirmed".
    return 'sent_unconfirmed'
  }
  if (session.state === 'PUBLISHING') return 'sent_unconfirmed'
  return 'not_attempted'
}

/**
 * Whether an approval still authorizes the candidate **as it is now**.
 *
 * This is the rule that makes editing safe: the owner approves bytes, not an intention. Any of
 * the three things that decide where and what gets posted — the text, the target, or the
 * candidate version — moving invalidates it.
 *
 * `undefined` approval means "nothing to compare", which is a refusal, not a pass.
 */
export function approvalStillApplies(input: {
  readonly candidate: Pick<StoredCandidate, 'replyId' | 'textHash' | 'candidateVersion' | 'targetPostId' | 'approved'>
  readonly approval?: {
    readonly candidateId: string
    readonly candidateVersion?: number
    readonly textHash?: string
    readonly targetPostId?: string
  }
}): { applies: boolean; reason: string } {
  const { candidate, approval } = input
  if (candidate.approved !== true) {
    return { applies: false, reason: '这条候选还没有被批准' }
  }
  if (approval === undefined) {
    return { applies: false, reason: '没有找到对应的批准记录' }
  }
  if (approval.candidateId !== candidate.replyId) {
    return { applies: false, reason: '批准记录绑定的是另一条候选' }
  }
  if (approval.candidateVersion !== undefined && approval.candidateVersion !== candidate.candidateVersion) {
    return {
      applies: false,
      reason: `候选版本已从 ${approval.candidateVersion} 变成 ${candidate.candidateVersion}（重新生成过），旧批准不再适用`,
    }
  }
  if (approval.textHash !== undefined && approval.textHash !== candidate.textHash) {
    return { applies: false, reason: '正文在批准之后被修改过，旧批准不再适用' }
  }
  if (approval.targetPostId !== undefined && approval.targetPostId !== candidate.targetPostId) {
    return { applies: false, reason: '目标楼层/回复在批准之后变过，旧批准不再适用' }
  }
  return { applies: true, reason: '批准与当前候选一致' }
}

/**
 * The sanitized diagnostic payload (§八).
 *
 * Redaction is by **allow-list of field names**, not by pattern: a pattern that hunts for
 * `cookie=` will miss the header next week. Nothing that is not named below leaves this function,
 * so a new sensitive field cannot leak by being forgotten.
 */
export function workbenchDiagnostics(input: {
  readonly platform: string
  readonly threadId?: string
  readonly step: WorkbenchStep
  readonly outcome: PublishOutcomeView
  readonly counts: { floors: number; nested: number; candidates: number }
  readonly faults?: readonly { kind: string; label: string; reason: string; nextStep: string }[]
  readonly gaps?: readonly MissingEvidence[]
  readonly capability?: { declared: string; effective: string; reason: string }
}): Record<string, unknown> {
  return {
    platform: input.platform,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    step: input.step,
    outcome: input.outcome,
    counts: input.counts,
    ...(input.capability === undefined ? {} : { capability: input.capability }),
    faults: (input.faults ?? []).map((fault) => ({
      kind: fault.kind,
      label: fault.label,
      reason: fault.reason,
      nextStep: fault.nextStep,
    })),
    gaps: (input.gaps ?? []).map((gap) => ({ what: gap.what, detail: gap.detail })),
    // Stated explicitly so a reader of the report knows the omission was deliberate.
    redacted: ['cookie', 'token', 'apiKey', 'credential', 'authorization', 'set-cookie'],
  }
}
