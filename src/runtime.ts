/**
 * The orchestration layer: one place where the pieces are wired into a task.
 *
 * The tools in `tools.ts` are thin wrappers over these functions so the
 * pipeline is testable without a Host, a network or a model. Every stage
 * records its state in the store, so a failure halfway through leaves a
 * session a human can inspect rather than a stack trace and nothing else.
 *
 * Since v0.2.0 this module speaks to the platform **only** through
 * `PlatformRegistry`. There is no `import ... from './platforms/tieba/...'`
 * here, and adding one is the regression the contract tests guard against: the
 * registry answers "whose URL is this?" and hands back an adapter, so a second
 * platform needs no edit to this file.
 */

import { PlatformError, type PlatformAdapter, type PlatformCapabilities, type ThreadRef } from './types.js'
import type { RegistryDiagnostics } from './platforms/registry.js'
import {
  analyzeDispute,
  buildHandleDirectory,
  describeParticipants,
  extractClaims,
  resolveKey,
  type Dispute,
  type OwnerIdentity,
} from './analyzer.js'
import {
  assertCollected,
  buildTimeline,
  collectThread,
  floorLabel,
  type CollectedThread,
  type TimelineEntry,
} from './collector.js'
import { compressContext, fixedCostTotal, resolveBudget, splitBudget } from './compressor.js'
import { generateReply } from './generator.js'
import { LlmError, OpenAiCompatibleClient, type LlmClient } from './llm.js'
import { resolvePersona, type PersonaConfig } from './persona.js'
import { publishCandidate, type PublishReport } from './publisher.js'
import { contentHash, resolveTarget, type TargetExpectation } from './target.js'
import { detectInjection, mustPauseOn, transition, type InteractionPolicy } from './safety.js'
import {
  DebateStore,
  dedupeKey,
  findTriggerRecords,
  mergeTriggerRecords,
  newCandidateId,
  newSessionId,
  type DedupeRecord,
  type StoredCandidate,
  type StoredSession,
  type TaskState,
} from './store.js'
import type { ResolvedConfig } from './config.js'
import { splitIds } from './config.js'

/** Everything the pipeline needs from the plugin shell. */
export interface Runtime {
  /**
   * The adapter for the platform this call is about.
   *
   * Kept as a getter, not a stored instance: in a multi-platform deployment the
   * adapter depends on which platform the URL belongs to, and a single field read
   * once at mount is what made "the registry says Weibo but every request went to
   * Tieba" possible.
   *
   * When {@link Runtime.platforms} can build adapters, prefer {@link adapterFor}
   * — this getter answers "the default platform", which is only correct for a
   * single-platform deployment and for callers that have already resolved one.
   */
  readonly adapter: PlatformAdapter
  readonly store: DebateStore
  readonly policy: InteractionPolicy
  readonly config: () => ResolvedConfig
  /** Model client factory, replaceable in tests. */
  readonly llm: () => LlmClient
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  /**
   * The platform registry, when the shell has one.
   *
   * Optional so the many v0.1.x tests that build a `Runtime` from a bare adapter
   * keep compiling. When present, URL resolution, adapter selection and capability
   * checks all go through it; when absent, {@link resolveThreadRef} falls back to
   * the adapter's own id, which is enough for a single-platform deployment.
   */
  readonly platforms?: PlatformRuntime
  /**
   * The credential state, when this deployment can report one.
   *
   * Absent in tests and in a deployment without `ctx.credentials`, where the
   * cookie comes from config and there is nothing to be uncertain about. When
   * present, the publisher refuses to send while it is unproven.
   */
  readonly credentialState?: () => {
    readonly phase: string
    readonly canPublish: boolean
    readonly error?: string
  }
}

/**
 * The platform services the pipeline needs.
 *
 * Deliberately an interface rather than the concrete `PlatformRegistry`: the
 * runtime must not be able to register or unregister platforms, and a test can
 * supply its own implementation without building a real registry.
 */
export interface PlatformRuntime {
  /** Find the platform that owns a URL and parse it. Throws when unknown. */
  resolveUrl(url: string): ThreadRef
  /** The registry's diagnostics, for the health report. */
  diagnostics(): RegistryDiagnostics
  /** The rich capability matrix for one platform. */
  capabilitiesOf(platform: string): import('./platforms/contracts.js').PlatformCapabilityMatrix
  /**
   * Build (or reuse) the adapter for one platform.
   *
   * This is the method that makes multi-platform operation real: the adapter is
   * chosen by platform id and created from *that platform's* configuration and
   * credentials, so two platforms in one process cannot share an identity.
   */
  adapterFor(platform: string): PlatformAdapter
  /**
   * Check a capability before a write, throwing when it is not proven.
   *
   * Present here so the publish path has one mandatory gate rather than relying
   * on each caller to remember. `supported` is required; `unverified`,
   * `degraded`, `permission_required` and `unavailable` all refuse.
   */
  assertCapability(platform: string, capability: import('./platforms/contracts.js').CapabilityName): void
}

/**
 * Resolve a user-supplied URL into a thread reference.
 *
 * This is the single place the pipeline discovers *which* platform it is talking
 * to. Three sources, in order:
 *
 * 1. the registry, which owns each platform's URL syntax;
 * 2. the adapter's own `parseUrl`, for a bare single-platform deployment;
 * 3. the raw string as a thread id — the last resort, and only correct when the
 *    caller already passed an id rather than a link.
 */
export function resolveThreadRef(runtime: Runtime, url: string): ThreadRef {
  if (runtime.platforms !== undefined) return runtime.platforms.resolveUrl(url)
  const adapterId = runtime.adapter.id
  const parse = (runtime.adapter as { parseUrl?: (input: string) => ThreadRef }).parseUrl
  if (typeof parse === 'function') {
    const parsed = parse.call(runtime.adapter, url)
    // A parser that disagrees with the adapter's own id would make the ledger
    // column and the session disagree; trust the adapter for the column.
    return { ...parsed, platform: adapterId }
  }
  // Last resort: an id-shaped input is a thread id.
  //
  // Anything else is refused. The previous version returned the raw string as the
  // thread id, so a pasted link became `kz=https://tieba.baidu.com/p/123` and the
  // platform answered 404 — a confusing failure a long way from its cause.
  if (/^[A-Za-z0-9_-]{4,}$/.test(url.trim())) {
    return { platform: adapterId, threadId: url.trim(), url: url.trim() }
  }
  throw new Error(
    `无法把「${url}」识别成帖子：它既不是已注册平台的链接，也不像帖子 ID。` +
      '请粘贴完整的帖子链接，或直接提供帖子 ID。',
  )
}

