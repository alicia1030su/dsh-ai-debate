/**
 * The platform contract: what a platform must declare and provide.
 *
 * This module is the boundary the v0.2.0 architecture is built around. Nothing
 * here may mention a concrete platform — Tieba, Weibo, Zhihu and the test fakes
 * are all just implementations of these interfaces.
 *
 * Two ideas carry most of the weight:
 *
 * 1. **Capabilities are states, not booleans.** The v0.1.x model answered
 *    `publish: true`, which conflates "the code exists", "it worked against a
 *    logged-out page" and "a real account published successfully". Those are
 *    very different claims, and collapsing them is how a plugin ends up
 *    telling someone a platform is supported when it never was.
 *
 * 2. **A provider is not an adapter.** The provider is the cheap, stateless
 *    description of a platform (can I handle this URL? what do I support?); the
 *    adapter is the stateful object that owns a cookie jar and a cache. Keeping
 *    them apart is what lets the registry answer "which platform is this link?"
 *    without constructing anything or touching the network.
 */

import type {
  Mention,
  PlatformAdapter,
  PlatformErrorCode,
  PublishOutcome,
  PublishTarget,
  ReplyContext,
  ReplyPage,
  AuthState,
  Thread,
  ThreadRef,
  UserProfile,
} from '../types.js'

// ---------------------------------------------------------------------------
// Capability model
// ---------------------------------------------------------------------------

/**
 * The state of one capability.
 *
 * `supported` and `unverified` are the pair that matters most: they both mean
 * "the code path exists", and only one of them means "somebody proved it
 * works". A caller that needs proof must check for `supported`.
 */
export type CapabilityState =
  /** Implemented and verified against the real platform. */
  | 'supported'
  /** The platform has the ability but this deployment/account lacks the grant. */
  | 'permission_required'
  /** The platform genuinely does not offer this; no code can fix it. */
  | 'unavailable'
  /** Works, but returns less than the platform actually has. */
  | 'degraded'
  /** Implemented, but never confirmed against a real account. Do not promise it. */
  | 'unverified'

/** The capability names the core cares about. */
export type CapabilityName =
  /** Read the thread body: title, content, author, time. */
  | 'thread.read'
  /** List top-level comments/answers/replies. */
  | 'comment.list'
  /** Page through that list rather than getting only the first page. */
  | 'comment.paginate'
  /** Read replies nested under a top-level comment. */
  | 'comment.nested'
  /** Resolve one specific comment id, for a precise summons. */
  | 'comment.locate'
  /** Prove which account is logged in. */
  | 'identity.verify'
  /** Read @-mention notifications for the bound account. */
  | 'event.mentions'
  /** Publish a new top-level comment. */
  | 'comment.publish'
  /** Reply to a specific comment. */
  | 'comment.reply'
  /** Read a published reply back to confirm it landed. */
  | 'publish.verify'
  /** Read image/video content, not just their URLs. */
  | 'media.read'
  /** Resolve a public user profile. */
  | 'user.profile'

/** Every capability name, in a stable order for display. */
export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'thread.read',
  'comment.list',
  'comment.paginate',
  'comment.nested',
  'comment.locate',
  'identity.verify',
  'event.mentions',
  'comment.publish',
  'comment.reply',
  'publish.verify',
  'media.read',
  'user.profile',
]

/** One capability, with the reason it is in that state. */
export interface CapabilityDeclaration {
  readonly state: CapabilityState
  /**
   * Why. Required even for `supported`, because "supported" with no evidence
   * reads exactly like a guess.
   */
  readonly reason: string
  /** Concrete limits a caller can hit, phrased for a human. */
  readonly limits?: readonly string[]
  /** What grant would move this to `supported`, when one would. */
  readonly requiredPermissions?: readonly string[]
  /**
   * ISO timestamp of the last real verification.
   *
   * Only ever a date at which someone actually exercised the capability against
   * the live platform. A date invented to make a row look complete is worse than
   * no date at all, so absence is normal and meaningful.
   */
  readonly lastVerifiedAt?: string
}

/** Everything a platform declares about itself, in one object. */
export interface PlatformCapabilityMatrix {
  readonly platform: string
  /** When this matrix was produced (not when the platform was verified). */
  readonly declaredAt: string
  readonly capabilities: Readonly<Record<CapabilityName, CapabilityDeclaration>>
  /** Anything that does not fit a single capability row. */
  readonly notes?: readonly string[]
}

/** Look one capability up, defaulting to `unavailable` rather than guessing. */
export function stateOf(
  matrix: PlatformCapabilityMatrix,
  name: CapabilityName,
): CapabilityDeclaration {
  return (
    matrix.capabilities[name] ?? {
      state: 'unavailable',
      reason: `${matrix.platform} 没有声明 ${name} 能力`,
    }
  )
}

/** True only for `supported`; `unverified` does not count as usable proof. */
export function isProven(matrix: PlatformCapabilityMatrix, name: CapabilityName): boolean {
  return stateOf(matrix, name).state === 'supported'
}

