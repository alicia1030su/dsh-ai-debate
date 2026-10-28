/**
 * Turn evidence into a decision.
 *
 * The pieces so far only *observe*: the detector names what it saw, the integrity
 * guard judges stance. This module is the one place that decides, so that "what is
 * allowed" is a policy question with one answer rather than being re-litigated at
 * each call site.
 *
 * ## The three outcomes, and why there is no fourth
 *
 * - `allow` — nothing significant found. Still goes through manual review; safety
 *   never removes the human step.
 * - `review` — something is unclear. A human must look at a specific piece of
 *   evidence. Safer than `allow` because uncertainty is not permission.
 * - `block` — a hard rule was broken: the reply attacks the owner, impersonates a
 *   role, follows an injected instruction, or leaks a credential. This cannot be
 *   overridden by having approved an earlier version of the candidate.
 *
 * There is deliberately no "allow because the owner clicked through the warning".
 * The owner may **edit** a blocked reply and re-run every check; that is different
 * from waving a blocked text through.
 *
 * ## Fail-closed
 *
 * Every decision function here treats a *missing* answer as the pessimistic one.
 * If the semantic reviewer times out, the candidate is `review`, never `allow`.
 * That is the single most important property in this file: a security system whose
 * default on error is "fine" is worse than none, because it fails silently exactly
 * when an attacker is hammering it.
 */

import type { InjectionAssessment, InjectionSeverity } from './injection-detector.js'
import type { StanceProblem, StanceVerdict, VerifiedOwner } from './owner-integrity.js'

/** The decision a security check produces. */
export type SecurityDecision = 'allow' | 'review' | 'block'

/**
 * The per-candidate security record.
 *
 * Every field is produced by program logic — never by asking the generation model
 * whether it behaved. A model's self-assessment is worthless here: the whole threat
 * is a model that has been persuaded to misbehave.
 */
export interface CandidateSecurityAssessment {
  /** An injection attempt was found in the conversation this reply came from. */
  readonly injectionDetected: boolean
  /** The owner identity used was the platform-verified one, not a claimed one. */
  readonly ownerIdentityValid: boolean
  /** The reply targets the post the opponent actually wrote. */
  readonly targetIdentityValid: boolean
  readonly stanceConsistency: StanceVerdict
  /** The reply explicitly attacks the owner rather than the argument. */
  readonly ownerDirectedAttack: boolean
  /** The reply appears to be executing a command found in untrusted text. */
  readonly unauthorizedInstructionFollowed: boolean
  /** Credential or privacy leakage risk. */
  readonly secretLeakRisk: boolean
  /** Every claim in the reply traces to a collected post. */
  readonly evidenceIntegrityValid: boolean
  readonly decision: SecurityDecision
  readonly reasons: readonly string[]
}

/** What the checks found, before a decision is made. */
export interface SecurityFindings {
  /** Injection assessment of the conversation the reply was built from. */
  readonly input?: InjectionAssessment
  /** Stance problems found in the generated reply. */
  readonly stance: { readonly verdict: StanceVerdict; readonly problems: readonly StanceProblem[] }
  /** Whether the owner identity came from the binding rather than the thread. */
  readonly ownerIdentityValid: boolean
  /** Whether the reply's declared target is the opponent's real post. */
  readonly targetIdentityValid: boolean
  /** Whether the reply's evidence citations all exist. */
  readonly evidenceIntegrityValid: boolean
  /** Whether the reply text itself looks like a credential or privacy leak. */
  readonly secretLeakRisk: boolean
}

/**
 * The strictness the owner may tune.
 *
 * Only the *semantic* thresholds move. The deterministic rules — target identity,
 * credential leakage, owner attack — are not configurable, because a setting that
 * turns those off is a setting that makes the plugin unsafe, and shipping one means
 * an attacker only has to talk the owner into flipping it.
 */
export type SecurityStrictness = 'strict' | 'standard' | 'relaxed'

/** Severity that forces review at each strictness. */
const REVIEW_THRESHOLD: Readonly<Record<SecurityStrictness, InjectionSeverity | 'none'>> = Object.freeze({
  // Anything at all gets a look. For a public account being actively targeted.
  strict: 'low',
  standard: 'medium',
  // Only high and critical. Ordinary arguments about AI won't trip it.
  relaxed: 'high',
})

function severityRank(severity: InjectionSeverity | 'none'): number {
  return ['none', 'low', 'medium', 'high', 'critical'].indexOf(severity)
}