/**
 * The adapter for one platform.
 *
 * The single point every stage calls. With a registry it asks for the platform's
 * own adapter (built from that platform's config and credentials); without one it
 * returns the single adapter the Runtime was constructed with, which is exactly
 * right for a one-platform test double.
 *
 * Anything that reads, analyses, generates or publishes must call this rather
 * than touching `runtime.adapter`, or the "resolved platform" and "adapter used"
 * can drift apart.
 */
export function adapterFor(runtime: Runtime, platform: string): PlatformAdapter {
  if (runtime.platforms === undefined) {
    // A bare Runtime has exactly one adapter. Returning it for a *different*
    // platform id would be the bug this function exists to prevent, so refuse.
    if (platform !== runtime.adapter.id) {
      throw new Error(
        `这个 Runtime 只带了一个「${runtime.adapter.id}」适配器，` +
          `无法处理「${platform}」的请求。请通过平台注册中心构造 Runtime。`,
      )
    }
    return runtime.adapter
  }
  return runtime.platforms.adapterFor(platform)
}

/**
 * Check that a platform may perform a write, before anything irreversible.
 *
 * Runs the registry's capability gate when there is a registry. A bare Runtime
 * (a test double) has no declarations to check against, so it passes — that is
 * not a bypass for production: production always has a registry, and the
 * publisher's other checks (identity, target snapshot, idempotency, credential
 * phase) all still run.
 */
export function assertPlatformCapability(
  runtime: Runtime,
  platform: string,
  capability: import('./platforms/contracts.js').CapabilityName,
): void {
  if (runtime.platforms === undefined) return
  runtime.platforms.assertCapability(platform, capability)
}

/** A progress callback the tools pass through to the UI. */
export type Progress = (message: string) => void

/** Result of an analyze run. */
export interface AnalysisOutput {
  readonly sessionId: string
  readonly thread: {
    readonly threadId: string
    readonly title: string
    readonly forumName: string
    readonly url: string
    readonly declaredReplyCount?: number
    readonly readFloors: number
  }
  readonly dispute: Dispute
  readonly ownerClaims: readonly string[]
  readonly participants: readonly { displayName: string; postCount: number; isOwner: boolean; isOpponent: boolean }[]
  readonly issues: readonly string[]
  readonly securityNotes: readonly string[]
  readonly collected: CollectedThread
}

/** Build the LLM client from configuration, or throw a clear error. */
export function buildLlm(config: ResolvedConfig): LlmClient {
  if (!config.llmBaseUrl) {
    throw new LlmError(
      '没有配置模型接口。请在插件设置里填写 llmBaseUrl / llmApiKey / llmModel（任意 OpenAI 兼容接口）。',
      'unavailable',
    )
  }
  if (!config.llmModel) {
    throw new LlmError('没有配置模型名称（llmModel）', 'unavailable')
  }
  return new OpenAiCompatibleClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
  })
}

/** The owner identity from configuration. */
export function ownerIdentity(config: ResolvedConfig): OwnerIdentity {
  return { userId: config.ownerUserId || undefined, userName: config.ownerUserName || undefined }
}

/** The persona from configuration. */
export function personaFromConfig(config: ResolvedConfig): PersonaConfig {
  return resolvePersona({
    style: config.personaStyle,
    intensity: config.intensity,
    maxLength: config.maxLength,
    emojiLevel: config.emojiLevel,
    sarcasmLevel: config.sarcasmLevel,
    directness: config.directness,
  })
}

/** The interaction policy from configuration. */
export function policyFromConfig(config: ResolvedConfig): InteractionPolicy {
  return {
    mode: config.interactionMode,
    maxAutoPublishesPerSession: config.maxAutoPerSession,
    cooldownMs: config.cooldownSeconds * 1000,
    maxPublishesPerThread: config.maxPerThread,
    stopOnChallenge: true,
  }
}

/**
 * The settings one platform's adapter is allowed to see.
 *
 * This used to put `config.tiebaCookie` into a generic `cookie` field for every
 * platform, which quietly defeated the whole point of platform scoping: the
 * field was named neutrally, so a future Weibo adapter reading `settings.cookie`
 * would have received a Tieba session and nothing in the code said that was
 * wrong.
 *
 * Now the function is **per platform**, and a platform it knows nothing about
 * receives only the neutral request parameters — no cookie at all. Credentials
 * come through `PlatformContext.resolveCredential`, which the adapter manager
 * namespaces; they never travel in this object.
 *
 * @param config the resolved configuration
 * @param platform the platform id the settings are for
 */
export function platformSettingsOf(
  config: ResolvedConfig,
  platform: string,
): Readonly<Record<string, unknown>> {
  // Shared request tuning. None of these are secrets, and every platform needs
  // the same polite defaults.
  const neutral = {
    timeoutMs: config.requestTimeoutMs,
    retries: config.requestRetries,
    pageDelayMs: config.pageDelayMs,
    maxPages: config.maxFloorPages,
  }

  // Platform-specific extras. A platform not listed here gets no extra fields —
  // in particular it gets no cookie, which is the whole point.
  if (platform === 'tieba') {
    return {
      ...neutral,
      // The legacy config field. Kept because a v0.1.5 profile has its cookie
      // here and must keep working; the credential store overrides it when the
      // overlay holds a value (see `applyOverlay` in index.ts).
      cookie: config.tiebaCookie.trim() || undefined,
    }
  }

  return neutral
}

/**
 * Run the full read + analyze stage.
 *
 * This never calls the model. It produces the structured reconstruction a human
 * can check before any text is generated, which is what makes the "wrong
 * opponent" failure visible instead of hidden inside a reply.
 */