/** Compact marker for a capability, for health/diagnostics output. */
export function markOf(state: CapabilityState): string {
  switch (state) {
    case 'supported':
      return '✅'
    case 'degraded':
      return '⚠️'
    case 'unverified':
      return '❓'
    case 'permission_required':
      return '🔑'
    case 'unavailable':
      return '❌'
  }
}

// ---------------------------------------------------------------------------
// Capability errors
// ---------------------------------------------------------------------------

/**
 * Raised when a capability is missing entirely.
 *
 * Deliberately not a `PlatformError`: this is a property of the integration, not
 * of a request, and retrying will never help. Callers that treat every failure
 * as retryable would otherwise hammer a platform that cannot answer.
 */
export class UnsupportedCapabilityError extends Error {
  readonly platform: string
  readonly capability: CapabilityName

  constructor(platform: string, capability: CapabilityName, reason?: string) {
    super(reason ?? `${platform} 不支持 ${capability}`)
    this.name = 'UnsupportedCapabilityError'
    this.platform = platform
    this.capability = capability
  }
}

/** Raised when the platform can do it but this account has not been granted it. */
export class PermissionRequiredError extends Error {
  readonly platform: string
  readonly capability: CapabilityName
  readonly requiredPermissions: readonly string[]

  constructor(
    platform: string,
    capability: CapabilityName,
    requiredPermissions: readonly string[],
    reason?: string,
  ) {
    super(reason ?? `${platform} 的 ${capability} 需要授权`)
    this.name = 'PermissionRequiredError'
    this.platform = platform
    this.capability = capability
    this.requiredPermissions = requiredPermissions
  }
}

/**
 * Translate a capability declaration into the error a caller should see.
 *
 * One place, so every platform refuses in the same shape instead of each
 * adapter inventing its own message — and so nothing can accidentally return a
 * pretend-success for a capability it does not have.
 */
