/**
 * The plugin-owned settings API — the configuration page's read/write path.
 *
 * Why a plugin-owned route instead of the Harness settings RPC: that wire only
 * exposes namespaces on a hard-coded allowlist (`WEB_SETTINGS_NAMESPACES` plus
 * model providers and product namespaces). A third-party plugin cannot widen it
 * without patching DSH source. The namespace itself *is* registered host-side
 * (the row's `Config` schema), so this plugin serves loopback-only endpoints
 * that read and write it through the settings service, exactly like the shipped
 * `dsh-mem0` card does.
 *
 * Three families, one fence:
 *
 *   GET  /api/dsh-ai-debate/settings          -> redacted config view
 *   POST /api/dsh-ai-debate/settings          -> { set?: {field: value}, unset?: [field] }
 *   POST /api/dsh-ai-debate/secrets           -> { ref, value } | { ref, clear: true }
 *   GET  /api/dsh-ai-debate/status            -> live diagnostics
 *   POST /api/dsh-ai-debate/action            -> { action: 'test-llm' | 'check-login' | 'preview-persona' }
 *   GET  /api/dsh-ai-debate/records           -> publish ledger for the UI
 *
 * Every response is redacted by construction: no handler here ever returns a
 * cookie, an API key, or any substring of one beyond the four-character tail the
 * status view already exposes. That is a rule of this module, not a check that
 * could be forgotten — the redaction happens when the value is read, in
 * `viewOfSettings` and `describeSecrets`, and no other path sends one.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { VerificationAuthorization } from './verification.js'
import { resolveConfig, type ResolvedConfig } from './config.js'
import type { CredentialPhase } from './credential-mirror.js'
import {
  clearSecret,
  describeSecrets,
  maskedTail,
  storeSecret,
  type CredentialSeam,
  type SecretOverlay,
  type SecretRefName,
  type SecretStatus,
} from './secrets.js'

/**
 * The credential phase as the page receives it.
 *
 * Structurally typed rather than importing the mirror's class: this module must
 * stay testable with a hand-written double, and a `CredentialPhase` union is
 * cheap to restate. The values are checked against the mirror by
 * `test/credential-states.test.ts`.
 */
export interface CredentialStatusView {
  readonly phase: CredentialPhase
  readonly settled: boolean
  readonly unresolved: readonly SecretRefName[]
  readonly error?: string
  readonly canPublish: boolean
}

/** Structural stand-in for the Host webserver's WebRoute (no build-time dep). */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle. */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The route family path prefix. */
export const ROUTE_PREFIX = '/api/dsh-ai-debate'

/** Cap on JSON request bodies (every payload here is tiny). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/**
 * Fields the settings page may edit.
 *
 * An explicit allowlist rather than "anything in the schema": the schema is
 * shared with the Host settings form, and one of its fields (`storeDir`) points
 * at the filesystem. A wire that accepts arbitrary field names is a wire that
 * accepts a path traversal the moment a field is added.
 */
const EDITABLE_FIELDS = new Set([
  'enabled',
  'ownerUserId',
  'ownerHandle',
  'ownerUserName',
  'aiAccountName',
  'aiAccountUserId',
  'allowedOwnerIds',
  /**
   * 按平台绑定（v0.2.33）。
   *
   * ## 为什么它必须可写
   *
   * 这个字段从 v0.2.2 起就是「接第二个平台的唯一入口」：旧的全局字段一律
   * 解释为贴吧的，微博必须在 `platformAccounts` 里显式绑定，否则 `ownerFor()`
   * 返回 `undefined`，`runAnalysis` 直接拒绝「还没有绑定主人」。
   *
   * 而它**此前不在可编辑清单里**。后果在真桌面上是可观测的：设置页能看到
   * 「主人账号名称」那一栏并填上名字，但那个名字只对贴吧生效；微博那一侧
   * 永远是未绑定，于是「输入微博链接 → 读取讨论」在桌面上无论如何都走不通，
   * 页面只会显示「还没有绑定主人」。
   *
   * 也就是说：这个字段写不进去，就等于**桌面端根本没有微博可用的路径**。
   * 光有界面不够，得让界面能把它写下去。
   */
  'platformAccounts',
  'personaStyle',
  'intensity',
  'maxLength',
  'emojiLevel',
  'sarcasmLevel',
  'directness',
  'llmSource',
  'egressMode',
  'llmBaseUrl',
  'llmModel',
  // 协议必须可保存，否则用户在页面上选了 responses 却存不下去（v0.2.34 §3.1）。
  'llmProtocol',
  'llmTimeoutMs',
  'llmTemperature',
  'llmMaxOutputTokens',
  'contextPreset',
  'contextTokens',
  'interactionMode',
  'maxAutoPerSession',
  'cooldownSeconds',
  'maxPerThread',
  'maxFloorPages',
  'pageDelayMs',
  'requestTimeoutMs',
  'requestRetries',
  'sessionTtlDays',
  'announceToAgent',
  'logLevel',
])

/** Legacy secret fields, accepted only as a *clear* target — never as a write. */
const LEGACY_SECRET_FIELDS = new Set(['tiebaCookie', 'llmApiKey'])

/**
 * Reject a request that has not been authenticated as the browser session.
 *
 * Supplied by the host half from `ctx.connection.requestRejection`, which
 * applies the DSH Connection layer's own Host/Origin trust checks *and* its
 * signed-browser-cookie authentication. Returning `undefined` means "admit".
 *
 * Deliberately a callback rather than a direct service handle: this module
 * stays free of a build-time Harness dependency (the same reason `host.ts`
 * declares its own structural interfaces), and a test can drive the fence
 * without constructing a Connection.
 */
export type RequestAuthorizer = (request: IncomingMessage) => 'ok' | 401 | 403