export async function runAnalysis(
  runtime: Runtime,
  input: {
    url: string
    postId?: string
    ownerInstruction?: string
    signal?: AbortSignal
    progress?: Progress
  },
): Promise<AnalysisOutput> {
  const config = runtime.config()
  const ref = resolveThreadRef(runtime, input.url)
  const config_ = config
  const owner = ownerIdentity(config_)
  if (!owner.userId && !owner.userName) {
    throw new Error('还没有绑定主人：请先调用 debate_bind_owner，或在插件设置里填写主人用户 ID')
  }

  const progress = input.progress ?? (() => undefined)
  progress(`正在读取帖子 ${ref.threadId}…`)

  // The adapter is chosen *by the platform the URL resolved to*. Reading it from
  // `runtime.adapter` here is what made a correctly-identified Weibo link get
  // read by the Tieba adapter.
  const collected = await collectThread(adapterFor(runtime, ref.platform), ref, {
    maxPages: config.maxFloorPages,
    signal: input.signal,
    onProgress: (update) => progress(update.message),
  })
  assertCollected(collected)

  // The trigger post: an explicit id, the URL's pid, or the newest owner post.
  //
  // The owner's posts are matched through the analyzer's own key resolver, not by
  // comparing raw ids. Tieba's `data-info.un` frequently holds the *nickname*
  // rather than a numeric id, so a nickname-configured owner and a floor whose
  // `authorId` is that same nickname produced the keys `name:似水蓝蝶` and
  // `似水蓝蝶` — never equal — and a thread the owner had clearly posted in was
  // reported as "the owner has not spoken here". One resolver, used everywhere,
  // is what keeps that from drifting apart again.
  const timeline = buildTimeline(collected)
  const nameByHandle = buildHandleDirectory(timeline)
  const ownerKeyMatches = (entry: TimelineEntry): boolean => {
    // A configured id is matched against the id only: the analyzer refuses to
    // degrade an id to a nickname, so the trigger lookup must not do it either.
    if (owner.userId) return entry.authorId === owner.userId
    if (owner.userName === undefined) return false
    return resolveKey(entry, nameByHandle) === owner.userName
  }
  const triggerPostId =
    input.postId ?? ref.postId ?? [...timeline].reverse().find(ownerKeyMatches)?.postId

  if (!triggerPostId) {
    throw new Error(
      '无法确定要分析的回复位置：请提供回复 ID（postId），或确认主人已在本帖发言',
    )
  }
  const triggerEntry = timeline.find((entry) => entry.postId === triggerPostId)
  if (!triggerEntry) {
    throw new Error(`回复 ${triggerPostId} 不在已采集的对话中（可能已被删除，或不在前面的楼层里）`)
  }

  progress('正在还原争论结构…')
  const dispute = analyzeDispute(collected, owner, {
    postId: triggerPostId,
    content: triggerEntry.content,
    aiAccountName: config.aiAccountName || undefined,
  })

  // The trigger must really be the owner's own post.
  //
  // Without this, passing any post id (or a URL whose pid belongs to somebody
  // else) would make the plugin act on a stranger's words as if the owner had
  // summoned it. The owner appearing elsewhere in the thread is not enough.
  //
  // The comparison reuses the resolved identity rather than comparing raw keys:
  // the platform exposes a numeric id on some rows and only a name on others, so
  // a name-shaped `ownerKey` never equals a row that carries an id. `analyzeDispute`
  // already unifies both shapes, so a trigger counts as the owner's when the
  // analyzer attributes it to the owner participant.
  const triggerIsOwner = isOwnersPost(timeline, triggerPostId, dispute)
  if (!triggerIsOwner) {
    const who = triggerEntry.authorName ?? triggerEntry.authorId ?? '未知用户'
    const idPart = triggerEntry.authorId ? `（${triggerEntry.authorId}）` : ''
    throw new Error(
      `这条回复的作者是 ${who}${idPart}，不是配置的主人。` +
        '为避免替别人吵架，请传主人自己发的回复 ID（postId）。' +
        '如果是按昵称匹配，建议改为主人稳定的用户 ID。',
    )
  }

  const participants = describeParticipants(collected, dispute.floorPostId).map((participant) => ({
    displayName: participant.displayName,
    postCount: participant.postCount,
    isOwner: participant.key === dispute.owner.key,
    isOpponent: dispute.opponent?.key === participant.key,
  }))

  // Content-safety scan: report, never execute. These strings are data.
  const securityNotes: string[] = []
  for (const entry of timeline) {
    const hits = detectInjection(entry.content)
    if (hits.length > 0) {
      securityNotes.push(
        `${floorLabel(entry.floorNumber, entry.postId)} ${entry.authorName ?? entry.postId} 的发言里出现可疑指令性文本（${hits.join('、')}），已按普通用户发言处理，不会作为系统指令执行`,
      )
    }
  }

  const ownerClaims = extractClaims(dispute.ownerStatements)
  const session = await persistAnalysis(runtime, ref, collected, dispute, triggerPostId, config)

  return {
    sessionId: session.id,
    thread: {
      threadId: collected.thread.id,
      title: collected.thread.title,
      forumName: collected.thread.forum.name,
      url: collected.thread.url,
      declaredReplyCount: collected.thread.declaredReplyCount,
      readFloors: collected.floors.length,
    },
    dispute,
    ownerClaims,
    participants,
    issues: collected.issues,
    securityNotes,
    collected,
  }
}

/**
 * Raised when live sessions already fill the configured cap.
 *
 * A distinct type rather than a plain `Error`, so tool handlers can report it as a
 * capacity condition with remediation ("finish or cancel a task, or raise
 * `maxSessions`") instead of a generic internal failure — and so no caller mistakes it
 * for "the platform refused", which would invite a retry that keeps failing.
 */
export class SessionCapacityError extends Error {
  readonly capacity: { active: number; cap: number; full: boolean; activeIds: readonly string[] }

  constructor(
    message: string,
    capacity: { active: number; cap: number; full: boolean; activeIds: readonly string[] },
  ) {
    super(message)
    this.name = 'SessionCapacityError'
    this.capacity = capacity
  }
}

