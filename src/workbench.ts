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
import { assuranceFromEvidence, describeEvidence } from './identity.js'

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

/**
 * How far the *target's author* has been checked.
 *
 * Kept separate from the approval on purpose. An approval record binds bytes — text,
 * version, target post id, publishing account — and says nothing about who is sitting
 * on the target post right now. The publish path re-reads the platform and checks the
 * author there (`resolveTarget` + `snapshotStillValid`); until that read happens, all
 * this page can honestly claim is "not re-checked".
 *
 * The two states that are `blocking` are not predictions, they are the same facts the
 * publish gate reads before it touches the network: no snapshot, or no stable author
 * id. `publishCandidate` refuses both with a dedicated error code, so offering a
 * publish button here would be offering a button that cannot work.
 *
 * The four states:
 *
 * - `not_approved` — nothing to check yet: no candidate, or no approval binding it.
 * - `not_rechecked` — a stable author id is recorded; the platform has not been
 *   re-read since, and this page cannot claim otherwise.
 * - `unverifiable` — only a display name is recorded; publishing will be refused.
 * - `no_snapshot` — the candidate has no target snapshot; publishing will be refused.
 */
export type TargetIdentityState =
  | 'not_approved'
  | 'not_rechecked'
  | 'unverifiable'
  | 'no_snapshot'

/** What the page may say about the target's author. */
export interface TargetIdentityView {
  readonly state: TargetIdentityState
  /** True when `publishCandidate` is certain to refuse on identity grounds. */
  readonly blocking: boolean
  /** One sentence a reader can act on. Never a claim of verification. */
  readonly detail: string
  readonly authorId?: string
  readonly authorName?: string
}

/** A fact the collection could not establish. Rendered as a caveat, never as content. */
export interface MissingEvidence {
  readonly what: string
  readonly detail: string
}

/** Everything the workbench page needs, in one shape. */
/**
 * The five states the workbench must let a reader tell apart.
 *
 * | state | what it means | can publish |
 * | --- | --- | --- |
 * | `verified` | evidence supports the owner's identity | yes |
 * | `unverified` | readable, but nothing proves who it is | no |
 * | `conflict` | two surfaces proved *different* accounts | no, must be resolved |
 * | `legacy_unknown` | a pre-v0.2.23 record; provenance was never recorded | no |
 * | `recheck_required` | identity is fine; the *target* is re-read at publish | proceed, with warning |
 *
 * The last one is not a defect. Target authorship is deliberately re-verified at
 * send time, so "this still needs a check" is the normal state of a ready page,
 * not a failure — and saying so is what keeps the other four believable.
 */
export type OwnerIdentityViewState =
  | 'verified'
  | 'unverified'
  | 'conflict'
  | 'legacy_unknown'
  | 'recheck_required'
  | 'unknown'

export interface OwnerIdentityView {
  readonly state: OwnerIdentityViewState
  /** One line a person can act on. Never "unknown error". */
  readonly detail: string
  /** True when the publish button must not be offered. */
  readonly blocking: boolean
  /** The evidence, in words, for the reader who wants to check. */
  readonly evidence?: string
}