export function capabilityFailure(
  platform: string,
  capability: CapabilityName,
  declaration: CapabilityDeclaration,
): Error {
  if (declaration.state === 'permission_required') {
    return new PermissionRequiredError(
      platform,
      capability,
      declaration.requiredPermissions ?? [],
      `${platform} 的「${capability}」需要授权：${declaration.reason}`,
    )
  }
  return new UnsupportedCapabilityError(
    platform,
    capability,
    `${platform} 的「${capability}」不可用（${declaration.state}）：${declaration.reason}`,
  )
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Everything a provider needs to build an adapter.
 *
 * Deliberately narrow: a provider gets the platform-scoped configuration, a way
 * to ask for credentials by name, and a logger. It does not get the store, the
 * model client or the publisher — a platform must not be able to publish on its
 * own, and it must not be able to read another platform's rows.
 */
export interface PlatformContext {
  /** Platform-scoped settings, already resolved. Never contains raw secrets. */
  readonly settings: Readonly<Record<string, unknown>>
  /**
   * Resolve one credential by its platform-namespaced name.
   *
   * Names are `DSH_AI_DEBATE_<PLATFORM>_<WHAT>`; a provider may only ask for its
   * own prefix, which the registry enforces. Absent means this deployment has no
   * credential service, in which case the provider falls back to settings.
   */
  readonly resolveCredential?: (name: string) => Promise<string | undefined>
  readonly log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  /** Cancellation for any work the provider does while being built. */
  readonly signal?: AbortSignal
}

/**
 * A platform, as the registry knows it.
 *
 * `canHandleUrl` and `parseUrl` are synchronous and offline on purpose: the
 * registry must be able to answer "which platform owns this link?" without
 * building an adapter, reading a cookie or making a request.
 */
export interface PlatformProvider {
  /** Stable, lowercase id. Must match the adapter's `id` and the config namespace. */
  readonly id: string
  /** Human name, for the settings page. */
  readonly displayName: string
  /**
   * What kind of interaction this platform is designed around.
   *
   * Only used for wording in the UI and docs; it changes no behaviour.
   */
  readonly shape: 'forum-thread' | 'microblog' | 'qa' | 'note' | 'video' | 'other'

  /** True when this platform owns the given URL. Must not throw on junk input. */
  canHandleUrl(url: string): boolean

  /**
   * Parse a URL into a thread reference.
   *
   * Must throw rather than return a guessed id: a wrong thread id means reading
   * the wrong argument and eventually replying into it.
   */
  parseUrl(url: string): ThreadRef

  /**
   * Declare capabilities.
   *
   * Synchronous and side-effect free: it reports what the *integration* can do,
   * not whether a particular request will succeed right now.
   */
  describeCapabilities(): PlatformCapabilityMatrix

  /** Build the stateful adapter. Called once per configuration generation. */
  createAdapter(context: PlatformContext): PlatformAdapter
}

// ---------------------------------------------------------------------------
// Legacy bridge
// ---------------------------------------------------------------------------

/**
 * The v0.1.x boolean shape, still used by the existing health report.
 *
 * Kept as its own type so the bridge below is the only place that knows how to
 * translate it, and so removing it later is a single-file change.
 */
export interface LegacyCapabilityFlags {
  readonly thread: boolean
  readonly replies: boolean
  readonly nestedReplies: boolean
  readonly userProfile: boolean
  readonly mentions: boolean
  readonly publish: boolean
  readonly authCheck: boolean
  readonly notes?: Readonly<Record<string, string>>
}

/** Map one legacy flag to a declaration, using its note as the reason. */
function fromFlag(
  platform: string,
  name: CapabilityName,
  enabled: boolean,
  note: string | undefined,
): CapabilityDeclaration {
  if (!enabled) {
    return { state: 'unavailable', reason: note ?? `${platform} 未声明 ${name}` }
  }
  // A legacy `true` carries no evidence. The honest state for it is "the code
  // exists and nobody disproved it", which is `unverified`, not `supported`.
  // An adapter that has really been proven overrides this by supplying its own
  // matrix.
  return { state: 'unverified', reason: note ?? `${platform} 声明支持 ${name}，但没有验证记录` }
}

/**
 * Derive a matrix from the old booleans.
 *
 * Every `true` becomes `unverified`, never `supported`: the old model could not
 * distinguish the two, so upgrading the claim here would invent evidence. An
 * adapter that wants `supported` must say so itself.
 */
export function matrixFromLegacy(
  platform: string,
  flags: LegacyCapabilityFlags,
  declaredAt = new Date().toISOString(),
): PlatformCapabilityMatrix {
  const note = (key: string): string | undefined => flags.notes?.[key]
  const capabilities = {
    'thread.read': fromFlag(platform, 'thread.read', flags.thread, note('thread')),
    'comment.list': fromFlag(platform, 'comment.list', flags.replies, note('replies')),
    'comment.paginate': fromFlag(platform, 'comment.paginate', flags.replies, note('replies')),
    'comment.nested': fromFlag(
      platform,
      'comment.nested',
      flags.nestedReplies,
      note('nestedReplies'),
    ),
    'comment.locate': fromFlag(platform, 'comment.locate', flags.replies, note('replies')),
    'identity.verify': fromFlag(platform, 'identity.verify', flags.authCheck, note('authCheck')),
    'event.mentions': fromFlag(platform, 'event.mentions', flags.mentions, note('mentions')),
    'comment.publish': fromFlag(platform, 'comment.publish', flags.publish, note('publish')),
    'comment.reply': fromFlag(platform, 'comment.reply', flags.publish, note('publish')),
    'publish.verify': fromFlag(platform, 'publish.verify', flags.publish, note('publish')),
    'media.read': { state: 'unavailable' as const, reason: `${platform} 未提供图片内容读取` },
    'user.profile': fromFlag(platform, 'user.profile', flags.userProfile, note('userProfile')),
  } satisfies Record<CapabilityName, CapabilityDeclaration>

  return {
    platform,
    declaredAt,
    capabilities,
    notes: ['该矩阵由 v0.1.x 的布尔能力转换而来；true 一律记为 unverified，不代表已验证。'],
  }
}

// ---------------------------------------------------------------------------
// Adapter shape checks
// ---------------------------------------------------------------------------

/**
 * The subset of the adapter contract the generic core actually calls today.
 *
 * Used by the contract tests to prove a fake platform implements everything the
 * core needs, so a real new platform cannot pass review with a method missing.
 */
export interface CoreAdapterSurface {
  readonly id: string
  readonly displayName: string
  checkAuthentication(signal?: AbortSignal): Promise<AuthState>
  getThread(ref: ThreadRef, signal?: AbortSignal): Promise<Thread>
  getReplies(ref: ThreadRef, page: number, signal?: AbortSignal): Promise<ReplyPage>
  getReplyContext(
    ref: ThreadRef,
    postId: string,
    signal?: AbortSignal,
    options?: { forceFresh?: boolean },
  ): Promise<ReplyContext>
  publishReply(
    ref: ThreadRef,
    target: PublishTarget,
    content: string,
    signal?: AbortSignal,
  ): Promise<PublishOutcome>
}

/** Services a platform may optionally expose, probed rather than required. */
export interface OptionalAdapterSurface {
  getNestedReplies?: (
    ref: ThreadRef,
    floor: unknown,
    page: number,
    signal?: AbortSignal,
  ) => Promise<unknown>
  getUserProfile?: (userNameOrId: string, signal?: AbortSignal) => Promise<UserProfile>
  getMentions?: (since: string | undefined, signal?: AbortSignal) => Promise<readonly Mention[]>
  /** Report which credential names the adapter holds. Values must never be returned. */
  describeCookieNames?: () => readonly string[]
  /** The rich capability matrix, when the adapter can state one. */
  describeCapabilities?: () => PlatformCapabilityMatrix
}

/** Normalize an unknown error into a platform error code, for uniform reporting. */
export function errorCodeOf(error: unknown): PlatformErrorCode {
  const code = (error as { code?: unknown } | null)?.code
  const known: readonly PlatformErrorCode[] = [
    'network',
    'timeout',
    'dns',
    'rate_limited',
    'forbidden',
    'captcha',
    'not_found',
    'auth_required',
    'permission_denied',
    'malformed_response',
    'unknown',
  ]
  return typeof code === 'string' && (known as readonly string[]).includes(code)
    ? (code as PlatformErrorCode)
    : 'unknown'
}