/** Persist the analysis as a session, reusing one for the same trigger. */
async function persistAnalysis(
  runtime: Runtime,
  ref: ThreadRef,
  collected: CollectedThread,
  dispute: Dispute,
  triggerPostId: string,
  config: ResolvedConfig,
): Promise<StoredSession> {
  const now = new Date().toISOString()
  const key = dedupeKey({
    platform: ref.platform,
    threadId: ref.threadId,
    ownerKey: dispute.owner.key,
    triggerPostId,
  })

  // Everything that does not depend on the ledger is built up front; the parts that
  // do — whether a session may exist at all, and under which id — are decided inside
  // the single `mutate` below.
  const fields = {
    platform: ref.platform,
    threadId: ref.threadId,
    threadUrl: collected.thread.url,
    threadTitle: collected.thread.title,
    forumName: collected.thread.forum.name,
    ownerKey: dispute.owner.key,
    ownerName: dispute.owner.displayName,
    opponentKey: dispute.opponent?.key,
    opponentName: dispute.opponent?.displayName,
    // The publisher needs the opponent's stable id for its author check, and the
    // kind of post being answered to decide floor-vs-nested. Both are recorded
    // here, from analysis output, never from the model.
    ...(dispute.opponent?.userId ? { opponentUserId: dispute.opponent.userId } : {}),
    ...(dispute.opponent?.lastPostId
      ? { targetKind: postKindOf(collected, dispute.opponent.lastPostId) }
      : {}),
    disputeFloorPostId: dispute.floorPostId,
    disputeFloorNumber: dispute.floorNumber,
    triggerPostId,
    persona: {
      style: config.personaStyle,
      intensity: config.intensity,
      maxLength: config.maxLength,
    },
    candidates: [] as readonly StoredCandidate[],
    sentTexts: [] as readonly string[],
    createdAt: now,
    updatedAt: now,
  }

  // The lookup, the decision, the session insert and the ledger write happen in one
  // synchronous `mutate` callback. Splitting them — read outside, write inside — let
  // two concurrent `runAnalysis` calls for the same trigger both observe "no record"
  // and each create a session, which is exactly the race that yields two candidates
  // for one summons.
  //
  // The callback records what it decided; the assignment cannot fail to run, since
  // `mutate` invokes it synchronously before touching disk.
  let outcome: { readonly session: StoredSession; readonly reused: boolean; readonly historical: boolean } | undefined

  await runtime.store.mutate((data) => {
    // Every row for this trigger, whatever scheme wrote it.    //
    // Looking up the canonical key alone would miss the rows v0.1.4 and earlier
    // wrote under `platform:thread:昵称:trigger:na`. Those rows carry the publish
    // facts, so missing them is exactly how a nickname change resurrected an already
    // answered summon. `findTriggerRecords` matches on the explicit columns instead,
    // which every version has always written correctly.
    const identity = { platform: ref.platform, threadId: ref.threadId, triggerPostId }
    const rows = findTriggerRecords(data.dedupe, identity)
    const merged = mergeTriggerRecords(rows)

    // Reuse a live session if any row still points at one.
    for (const row of rows) {
      const live = data.sessions.find((session) => session.id === row.sessionId)
      if (live) {
        outcome = { session: live, reused: true, historical: false }
        return data
      }
    }

    // The rows survive but their sessions are gone (TTL prune, or a store that
    // outlived the session). The merged verdict decides whether this analysis may
    // create an actionable session at all.
    //
    // Creating a fresh session here and rewriting the row is what v0.1.3 did, and it
    // is how a confirmed publish turned back into "never sent" — the analysis path
    // dropped the row and inserted a blank one under the same key, so the user could
    // be offered a candidate for a trigger already answered in the thread.
    const historical = merged.found ? describeHistoricalPublish(merged) : undefined

    // `newSessionId` is second-resolution, so two runs in the same second would
    // otherwise collide and make `getSession` return the wrong task.
    const id = uniqueSessionId(key, data.sessions)

    // Refuse to start new work when live sessions already fill the cap.
    //
    // The cap bounds *finished* history (see `prune`), so reaching it with live work
    // means the user has that many tasks open. Dropping one to make room — which is
    // what v0.1.4 did via `slice(-maxSessions)` — destroys a draft mid-review, and
    // because its ledger row survives, the trigger looks freshly analysed while the
    // candidate is gone. Refusing is recoverable; losing work is not.
    const capacity = runtime.store.capacity()
    if (capacity.full) {
      throw new SessionCapacityError(
        `活跃会话已达上限（${capacity.active}/${capacity.cap}），无法开始新的分析任务。` +
          '为避免丢掉正在处理的任务，这里不会自动清理活跃会话。' +
          '请先发表或取消其中一些任务（debate_stop_session），或调大 maxSessions。',
        capacity,
      )
    }

    let session = {
      id,
      ...fields,
      state: historical?.state ?? (dispute.needsConfirmation ? 'NEEDS_CONFIRMATION' : 'ANALYZING'),
      statusText: historical
        ? historical.reason
        : dispute.needsConfirmation
          ? `无法确定争论对象：${dispute.notes.join('；')}`
          : `已识别主人与「${dispute.opponent?.displayName ?? '未知'}」的争论`,
      publishedPostIds: historical?.publishedPostIds ?? [],
    } as StoredSession
    outcome = { session, reused: false, historical: historical !== undefined }

    // Migration: fold every historical row for this trigger into one canonical row.
    //
    // Old keys are dropped rather than kept alongside the new one, because two rows
    // for one summon is the ambiguity that produced the conflict this merge exists to
    // resolve. The surviving facts — state, post id, first sighting — are carried
    // over, and a conflicting `confirmed` history is preserved as-is so the session
    // stays blocked instead of silently becoming publishable.
    const remaining = data.dedupe.filter((record) => !rows.some((row) => row.key === record.key))
    // Record where the row came from, so a later audit can explain a key that no
    // longer matches its own history. Only kept when an older write used a different
    // owner field than the one we are storing now.
    const previousOwner = rows
      .map((row: DedupeRecord) => row.legacyOwnerKey ?? row.ownerKey)
      .find((value: string) => value.length > 0 && value !== dispute.owner.key)
    const canonical: DedupeRecord = {
      key,
      platform: ref.platform,
      threadId: ref.threadId,
      // The owner is recorded for display; it is no longer part of the key.
      ownerKey: dispute.owner.key,
      triggerPostId,
      sessionId: id,
      firstSeenAt: merged.found ? merged.firstSeenAt : now,
      ...(merged.found && merged.publishedPostId ? { publishedPostId: merged.publishedPostId } : {}),
      ...(merged.found && merged.publishState ? { publishState: merged.publishState } : {}),
      ...(previousOwner ? { legacyOwnerKey: previousOwner } : {}),
    }
    if (merged.found && merged.conflicting) {
      // Contradictory history: keep it blocked and say so. Do not pick a winner.
      // `session` was declared `as StoredSession`, whose fields are readonly, so the
      // verdict is applied by rebuilding the object.
      session = {
        ...session,
        state: 'NEEDS_CONFIRMATION',
        statusText: merged.reason ?? '历史发表记录互相冲突，需要人工核对',
      }
    }

    return {
      ...data,
      sessions: [...data.sessions, session],
      dedupe: [...remaining, canonical],
    }
  })

  if (!outcome) throw new Error(`会话写入后未能读回（幂等键 ${key}）`)
  if (outcome.reused) runtime.log('info', `复用已有会话 ${outcome.session.id}`)
  else if (outcome.historical) runtime.log('info', `召唤 ${key} 已有历史发表记录，本次分析不创建可发布会话`)
  return outcome.session
}

/**
 * A session id that no existing session already uses.
 *
 * `newSessionId` stamps to the second, so two analyses of different triggers in the
 * same second can collide — and a collision makes `getSession` return the wrong task,
 * which then carries the wrong candidates into the publish path. Suffixing a counter
 * keeps the time-sortable prefix while guaranteeing uniqueness.
 *
 * @param seed the dedupe key, for the hash suffix
 * @param sessions the sessions already stored
 * @returns an id not present in `sessions`
 */