export interface WorkbenchState {
  readonly step: WorkbenchStep
  readonly steps: readonly WorkbenchStepView[]
  /** Ordered reasons the *next* irreversible action cannot happen yet. */
  readonly blockers: readonly string[]
  /**
   * What is known about the *owner's* identity, and whether it is enough.
   *
   * v0.2.23 surfaced a bare "cannot publish" with no reason. A grey button that
   * says nothing teaches the reader to guess, and the guess is usually "the tool is
   * broken". This carries the five states the page must distinguish, all derived
   * from the session plus the evidence the gate itself uses — never inferred by the
   * client, which cannot see the session at all.
   */
  readonly ownerIdentity: OwnerIdentityView
  /**
   * Facts the reader must know but that do not block anything.
   *
   * Separate from `blockers` because "you cannot proceed" and "proceeding will also
   * re-check something" are different messages, and merging them teaches the reader
   * to skim both. `blockers` is what stops the button; this is what the button will
   * still do after it is pressed.
   */
  readonly notices: readonly string[]
  /**
   * The two things an approval does and does not cover, stated side by side.
   *
   * This exists because v0.2.22's页面 showed a bare `已批准` next to a publish button,
   * which reads as "everything is authorized". The approval covers bytes; the author
   * of the target is re-checked by the publish path, and the page must not borrow that
   * check's authority for itself.
   */
  readonly approval: {
    /** What the approval record authorizes: the text, version and target post. */
    readonly content: { readonly applies: boolean; readonly detail: string }
    /** What it does not: who is on the other end. */
    readonly target: TargetIdentityView
  }
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
      notices: [],
      approval: {
        content: { applies: false, detail: '还没有候选，也没有可批准的正文' },
        target: describeTargetIdentity(undefined, false),
      },
      missingEvidence: gaps,
      outcome: 'not_attempted',
      ownerIdentity: describeOwnerIdentity(undefined),
      counts: { floors: 0, nested: 0, candidates: 0 },
      ...(capability === undefined ? {} : { capability }),
    }
  }

  const hasTarget = session.targetSnapshot !== undefined || current?.targetPostId !== undefined
  const hasCandidates = candidates.length > 0

  let step: WorkbenchStep
  const blockers: string[] = []
  const notices: string[] = []

  // What the approval covers, and what it does not. Computed once, used by the step
  // decision below and by the page.
  const targetIdentity = describeTargetIdentity(current, input.approvalApplies)
  /**
   * The owner's identity, which is a *different* question from the target's.
   *
   * Both can block, for unrelated reasons, and the page has to say which. A reader
   * told only "cannot publish" will retry the same thing forever.
   */
  const ownerIdentity = describeOwnerIdentity(session)

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
  } else if (ownerIdentity.blocking) {
    // The owner's identity is the more fundamental failure: if we cannot prove whose
    // words these are, re-checking the target is moot. Reported before the target
    // check so the page names the first thing to fix.
    step = 'review'
    blockers.push(ownerIdentity.detail)
    if (ownerIdentity.evidence !== undefined) {
      notices.push(`身份依据：${ownerIdentity.evidence}`)
    }
  } else if (targetIdentity.blocking) {
    // The content is approved, but the publish path is certain to refuse on identity
    // grounds. Staying on `publish` and rendering a button that always fails would be a
    // second, quieter version of the same lie: the page would look ready while the gate
    // was already closed.
    step = 'review'
    blockers.push(targetIdentity.detail)
  } else {
    step = 'publish'
    // Approved content is not approved identity. Say so where the publish button is,
    // because that is the moment the reader is deciding whether everything is in order.
    notices.push(
      '内容已批准（正文、版本、目标位置三方绑定）。目标作者身份不在批准范围内：' +
        '发表时会重新读取平台并核对作者，对不上就会被拒绝。',
    )
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
    notices,
    ownerIdentity,
    approval: {
      content: {
        applies: input.approvalApplies,
        detail: input.approvalApplies
          ? '内容已批准：正文、候选版本、目标位置与批准记录一致'
          : '内容未获批准，或批准已失效',
      },
      target: targetIdentity,
    },
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
 * Say what is known about the *author* of the target — and, just as important, what is not.
 *
 * ## Why this is not a second identity check
 *
 * `approvalStillApplies` compares bytes; `publishCandidate` compares authors, but only
 * after re-reading the platform. Re-reading here would be a network call inside a
 * read-only page render, and duplicating the comparison would create a second place
 * that decides whether publishing may happen.
 *
 * So this function does neither. It reads the two facts the publish gate reads *before*
 * it touches the network — is there a snapshot, does it carry a stable author id — and
 * reports them. Everything else is reported as `not_rechecked`, which is the literal
 * truth: this page has not re-read the platform, and no boolean stored here could make
 * it have done so.
 */
/**
 * Describe what is known about the owner's identity.
 *
 * ## Derived, not stored
 *
 * This reads the session's evidence and recomputes with the *same* function the
 * publish gate uses (`assuranceFromEvidence`). A page that invented its own idea of
 * "verified" would sooner or later disagree with the gate, and the disagreement
 * would show up as a button that lies.
 *
 * The order of checks matters: a conflict is reported before "unverified", because
 * "we proved these are different people" is more informative — and more alarming —
 * than "we could not prove anything".
 */
export function describeOwnerIdentity(session: StoredSession | undefined): OwnerIdentityView {
  if (session === undefined) {
    return {
      state: 'unknown',
      blocking: true,
      detail: '还没有会话：先分析一条讨论，才能知道主人是谁。',
    }
  }

  if (session.identityConflicts !== undefined && session.identityConflicts.length > 0) {
    return {
      state: 'conflict',
      blocking: true,
      detail:
        '这个帖子里有不同的数据源把同一条回复判给了不同账号，无法确定哪一个是主人。' +
        '再次批准也不能解除这个冲突——需要先核对帖子本身，或换一条能读到稳定 ID 的讨论。',
      evidence: session.identityConflicts.map((entry) => entry.summary).join('；'),
    }
  }

  const evidence = session.ownerIdentityEvidence
  const proven = assuranceFromEvidence(evidence as never) === 'verified'

  if (proven) {
    return {
      state: 'verified',
      blocking: false,
      detail: '主人的身份有可核对的依据。发表时仍会重新读取目标作者，那是另一道检查。',
      evidence: describeEvidence(evidence as never),
    }
  }

  // A legacy-only session reads the same as "unverified" to the gate, but the reader
  // deserves the distinction: "we never recorded how this was identified" is a
  // different problem from "we looked and could not prove it".
  const legacy = evidence === undefined || evidence.kind === 'legacy'
  return {
    state: legacy ? 'legacy_unknown' : 'unverified',
    blocking: true,
    detail: legacy
      ? '这是一个旧会话：当时没有记录账号标识的来源，因此无法证明这条回复属于谁。' +
        '只读查看不受影响；要发表，请重新分析一次，或在配置里填写可核验的登录名/数字 ID。'
      : '主人的身份只有昵称之类的弱依据，不足以证明这条回复属于谁。' +
        '请改填可核验的贴吧登录名（un）或数字 ID。',
    evidence: describeEvidence(evidence as never),
  }
}

export function describeTargetIdentity(
  candidate: Pick<StoredCandidate, 'targetSnapshot'> | undefined,
  contentApproved: boolean,
): TargetIdentityView {
  if (candidate === undefined) {
    return {
      state: 'not_approved',
      blocking: false,
      detail: '还没有候选，谈不上目标身份',
    }
  }
  if (!contentApproved) {
    // There is nothing to verify *yet*: the page is at the approval step, and the
    // author re-read happens at publish. Saying `unverifiable` here would blame the
    // platform for a step the owner has not reached.
    return {
      state: 'not_approved',
      blocking: false,
      detail: '内容还没有获得批准。目标作者身份也没有核验；批准之后、发表时才会重新读取平台核对作者。',
    }
  }
  const snapshot = candidate.targetSnapshot
  if (snapshot === undefined) {
    return {
      state: 'no_snapshot',
      blocking: true,
      // Same condition and same outcome as `publishCandidate`'s `target_no_snapshot`
      // refusal: without a snapshot there is nothing to compare a fresh read against.
      detail:
        '这条候选没有目标快照（可能是旧版本生成的），发表路径会直接拒绝：' +
        '没有快照就没有可比对的对象。请重新生成并重新批准。',
    }
  }
  const authorId = snapshot.targetAuthorId
  const authorName = snapshot.targetAuthorName
  if (authorId === undefined || authorId === '') {
    return {
      state: 'unverifiable',
      blocking: true,
      detail:
        `要回复的这条发言只记录了显示昵称「${authorName ?? '未知用户'}」，平台没有给出稳定的用户 ID。` +
        '发表路径会以「作者无法核验」拒绝：昵称可以随时改，也可能被别人占用。',
      ...(authorName === undefined ? {} : { authorName }),
    }
  }
  return {
    state: 'not_rechecked',
    blocking: false,
    detail:
      `分析时记录的目标作者 ID 是 ${authorId}` +
      (authorName === undefined ? '' : `（昵称「${authorName}」）`) +
      '。本页没有重新读取平台，作者是否仍是同一人由发表路径现场核验。',
    authorId,
    ...(authorName === undefined ? {} : { authorName }),
  }
}

/**
 * Whether an approval still authorizes the candidate **as it is now**.
 *
 * ## Scope, stated once
 *
 * This function answers exactly one question: **do the bytes still match what the owner
 * approved?** It compares the candidate id, version, text hash and target post id. It
 * deliberately does **not** compare the author of the target, and adding that here would
 * be the wrong fix:
 *
 * - the approval record does not carry an author, so there is nothing to compare against
 *   without inventing a field;
 * - `snapshotStillValid` already does that comparison, against a *fresh platform read*,
 *   inside `publishCandidate`. A second comparison would be a second decider, and the two
 *   could disagree — which is how a UI ends up saying "approved" while the gate refuses.
 *
 * What the workbench needs instead is the honest statement that approval covers content
 * only; see {@link describeTargetIdentity} and `WorkbenchState.approval`.
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