/** The services and callbacks the route family needs from its host half. */
export interface SettingsRouteDeps {
  /**
   * Authenticate the caller.
   *
   * Absent means this deployment has no browser-session mechanism. The routes
   * then refuse every request — a settings API whose only credential is
   * "the socket came from 127.0.0.1" cannot tell the owner's browser from any
   * other local process, and this plugin owns a Tieba cookie and an API key.
   */
  authorize?: RequestAuthorizer
  /** Read the live resolved config. */
  config(): ResolvedConfig
  /** The credential seam, or undefined when unavailable. */
  credentials(): CredentialSeam | undefined
  /** The overlay currently in force. */
  overlay(): SecretOverlay
  /**
   * What the plugin currently believes about the credential store.
   *
   * The phase is what lets the page say "尚未确认" instead of picking one of two
   * lies: "未配置" (a fact the plugin does not have) or "已配置 · 长度 0" (the
   * v0.1.10 defect). Optional so a test double written against the older shape
   * keeps compiling; absent means the page falls back to the overlay alone.
   */
  credentialState?(): CredentialStatusView
  /**
   * Install a value the store already confirmed.
   *
   * Called after a successful write so the mirror holds the new value before the
   * next read can race it. Optional for the same reason as `credentialState`.
   */
  acceptSecret?(ref: SecretRefName, value: string): void
  /** Install a deletion the store already confirmed. */
  acceptSecretClear?(ref: SecretRefName): void
  /** Re-read the credential store and install the result. */
  refreshSecrets(): Promise<void>
  /** The settings service, or undefined. */
  settings(): SettingsService | undefined
  /** The settings namespace (the row id). */
  namespace(): string
  /** Run the model-connection probe. */
  testModel(): Promise<ModelProbe>
  /** 宿主模型服务探测（v0.2.36）。省略时报告「拿不到」。 */
  probeHostLlm?(): Promise<unknown>
  /** 出网守卫自检（v0.2.36）。省略时报告「没有守卫」。 */
  probeEgress?(): Promise<{ blocked: boolean; mode: string; host: string; reason: string }>
  /** Probe the bound account's login state. */
  checkLogin(): Promise<LoginProbe>
  /**
   * What platforms this build knows about, in the state they are actually in.
   *
   * Optional so every existing route test keeps compiling. When present the page
   * renders a platform section: the registered adapters with their capability
   * matrix, plus the future platforms that exist only as manifests. Those two
   * groups are shown differently on purpose — one is code, the other is a plan,
   * and a settings page that blurs them is the thing this version exists to
   * prevent.
   */
  platforms?(): readonly PlatformView[]
  /**
   * What the injection-protection layer is actually doing.
   *
   * Optional for the same reason `platforms` is: existing route tests keep
   * compiling. When present the page shows a security section, and the values come
   * from the running code rather than from the defaults — a page that reports the
   * default instead of the effective value is how a disabled protection looks
   * enabled.
   */
  security?(): SecurityView
  /** Preview all four personas against a fixed exchange. */
  previewPersonas(): Promise<readonly PersonaPreview[]>
  /**
   * Stop every task that is still in a non-terminal state.
   *
   * This is the honest half of the "pause everything" affordance: the plugin
   * has no background scheduler, so there is nothing to switch off, but there
   * **are** live sessions and publishes in flight, and those can be stopped for
   * real. Publish records that already reached the platform are left alone.
   */
  stopAllActive(): Promise<PauseOutcome>
  /** Read the publish ledger and session counters. */
  diagnostics(): Promise<Diagnostics>
  /**
   * Live per-platform diagnostic, for the platform section of the page (v0.2.13 §四).
   *
   * ## Two properties that matter more than the shape
   *
   * 1. **It is reached only through the guarded route.** The page cannot read an account's CLI
   *    state without an authenticated session, the same fence every other sensitive read uses.
   * 2. **A platform that cannot answer contributes an `error`, not silence.** Returning an
   *    empty list for "the probe threw" would render as "no platforms to check" — which a reader
   *    would take as all-clear. The failure has to be visible.
   *
   * Optional so route tests written before this existed keep compiling; when absent the page
   * shows "no live diagnostic available" rather than a passing state.
   */
  platformDiagnostics?(options?: { readonly refresh?: boolean }): Promise<readonly PlatformDiagnosticBlock[]>
  /**
   * The one-off publish verification view, for the owner-only panel (v0.2.21 §三/§四).
   *
   * Reads the live account, the declared capabilities and every record. Optional for the same
   * reason `platformDiagnostics` is: route tests written before this existed keep compiling, and
   * a build without the publishing stack shows "this build cannot verify" rather than a green
   * state it did not measure.
   */
  verification?(input: { readonly platform: string }): Promise<VerificationView>
  /**
   * Run exactly one verification attempt.
   *
   * Separate from `verification()` so the read-only view can be served without the write
   * dependency existing at all: a deployment that never wants to publish once can leave this
   * undefined, and the POST is then refused instead of quietly becoming a no-op.
   *
   * The input is the owner's form, verbatim. Nothing here fills a default — §三.2 requires the
   * account, the thread, the target and the text to come from the owner, and a default is
   * precisely the thing that would make them come from the code.
   */
  runVerification?(input: VerificationActionInput): Promise<VerificationRunView>
  /**
   * The publish workbench read model (v0.2.22 §一).
   *
   * Optional like the others: a build without the publishing stack shows "this build has no
   * workbench" rather than an empty success.
   */
  workbench?(input: { readonly sessionId?: string }): Promise<WorkbenchView>
  /**
   * Edit one candidate's text (v0.2.22 §三).
   *
   * A separate write from approve/publish because it invalidates both: the response is the new
   * version and hash, so the page can show that the old approval no longer applies instead of
   * discovering it on the next publish attempt.
   */
  editCandidate?(input: {
    readonly sessionId: string
    readonly candidateId: string
    readonly text: string
  }): Promise<{ readonly ok: boolean; readonly message?: string; readonly candidateVersion?: number; readonly textHash?: string }>
  /**
   * Collect and analyse one discussion (v0.2.22 §二).
   *
   * The same `runAnalysis` the agent tool uses, reached from the owner's form. It reads the
   * thread and produces the session + reconstruction; it never publishes, and it cannot choose
   * the target on the owner's behalf.
   */
  analyzeThread?(input: {
    readonly url: string
    readonly postId?: string
    readonly ownerInstruction?: string
  }): Promise<{ readonly ok: boolean; readonly message?: string; readonly sessionId?: string }>
  /**
   * Generate candidates for an existing session (v0.2.22 §三).
   *
   * Reuses the generator and the persona; each call bumps the candidate version, which is what
   * retires any earlier approval.
   */
  generateCandidates?(input: {
    readonly sessionId: string
    readonly style?: string
    readonly ownerInstruction?: string
    /** The comment to answer, chosen in the workbench (v0.2.24). */
    readonly targetPostId?: string
  }): Promise<{ readonly ok: boolean; readonly message?: string; readonly candidates?: number }>
  /**
   * Publish one approved candidate (v0.2.22 §四/§五).
   *
   * Deliberately goes through `runPublish` — the only path that can reach a platform — so the
   * workbench inherits the capability gate, the approval check, the ledger and the read-back
   * rather than reimplementing any of them.
   */
  publishApproved?(input: {
    readonly sessionId: string
    readonly candidateId: string
    readonly approvedText: string
  }): Promise<{
    readonly ok: boolean
    readonly status: string
    readonly message: string
    readonly postId?: string
  }>
  /**
   * Candidates that are waiting for a human approval, newest first.
   *
   * This is what makes the approval section possible: the page cannot approve something
   * it cannot see, and it must not be told "approve candidate X" by the agent — the list
   * comes from the store, so what the owner sees is what is actually waiting.
   *
   * Asynchronous since v0.2.8, because a *correct* answer requires re-reading the state
   * file: a candidate created by another process is invisible in this instance's cache,
   * and reporting the cache made "nothing is waiting" the default answer for a busy
   * host. The result carries the failure case explicitly, so an unreadable document
   * cannot render as an empty list.
   *
   * Optional so existing route tests keep compiling. When absent the page says it cannot
   * report the list rather than inventing an empty success.
   */
  pendingApprovals?(): Promise<PendingApprovalsView>
  /**
   * Create a human approval for one candidate.
   *
   * This is the *only* way an approval record comes into existence, and it is only
   * reachable from an authenticated browser session (see {@link makeSettingsRoutes}'s
   * `guard`). The agent cannot call it: no tool wraps it, and the publish tool
   * deliberately has no equivalent.
   *
   * Optional so route tests written against the older shape keep compiling. When it is
   * absent the endpoint answers 501 rather than pretending to approve — a page that
   * silently "approves" nothing would teach the owner to trust a broken button.
   */
  approve?(input: Record<string, unknown>): Promise<ApprovalOutcome>
  /**
   * 离线讨论的完整接口（v0.2.30 §一/§二）。
   *
   * ## 为什么整块作为一个依赖，而不是七个
   *
   * 这七步是**一条链**：预览的结果要原样交给确认，确认的会话要交给生成，
   * 生成之后才有评估、确认与复制。拆成七个独立依赖会让装配方可以选择性实现，
   * 而「只实现了生成、没实现确认」的组合是不成立的（复制前必须人工确认）。
   * 一个对象意味着它要么整块在位，要么整块缺席——缺席时页面明确说这个构建
   * 没有离线工作流，而不是让用户点到一个永远失败的按钮。
   */
  manualImport?: {
    /** 解析并返回预览，不落盘、不建会话。 */
    preview(input: {
      readonly kind: 'text' | 'json' | 'file'
      readonly content: string
      readonly title?: string
      readonly url?: string
      readonly fileName?: string
      /** 上一轮预览上做过的人工修正（v0.2.31 §四）。 */
      readonly corrections?: unknown
    }): Promise<{
      readonly ok: boolean
      readonly reason?: string
      readonly issues?: readonly { readonly severity: string; readonly code: string; readonly message: string }[]
      readonly discussion?: {
        readonly title: string
        readonly author: string
        readonly text: string
        readonly comments: readonly {
          readonly id: string
          readonly author: string
          readonly text: string
          readonly replyTo?: string
        }[]
        readonly participants: readonly string[]
      }
      /** 结构化预览（v0.2.31）：关系三档、楼层、依据、同名、统计。 */
      readonly structure?: unknown
      /** 修正做了什么，逐条可读。 */
      readonly audit?: readonly unknown[]
      /** 回传给下一次预览/确认的修正清单（原样带上即可）。 */
      readonly corrections?: unknown
    }>
    /** 确认导入：分析并建会话。 */
    confirm(input: {
      readonly kind: 'text' | 'json' | 'file'
      readonly content: string
      readonly title?: string
      readonly url?: string
      readonly fileName?: string
      readonly ownerName?: string
      readonly targetPostId?: string
      readonly persona?: string
      /** 与预览时同一份修正清单，保证「确认的数据 = 预览的数据」。 */
      readonly corrections?: unknown
    }): Promise<{
      readonly ok: boolean
      readonly sessionId?: string
      readonly reason?: string
      readonly next?: readonly string[]
      readonly participants?: readonly { readonly name: string; readonly postCount: number; readonly isOwner: boolean; readonly isOpponent: boolean }[]
      readonly securityNotes?: readonly string[]
    }>
    /**
     * 对已确认的会话应用一批修正（v0.2.31 §四）。
     *
     * 与 `preview` 的 `corrections` 不同：那条路径在**导入之前**改，
     * 这条在**已经建了会话之后**改，需要重新分析并把旧候选作废。
     * 两条都必须只能用于分析，永远不产生发表权限。
     */
    revise(input: {
      readonly sessionId: string
      readonly corrections: unknown
    }): Promise<{
      readonly ok: boolean
      readonly reason?: string
      readonly next?: readonly string[]
      readonly structure?: unknown
      readonly audit?: readonly unknown[]
      /** 因修正而作废的候选数。必须报出来：用户要知道自己刚才那段草稿没了。 */
      readonly discardedCandidates?: number
    }>
    /** 换主人或换目标，重跑分析。 */
    select(input: {
      readonly sessionId: string
      readonly ownerName?: string
      readonly targetPostId?: string
      readonly persona?: string
    }): Promise<{ readonly ok: boolean; readonly reason?: string; readonly next?: readonly string[] }>
    /** 取目标上下文（v0.2.31 §五）：这条发言前后是谁在说什么。 */
    context(input: {
      readonly sessionId: string
      readonly postId: string
    }): Promise<{ readonly ok: boolean; readonly reason?: string; readonly context?: unknown }>
    /** 生成候选。 */
    generate(input: {
      readonly sessionId: string
      readonly targetPostId?: string
      readonly persona?: string
      readonly ownerInstruction?: string
      /**
       * 手工指定的论证打法（v0.2.38）。
       *
       * 不传就是自动选择。传了但材料不支撑它时，接口返回 `ok: false` 并说明缺什么 ——
       * 不会悄悄回落到自动选择，那样主人会以为自己指定生效了。
       */
      readonly strategy?: string
    }): Promise<{
      readonly ok: boolean
      readonly candidateId?: string
      readonly text?: string
      readonly reason?: string
      readonly next?: readonly string[]
      readonly securityDecision?: string
      readonly securityReasons?: readonly string[]
      /** 模型主动要求补充信息（v0.2.38）。 */
      readonly needsInput?: boolean
      readonly needsInputReason?: string
      /** 程序选出的打法与依据（v0.2.38）。 */
      readonly argumentStrategy?: {
        readonly id: string
        readonly name: string
        readonly source: 'auto' | 'manual'
        readonly reason: string
        readonly confidence: 'high' | 'medium' | 'low'
        readonly evidence: readonly {
          readonly field: string
          readonly postIds: readonly string[]
          readonly why: string
        }[]
      }
    }>
    /** 编辑正文并重新评估。 */
    edit(input: {
      readonly sessionId: string
      readonly candidateId: string
      readonly text: string
    }): Promise<{ readonly ok: boolean; readonly reason?: string; readonly candidateVersion?: number }>
    /** 人工确认。 */
    approve(input: {
      readonly sessionId: string
      readonly candidateId: string
      readonly approvedText: string
    }): Promise<{ readonly ok: boolean; readonly reason?: string; readonly next?: readonly string[] }>
    /** 取可复制的正文与目标。 */
    copy(input: {
      readonly sessionId: string
      readonly candidateId: string
      readonly visibleText?: string
    }): Promise<{
      readonly ok: boolean
      readonly reason?: string
      readonly next?: readonly string[]
      readonly text?: string
      readonly target?: { readonly author?: string; readonly excerpt: string; readonly postId: string }
      readonly safe?: boolean
      readonly blockers?: readonly string[]
      readonly persona?: string
    }>
    /**
     * 四种人格比较（v0.2.37 §7）。
     *
     * 逐条返回结果：成功带候选 id 与正文，失败带原因。**不许整批成功才返回** ——
     * 四种人格里有一条失败（模型偶尔不守格式），另外三条仍然是用户想看的东西。
     */
    compare?(input: {
      readonly sessionId: string
      readonly targetPostId?: string
      readonly personas?: readonly string[]
      readonly ownerInstruction?: string
    }): Promise<{
      readonly ok: boolean
      readonly rows: readonly {
        readonly persona: string
        readonly personaName: string
        readonly ok: boolean
        readonly candidateId?: string
        readonly text?: string
        readonly securityDecision?: 'allow' | 'review' | 'block'
        readonly securityReasons?: readonly string[]
        readonly violations?: readonly string[]
        readonly elapsedMs?: number
        readonly reason?: string
      }[]
      readonly calls: number
      readonly skipped: readonly string[]
      readonly cancelled: boolean
      readonly message: string
    }>
    /** 取消正在进行的比较（v0.2.37 §8）。 */
    cancelCompare?(input: { readonly sessionId: string }): Promise<{ readonly ok: boolean; readonly reason?: string }>
  }
}