function uniqueSessionId(seed: string, sessions: readonly StoredSession[]): string {
  const base = newSessionId(seed)
  if (!sessions.some((session) => session.id === base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!sessions.some((session) => session.id === candidate)) return candidate
  }
  // A thousand same-second analyses of one trigger is not a real workload; fail
  // loudly rather than return an id that is already taken.
  throw new Error(`无法为 ${seed} 生成不重复的会话 id`)
}

/**
 * What the merged publish history means for a new analysis.
 *
 * A pruned session removes the working copy of a task; it must not remove the
 * evidence that a reply was sent. This turns the merged verdict from every row for
 * the trigger — canonical or legacy — into the state the new session must carry.
 *
 * @param merged the combined verdict from {@link mergeTriggerRecords}
 * @returns whether a new session may publish, and the state it must carry
 */
function describeHistoricalPublish(
  merged: Exclude<ReturnType<typeof mergeTriggerRecords>, { readonly found: false }>,
):
  | {
      readonly blocked: boolean
      readonly state: TaskState
      readonly reason: string
      readonly publishedPostIds: readonly string[]
    }
  | undefined {
  // Contradictory confirmed history outranks everything: the ledger cannot say which
  // reply is real, so nothing may be published on that basis.
  if (merged.conflicting) {
    return {
      blocked: true,
      state: 'NEEDS_CONFIRMATION',
      reason: merged.reason ?? '历史发表记录互相冲突，需要人工核对',
      publishedPostIds: [],
    }
  }
  const sentId = merged.publishedPostId
  if (merged.publishState === 'confirmed') {
    const known = sentId ? [sentId] : []
    return {
      blocked: true,
      // The trigger has been answered. `PUBLISHED` is terminal, so this session
      // cannot be generated into or published again — which is the point.
      state: 'PUBLISHED',
      reason:
        `这条召唤已经在帖子里发表过回复（post id ${sentId ?? '历史未记录'}），` +
        '本次只做只读分析，不会再进入生成与发布流程。',
      publishedPostIds: known,
    }
  }
  if (merged.publishState === 'pending') {
    return {
      blocked: true,
      // Outcome unknown: a human has to look at the thread before anything else
      // happens, and `NEEDS_CONFIRMATION` is the state that says so.
      state: 'NEEDS_CONFIRMATION',
      reason:
        '这条召唤此前尝试过发表，但没有拿到确定结果（可能已经发出，也可能没有）。' +
        '为避免重复回帖，本次分析不会创建可发布的候选；请先打开帖子确认后再决定。',
      publishedPostIds: [],
    }
  }
  if (merged.publishState === 'failed') {
    // A definite failure sent nothing, so a fresh attempt is legitimate. The row
    // is reused, not recreated, so its `firstSeenAt` survives.
    return undefined
  }
  // No publish state at all: the trigger was analysed but never published.
  return undefined
}

/** Result of a generate run. */
export interface GenerateOutput {
  readonly sessionId: string
  readonly candidateId: string
  readonly text: string
  readonly strategy: string
  readonly confidence: number
  readonly violations: readonly string[]
  readonly notes: readonly string[]
  readonly needsInput: boolean
  readonly needsInputReason?: string
  readonly contextTokens: number
  /** The thread-context share of the budget, after fixed costs. */
  readonly budget: number
  /** What the request spends outside the quoted thread. */
  readonly fixedCostTokens: number
  /** The whole request budget the user configured. */
  readonly totalBudget: number
  readonly omissions: readonly string[]
  readonly usage: { inputTokens: number; outputTokens: number; elapsedMs: number }
}

/**
 * Generate a candidate reply for an analyzed session.
 *
 * The session is re-collected rather than trusting a cached copy: a floor can
 * be deleted or edited between analysis and generation, and replying to a
 * vanished post is exactly what the "wrong target" guard exists to prevent.
 */