/**
 * Decide what may happen to this candidate.
 *
 * Order matters: the hard blocks are evaluated first and cannot be softened by
 * strictness. Only the *uncertainty* branch consults the setting.
 */
export function decideSecurity(
  findings: SecurityFindings,
  strictness: SecurityStrictness = 'standard',
): CandidateSecurityAssessment {
  const reasons: string[] = []
  const problems = findings.stance.problems

  const ownerDirectedAttack = problems.some((problem) => problem.kind === 'attacks_owner')
  const unauthorizedInstructionFollowed = problems.some(
    (problem) => problem.kind === 'follows_injected_instruction',
  )
  const roleInversion = problems.some(
    (problem) =>
      problem.kind === 'role_inversion' || problem.kind === 'owner_identity_claimed_by_other',
  )
  const ownerPrivacyLeak = problems.some((problem) => problem.kind === 'leaks_owner_privacy')

  // ---- hard blocks: independent of strictness, not overridable ----------------

  if (!findings.ownerIdentityValid) {
    reasons.push('主人身份不是来自已验证的平台账号绑定，可能是被评论或模型改写过的')
  }
  if (!findings.targetIdentityValid) {
    reasons.push('回复目标与对手真实发言不一致，目标可能被改变')
  }
  if (ownerDirectedAttack) {
    reasons.push('回复针对主人本人进行攻击，而插件应当站在主人这边')
  }
  if (roleInversion) {
    reasons.push('回复接受了「主人已更换」或「服从对方」的说法，主人身份被外部文本改写')
  }
  if (unauthorizedInstructionFollowed) {
    reasons.push('回复看起来在执行外部评论里的行为命令')
  }
  if (ownerPrivacyLeak || findings.secretLeakRisk) {
    reasons.push('回复可能泄露凭据或主人隐私')
  }

  const blocked =
    !findings.ownerIdentityValid ||
    !findings.targetIdentityValid ||
    ownerDirectedAttack ||
    roleInversion ||
    unauthorizedInstructionFollowed ||
    ownerPrivacyLeak ||
    findings.secretLeakRisk

  if (blocked) {
    return {
      injectionDetected: (findings.input?.severity ?? 'none') !== 'none',
      ownerIdentityValid: findings.ownerIdentityValid,
      targetIdentityValid: findings.targetIdentityValid,
      stanceConsistency: findings.stance.verdict,
      ownerDirectedAttack,
      unauthorizedInstructionFollowed: unauthorizedInstructionFollowed || roleInversion,
      secretLeakRisk: findings.secretLeakRisk || ownerPrivacyLeak,
      evidenceIntegrityValid: findings.evidenceIntegrityValid,
      decision: 'block',
      reasons,
    }
  }

  // ---- text-level injection: the conversation contained an attempt ----------
  //
  // A flagged conversation does not by itself condemn a good reply. The owner may
  // well want to answer an attacker who just tried an injection. But the reply can
  // no longer be treated as certainly independent, so it goes to a human.
  const inputSeverity = findings.input?.severity ?? 'none'
  const threshold = REVIEW_THRESHOLD[strictness]
  const inputFlagged = severityRank(inputSeverity) >= severityRank(threshold)
  if (inputFlagged) {
    reasons.push(
      `所依据的对话里有注入痕迹（最高 ${inputSeverity}）：` +
        (findings.input?.signals.map((signal) => signal.label).join('、') ?? '未记录细节') +
        '。回复本身没有明显问题，但无法排除受影响，需要人工确认',
    )
  }

  if (findings.stance.verdict === 'uncertain') {
    reasons.push(
      `立场待确认：${problems.map((problem) => problem.message).join('；') || '无法判定回复与主人立场的关系'}`,
    )
  }

  if (!findings.evidenceIntegrityValid) {
    reasons.push('回复里的部分说法找不到对应的已读帖子作为依据')
  }

  if (reasons.length > 0) {
    return {
      injectionDetected: inputSeverity !== 'none',
      ownerIdentityValid: findings.ownerIdentityValid,
      targetIdentityValid: findings.targetIdentityValid,
      stanceConsistency: findings.stance.verdict,
      ownerDirectedAttack: false,
      unauthorizedInstructionFollowed: false,
      secretLeakRisk: findings.secretLeakRisk,
      evidenceIntegrityValid: findings.evidenceIntegrityValid,
      decision: 'review',
      reasons,
    }
  }

  return {
    injectionDetected: false,
    ownerIdentityValid: true,
    targetIdentityValid: true,
    stanceConsistency: findings.stance.verdict,
    ownerDirectedAttack: false,
    unauthorizedInstructionFollowed: false,
    secretLeakRisk: false,
    evidenceIntegrityValid: findings.evidenceIntegrityValid,
    decision: 'allow',
    reasons: [],
  }
}