/** The status and body an approval attempt answers with. */
export interface ApprovalOutcome {
  readonly status: number
  readonly body: Record<string, unknown>
}

/**
 * The answer to "what is waiting for my approval".
 *
 * ## Why this is not just an array (v0.2.8)
 *
 * Three different facts were collapsing into "zero rows": a successful read that found
 * nothing, a read that failed, and a Host too old to answer. The page rendered all
 * three as "当前没有待批准候选" — so a corrupt state file, a permissions problem, or a
 * document held by another writer all looked like a calm empty list, and the owner
 * walked away believing the agent simply had not generated anything.
 *
 * The discriminant makes each one a distinct, renderable outcome. `ok: false` is not
 * an error the caller can ignore and retry away; it means "the pending set is
 * unknown", which is a different instruction to a human than "the set is empty".
 */
export type PendingApprovalsView =
  | { readonly ok: true; readonly rows: readonly PendingApprovalView[] }
  | {
      readonly ok: false
      /** Already a human-readable sentence: the store writes these for the page. */
      readonly reason: string
      /** `corrupt` / `read_failed` / `write_failed`, when the store named one. */
      readonly code?: string
    }

/**
 * One candidate waiting for approval, as the page renders it.
 *
 * Nothing here is a secret, and nothing here is a capability: `sessionId` and
 * `candidateId` are the two names the approve route needs, and both are already visible
 * in the session the owner is looking at. The approval itself is created by the *route*
 * from what is stored, so a page that lied about the text could not approve a different
 * body — the Host would bind the approval to the stored one.
 */
export interface PendingApprovalView {
  readonly sessionId: string
  readonly candidateId: string
  readonly platform: string
  readonly threadTitle: string
  readonly threadUrl: string
  readonly targetPostId: string
  /** The exact body that would be posted, so the owner reads what they approve. */
  readonly text: string
  readonly candidateVersion: number
  /** `allow` or `review`. A `block` candidate is never listed: it cannot be approved. */
  readonly verdict: string
  readonly createdAt: string
  /** Why this needs a human, already formatted for display. */
  readonly reason: string
  /**
   * The fingerprint of the security assessment shown with this row.
   *
   * Sent back on approval so the Host can prove it is minting a record for the
   * assessment the owner actually saw (v0.2.7). Without it, the approval route had
   * no way to tell "the page is current" from "the page is three regenerations old"
   * and silently bound the record to whatever was stored *now*.
   */
  readonly assessmentFingerprint?: string
  /**
   * The whole expected snapshot, echoed back verbatim on approval.
   *
   * One field rather than eight so a new bound field (a publishing account, a
   * content hash) becomes a change here and in `bindingOf` only — not in the client,
   * the route and every test. It is data the page was given, never data it computed.
   */
  readonly expected?: PendingApprovalExpectation
}

/**
 * What the page promises it is showing when it asks for an approval.
 *
 * Every field is a value the Host sent in the `PendingApprovalView`, so a mismatch
 * means the page and the store disagree — the owner is looking at something that no
 * longer exists. The route answers `409 stale_candidate` and asks for a re-read
 * rather than binding an approval to content nobody reviewed.
 */
export interface PendingApprovalExpectation {
  readonly sessionId: string
  readonly candidateId: string
  readonly candidateVersion: number
  readonly platform: string
  readonly targetPostId: string
  /** The account that would post it; a switch invalidates the expectation. */
  readonly publishingAccount: string
  /** Hash of the body the page displayed. */
  readonly textHash: string
  readonly assessmentFingerprint: string
}

/**
 * One platform, as the settings page shows it.
 *
 * `implemented` is the field that keeps the page honest: a registered platform
 * with a real adapter is a different object from a manifest describing a plan,
 * and the two must never render identically.
 */
/**
 * How far a platform's read path has actually been proven.
 *
 * ## Why this is five values and not a boolean (v0.2.28)
 *
 * The page had one bit — `implemented` — and it was derived as "some capability row
 * is `supported` **or** `unverified`". For Weibo every read row is `unverified` (the
 * code exists, no live call ever succeeded here), so the platform rendered as green
 * 「已接入」 next to Tieba, which really has been run. The owner could not tell
 * "works" from "written but untested", and the one state the read path is actually
 * in was the one the page could not say.
 *
 * The five states are the five different things the owner might have to do:
 *
 * - `verified` — proven against the real platform; nothing to do;
 * - `untested` — implemented and structurally sound, never called for real;
 * - `needs_login` — the CLI is installed but no account is logged in;
 * - `needs_permission` — logged in, but the read scope is not granted;
 * - `unavailable` — nothing will make it work; the platform does not offer it.
 *
 * They are ordered by "how much work remains", so the page can sort on them.
 */
export type PlatformReadiness =
  | 'verified'
  | 'untested'
  | 'needs_login'
  | 'needs_permission'
  | 'unavailable'

export interface PlatformView {
  readonly id: string
  readonly displayName: string
  readonly shape: string
  /** True when an adapter exists and is registered right now. */
  readonly implemented: boolean
  /** True when this is the platform the plugin currently talks to. */
  readonly active: boolean
  /**
   * How far the read path has been proven (v0.2.28).
   *
   * Derived from the capability matrix by the host, never restated by the page: a
   * badge computed in two places is how the two ends up disagreeing.
   *
   * Optional so a caller written before this field — and every older test that builds a
   * `PlatformView` by hand — keeps compiling. The page renders the badge only when it is
   * present, so an absent value degrades to the previous one-badge display instead of
   * inventing a readiness state the host never claimed.
   */
  readonly readiness?: PlatformReadiness
  /** One line explaining `readiness`, in the platform's own words. */
  readonly readinessReason?: string
  /** Research stage, for the not-yet-implemented ones. */
  readonly research?: string
  /** Capability rows, already flattened for the page. */
  readonly capabilities: readonly {
    readonly name: string
    readonly state: string
    readonly mark: string
    readonly reason: string
    readonly limits?: readonly string[]
    readonly requiredPermissions?: readonly string[]
    readonly lastVerifiedAt?: string
  }[]
  /** What would have to happen before this becomes implemented. */
  readonly prerequisites?: readonly string[]
  readonly constraints?: readonly string[]
  readonly authModel?: string
  readonly urlShapes?: readonly string[]
}

/**
 * What the injection-protection layer reports to the settings page.
 *
 * Every field is the *effective* state, read from the running code. A page that
 * echoed the configured default instead would show protection as on while it was
 * off, which is the worst possible lie for a security panel: the owner would stop
 * looking.
 *
 * No field can carry attacker text. `recent` entries are the redacted one-line
 * summaries produced by `security-events.ts`, and they never include a credential
 * or a full post.
 */
export interface SecurityView {
  /** The master switch, as effective right now. */
  readonly protectionEnabled: boolean
  /** How eagerly text-level evidence forces review. */
  readonly strictness: string
  /**
   * True when the deterministic rules are enforced.
   *
   * Always true. It is in the payload so the page can *say* it, and so a future
   * change that made it configurable would break this field rather than quietly
   * shipping an off switch.
   */
  readonly hardRulesEnforced: true
  /** Input scanning is available and running. */
  readonly inputScanning: boolean
  /** The output gate runs before every publish. */
  readonly outputGate: boolean
  /** Stance protection is active, i.e. replies are checked against the owner. */
  readonly stanceGuard: boolean
  /** Whether the semantic reviewer is configured at all. */
  readonly semanticReview: boolean
  /** Counters over the retained event window. */
  readonly counters: {
    readonly last24h: number
    readonly blocked: number
    readonly reviewerUnavailable: number
  }
  /** Redacted recent events, newest first, already formatted for display. */
  readonly recent: readonly {
    readonly at: string
    readonly summary: string
    readonly severity: string
    readonly decision?: string
  }[]
}

/** What a real "stop everything now" call actually managed to do. */export interface PauseOutcome {
  /** Sessions moved to CANCELLED by this call. */
  readonly stopped: readonly string[]
  /** Sessions that refused to stop, with the reason the state machine gave. */
  readonly refused: readonly { readonly sessionId: string; readonly reason: string }[]
  /** Publishes whose in-flight request was aborted before it was sent. */
  readonly abortedInFlight: number
  /**
   * Replies that already reached the platform. Those are not withdrawn — no
   * API can recall them, and claiming otherwise would be a lie the user acts on.
   */
  readonly alreadyPublished: number
}

/** The settings service face used here (structural; see `host.ts` for the why). */
/**
 * The fields the owner fills in for a one-off publish verification (v0.2.21 §三).
 *
 * Restated here instead of importing `VerificationAuthorization`: this module must stay loadable
 * without the publishing stack, and a page-shaped interface is cheaper to keep honest than a
 * type that quietly grows a default. Every field is required except the two parent ids, which
 * only a nested reply needs.
 */
export interface VerificationActionInput {
  readonly platform: string
  readonly capability: 'comment.publish' | 'comment.reply'
  readonly authorizedAccountId: string
  readonly authorizedThreadId: string
  readonly authorizedFloorId?: string
  readonly replyToPostId?: string
  readonly authorizedBy: string
  readonly approvedText: string
}