export async function runGeneration(
  runtime: Runtime,
  input: {
    sessionId: string
    persona?: Partial<PersonaConfig>
    ownerInstruction?: string
    signal?: AbortSignal
    progress?: Progress
  },
): Promise<GenerateOutput> {
  const config = runtime.config()
  const progress = input.progress ?? (() => undefined)
  await runtime.store.ready()
  const session = runtime.store.getSession(input.sessionId)
  if (!session) throw new Error(`找不到会话 ${input.sessionId}`)

  // A finished task must not produce new candidates.
  //
  // `CANCELLED` means the owner stopped it, and `PUBLISHED` means a reply already
  // went out; generating in either case spends a model call on something that can
  // never be sent and leaves behind a candidate that looks actionable.
  assertSessionCanGenerate(session)

  progress('正在重新读取帖子，确认目标仍然存在…')
  const ref: ThreadRef = {
    platform: session.platform,
    threadId: session.threadId,
    url: session.threadUrl,
  }
  // The session's stored platform decides which adapter re-reads the thread, so a
  // resumed Weibo session cannot be served by the Tieba adapter.
  const collected = await collectThread(adapterFor(runtime, session.platform), ref, {
    maxPages: config.maxFloorPages,
    signal: input.signal,
    onProgress: (update) => progress(update.message),
  })
  assertCollected(collected)

  const owner = ownerIdentity(config)
  const dispute = analyzeDispute(collected, owner, {
    postId: session.triggerPostId,
    content: buildTimeline(collected).find((entry) => entry.postId === session.triggerPostId)?.content,
  })

  // Opponent drift is a hard stop, not a warning.
  //
  // The reply text is written against one person. If a fresh read says the
  // argument is now with somebody else, continuing would produce a reply aimed at
  // somebody the owner never saw, or reuse the old opponent's ids and floor while
  // the text answers a new person. The original approved candidates also stop
  // being valid, because they were reviewed against the old target.
  const opponentDrift = detectOpponentDrift(session, dispute)
  if (opponentDrift) {
    await runtime.store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((entry) =>
        entry.id === session.id
          ? {
              ...entry,
              state: transition(entry.state, 'NEEDS_CONFIRMATION').state,
              statusText: opponentDrift,
              // Every existing candidate was reviewed against the old opponent.
              candidates: entry.candidates.map((row) => ({ ...row, approved: false })),
              updatedAt: new Date().toISOString(),
            }
          : entry,
      ),
    }))
    throw new Error(
      `${opponentDrift}。已停止生成：请重新分析这个帖子并确认争论对象，旧的候选回复不再可发表。`,
    )
  }

  // Resolve and verify the target *before* calling the model, so the text is
  // written against a snapshot that a human will review alongside it.
  const targetExpectation: TargetExpectation = {
    threadId: session.threadId,
    floorPostId: dispute.floorPostId,
    targetPostId: dispute.opponent?.lastPostId ?? '',
    targetKind: dispute.opponent
      ? postKindOf(collected, dispute.opponent.lastPostId ?? '')
      : session.targetKind ?? 'nested',
    ...(dispute.opponent?.userId ? { targetAuthorId: dispute.opponent.userId } : {}),
  }

  if (!targetExpectation.targetPostId) {
    await runtime.store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((entry) =>
        entry.id === session.id
          ? {
              ...entry,
              state: transition(entry.state, 'NEEDS_CONFIRMATION').state,
              statusText: '无法确定要回复哪一条发言，不能生成可发表的回复',
              updatedAt: new Date().toISOString(),
            }
          : entry,
      ),
    }))
    throw new Error(
      '无法确定回复目标：争论对手没有可定位的发言。请用 debate_analyze_reply 指定要回复的那条帖子。',
    )
  }

  progress('正在核对回复目标…')
  const resolved = await resolveTarget(adapterFor(runtime, session.platform), targetExpectation, {
    signal: input.signal,
    platform: session.platform,
  })
  if (!resolved.ok) {
    await runtime.store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((entry) =>
        entry.id === session.id
          ? {
              ...entry,
              state: transition(entry.state, 'NEEDS_CONFIRMATION').state,
              statusText: resolved.message,
              updatedAt: new Date().toISOString(),
            }
          : entry,
      ),
    }))
    throw new Error(`回复目标无法确认：${resolved.message}`)
  }

  const persona = { ...personaFromConfig(config), ...(input.persona ?? {}) }
  const total = resolveBudget({
    preset: config.contextPreset,
    tokens: config.contextTokens > 0 ? config.contextTokens : undefined,
  })
  // The configured number is the *whole request*, so the quoted thread only gets
  // what is left after the system prompt, persona, scaffold and reply reservation.
  const split = splitBudget(total.tokens)
  const budget = { tokens: split.contextTokens, quoteLimit: total.quoteLimit }
  const context = compressContext({
    collected,
    dispute,
    trigger: { postId: session.triggerPostId },
    persona,
    budget,
    totalTokens: total.tokens,
    ownerInstruction: input.ownerInstruction,
  })

  progress(
    `正在生成回复（上下文 ${context.tokens} + 固定开销 ${fixedCostTotal()} / 总预算 ${total.tokens} tokens）…`,
  )
  const client = runtime.llm()
  const result = await generateReply(client, {
    dispute,
    context,
    persona,
    recentReplies: session.sentTexts,
    alreadyPublished: session.publishedPostIds,
    signal: input.signal,
    ownerInstruction: input.ownerInstruction,
    // Sampling controls come from config so a small model can be fed a
    // lower temperature without editing code.
    temperature: config.llmTemperature,
    maxTokens: config.llmMaxOutputTokens > 0 ? config.llmMaxOutputTokens : undefined,
  })

  const candidateId = newCandidateId(session.id, session.candidates.length + 1)
  // The stored target is the opponent's verified last post — not whatever id the
  // model returned. A model may suggest *who* to answer (and is validated
  // against that), but the id used to place the reply comes from collected data.
  const verifiedTargetPostId = dispute.opponent?.lastPostId ?? ''
  const candidateText = result.draft?.reply ?? ''
  const candidate: StoredCandidate = {
    replyId: candidateId,
    text: candidateText,
    strategy: result.draft?.strategy ?? 'direct_rebuttal',
    targetPostId: verifiedTargetPostId,
    // The snapshot travels with the candidate, so an approval binds to the exact
    // target this text was written against.
    targetSnapshot: resolved.snapshot,
    candidateVersion: nextCandidateVersion(session),
    textHash: contentHash(candidateText),
    confidence: result.draft?.confidence ?? 0,
    violations: result.violations.map((violation) => violation.message),
    notes: result.notes,
    createdAt: new Date().toISOString(),
    approved: false,
  }

  // READY is only reachable when the target is confirmed and the draft is clean.
  // Both conditions are checked here rather than trusting the violation list to
  // have covered them, because a candidate that reaches READY is publishable.
  const targetConfirmed = !dispute.needsConfirmation && dispute.opponent !== undefined
  const wantsReady = targetConfirmed && candidate.violations.length === 0 && candidate.text.length > 0
  const desiredState: TaskState = result.needsInput
    ? 'NEEDS_CONFIRMATION'
    : wantsReady
      ? 'READY'
      : 'REVIEWING'

  await runtime.store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((entry) => {
      if (entry.id !== session.id) return entry
      // Every transition goes through the machine; an illegal move keeps the
      // previous state and says why instead of silently jumping.
      //
      // Generation is entered explicitly first, so a session still in ANALYZING
      // has a legal path to REVIEWING/READY rather than needing a shortcut.
      const entered = transition(entry.state, 'GENERATING')
      const base = entered.state
      const moved = transition(base, desiredState)
      const statusText = !moved.ok
        ? (moved.reason ?? '状态不允许本次变更')
        : result.needsInput
          ? `模型要求补充信息：${result.needsInputReason ?? ''}`
          : !targetConfirmed
            ? '尚未确认争论对象，不能进入待发表状态'
            : candidate.violations.length > 0
              ? `候选回复未通过检查：${candidate.violations.join('；')}`
              : '候选回复已就绪，等待主人确认'
      return {
        ...entry,
        state: moved.state,
        statusText,
        candidates: [...entry.candidates, candidate],
        updatedAt: new Date().toISOString(),
      }
    }),
    usage: [
      ...data.usage,
      {
        at: new Date().toISOString(),
        sessionId: session.id,
        purpose: 'generate' as const,
        model: config.llmModel,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        elapsedMs: result.usage.elapsedMs,
      },
    ],
  }))

  return {
    sessionId: session.id,
    candidateId,
    text: candidate.text,
    strategy: candidate.strategy,
    confidence: candidate.confidence,
    violations: candidate.violations,
    notes: candidate.notes,
    needsInput: result.needsInput,
    needsInputReason: result.needsInputReason,
    contextTokens: context.tokens,
    budget: budget.tokens,
    fixedCostTokens: fixedCostTotal(),
    totalBudget: context.totalBudget,
    omissions: context.omissions,
    usage: result.usage,
  }
}