/**
 * Fold in a semantic reviewer's opinion, which can only make things stricter.
 *
 * A reviewer may raise `allow` to `review` or `review` to `block`. It may never
 * lower anything: the reviewer reads attacker-controlled text, so it is itself a
 * target, and letting it grant permission would be trusting the thing under attack.
 *
 * @param current the deterministic decision
 * @param opinion what the reviewer said, or `undefined` when it failed
 */
export function applyReviewerOpinion(
  current: CandidateSecurityAssessment,
  opinion:
    | { readonly status: 'ok'; readonly risk: 'none' | 'some' | 'high'; readonly note?: string }
    | { readonly status: 'unavailable'; readonly reason: string }
    | { readonly status: 'malformed'; readonly reason: string }
    | undefined,
): CandidateSecurityAssessment {
  // No opinion at all is treated as failure, not as approval.
  if (opinion === undefined) {
    return escalate(current, 'review', '语义安全审核没有返回结论，按不可用处理')
  }

  if (opinion.status === 'unavailable') {
    return escalate(current, 'review', `语义安全审核不可用（${opinion.reason}），未默认放行`)
  }
  if (opinion.status === 'malformed') {
    return escalate(current, 'review', `语义安全审核返回了无法解析的结果（${opinion.reason}）`)
  }

  if (opinion.risk === 'high') {
    return escalate(current, 'block', `语义安全审核判定高风险${opinion.note ? `：${opinion.note}` : ''}`)
  }
  if (opinion.risk === 'some') {
    return escalate(current, 'review', `语义安全审核提示有风险${opinion.note ? `：${opinion.note}` : ''}`)
  }
  // `none` can never relax the deterministic verdict.
  return current
}

/** Raise a decision to at least `target`, never lower it. */
function escalate(
  current: CandidateSecurityAssessment,
  target: SecurityDecision,
  reason: string,
): CandidateSecurityAssessment {
  const rank: Readonly<Record<SecurityDecision, number>> = { allow: 0, review: 1, block: 2 }
  if (rank[target] <= rank[current.decision]) return current
  return {
    ...current,
    decision: target,
    reasons: [...current.reasons, reason],
  }
}

/** True when a candidate may be published without further human action. */
export function mayAutoPublish(assessment: CandidateSecurityAssessment): boolean {
  // Only `allow` *and* an actual assessment. A candidate with no assessment is a
  // candidate that skipped the gate, which is the shape of a bypass.
  return assessment.decision === 'allow'
}

/**
 * A key identifying which text and assessment a decision belongs to.
 *
 * The publisher re-checks before sending: the owner may have approved candidate A,
 * then the text or the target changed, and the stored assessment no longer
 * describes what would be sent. Comparing this key is how "approved" is tied to
 * the exact text rather than to a session.
 */
export function assessmentFingerprint(input: {
  readonly reply: string
  readonly targetPostId: string
  readonly decision: SecurityDecision
}): string {
  // A simple, dependency-free digest is enough: this is an equality check between
  // two values in the same process, not a security primitive.
  const material = `${input.decision}\u0000${input.targetPostId}\u0000${input.reply}`
  let hash = 0x811c9dc5
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${input.decision}:${hash.toString(16)}:${material.length}`
}

/**
 * Describe a decision for the owner.
 *
 * Phrased as an explanation rather than a verdict, because the owner needs to know
 * *what to look at* in order to decide whether to edit and retry.
 */
export function describeAssessment(assessment: CandidateSecurityAssessment): string {
  const head =
    assessment.decision === 'block'
      ? '已阻止发表'
      : assessment.decision === 'review'
        ? '需要人工确认'
        : '未发现异常'
  if (assessment.reasons.length === 0) return head
  return `${head}：\n- ${assessment.reasons.join('\n- ')}`
}

/** The owner identity a check must be run against, derived from the binding only. */
export function ownerFromBinding(input: {
  readonly platform: string
  readonly accountId?: string
  readonly displayName?: string
}): VerifiedOwner {
  return {
    platform: input.platform,
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
  }
}