/** The POST result for one verification attempt. */
export interface VerificationRunView {
  readonly ok: boolean
  readonly message: string
  /** Which refusal stopped it, when it did not publish. */
  readonly refusal?: string
  readonly publishedPostId?: string
  readonly readBack?: {
    readonly postFound: boolean
    readonly authorMatched: boolean
    readonly textMatched: boolean
    readonly parentMatched: boolean
    readonly notes: readonly string[]
  }
  /** True only when all four read-back facts held and the capability may be treated as proven. */
  readonly upgraded: boolean
}

/**
 * Turn the owner's form into the authorization the runner takes.
 *
 * Two rules, both from §三:
 *
 * - **The capability decides the family.** `comment.reply` requires a floor and a target post;
 *   `comment.publish` must not inherit them, because a leftover id from a previous attempt would
 *   silently move the next publish somewhere the owner did not pick.
 * - **Nothing is defaulted.** A blank field stays blank, so `checkVerification` refuses it and the
 *   owner sees which field is missing instead of a publish to an empty account id.
 */
export function authorizationFromInput(input: VerificationActionInput): VerificationAuthorization {
  const base = {
    platform: input.platform,
    capability: input.capability,
    authorizedAccountId: input.authorizedAccountId,
    authorizedThreadId: input.authorizedThreadId,
    authorizedBy: input.authorizedBy,
    approvedText: input.approvedText,
  }
  if (input.capability !== 'comment.reply') return base
  return {
    ...base,
    ...(input.authorizedFloorId !== undefined ? { authorizedFloorId: input.authorizedFloorId } : {}),
    ...(input.replyToPostId !== undefined ? { replyToPostId: input.replyToPostId } : {}),
  }
}

/**
 * The publish workbench's read model (v0.2.22 §一).
 *
 * Deliberately the same shape `deriveWorkbenchState()` returns plus the candidate list the owner
 * needs to compare — the page renders what the server derived, so the "which step am I on"
 * answer cannot differ between a refresh and the live process.
 */
export interface WorkbenchView {
  readonly ok: boolean
  /** Present once a session exists. */
  readonly sessionId?: string
  readonly platform?: string
  readonly threadUrl?: string
  readonly threadTitle?: string
  /** The derived steps and blockers, straight from `deriveWorkbenchState`. */
  readonly workbench?: {
    readonly step: string
    readonly steps: readonly { readonly id: string; readonly title: string; readonly status: string }[]
    readonly blockers: readonly string[]
    readonly missingEvidence: readonly { readonly what: string; readonly detail: string }[]
    readonly outcome: string
    readonly counts: { readonly floors: number; readonly nested: number; readonly candidates: number }
    readonly target?: { readonly threadId: string; readonly postId: string; readonly kind: string; readonly authorName?: string }
    readonly capability?: { readonly declared: string; readonly effective: string; readonly reason: string }
  }
  /** Candidates, newest last, for the compare-and-edit pane. */
  readonly candidates?: readonly {
    readonly replyId: string
    readonly text: string
    readonly strategy: string
    readonly candidateVersion: number
    readonly textHash: string
    readonly approved: boolean
    readonly targetPostId: string
    readonly createdAt: string
    readonly violations: readonly string[]
    /** 生成这条候选时用的人格 id（v0.2.37 §7）。旧候选没有这个字段。 */
    readonly persona?: string
    /** 这次生成实际耗时（ms）。 */
    readonly elapsedMs?: number
    readonly inputTokens?: number
    readonly outputTokens?: number
    /**
     * The security assessment fingerprint, when one was recorded.
     *
     * Present so the workbench can submit an approval whose `expected` snapshot matches what it
     * displayed. The approve route refuses a request without a complete snapshot — a page that
     * "approves whatever is stored now" is exactly the v0.2.7 hole — so this is not an optional
     * convenience, it is what makes approving from the workbench possible at all.
     */
    readonly assessmentFingerprint?: string
  }[]
  /**
   * The full expectation the approve route requires, built from the facts above.
   *
   * `null` when it cannot be built (no bound publishing account, no assessment, no snapshot) —
   * and then the workbench must *not* offer an approve button, because the record it would create
   * could never authorise the publish it claims to.
   */
  readonly approveExpectation?: Record<string, unknown> | null
  /** Why the expectation is unavailable, when it is. */
  readonly approveBlocked?: string
  /** Why the page cannot render a workbench at all, when it cannot. */
  readonly blockers: readonly string[]
  /**
   * 这份讨论的来源（v0.2.30 §四）。
   *
   * ## 为什么来源必须由服务端给
   *
   * 页面不能自己判断「这是官方读取还是我粘进来的」：它手上只有一个平台字符串，
   * 而那个字符串在两种情况下的可靠程度天差地别。让页面去猜，猜错的方向永远是
   * 「看起来更像官方」——把剪贴板内容显示成「微博 · 已读取」。
   *
   * 服务端按 `session.imported` 是否存在判断，那是决定性的事实。字段本身携带
   * 标签、可说清的证据强度、以及一句必须显示的风险提示。
   */
  readonly source?: {
    readonly kind: 'official_read' | 'manual_import'
    readonly label: string
    readonly provenance: string
    readonly canProveCompleteness: boolean
    readonly canProveAuthorship: boolean
    readonly allowsWrite: boolean
    readonly caution: string
  }
  /**
   * 人工导入的十一步进度（v0.2.30 §二）。
   *
   * 只在 `source.kind === 'manual_import'` 时出现。步骤由服务端从存下来的事实推导
   * （`stepOf`），页面照画即可——存一个 `step` 字段会让刷新后显示一个与候选、
   * 批准、编辑记录三者都可能不一致的进度。
   */
  readonly manualFlow?: {
    readonly step: string
    readonly stepTitle: string
    readonly steps: readonly { readonly id: string; readonly title: string; readonly done: boolean; readonly current: boolean }[]
    /** 四种人格，页面渲染成选择器。 */
    readonly personas: readonly { readonly id: string; readonly name: string; readonly summary: string; readonly approach: string }[]
    /**
     * 可选论证打法（v0.2.38）。
     *
     * 与人格**并列而不是嵌在人格里**：这是两层，页面要能分别选。嵌进去就又会变成
     * 「选人格顺带决定打法」——那正是这一版要拆开的东西。
     */
    readonly strategies?: readonly { readonly id: string; readonly name: string; readonly summary: string }[]
    /** 这份讨论里出现过的人，按分析结果。 */
    readonly participants: readonly { readonly name: string; readonly postCount: number; readonly isOwner: boolean; readonly isOpponent: boolean }[]
    /** 导入内容的来源形式与时间。 */
    readonly importedAt?: string
    readonly importSource?: string
    /** 复制前必须看得见的目标。 */
    readonly copyTarget?: { readonly author?: string; readonly excerpt: string; readonly postId: string }
    /** 这段正文能不能安全复制；不能时 `copyBlockers` 说明为什么。 */
    readonly copyAllowed?: boolean
    readonly copyBlockers?: readonly string[]
  }
}

export interface SettingsService {
  writable: boolean
  update(namespace: string, patch: Record<string, unknown>): Promise<unknown>
  mutate(namespace: string, ops: readonly { op: 'unset'; path: readonly string[] }[]): Promise<unknown>
}

/**
 * What the verification panel reads, and what the run action returns (v0.2.21 §三/§四).
 *
 * ## Why the view carries `expectedCapability` instead of the page computing it
 *
 * §三.4 requires the record's family, target and account to follow from the input. The page could
 * derive that itself, but then there would be two derivations and the persisted record would
 * follow whichever ran last. It is computed once, on the server, and echoed back so the owner
 * sees exactly what will be checked before pressing the button — and the run action refuses a
 * request whose `expectedCapability` disagrees with its own derivation.
 */
export interface VerificationView {
  readonly ok: boolean
  /**
   * The account the live session **actually** reports right now (v0.2.21 P0-2).
   *
   * Absent when the session could not be read. It is deliberately not filled from configuration:
   * the panel used to show the configured id under this name, which told the owner "this is who
   * is logged in" when nobody had checked. A verification cannot proceed on an unknown account,
   * so the absence has to survive into the view.
   */
  readonly liveAccountId?: string
  /** The configured posting identity. Separate field, because it is a *different fact*. */
  readonly configuredAccountId?: string
  readonly liveAccountName?: string
  readonly adapterVersion?: string
  readonly capabilities: readonly {
    readonly capability: string
    readonly declared: string
    readonly effective: string
    readonly reason: string
  }[]
  readonly records: readonly {
    readonly key: string
    readonly platform: string
    readonly capability: string
    readonly authorizedAccountId: string
    readonly authorizedThreadId: string
    readonly startedAt: string
    readonly outcome: string
    readonly publishedPostId?: string
    readonly readBack?: {
      readonly postFound: boolean
      readonly authorMatched: boolean
      readonly textMatched: boolean
      readonly parentMatched: boolean
      readonly notes: readonly string[]
    }
    readonly failure?: string
  }[]
  /** One line per reason this deployment cannot verify right now. Empty means "can try". */
  readonly blockers: readonly string[]
  /**
   * The machine-readable half (§四).
   *
   * Same numbers the prose uses, in a shape a script can read: which capabilities are claimed,
   * which were actually proven, and which are still only declared. `null` never appears here —
   * an unknown state is `'unverified'`, because a script that sees `null` will treat it as "fine".
   */
  readonly report: {
    readonly platform: string
    readonly generatedAt: string
    readonly capabilities: readonly {
      readonly name: string
      readonly declared: string
      readonly effective: string
      readonly evidence: readonly { readonly at: string; readonly accountId: string; readonly adapterVersion: string }[]
    }[]
  }
}