/** Publish an approved candidate. */
export async function runPublish(
  runtime: Runtime,
  input: {
    sessionId: string
    candidateId: string
    approvedText: string
    humanApproved: boolean
    signal?: AbortSignal
  },
): Promise<PublishReport> {
  // One controller per publish, registered so `stopSession` can abort a send that
  // is still in its validation phase. The caller's own signal is chained in.
  const controller = new AbortController()
  const unregister = registerInFlight(input.sessionId, controller)
  const callerSignal = input.signal
  const onCallerAbort = (): void => controller.abort()
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

  try {
    const session = runtime.store.getSession(input.sessionId)
    if (!session) {
      return {
        ok: false,
        status: 'refused',
        message: `找不到会话 ${input.sessionId}`,
      }
    }
    return await publishCandidate(
      {
        adapter: adapterFor(runtime, session.platform),
        store: runtime.store,
        policy: runtime.policy,
        // The mandatory capability gate. Wiring it here means every publish path
        // that goes through `runPublish` is checked, without each caller having to
        // remember — and `runPublish` is the only path that can reach the platform.
        ...(runtime.platforms === undefined
          ? {}
          : {
              assertCapability: (platform: string, capability: 'comment.publish' | 'comment.reply') => {
                runtime.platforms!.assertCapability(platform, capability)
              },
            }),
        // Read live so a changed aiAccountUserId applies to this publish.
        config: () => {
          const current = runtime.config()
          return { aiAccountUserId: current.aiAccountUserId, aiAccountName: current.aiAccountName }
        },
        // Consulted immediately before the network call by the publisher.
        isCancelled: (sessionId) => runtime.store.getSession(sessionId)?.state === 'CANCELLED',
        // Consulted before anything irreversible: an unproven credential state
        // means the plugin cannot tell an absent cookie from an unread one, and
        // publishing as a guessed identity cannot be undone.
        ...(runtime.credentialState === undefined
          ? {}
          : { credentialState: () => runtime.credentialState!() }),
      },
      { ...input, signal: controller.signal },
    )
  } finally {
    callerSignal?.removeEventListener('abort', onCallerAbort)
    unregister()
  }
}

/** A readable session summary. */
export interface SessionView {
  readonly session: StoredSession
  readonly candidates: readonly StoredCandidate[]
}

/** Read one session. */
export async function getSession(runtime: Runtime, sessionId: string): Promise<SessionView> {
  await runtime.store.ready()
  const session = runtime.store.getSession(sessionId)
  if (!session) throw new Error(`找不到会话 ${sessionId}`)
  return { session, candidates: session.candidates }
}

/**
 * Stop a session.
 *
 * Two things this must get right:
 *
 * 1. The transition goes through the state machine, so a `PUBLISHED` session is not
 *    relabelled as cancelled — that would erase the fact that a reply went out.
 * 2. Cancelling is *not* an undo. If a publish already reached the platform the
 *    reply exists; the record must keep saying so. The abort controller only stops
 *    requests that have not been sent yet.
 */
export async function stopSession(
  runtime: Runtime,
  sessionId: string,
  reason?: string,
): Promise<StoredSession> {
  await runtime.store.ready()
  const session = runtime.store.getSession(sessionId)
  if (!session) throw new Error(`找不到会话 ${sessionId}`)

  // Signal in-flight work first, so a publish that is still validating aborts.
  cancelInFlight(sessionId)

  const moved = transition(session.state, 'CANCELLED')
  if (!moved.ok) {
    // Refusing to cancel a finished task is the honest answer: the reply is
    // already out there, and pretending otherwise loses the publish record.
    throw new Error(
      `${moved.reason ?? '当前状态不能取消'}。` +
        (session.publishedPostIds.length > 0
          ? `这条会话已经发表过（post id ${session.publishedPostIds.join(', ')}），取消不会撤回已发出的回复。`
          : ''),
    )
  }

  const next: StoredSession = {
    ...session,
    state: moved.state,
    statusText: reason ?? '主人已停止本次任务',
    updatedAt: new Date().toISOString(),
  }
  await runtime.store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((entry) => (entry.id === sessionId ? next : entry)),
  }))
  return next
}

/**
 * Abort controllers for publishes currently in flight, keyed by session.
 *
 * A session may legitimately have more than one publish in progress — two
 * candidates tried at once, or an approval racing a retry. Keeping a single
 * controller per session meant the second registration silently overwrote the
 * first, so `stop_session` would abort only the last one and leave the other
 * running. A set keeps every live controller addressable.
 */
const inFlightControllers = new Map<string, Set<AbortController>>()

/** Register a controller for one session's publish. */
export function registerInFlight(sessionId: string, controller: AbortController): () => void {
  let set = inFlightControllers.get(sessionId)
  if (!set) {
    set = new Set()
    inFlightControllers.set(sessionId, set)
  }
  set.add(controller)
  return () => {
    const current = inFlightControllers.get(sessionId)
    if (!current) return
    current.delete(controller)
    if (current.size === 0) inFlightControllers.delete(sessionId)
  }
}

/** Abort every publish in flight for this session. */
export function cancelInFlight(sessionId: string): void {
  const set = inFlightControllers.get(sessionId)
  if (!set) return
  // Abort all of them; a session-level cancel is not a request to cancel one task.
  for (const controller of set) controller.abort()
}

/**
 * How many publishes are currently tracked.
 *
 * With a `sessionId`, counts only that session's — which is what the settings
 * page needs when it reports "aborted N requests". Without one, the whole
 * process; that form is a test seam.
 */
export function inFlightPublishCount(sessionId?: string): number {
  if (sessionId !== undefined) return inFlightControllers.get(sessionId)?.size ?? 0
  let total = 0
  for (const set of inFlightControllers.values()) total += set.size
  return total
}

/** The health report. */
export interface HealthReport {
  readonly ok: boolean
  readonly enabled: boolean
  readonly ownerBound: boolean
  readonly llmConfigured: boolean
  readonly storePath: string
  readonly sessions: number
  readonly usage: { calls: number; inputTokens: number; outputTokens: number; failures: number }
  readonly capabilities: PlatformCapabilities
  readonly cookieNames: readonly string[]
  readonly notes: readonly string[]
}