/** Result of probing the configured model endpoint. */
export interface ModelProbe {
  readonly ok: boolean
  readonly baseUrl: string
  readonly model: string
  readonly latencyMs?: number
  readonly message: string
  readonly sample?: string
  /**
   * Which wire protocol the probe actually spoke (v0.2.27).
   *
   * A diagnostic that only says "failed" hides the most common real problem: the Base URL
   * points at something that is not a chat-completions endpoint. Naming the protocol and the
   * URL it was sent to makes that visible without reading the source.
   */
  readonly protocol?: string
  /** The classified failure, when it failed. Same vocabulary the runtime acts on. */
  readonly errorCode?: string
  /** HTTP status, when the failure had one. */
  readonly status?: number
  /** What the owner can do about it. Empty when nothing is actionable. */
  readonly suggestions?: readonly string[]
  /** Token usage reported by this probe, when the endpoint returns it. */
  readonly inputTokens?: number
  readonly outputTokens?: number
  /**
   * Whether the model also produced a parseable JSON candidate (v0.2.35 §2.1).
   *
   * ## Why "can I connect" was not enough
   *
   * A model that answers `OK` to `ping` can still be unusable: the whole workflow depends
   * on it returning a small JSON object with a fixed set of keys. An endpoint that speaks
   * the protocol but cannot follow the contract looks perfectly healthy on the old probe,
   * and the failure then appears later as "the model returned something unparseable" —
   * the hardest kind of failure to attribute.
   *
   * The second probe costs a few hundred tokens and answers that question before the owner
   * spends a single generation call. It is reported separately from `ok` so a protocol
   * that works but a model that cannot follow the contract shows both facts.
   */
  readonly contract?: {
    readonly ok: boolean
    readonly message: string
    /** Fields the contract required but the answer did not carry. */
    readonly missingFields?: readonly string[]
    /** Latency of this second call, in ms. */
    readonly latencyMs?: number
    readonly inputTokens?: number
    readonly outputTokens?: number
    /** A short excerpt of what the model actually returned, for the owner to read. */
    readonly sample?: string
  }
  /** Total wall-clock time of the whole probe, including both calls. */
  readonly totalMs?: number
  /**
   * 这次探测实际走的是哪条路（v0.2.36 §3.2）。
   *
   * 必须显示：同一个「连接正常」，走宿主和走自己配置的接口是两件不同的事 ——
   * 前者花的是宿主那边的额度，后者花的是填在插件里的那把 key。
   */
  readonly source?: 'host' | 'custom' | 'none'
  /** 宿主是否有可用的模型服务，即使这次没走它。 */
  readonly hostAvailable?: boolean
  /** 实际用到的模型标识（`provider/model`），由客户端回报。 */
  readonly provider?: string
}

/** Result of probing the Tieba login state. */
export interface LoginProbe {
  readonly ok: boolean
  readonly authenticated: boolean
  readonly message: string
  readonly userName?: string
  readonly userId?: string
  readonly cookieNames: readonly string[]
}

/** One persona's preview against a fixed, non-published exchange. */
export interface PersonaPreview {
  readonly style: string
  readonly name: string
  readonly summary: string
  readonly sample: string
  readonly promptShape: string
}

/** The live status block the diagnostics panel renders. */
export interface Diagnostics {
  readonly enabled: boolean
  readonly storePath: string
  /**
   * How `storePath` was chosen (v0.2.24).
   *
   * `configured` > `host` > `dsh_home` > `default`, in that order. Surfaced because
   * the v0.2.23 bug was invisible: the page showed a path, the path looked plausible,
   * and nothing said it had been resolved from the OS home rather than from the
   * instance the user was running.
   */
  readonly storeDirSource?: 'configured' | 'host' | 'dsh_home' | 'default'
  /** `DSH_HOME` as the plugin saw it, echoed for the same reason. */
  readonly dshHome?: string
  readonly sessions: { total: number; active: number; awaitingConfirmation: number; published: number }
  readonly publishLedger: {
    total: number
    confirmed: number
    pending: number
    failed: number
    overCapacity: boolean
  }
  readonly usage: { calls: number; inputTokens: number; outputTokens: number; failures: number }
  readonly recentErrors: readonly { at: string; message: string }[]
  readonly rateLimit: { limited: boolean; note: string }
  readonly dshVersion?: string
  readonly pluginVersion: string
  /**
   * Per-platform live state (v0.2.13 §四).
   *
   * ## Why this is an opaque block rather than typed fields
   *
   * This module is platform-neutral by design; importing a Weibo type here would mean editing
   * the route layer every time a platform is added. The adapter and the page agree on the
   * shape, and the route only carries it.
   *
   * A platform that has nothing to report contributes **no entry**, which the client renders
   * as "this platform has no live diagnostic" — never as all-clear. That distinction is the
   * whole point: an absent probe must not look like a passing one.
   */
  readonly platforms?: readonly PlatformDiagnosticBlock[]
}

/** One platform's diagnostic, shaped by the adapter that produced it. */
export interface PlatformDiagnosticBlock {
  readonly platform: string
  readonly displayName: string
  /** Present only when the adapter answered. Absent means "no probe ran". */
  readonly state?: unknown
  /** Why there is no state, when there is none. */
  readonly error?: string
}

/** Send one JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * The cheap structural fence: loopback peer plus browser same-origin markers.
 *
 * This is **not** authentication and is no longer the only check. It answers
 * "does this look like a browser request aimed at this same origin", which
 * still usefully rejects DNS rebinding and a cross-site form post before any
 * work happens. Identity comes from {@link SettingsRouteDeps.authorize}.
 *
 * Two rules here are load-bearing and easy to get wrong:
 *
 * - A missing `Origin` does **not** mean trusted. Non-browser clients omit it,
 *   and a non-browser client on loopback is exactly what this fence cannot
 *   distinguish from the owner's page. It is admitted here only so the
 *   authorizer can judge it; the authorizer is what actually decides.
 * - A loopback socket address does **not** mean trusted either, for the same
 *   reason: every local process has one.
 */
export function isTrustedRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (
    hostUrl.hostname !== '127.0.0.1' &&
    hostUrl.hostname !== 'localhost' &&
    hostUrl.hostname !== '[::1]' &&
    hostUrl.hostname !== '::1'
  ) {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Read a JSON request body; undefined when oversized or unparseable. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) {
      // Drain rather than abort: an aborted request leaves the keep-alive
      // connection in a state Node will not reuse.
      overflow = true
      continue
    }
    chunks.push(buffer)
  }
  if (overflow) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The redacted settings view.
 *
 * `secrets` carries per-reference status only: `configured`, where it came from,
 * whether it is writable, and a four-character tail. The value itself is never
 * read here — `describeSecrets` is given a reader that returns the *legacy
 * config* field, which is already in the profile file and therefore not a
 * disclosure, and the store value never leaves `describe`.
 */
export async function viewOfSettings(deps: SettingsRouteDeps): Promise<Record<string, unknown>> {
  const config = deps.config()
  const settings = deps.settings()
  const overlay = deps.overlay()
  const secrets = await describeSecrets(deps.credentials(), overlay, (ref) =>
    ref === 'DSH_AI_DEBATE_TIEBA_COOKIE' ? config.tiebaCookie : config.llmApiKey,
  )
  const credential = deps.credentialState?.()
  return {
    status: 'ready',
    writable: settings?.writable ?? false,
    // A copy of the resolved (defaults applied) config, minus every secret. The
    // legacy secret fields are answered as booleans so the page can tell the
    // user their old config value is still in effect without echoing it.
    values: publicConfig(config),
    secrets: secrets.map(publicSecret),
    // What the plugin believes about the store. This is the field that lets the
    // page distinguish "unconfigured" from "not confirmed yet" instead of
    // guessing — the two look identical in `secrets` alone.
    credentials: credential === undefined ? undefined : publicCredentialState(credential),
    // Platforms, when the shell can report them.
    //
    // Separated into `implemented` (a registered adapter) and the rest (a
    // manifest only) so the page cannot render a plan as if it were a feature.
    ...(deps.platforms === undefined ? {} : { platforms: deps.platforms() }),
    // The security state, so the settings page can show what is actually on
    // rather than what the defaults say.
    ...
    (deps.security === undefined ? {} : { security: deps.security() }),
    // Candidates waiting for a human approval. Separate from `security`: the security
    // panel reports what the guards are doing, this reports what the owner has to
    // decide. Mixing them was how "protection is on" and "a reply is waiting for you"
    // became the same paragraph.
    //
    // Two fields, not one (v0.2.8). `pendingApprovals` keeps its old array shape so a
    // page built against v0.2.7 keeps rendering, while `pendingApprovalsState` carries
    // the read outcome. A page that only understands the array sees an empty list on a
    // failed read — which is exactly why the new field exists and the client prefers it.
    ...(deps.pendingApprovals === undefined
      ? {}
      : await pendingApprovalFields(deps.pendingApprovals)),
    capabilities: {
      // The settings RPC is unavailable to third-party namespaces, so the write
      // path is this route; `writable` above mirrors the Host's own flag.
      settingsService: settings !== undefined,
      credentialService: deps.credentials() !== undefined,
    },
  }
}

/**
 * Split the pending-approval view into the two fields the page consumes.
 *
 * The split exists so the *failure* case has somewhere to live. Writing
 * `pendingApprovals: []` on a failed read is the bug: it is a well-formed, believable
 * answer to a question that could not be answered.
 */
async function pendingApprovalFields(
  read: () => Promise<PendingApprovalsView>,
): Promise<Record<string, unknown>> {
  let view: PendingApprovalsView
  try {
    view = await read()
  } catch (error) {
    // A thrower (an older or experimental implementation) is a failed read too, not a
    // crashed page: the rest of the settings view is still worth rendering.
    view = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!view.ok) {
    return {
      pendingApprovals: [],
      pendingApprovalsState: {
        status: 'failed',
        reason: view.reason,
        ...(view.code === undefined ? {} : { code: view.code }),
      },
    }
  }
  return {
    pendingApprovals: [...view.rows],
    pendingApprovalsState: { status: 'ready', count: view.rows.length },
  }
}

/** The credential phase, with nothing that could carry a value. */
function publicCredentialState(state: CredentialStatusView): Record<string, unknown> {
  return {
    phase: state.phase,
    settled: state.settled,
    unresolved: [...state.unresolved],
    canPublish: state.canPublish,
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

/** Every config field except the secrets, as plain JSON. */
function publicConfig(config: ResolvedConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    ownerUserId: config.ownerUserId,
    ownerHandle: config.ownerHandle,
    ownerUserName: config.ownerUserName,
    aiAccountName: config.aiAccountName,
    aiAccountUserId: config.aiAccountUserId,
    allowedOwnerIds: config.allowedOwnerIds,
    /**
     * 按平台绑定（v0.2.33）。
     *
     * 它必须出现在 `values` 里，否则页面拿不到当前值，编辑永远是「从空开始」——
     * 保存一次就会把主人已经配好的微博绑定覆盖成只有一个平台。配置的读与写
     * 必须成对，这是同一个字段的两端。
     */
    platformAccounts: config.platformAccounts,
    personaStyle: config.personaStyle,
    intensity: config.intensity,
    maxLength: config.maxLength,
    emojiLevel: config.emojiLevel,
    sarcasmLevel: config.sarcasmLevel,
    directness: config.directness,
    llmSource: config.llmSource,
    egressMode: config.egressMode,
    llmBaseUrl: config.llmBaseUrl,
    llmModel: config.llmModel,
    llmProtocol: config.llmProtocol,
    llmTimeoutMs: config.llmTimeoutMs,
    llmTemperature: config.llmTemperature,
    llmMaxOutputTokens: config.llmMaxOutputTokens,
    contextPreset: config.contextPreset,
    contextTokens: config.contextTokens,
    interactionMode: config.interactionMode,
    maxAutoPerSession: config.maxAutoPerSession,
    cooldownSeconds: config.cooldownSeconds,
    maxPerThread: config.maxPerThread,
    maxFloorPages: config.maxFloorPages,
    pageDelayMs: config.pageDelayMs,
    requestTimeoutMs: config.requestTimeoutMs,
    requestRetries: config.requestRetries,
    sessionTtlDays: config.sessionTtlDays,
    announceToAgent: config.announceToAgent,
    logLevel: config.logLevel,
  }
}

/** One secret row, with no value in it. */
function publicSecret(status: SecretStatus): Record<string, unknown> {
  return {
    ref: status.ref,
    configured: status.configured,
    ...(status.source === undefined ? {} : { source: status.source }),
    writable: status.writable,
    configSuperseded: status.configSuperseded,
    fromConfigFallback: status.fromConfigFallback,
    length: status.length,
    ...(status.tail === undefined ? {} : { tail: status.tail }),
  }
}

/** Coerce one edited field to the type its schema declares. */
function coerceField(field: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const numeric = new Set([
    'intensity',
    'maxLength',
    'emojiLevel',
    'sarcasmLevel',
    'directness',
    'llmTimeoutMs',
    'llmTemperature',
    'llmMaxOutputTokens',
    'contextTokens',
    'maxAutoPerSession',
    'cooldownSeconds',
    'maxPerThread',
    'maxFloorPages',
    'pageDelayMs',
    'requestTimeoutMs',
    'requestRetries',
    'sessionTtlDays',
  ])
  const boolean = new Set(['enabled', 'announceToAgent'])
  if (boolean.has(field)) {
    if (typeof value === 'boolean') return { ok: true, value }
    if (value === 'true') return { ok: true, value: true }
    if (value === 'false') return { ok: true, value: false }
    return { ok: false, error: `字段 ${field} 需要布尔值` }
  }
  if (numeric.has(field)) {
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(number)) return { ok: false, error: `字段 ${field} 需要数字` }
    return { ok: true, value: number }
  }
  if (typeof value !== 'string') return { ok: false, error: `字段 ${field} 需要字符串` }
  return { ok: true, value }
}

/**
 * Build the route family.
 *
 * Every handler resolves its dependencies at request time, never at
 * registration time: a settings edit changes the resolved config immediately,
 * and the credential overlay is refreshed by its own subscription, so a capture
 * of either at mount would serve stale answers.
 *
 * @param deps the host-half callbacks
 * @returns the routes to register
 */