/** Build a health report without touching the network. */
export async function healthCheck(runtime: Runtime): Promise<HealthReport> {
  const config = runtime.config()
  await runtime.store.ready()
  const notes: string[] = []
  const ownerBound = Boolean(config.ownerUserId || config.ownerUserName)
  const llmConfigured = Boolean(config.llmBaseUrl && config.llmModel)
  if (!ownerBound) notes.push('尚未绑定主人（ownerUserId / ownerUserName 都为空）')
  if (!llmConfigured) notes.push('尚未配置模型接口（llmBaseUrl / llmModel 为空）')
  if (!config.tiebaCookie) {
    notes.push('尚未填写贴吧 Cookie：读取公开帖子不需要，但发表回复和检查登录状态需要')
  }
  if (config.interactionMode === 'manual') {
    notes.push('当前是手动审核模式：任何回复都必须由主人确认后才会发送')
  }

  return {
    ok: config.enabled,
    enabled: config.enabled,
    ownerBound,
    llmConfigured,
    storePath: runtime.store.path,
    sessions: runtime.store.snapshot().sessions.length,
    usage: runtime.store.usageSummary(),
    capabilities: runtime.adapter.getCapabilities(),
    cookieNames: credentialNamesOf(runtime.adapter),
    notes,
  }
}

/**
 * Ask an adapter which credential names it holds.
 *
 * A platform adapter may or may not expose this, so it is probed rather than
 * required: the generic interface stays free of a Tieba-specific accessor while
 * the health report can still say something useful. Values are never returned.
 */
function credentialNamesOf(adapter: object): readonly string[] {
  const probe = adapter as { describeCookieNames?: () => readonly string[] }
  return typeof probe.describeCookieNames === 'function' ? probe.describeCookieNames() : []
}

/** Check whether an id may summon. */
export function isAllowedOwner(config: ResolvedConfig, userId: string | undefined): boolean {
  const allowed = [config.ownerUserId, ...splitIds(config.allowedOwnerIds)].filter(Boolean)
  if (allowed.length === 0) return false
  if (!userId) return false
  return allowed.includes(userId)
}

/** Translate an arbitrary failure into a user-facing sentence. */
export function describeFailure(error: unknown): { message: string; pause: boolean } {
  if (error instanceof PlatformError) {
    return { message: error.message, pause: mustPauseOn(error).pause }
  }
  if (error instanceof LlmError) {
    const pause = error.code === 'quota' || error.code === 'unavailable'
    return { message: error.message, pause }
  }
  return { message: (error as Error)?.message ?? String(error), pause: false }
}

/**
 * Whether a post id is a first-level floor or a reply inside one.
 *
 * Read from the collected thread rather than assumed, because the publisher uses
 * it to decide between posting a new floor and replying inside an existing one.
 */
function postKindOf(collected: CollectedThread, postId: string): 'floor' | 'nested' {
  for (const entry of collected.floors) {
    if (entry.floor.postId === postId) return 'floor'
    if (entry.nested.some((reply) => reply.postId === postId)) return 'nested'
  }
  return 'nested'
}

/**
 * Whether a trigger post belongs to the owner, judged on unified identity.
 *
 * Comparing a raw `ownerKey` against a raw author key fails whenever the two
 * surfaces disagree about whether to expose a numeric id — which, on Tieba, they
 * routinely do: the same person appears as a name on one row and as an id on the
 * next. `analyzeDispute` already merges those shapes into one participant, so the
 * question "is this the owner's post" is answered by asking whether the
 * *participant who wrote it* is the owner participant.
 *
 * Being wrong here is expensive in both directions: a false pass makes the plugin
 * argue on a stranger's behalf, a false refusal makes every nickname binding
 * unusable.
 */
function isOwnersPost(
  timeline: readonly { postId: string; authorId?: string; authorName?: string }[],
  triggerPostId: string,
  dispute: Dispute,
): boolean {
  const trigger = timeline.find((entry) => entry.postId === triggerPostId)
  if (!trigger) return false

  const owner = dispute.owner

  // While the analyzer attributes this post to the owner participant, it is the
  // owner's post — regardless of whether one surface rendered a numeric id and
  // another rendered only the name. `analyzeDispute` already unified those shapes,
  // and its verdict is what `dispute.owner` reflects.
  const attributedToOwner =
    dispute.ownerStatements.some((statement) => statement.postId === triggerPostId) ||
    dispute.exchange.some(
      (statement) => statement.postId === triggerPostId && statement.authorKey === owner.key,
    )
  if (attributedToOwner) return true

  // Not attributed to the owner. These checks are a cross-check on identity and
  // must be conjunctive about the id: a matching display name never overrides a
  // conflicting numeric id, because two accounts can share a nickname.
  if (trigger.authorId) {
    if (!owner.userId) return false
    return trigger.authorId === owner.userId
  }
  // No id on this row: a name match is the only signal, and it is usable only when
  // no stable id was configured (otherwise the id is authoritative).
  if (trigger.authorName && !owner.userId) return trigger.authorName === owner.displayName
  return false
}

/**
 * Explain why the opponent changed, or `undefined` when it did not.
 *
 * Both directions matter: a session that had an opponent and now has a different
 * one, and a session that had one and now has none. Treating the second as
 * "nothing changed" would let a reply go out with no opponent at all.
 */
function detectOpponentDrift(session: StoredSession, dispute: Dispute): string | undefined {
  if (!session.opponentKey) return undefined
  if (!dispute.opponent) {
    return `上次分析的争论对象是「${session.opponentName ?? session.opponentKey}」，本次重新分析没有找到对手`
  }
  if (dispute.opponent.key !== session.opponentKey) {
    return (
      `争论对象已变化：上次是「${session.opponentName ?? session.opponentKey}」，` +
      `本次是「${dispute.opponent.displayName}」`
    )
  }
  return undefined
}

/**
 * The next candidate version for a session.
 *
 * Monotonic across regenerations, including after candidates are pruned, so an
 * approval given for version N never matches a later version N.
 */
function nextCandidateVersion(session: StoredSession): number {
  const highest = session.candidates.reduce((max, row) => Math.max(max, row.candidateVersion ?? 0), 0)
  return highest + 1
}

/**
 * Refuse to generate for a session that is finished.
 *
 * Deliberately narrow: only the two states where a new candidate is meaningless are
 * blocked. `NEEDS_CONFIRMATION` and `REVIEWING` stay allowed, because regenerating
 * after a refusal is exactly how a user recovers.
 */
function assertSessionCanGenerate(session: StoredSession): void {
  if (session.state === 'CANCELLED') {
    throw new Error('这个会话已被主人停止，不能再生成新的候选回复。如需继续，请重新分析这个帖子。')
  }
  if (session.state === 'PUBLISHED') {
    throw new Error(
      `这个会话已经发表过回复（post id ${session.publishedPostIds.join(', ') || '未知'}），不再生成新的候选。` +
        '如果要继续跟帖，请对新的一条召唤重新分析。',
    )
  }
}

/** Re-export for tools that build their own compressed context preview. */
export type { CompressedContext } from './compressor.js'
export type { CollectedThread } from './collector.js'
export type { GenerationResult } from './generator.js'