export function makeSettingsRoutes(deps: SettingsRouteDeps): readonly WebRoute[] {
  /** Wrap a handler with the trust fence, the authorization check, and a uniform error shape. */
  const guard = (
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  ): (request: IncomingMessage, response: ServerResponse) => Promise<void> => {
    return async (request, response) => {
      // Stage 1 — structural: loopback peer, same-origin Host/Origin markers.
      // Cheap, and it stops DNS rebinding and cross-site posts before any work.
      if (!isTrustedRequest(request)) {
        writeJson(response, 403, { error: 'forbidden: origin' })
        return
      }
      // Stage 2 — identity: the DSH browser session. A loopback socket address
      // says "some local process"; only the signed session cookie says "the
      // owner's browser". Nothing below this line runs unauthenticated, so a
      // rejected request can never reach a settings or credential write.
      const authorize = deps.authorize
      if (authorize === undefined) {
        writeJson(response, 403, {
          error:
            '本部署没有可用的会话认证（ctx.connection 缺失），配置接口已关闭。' +
            '请在 DSH 桌面端或 Web 界面中打开设置页；工具本身不受影响。',
        })
        return
      }
      let verdict: 'ok' | 401 | 403
      try {
        verdict = authorize(request)
      } catch {
        // A throwing authorizer is a refusal, never an admission.
        verdict = 403
      }
      if (verdict !== 'ok') {
        writeJson(response, verdict, {
          error:
            verdict === 401
              ? 'unauthorized: 需要已登录的 DSH 会话。请从 DSH 界面打开设置页。'
              : 'forbidden: 会话校验未通过。',
        })
        return
      }
      try {
        await handler(request, response)
      } catch (error) {
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const settingsRoute = guard(async (request, response) => {
    const method = request.method ?? 'GET'
    if (method === 'GET') {
      // Refresh the credential mirror before answering. Without this a cold
      // start reports every credential as unconfigured while the store holds
      // it — the page then shows "未配置" for a cookie that is actually saved.
      await deps.refreshSecrets()
      writeJson(response, 200, await viewOfSettings(deps))
      return
    }
    if (method !== 'POST') {
      writeJson(response, 405, { error: `method not allowed: ${method}` })
      return
    }
    const settings = deps.settings()
    if (settings === undefined) {
      writeJson(response, 503, { error: '本部署没有 settings 服务，无法保存配置。' })
      return
    }
    if (settings.writable === false) {
      writeJson(response, 409, { error: '本部署的设置为只读（被更高优先级的配置层覆盖）。' })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const patch: Record<string, unknown> = {}
    const ops: { op: 'unset'; path: readonly string[] }[] = []

    const set = body.set
    if (set !== undefined) {
      if (typeof set !== 'object' || set === null || Array.isArray(set)) {
        writeJson(response, 400, { error: '"set" 必须是字段到值的对象' })
        return
      }
      for (const [field, raw] of Object.entries(set as Record<string, unknown>)) {
        if (LEGACY_SECRET_FIELDS.has(field)) {
          writeJson(response, 400, {
            error: `${field} 是旧版明文密钥字段，配置页不接受写入。请改用凭据栏保存，或点「清除」把它从配置里删掉。`,
          })
          return
        }
        if (!EDITABLE_FIELDS.has(field)) {
          writeJson(response, 400, { error: `未知配置字段 "${field}"` })
          return
        }
        const coerced = coerceField(field, raw)
        if (!coerced.ok) {
          writeJson(response, 400, { error: coerced.error })
          return
        }
        patch[field] = coerced.value
      }
    }

    const unset = body.unset
    if (unset !== undefined) {
      if (!Array.isArray(unset) || unset.some((item) => typeof item !== 'string')) {
        writeJson(response, 400, { error: '"unset" 必须是字段名数组' })
        return
      }
      for (const field of unset as string[]) {
        if (LEGACY_SECRET_FIELDS.has(field)) {
          ops.push({ op: 'unset', path: [field] })
          continue
        }
        if (!EDITABLE_FIELDS.has(field)) {
          writeJson(response, 400, { error: `未知配置字段 "${field}"` })
          return
        }
        ops.push({ op: 'unset', path: [field] })
      }
    }

    if (Object.keys(patch).length === 0 && ops.length === 0) {
      writeJson(response, 200, await viewOfSettings(deps))
      return
    }

    try {
      if (Object.keys(patch).length > 0) await settings.update(deps.namespace(), patch)
      if (ops.length > 0) await settings.mutate(deps.namespace(), ops)
    } catch (error) {
      writeJson(response, 409, {
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    writeJson(response, 200, await viewOfSettings(deps))
  })

  const secretRoute = guard(async (request, response) => {
    if ((request.method ?? 'GET') !== 'POST') {
      writeJson(response, 405, { error: `method not allowed: ${request.method ?? 'GET'}` })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const ref = body.ref
    if (ref !== 'DSH_AI_DEBATE_TIEBA_COOKIE' && ref !== 'DSH_AI_DEBATE_LLM_API_KEY') {
      writeJson(response, 400, { error: '未知凭据引用' })
      return
    }
    const target = ref as SecretRefName
    if (body.clear === true) {
      const result = await clearSecret(deps.credentials(), target)
      if (result.cleared) {
        // Install the deletion the store just confirmed, then discard every read
        // that was in flight while it happened. Doing this before the re-read is
        // what keeps a slow pre-clear read from resurrecting the old value.
        deps.acceptSecretClear?.(target)
        await deps.refreshSecrets()
      }
      writeJson(response, result.cleared ? 200 : 409, {
        cleared: result.cleared,
        ...(result.note === undefined ? {} : { error: result.note }),
        view: await viewOfSettings(deps),
      })
      return
    }
    const value = body.value
    if (typeof value !== 'string') {
      writeJson(response, 400, { error: '"value" 必须是字符串' })
      return
    }
    try {
      await storeSecret(deps.credentials(), target, value)
    } catch (error) {
      // The write did not commit, so the mirror keeps whatever it last confirmed.
      // Nothing is installed here on purpose: a failed save must not overwrite the
      // last known-good in-memory state with an unconfirmed value.
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    // Confirmed by the store: install it now so the very next operation — and any
    // read that was already running — uses the new value.
    deps.acceptSecret?.(target, value.trim())
    await deps.refreshSecrets()
    writeJson(response, 200, { saved: true, view: await viewOfSettings(deps) })
  })

  const statusRoute = guard(async (_request, response) => {
    await deps.refreshSecrets()
    const base = await deps.diagnostics()
    // The platform blocks are attached here rather than inside `diagnostics()` so the core
    // report stays independent of any platform being installed.
    //
    // A throwing probe becomes an explicit `error` entry: swallowing it would render as "no
    // platforms", which reads as "all clear".
    let platforms: readonly PlatformDiagnosticBlock[] | undefined
    if (deps.platformDiagnostics !== undefined) {
      try {
        platforms = await deps.platformDiagnostics()
      } catch (error) {
        platforms = [
          {
            platform: 'unknown',
            displayName: '平台诊断',
            error: `平台诊断读取失败：${(error as Error).message}`,
          },
        ]
      }
    }
    writeJson(response, 200, platforms === undefined ? base : { ...base, platforms })
  })

  /**
   * The verification panel's read side (v0.2.21 §三/§四).
   *
   * GET with a `platform` query, behind the same `guard`: the live account name and the record
   * history are both facts about the owner's own account, and an unauthenticated reader must not
   * be able to enumerate them. A build without the publishing stack answers with an explicit
   * "cannot verify" rather than an empty success.
   */
  const verificationRoute = guard(async (request, response) => {
    if ((request.method ?? 'GET') !== 'GET') {
      writeJson(response, 405, { error: `method not allowed: ${request.method ?? 'GET'}` })
      return
    }
    if (deps.verification === undefined) {
      writeJson(response, 200, {
        ok: false,
        capabilities: [],
        records: [],
        blockers: ['当前构建没有接上真实发表验收（verification 未提供）'],
      })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const platform = url.searchParams.get('platform') ?? ''
    try {
      writeJson(response, 200, await deps.verification({ platform }))
    } catch (error) {
      // A throwing read is reported, not swallowed: an empty panel would read as "nothing to
      // verify", which is the opposite of what a failure means here.
      writeJson(response, 200, {
        ok: false,
        capabilities: [],
        records: [],
        blockers: [`读取验收状态失败：${(error as Error).message}`],
      })
    }
  })

  /**
   * The publish workbench's read side (v0.2.22 §一).
   *
   * Behind the same `guard` as every other read: the thread title, the candidate texts and the
   * blockers are all facts about the owner's own session. No write happens here, and in
   * particular **nothing in this route can re-send a publish** — refreshing the page must be
   * safe by construction, not by remembering not to do it.
   */
  const workbenchRoute = guard(async (request, response) => {
    if ((request.method ?? 'GET') !== 'GET') {
      writeJson(response, 405, { error: `method not allowed: ${request.method ?? 'GET'}` })
      return
    }
    if (deps.workbench === undefined) {
      writeJson(response, 200, {
        ok: false,
        blockers: ['当前构建没有接上发表工作台（workbench 未提供）'],
      } satisfies WorkbenchView)
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    try {
      writeJson(response, 200, await deps.workbench(sessionId === undefined ? {} : { sessionId }))
    } catch (error) {
      writeJson(response, 200, {
        ok: false,
        blockers: [`读取工作台状态失败：${(error as Error).message}`],
      } satisfies WorkbenchView)
    }
  })

  const actionRoute = guard(async (request, response) => {
    if ((request.method ?? 'GET') !== 'POST') {
      writeJson(response, 405, { error: `method not allowed: ${request.method ?? 'GET'}` })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const action = body.action
    if (action === 'test-llm') {
      writeJson(response, 200, await deps.testModel())
      return
    }
    if (action === 'check-login') {
      writeJson(response, 200, await deps.checkLogin())
      return
    }
    /**
     * 宿主模型能力探测（v0.2.36 §3.1）。
     *
     * 只读 `listProviders` / `listModels`，不发补全 —— 刷新这一栏不花额度。
     * 它存在的意义是让用户知道「还有一条路」，而不是让他在两者之间猜。
     */
    if (action === 'probe-host-llm') {
      if (deps.probeHostLlm === undefined) {
        writeJson(response, 200, {
          available: false,
          servicePresent: false,
          providers: [],
          models: [],
          reason: '当前构建拿不到宿主模型服务',
        })
        return
      }
      writeJson(response, 200, await deps.probeHostLlm())
      return
    }
    /**
     * 出网边界自检（v0.2.36 §4.3）。
     *
     * 故意访问一个必然被拒的地址，证明守卫是活的。返回 `blocked:false` 就是
     * 「这次没被拦住」——页面必须照实显示，不能把它读成通过。
     */
    if (action === 'probe-egress') {
      if (deps.probeEgress === undefined) {
        writeJson(response, 200, { blocked: false, mode: 'open', host: '', reason: '当前构建没有出网守卫' })
        return
      }
      writeJson(response, 200, await deps.probeEgress())
      return
    }
    // The diagnostic panel's refresh button (v0.2.13 §四).
    //
    // This is the *controlled* re-probe: one probe, ignoring any cached verdict, and nothing
    // else. It is a POST because it changes the cached state, and it runs behind the same
    // `guard` as every other action — an unauthenticated caller cannot use it to learn an
    // account's CLI state.
    if (action === 'refresh-platforms') {
      if (deps.platformDiagnostics === undefined) {
        writeJson(response, 200, { platforms: [], note: '当前构建没有平台诊断能力' })
        return
      }
      try {
        writeJson(response, 200, { platforms: await deps.platformDiagnostics({ refresh: true }) })
      } catch (error) {
        writeJson(response, 200, { platforms: [], error: `重新探测失败：${(error as Error).message}` })
      }
      return
    }
    /**
     * 离线工作流的七个动作（v0.2.30 §一/§二）。
     *
     * ## 一条前缀、七个 action，而不是七条路由
     *
     * 这七步共享同一个副作用边界：都不发表。分成七条路由会让注册表长出七行，
     * 而它们共用同一个前置检查（这个构建有没有离线工作流）。一个前缀分支
     * 让「没有实现」这件事只有一个回答的地方。
     *
     * ## 每一步都从表单原样取字段
     *
     * 这里不填任何默认值：`content` 是用户粘的，`ownerName` 是用户选的，
     * 「默认用原帖作者」那条规则在 `analyzeImport` 里，与命令行调用共用。
     */
    if (
      action === 'manual-preview' ||
      action === 'manual-confirm' ||
      action === 'manual-select' ||
      action === 'manual-revise' ||
      action === 'manual-context' ||
      action === 'manual-generate' ||
      action === 'manual-edit' ||
      action === 'manual-approve' ||
      action === 'manual-copy' ||
      action === 'manual-compare' ||
      action === 'manual-cancel-compare'
    ) {
      const manual = deps.manualImport
      if (manual === undefined) {
        writeJson(response, 200, {
          ok: false,
          reason:
            '这个构建没有接上离线工作流（manualImport 未提供）。' +
            '真实平台的读取与工作台不受影响。',
        })
        return
      }
      const kind =
        body.kind === 'json' || body.kind === 'file' || body.kind === 'text' ? body.kind : 'text'
      const str = (value: unknown): string | undefined =>
        typeof value === 'string' && value !== '' ? value : undefined
      try {
        if (action === 'manual-preview') {
          writeJson(
            response,
            200,
            await manual.preview({
              kind,
              content: typeof body.content === 'string' ? body.content : '',
              ...(str(body.title) === undefined ? {} : { title: str(body.title)! }),
              ...(str(body.url) === undefined ? {} : { url: str(body.url)! }),
              ...(str(body.fileName) === undefined ? {} : { fileName: str(body.fileName)! }),
              ...(body.corrections === undefined ? {} : { corrections: body.corrections }),
            }),
          )
          return
        }
        if (action === 'manual-confirm') {
          writeJson(
            response,
            200,
            await manual.confirm({
              kind,
              content: typeof body.content === 'string' ? body.content : '',
              ...(str(body.title) === undefined ? {} : { title: str(body.title)! }),
              ...(str(body.url) === undefined ? {} : { url: str(body.url)! }),
              ...(str(body.fileName) === undefined ? {} : { fileName: str(body.fileName)! }),
              ...(str(body.ownerName) === undefined ? {} : { ownerName: str(body.ownerName)! }),
              ...(str(body.targetPostId) === undefined
                ? {}
                : { targetPostId: str(body.targetPostId)! }),
              ...(str(body.persona) === undefined ? {} : { persona: str(body.persona)! }),
              ...(body.corrections === undefined ? {} : { corrections: body.corrections }),
            }),
          )
          return
        }
        if (action === 'manual-revise') {
          writeJson(
            response,
            200,
            await manual.revise({
              sessionId: str(body.sessionId) ?? '',
              corrections: body.corrections,
            }),
          )
          return
        }
        if (action === 'manual-context') {
          writeJson(
            response,
            200,
            await manual.context({
              sessionId: str(body.sessionId) ?? '',
              postId: str(body.postId) ?? '',
            }),
          )
          return
        }
        if (action === 'manual-select') {
          writeJson(
            response,
            200,
            await manual.select({
              sessionId: str(body.sessionId) ?? '',
              ...(str(body.ownerName) === undefined ? {} : { ownerName: str(body.ownerName)! }),
              ...(str(body.targetPostId) === undefined
                ? {}
                : { targetPostId: str(body.targetPostId)! }),
              ...(str(body.persona) === undefined ? {} : { persona: str(body.persona)! }),
            }),
          )
          return
        }
        if (action === 'manual-generate') {
          writeJson(
            response,
            200,
            await manual.generate({
              sessionId: str(body.sessionId) ?? '',
              ...(str(body.targetPostId) === undefined
                ? {}
                : { targetPostId: str(body.targetPostId)! }),
              ...(str(body.persona) === undefined ? {} : { persona: str(body.persona)! }),
              ...(str(body.ownerInstruction) === undefined
                ? {}
                : { ownerInstruction: str(body.ownerInstruction)! }),
              // 空字符串等于「自动」——页面上的下拉默认项就是不传，这里不再造一个
              // 特殊值，避免出现「strategy=""」这种既不是自动也不是合法 id 的第三种状态。
              ...(str(body.strategy) === undefined || str(body.strategy) === ''
                ? {}
                : { strategy: str(body.strategy)! }),
            }),
          )
          return
        }
        /**
         * 四种人格比较（v0.2.37 §7）。
         *
         * 页面必须由用户明确点「比较四种人格」才会到这里 —— 那是四次真实计费调用。
         * 服务端不再加一道「你确定吗」：确认发生在界面上，重复确认只会让人麻木。
         */
        if (action === 'manual-compare') {
          if (manual.compare === undefined) {
            writeJson(response, 200, { ok: false, message: '当前构建不支持批量比较。' })
            return
          }
          writeJson(
            response,
            200,
            await manual.compare({
              sessionId: str(body.sessionId) ?? '',
              ...(str(body.targetPostId) === undefined ? {} : { targetPostId: str(body.targetPostId)! }),
              ...(Array.isArray(body.personas)
                ? { personas: (body.personas as unknown[]).filter((item): item is string => typeof item === 'string') }
                : {}),
              ...(str(body.ownerInstruction) === undefined
                ? {}
                : { ownerInstruction: str(body.ownerInstruction)! }),
            }),
          )
          return
        }
        if (action === 'manual-cancel-compare') {
          if (manual.cancelCompare === undefined) {
            writeJson(response, 200, { ok: false, reason: '当前构建不支持取消比较。' })
            return
          }
          writeJson(response, 200, await manual.cancelCompare({ sessionId: str(body.sessionId) ?? '' }))
          return
        }
        if (action === 'manual-edit') {
          writeJson(
            response,
            200,
            await manual.edit({
              sessionId: str(body.sessionId) ?? '',
              candidateId: str(body.candidateId) ?? '',
              text: typeof body.text === 'string' ? body.text : '',
            }),
          )
          return
        }
        if (action === 'manual-approve') {
          writeJson(
            response,
            200,
            await manual.approve({
              sessionId: str(body.sessionId) ?? '',
              candidateId: str(body.candidateId) ?? '',
              approvedText: typeof body.approvedText === 'string' ? body.approvedText : '',
            }),
          )
          return
        }
        writeJson(
          response,
          200,
          await manual.copy({
            sessionId: str(body.sessionId) ?? '',
            candidateId: str(body.candidateId) ?? '',
            ...(typeof body.visibleText === 'string' ? { visibleText: body.visibleText } : {}),
          }),
        )
        return
      } catch (error) {
        // 抛错也必须是一个可读的答复：页面拿到 500 只会显示「操作失败」，
        // 而这里的每一条错都带着用户能做的事。
        writeJson(response, 200, {
          ok: false,
          reason: `离线工作流内部错误：${error instanceof Error ? error.message : String(error)}`,
        })
        return
      }
    }
    if (action === 'preview-personas') {
      writeJson(response, 200, { personas: await deps.previewPersonas() })
      return
    }
    // Stop everything that is still live. Distinct from the "switch to manual"
    // form edit above: that only stages config, this actually stops work.
    if (action === 'pause-now') {
      const outcome = await deps.stopAllActive()
      writeJson(response, 200, { ...outcome, view: await viewOfSettings(deps) })
      return
    }
    // The one-off publish verification (v0.2.21 §三).
    //
    // Behind the same `guard` as every other action, and deliberately an action rather than a
    // tool: the account, the thread, the target and the text are the owner's to type. A model
    // that could call this would be choosing where to post, which is the one decision §三.2
    // reserves for the human.
    if (action === 'verify-publish') {
      if (deps.runVerification === undefined) {
        writeJson(response, 200, {
          ok: false,
          upgraded: false,
          message: '当前构建没有接上真实发表验收（runVerification 未提供）',
        } satisfies VerificationRunView)
        return
      }
      const platform = typeof body.platform === 'string' ? body.platform : ''
      const capability = body.capability
      if (capability !== 'comment.publish' && capability !== 'comment.reply') {
        writeJson(response, 400, { error: 'capability 只能是 comment.publish 或 comment.reply' })
        return
      }
      const outcome = await deps.runVerification({
        platform,
        capability,
        authorizedAccountId: typeof body.authorizedAccountId === 'string' ? body.authorizedAccountId : '',
        authorizedThreadId: typeof body.authorizedThreadId === 'string' ? body.authorizedThreadId : '',
        ...(typeof body.authorizedFloorId === 'string' ? { authorizedFloorId: body.authorizedFloorId } : {}),
        ...(typeof body.replyToPostId === 'string' ? { replyToPostId: body.replyToPostId } : {}),
        authorizedBy: typeof body.authorizedBy === 'string' ? body.authorizedBy : '',
        approvedText: typeof body.approvedText === 'string' ? body.approvedText : '',
      })
      writeJson(response, 200, outcome)
      return
    }
    // Editing a candidate's text (v0.2.22 §三). Behind the guard like every other write, and
    // deliberately narrow: it rewrites prose and nothing else. It cannot approve, cannot publish,
    // and cannot change the target — those are separate actions with their own gates.
    if (action === 'edit-candidate') {
      if (deps.editCandidate === undefined) {
        writeJson(response, 200, { ok: false, message: '当前构建没有接上候选编辑（editCandidate 未提供）' })
        return
      }
      const outcome = await deps.editCandidate({
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
        candidateId: typeof body.candidateId === 'string' ? body.candidateId : '',
        text: typeof body.text === 'string' ? body.text : '',
      })
      writeJson(response, 200, outcome)
      return
    }
    // Collect and analyse a discussion (v0.2.22 §二). The owner pastes a link; everything after
    // that is the same code the agent tool runs.
    if (action === 'analyze-thread') {
      if (deps.analyzeThread === undefined) {
        writeJson(response, 200, { ok: false, message: '当前构建没有接上讨论收集（analyzeThread 未提供）' })
        return
      }
      const outcome = await deps.analyzeThread({
        url: typeof body.url === 'string' ? body.url : '',
        ...(typeof body.postId === 'string' && body.postId !== '' ? { postId: body.postId } : {}),
        ...(typeof body.ownerInstruction === 'string' ? { ownerInstruction: body.ownerInstruction } : {}),
      })
      writeJson(response, 200, outcome)
      return
    }
    // Generate candidates (v0.2.22 §三). Reuses the generator and persona; each call bumps the
    // candidate version, which is what retires an earlier approval.
    if (action === 'generate-candidates') {
      if (deps.generateCandidates === undefined) {
        writeJson(response, 200, { ok: false, message: '当前构建没有接上候选生成（generateCandidates 未提供）' })
        return
      }
      const outcome = await deps.generateCandidates({
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
        ...(typeof body.style === 'string' && body.style !== '' ? { style: body.style } : {}),
        ...(typeof body.ownerInstruction === 'string' ? { ownerInstruction: body.ownerInstruction } : {}),
        // v0.2.24: the comment picked in the workbench. Absent keeps the old
        // behaviour of answering whatever summoned the session.
        ...(typeof body.targetPostId === 'string' && body.targetPostId !== ''
          ? { targetPostId: body.targetPostId }
          : {}),
      })
      writeJson(response, 200, outcome)
      return
    }
    // Publish one approved candidate (v0.2.22 §四). This route does not approve anything and does
    // not retry: `runPublish` owns the ledger, the capability gate and the read-back, and it
    // refuses an approval that no longer matches the bytes.
    if (action === 'publish-approved') {
      if (deps.publishApproved === undefined) {
        writeJson(response, 200, { ok: false, status: 'refused', message: '当前构建没有接上工作台发表' })
        return
      }
      const outcome = await deps.publishApproved({
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
        candidateId: typeof body.candidateId === 'string' ? body.candidateId : '',
        approvedText: typeof body.approvedText === 'string' ? body.approvedText : '',
      })
      writeJson(response, 200, outcome)
      return
    }
    writeJson(response, 400, { error: `未知操作 "${String(action)}"` })
  })

  /**
   * The human-approval endpoint.
   *
   * ## Why this is the only place an approval can be created
   *
   * v0.2.4 took `humanApproved: true` from the model's own tool arguments, so "the
   * model wrote a boolean" and "the owner clicked approve" were the same event. The
   * whole point of this version is that they are not. A record created here is
   * reachable **only** through this route, and the route sits behind `guard`: a
   * loopback peer, a same-origin Host/Origin pair, and a verified DSH browser session.
   * No tool exposes it, and the agent has no client pointed at it.
   *
   * ## The body carries no secret and the reply carries none either
   *
   * `{ sessionId, candidateId }` in; a boolean and the record's *id* out. The id is an
   * audit handle, not a capability: possessing it authorises nothing, because the
   * publish path looks the record up by the binding it is about to send rather than by
   * an id a caller supplies. A token the agent could read would be a token it could
   * replay.
   *
   * ## What it refuses
   *
   * A `block` candidate cannot be approved at all. An approval is not a way past the
   * security gate, and minting one would leave a record that is refused later for a
   * different reason than the one that matters.
   */
  const approveRoute = guard(async (request, response) => {
    if ((request.method ?? 'GET') !== 'POST') {
      writeJson(response, 405, { error: `method not allowed: ${request.method ?? 'GET'}` })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      writeJson(response, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const outcome = await (deps.approve?.(body) ??
      Promise.resolve({
        status: 501,
        body: {
          error:
            '这个 Host 版本没有提供人工批准接口，无法创建发表授权。' +
            '候选仍然可以生成和复制；真实发表会被拒绝。',
        },
      }))
    writeJson(response, outcome.status, outcome.body)
  })

  return [
    { kind: 'exact', path: `${ROUTE_PREFIX}/settings`, handler: settingsRoute },
    { kind: 'exact', path: `${ROUTE_PREFIX}/secrets`, handler: secretRoute },
    { kind: 'exact', path: `${ROUTE_PREFIX}/status`, handler: statusRoute },
    { kind: 'exact', path: `${ROUTE_PREFIX}/action`, handler: actionRoute },
    { kind: 'exact', path: `${ROUTE_PREFIX}/verification`, handler: verificationRoute },
    { kind: 'exact', path: `${ROUTE_PREFIX}/workbench`, handler: workbenchRoute },
    { kind: 'exact', path: `${ROUTE_PREFIX}/approve`, handler: approveRoute },
  ]
}

/** Re-export so the client bundle comment and the tests agree on one spelling. */
export const ROUTE_SETTINGS = `${ROUTE_PREFIX}/settings`
export const ROUTE_SECRETS = `${ROUTE_PREFIX}/secrets`
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`
export const ROUTE_ACTION = `${ROUTE_PREFIX}/action`
export const ROUTE_APPROVE = `${ROUTE_PREFIX}/approve`
export const ROUTE_VERIFICATION = `${ROUTE_PREFIX}/verification`
export const ROUTE_WORKBENCH = `${ROUTE_PREFIX}/workbench`

/** A masked tail, exposed for the diagnostics panel's credential rows. */
export { maskedTail }

/** The config the route family serves, resolved from a raw row config. */
export function resolvedForRoute(raw: unknown): ResolvedConfig {
  return resolveConfig(raw)
}
