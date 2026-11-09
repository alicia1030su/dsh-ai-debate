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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerificationAuthorization } from './verification.js';
import { type ResolvedConfig } from './config.js';
import type { CredentialPhase } from './credential-mirror.js';
import { maskedTail, type CredentialSeam, type SecretOverlay, type SecretRefName } from './secrets.js';
/**
 * The credential phase as the page receives it.
 *
 * Structurally typed rather than importing the mirror's class: this module must
 * stay testable with a hand-written double, and a `CredentialPhase` union is
 * cheap to restate. The values are checked against the mirror by
 * `test/credential-states.test.ts`.
 */
export interface CredentialStatusView {
    readonly phase: CredentialPhase;
    readonly settled: boolean;
    readonly unresolved: readonly SecretRefName[];
    readonly error?: string;
    readonly canPublish: boolean;
}
/** Structural stand-in for the Host webserver's WebRoute (no build-time dep). */
export interface WebRoute {
    kind: 'exact' | 'prefix';
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns the full response lifecycle. */
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** The route family path prefix. */
export declare const ROUTE_PREFIX = "/api/dsh-ai-debate";
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
export type RequestAuthorizer = (request: IncomingMessage) => 'ok' | 401 | 403;
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
    authorize?: RequestAuthorizer;
    /** Read the live resolved config. */
    config(): ResolvedConfig;
    /** The credential seam, or undefined when unavailable. */
    credentials(): CredentialSeam | undefined;
    /** The overlay currently in force. */
    overlay(): SecretOverlay;
    /**
     * What the plugin currently believes about the credential store.
     *
     * The phase is what lets the page say "尚未确认" instead of picking one of two
     * lies: "未配置" (a fact the plugin does not have) or "已配置 · 长度 0" (the
     * v0.1.10 defect). Optional so a test double written against the older shape
     * keeps compiling; absent means the page falls back to the overlay alone.
     */
    credentialState?(): CredentialStatusView;
    /**
     * Install a value the store already confirmed.
     *
     * Called after a successful write so the mirror holds the new value before the
     * next read can race it. Optional for the same reason as `credentialState`.
     */
    acceptSecret?(ref: SecretRefName, value: string): void;
    /** Install a deletion the store already confirmed. */
    acceptSecretClear?(ref: SecretRefName): void;
    /** Re-read the credential store and install the result. */
    refreshSecrets(): Promise<void>;
    /** The settings service, or undefined. */
    settings(): SettingsService | undefined;
    /** The settings namespace (the row id). */
    namespace(): string;
    /** Run the model-connection probe. */
    testModel(): Promise<ModelProbe>;
    /** 宿主模型服务探测（v0.2.36）。省略时报告「拿不到」。 */
    probeHostLlm?(): Promise<unknown>;
    /** 出网守卫自检（v0.2.36）。省略时报告「没有守卫」。 */
    probeEgress?(): Promise<{
        blocked: boolean;
        mode: string;
        host: string;
        reason: string;
    }>;
    /** Probe the bound account's login state. */
    checkLogin(): Promise<LoginProbe>;
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
    platforms?(): readonly PlatformView[];
    /**
     * What the injection-protection layer is actually doing.
     *
     * Optional for the same reason `platforms` is: existing route tests keep
     * compiling. When present the page shows a security section, and the values come
     * from the running code rather than from the defaults — a page that reports the
     * default instead of the effective value is how a disabled protection looks
     * enabled.
     */
    security?(): SecurityView;
    /** Preview all four personas against a fixed exchange. */
    previewPersonas(): Promise<readonly PersonaPreview[]>;
    /**
     * Stop every task that is still in a non-terminal state.
     *
     * This is the honest half of the "pause everything" affordance: the plugin
     * has no background scheduler, so there is nothing to switch off, but there
     * **are** live sessions and publishes in flight, and those can be stopped for
     * real. Publish records that already reached the platform are left alone.
     */
    stopAllActive(): Promise<PauseOutcome>;
    /** Read the publish ledger and session counters. */
    diagnostics(): Promise<Diagnostics>;
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
    platformDiagnostics?(options?: {
        readonly refresh?: boolean;
    }): Promise<readonly PlatformDiagnosticBlock[]>;
    /**
     * The one-off publish verification view, for the owner-only panel (v0.2.21 §三/§四).
     *
     * Reads the live account, the declared capabilities and every record. Optional for the same
     * reason `platformDiagnostics` is: route tests written before this existed keep compiling, and
     * a build without the publishing stack shows "this build cannot verify" rather than a green
     * state it did not measure.
     */
    verification?(input: {
        readonly platform: string;
    }): Promise<VerificationView>;
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
    runVerification?(input: VerificationActionInput): Promise<VerificationRunView>;
    /**
     * The publish workbench read model (v0.2.22 §一).
     *
     * Optional like the others: a build without the publishing stack shows "this build has no
     * workbench" rather than an empty success.
     */
    workbench?(input: {
        readonly sessionId?: string;
    }): Promise<WorkbenchView>;
    /**
     * Edit one candidate's text (v0.2.22 §三).
     *
     * A separate write from approve/publish because it invalidates both: the response is the new
     * version and hash, so the page can show that the old approval no longer applies instead of
     * discovering it on the next publish attempt.
     */
    editCandidate?(input: {
        readonly sessionId: string;
        readonly candidateId: string;
        readonly text: string;
    }): Promise<{
        readonly ok: boolean;
        readonly message?: string;
        readonly candidateVersion?: number;
        readonly textHash?: string;
    }>;
    /**
     * Collect and analyse one discussion (v0.2.22 §二).
     *
     * The same `runAnalysis` the agent tool uses, reached from the owner's form. It reads the
     * thread and produces the session + reconstruction; it never publishes, and it cannot choose
     * the target on the owner's behalf.
     */
    analyzeThread?(input: {
        readonly url: string;
        readonly postId?: string;
        readonly ownerInstruction?: string;
    }): Promise<{
        readonly ok: boolean;
        readonly message?: string;
        readonly sessionId?: string;
    }>;
    /**
     * Generate candidates for an existing session (v0.2.22 §三).
     *
     * Reuses the generator and the persona; each call bumps the candidate version, which is what
     * retires any earlier approval.
     */
    generateCandidates?(input: {
        readonly sessionId: string;
        readonly style?: string;
        readonly ownerInstruction?: string;
        /** The comment to answer, chosen in the workbench (v0.2.24). */
        readonly targetPostId?: string;
    }): Promise<{
        readonly ok: boolean;
        readonly message?: string;
        readonly candidates?: number;
    }>;
    /**
     * Publish one approved candidate (v0.2.22 §四/§五).
     *
     * Deliberately goes through `runPublish` — the only path that can reach a platform — so the
     * workbench inherits the capability gate, the approval check, the ledger and the read-back
     * rather than reimplementing any of them.
     */
    publishApproved?(input: {
        readonly sessionId: string;
        readonly candidateId: string;
        readonly approvedText: string;
    }): Promise<{
        readonly ok: boolean;
        readonly status: string;
        readonly message: string;
        readonly postId?: string;
    }>;
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
    pendingApprovals?(): Promise<PendingApprovalsView>;
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
    approve?(input: Record<string, unknown>): Promise<ApprovalOutcome>;
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
            readonly kind: 'text' | 'json' | 'file';
            readonly content: string;
            readonly title?: string;
            readonly url?: string;
            readonly fileName?: string;
            /** 上一轮预览上做过的人工修正（v0.2.31 §四）。 */
            readonly corrections?: unknown;
        }): Promise<{
            readonly ok: boolean;
            readonly reason?: string;
            readonly issues?: readonly {
                readonly severity: string;
                readonly code: string;
                readonly message: string;
            }[];
            readonly discussion?: {
                readonly title: string;
                readonly author: string;
                readonly text: string;
                readonly comments: readonly {
                    readonly id: string;
                    readonly author: string;
                    readonly text: string;
                    readonly replyTo?: string;
                }[];
                readonly participants: readonly string[];
            };
            /** 结构化预览（v0.2.31）：关系三档、楼层、依据、同名、统计。 */
            readonly structure?: unknown;
            /** 修正做了什么，逐条可读。 */
            readonly audit?: readonly unknown[];
            /** 回传给下一次预览/确认的修正清单（原样带上即可）。 */
            readonly corrections?: unknown;
        }>;
        /** 确认导入：分析并建会话。 */
        confirm(input: {
            readonly kind: 'text' | 'json' | 'file';
            readonly content: string;
            readonly title?: string;
            readonly url?: string;
            readonly fileName?: string;
            readonly ownerName?: string;
            readonly targetPostId?: string;
            readonly persona?: string;
            /** 与预览时同一份修正清单，保证「确认的数据 = 预览的数据」。 */
            readonly corrections?: unknown;
        }): Promise<{
            readonly ok: boolean;
            readonly sessionId?: string;
            readonly reason?: string;
            readonly next?: readonly string[];
            readonly participants?: readonly {
                readonly name: string;
                readonly postCount: number;
                readonly isOwner: boolean;
                readonly isOpponent: boolean;
            }[];
            readonly securityNotes?: readonly string[];
        }>;
        /**
         * 对已确认的会话应用一批修正（v0.2.31 §四）。
         *
         * 与 `preview` 的 `corrections` 不同：那条路径在**导入之前**改，
         * 这条在**已经建了会话之后**改，需要重新分析并把旧候选作废。
         * 两条都必须只能用于分析，永远不产生发表权限。
         */
        revise(input: {
            readonly sessionId: string;
            readonly corrections: unknown;
        }): Promise<{
            readonly ok: boolean;
            readonly reason?: string;
            readonly next?: readonly string[];
            readonly structure?: unknown;
            readonly audit?: readonly unknown[];
            /** 因修正而作废的候选数。必须报出来：用户要知道自己刚才那段草稿没了。 */
            readonly discardedCandidates?: number;
        }>;
        /** 换主人或换目标，重跑分析。 */
        select(input: {
            readonly sessionId: string;
            readonly ownerName?: string;
            readonly targetPostId?: string;
            readonly persona?: string;
        }): Promise<{
            readonly ok: boolean;
            readonly reason?: string;
            readonly next?: readonly string[];
        }>;
        /** 取目标上下文（v0.2.31 §五）：这条发言前后是谁在说什么。 */
        context(input: {
            readonly sessionId: string;
            readonly postId: string;
        }): Promise<{
            readonly ok: boolean;
            readonly reason?: string;
            readonly context?: unknown;
        }>;
        /** 生成候选。 */
        generate(input: {
            readonly sessionId: string;
            readonly targetPostId?: string;
            readonly persona?: string;
            readonly ownerInstruction?: string;
            /**
             * 手工指定的论证打法（v0.2.38）。
             *
             * 不传就是自动选择。传了但材料不支撑它时，接口返回 `ok: false` 并说明缺什么 ——
             * 不会悄悄回落到自动选择，那样主人会以为自己指定生效了。
             */
            readonly strategy?: string;
        }): Promise<{
            readonly ok: boolean;
            /**
             * 本次生成的结果类型（v0.2.39 §3.1）。
             *
             * 页面据此决定说什么：`needs_more_context` 要引导去补材料，
             * `technical_failure` 要引导重试，`unjustified_refusal` 要提示换模型或换打法。
             * 三者都不该显示成同一句「生成失败」。
             */
            readonly outcome?: string;
            readonly candidateId?: string;
            readonly text?: string;
            readonly reason?: string;
            readonly next?: readonly string[];
            readonly securityDecision?: string;
            readonly securityReasons?: readonly string[];
            /** 模型主动要求补充信息（v0.2.38）。 */
            readonly needsInput?: boolean;
            readonly needsInputReason?: string;
            /** 程序选出的打法与依据（v0.2.38）。 */
            readonly argumentStrategy?: {
                readonly id: string;
                readonly name: string;
                readonly source: 'auto' | 'manual';
                readonly reason: string;
                readonly confidence: 'high' | 'medium' | 'low';
                readonly evidence: readonly {
                    readonly field: string;
                    readonly postIds: readonly string[];
                    readonly why: string;
                }[];
            };
        }>;
        /** 编辑正文并重新评估。 */
        edit(input: {
            readonly sessionId: string;
            readonly candidateId: string;
            readonly text: string;
        }): Promise<{
            readonly ok: boolean;
            readonly reason?: string;
            readonly candidateVersion?: number;
        }>;
        /** 人工确认。 */
        approve(input: {
            readonly sessionId: string;
            readonly candidateId: string;
            readonly approvedText: string;
        }): Promise<{
            readonly ok: boolean;
            readonly reason?: string;
            readonly next?: readonly string[];
        }>;
        /** 取可复制的正文与目标。 */
        copy(input: {
            readonly sessionId: string;
            readonly candidateId: string;
            readonly visibleText?: string;
        }): Promise<{
            readonly ok: boolean;
            readonly reason?: string;
            readonly next?: readonly string[];
            readonly text?: string;
            readonly target?: {
                readonly author?: string;
                readonly excerpt: string;
                readonly postId: string;
            };
            readonly safe?: boolean;
            readonly blockers?: readonly string[];
            readonly persona?: string;
        }>;
        /**
         * 四种人格比较（v0.2.37 §7）。
         *
         * 逐条返回结果：成功带候选 id 与正文，失败带原因。**不许整批成功才返回** ——
         * 四种人格里有一条失败（模型偶尔不守格式），另外三条仍然是用户想看的东西。
         */
        compare?(input: {
            readonly sessionId: string;
            readonly targetPostId?: string;
            readonly personas?: readonly string[];
            readonly ownerInstruction?: string;
        }): Promise<{
            readonly ok: boolean;
            readonly rows: readonly {
                readonly persona: string;
                readonly personaName: string;
                readonly ok: boolean;
                readonly candidateId?: string;
                readonly text?: string;
                readonly securityDecision?: 'allow' | 'review' | 'block';
                readonly securityReasons?: readonly string[];
                readonly violations?: readonly string[];
                readonly elapsedMs?: number;
                readonly reason?: string;
            }[];
            readonly calls: number;
            readonly skipped: readonly string[];
            readonly cancelled: boolean;
            readonly message: string;
        }>;
        /** 取消正在进行的比较（v0.2.37 §8）。 */
        cancelCompare?(input: {
            readonly sessionId: string;
        }): Promise<{
            readonly ok: boolean;
            readonly reason?: string;
        }>;
    };
}
/** The status and body an approval attempt answers with. */
export interface ApprovalOutcome {
    readonly status: number;
    readonly body: Record<string, unknown>;
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
export type PendingApprovalsView = {
    readonly ok: true;
    readonly rows: readonly PendingApprovalView[];
} | {
    readonly ok: false;
    /** Already a human-readable sentence: the store writes these for the page. */
    readonly reason: string;
    /** `corrupt` / `read_failed` / `write_failed`, when the store named one. */
    readonly code?: string;
};
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
    readonly sessionId: string;
    readonly candidateId: string;
    readonly platform: string;
    readonly threadTitle: string;
    readonly threadUrl: string;
    readonly targetPostId: string;
    /** The exact body that would be posted, so the owner reads what they approve. */
    readonly text: string;
    readonly candidateVersion: number;
    /** `allow` or `review`. A `block` candidate is never listed: it cannot be approved. */
    readonly verdict: string;
    readonly createdAt: string;
    /** Why this needs a human, already formatted for display. */
    readonly reason: string;
    /**
     * The fingerprint of the security assessment shown with this row.
     *
     * Sent back on approval so the Host can prove it is minting a record for the
     * assessment the owner actually saw (v0.2.7). Without it, the approval route had
     * no way to tell "the page is current" from "the page is three regenerations old"
     * and silently bound the record to whatever was stored *now*.
     */
    readonly assessmentFingerprint?: string;
    /**
     * The whole expected snapshot, echoed back verbatim on approval.
     *
     * One field rather than eight so a new bound field (a publishing account, a
     * content hash) becomes a change here and in `bindingOf` only — not in the client,
     * the route and every test. It is data the page was given, never data it computed.
     */
    readonly expected?: PendingApprovalExpectation;
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
    readonly sessionId: string;
    readonly candidateId: string;
    readonly candidateVersion: number;
    readonly platform: string;
    readonly targetPostId: string;
    /** The account that would post it; a switch invalidates the expectation. */
    readonly publishingAccount: string;
    /** Hash of the body the page displayed. */
    readonly textHash: string;
    readonly assessmentFingerprint: string;
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
export type PlatformReadiness = 'verified' | 'untested' | 'needs_login' | 'needs_permission' | 'unavailable';
export interface PlatformView {
    readonly id: string;
    readonly displayName: string;
    readonly shape: string;
    /** True when an adapter exists and is registered right now. */
    readonly implemented: boolean;
    /** True when this is the platform the plugin currently talks to. */
    readonly active: boolean;
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
    readonly readiness?: PlatformReadiness;
    /** One line explaining `readiness`, in the platform's own words. */
    readonly readinessReason?: string;
    /** Research stage, for the not-yet-implemented ones. */
    readonly research?: string;
    /** Capability rows, already flattened for the page. */
    readonly capabilities: readonly {
        readonly name: string;
        readonly state: string;
        readonly mark: string;
        readonly reason: string;
        readonly limits?: readonly string[];
        readonly requiredPermissions?: readonly string[];
        readonly lastVerifiedAt?: string;
    }[];
    /** What would have to happen before this becomes implemented. */
    readonly prerequisites?: readonly string[];
    readonly constraints?: readonly string[];
    readonly authModel?: string;
    readonly urlShapes?: readonly string[];
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
    readonly protectionEnabled: boolean;
    /** How eagerly text-level evidence forces review. */
    readonly strictness: string;
    /**
     * True when the deterministic rules are enforced.
     *
     * Always true. It is in the payload so the page can *say* it, and so a future
     * change that made it configurable would break this field rather than quietly
     * shipping an off switch.
     */
    readonly hardRulesEnforced: true;
    /** Input scanning is available and running. */
    readonly inputScanning: boolean;
    /** The output gate runs before every publish. */
    readonly outputGate: boolean;
    /** Stance protection is active, i.e. replies are checked against the owner. */
    readonly stanceGuard: boolean;
    /** Whether the semantic reviewer is configured at all. */
    readonly semanticReview: boolean;
    /** Counters over the retained event window. */
    readonly counters: {
        readonly last24h: number;
        readonly blocked: number;
        readonly reviewerUnavailable: number;
    };
    /** Redacted recent events, newest first, already formatted for display. */
    readonly recent: readonly {
        readonly at: string;
        readonly summary: string;
        readonly severity: string;
        readonly decision?: string;
    }[];
}
/** What a real "stop everything now" call actually managed to do. */ export interface PauseOutcome {
    /** Sessions moved to CANCELLED by this call. */
    readonly stopped: readonly string[];
    /** Sessions that refused to stop, with the reason the state machine gave. */
    readonly refused: readonly {
        readonly sessionId: string;
        readonly reason: string;
    }[];
    /** Publishes whose in-flight request was aborted before it was sent. */
    readonly abortedInFlight: number;
    /**
     * Replies that already reached the platform. Those are not withdrawn — no
     * API can recall them, and claiming otherwise would be a lie the user acts on.
     */
    readonly alreadyPublished: number;
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
    readonly platform: string;
    readonly capability: 'comment.publish' | 'comment.reply';
    readonly authorizedAccountId: string;
    readonly authorizedThreadId: string;
    readonly authorizedFloorId?: string;
    readonly replyToPostId?: string;
    readonly authorizedBy: string;
    readonly approvedText: string;
}
/** The POST result for one verification attempt. */
export interface VerificationRunView {
    readonly ok: boolean;
    readonly message: string;
    /** Which refusal stopped it, when it did not publish. */
    readonly refusal?: string;
    readonly publishedPostId?: string;
    readonly readBack?: {
        readonly postFound: boolean;
        readonly authorMatched: boolean;
        readonly textMatched: boolean;
        readonly parentMatched: boolean;
        readonly notes: readonly string[];
    };
    /** True only when all four read-back facts held and the capability may be treated as proven. */
    readonly upgraded: boolean;
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
export declare function authorizationFromInput(input: VerificationActionInput): VerificationAuthorization;
/**
 * The publish workbench's read model (v0.2.22 §一).
 *
 * Deliberately the same shape `deriveWorkbenchState()` returns plus the candidate list the owner
 * needs to compare — the page renders what the server derived, so the "which step am I on"
 * answer cannot differ between a refresh and the live process.
 */
export interface WorkbenchView {
    readonly ok: boolean;
    /** Present once a session exists. */
    readonly sessionId?: string;
    readonly platform?: string;
    readonly threadUrl?: string;
    readonly threadTitle?: string;
    /** The derived steps and blockers, straight from `deriveWorkbenchState`. */
    readonly workbench?: {
        readonly step: string;
        readonly steps: readonly {
            readonly id: string;
            readonly title: string;
            readonly status: string;
        }[];
        readonly blockers: readonly string[];
        readonly missingEvidence: readonly {
            readonly what: string;
            readonly detail: string;
        }[];
        readonly outcome: string;
        readonly counts: {
            readonly floors: number;
            readonly nested: number;
            readonly candidates: number;
        };
        readonly target?: {
            readonly threadId: string;
            readonly postId: string;
            readonly kind: string;
            readonly authorName?: string;
        };
        readonly capability?: {
            readonly declared: string;
            readonly effective: string;
            readonly reason: string;
        };
    };
    /** Candidates, newest last, for the compare-and-edit pane. */
    readonly candidates?: readonly {
        readonly replyId: string;
        readonly text: string;
        readonly strategy: string;
        readonly candidateVersion: number;
        readonly textHash: string;
        readonly approved: boolean;
        readonly targetPostId: string;
        readonly createdAt: string;
        readonly violations: readonly string[];
        /** 生成这条候选时用的人格 id（v0.2.37 §7）。旧候选没有这个字段。 */
        readonly persona?: string;
        /** 这次生成实际耗时（ms）。 */
        readonly elapsedMs?: number;
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        /**
         * The security assessment fingerprint, when one was recorded.
         *
         * Present so the workbench can submit an approval whose `expected` snapshot matches what it
         * displayed. The approve route refuses a request without a complete snapshot — a page that
         * "approves whatever is stored now" is exactly the v0.2.7 hole — so this is not an optional
         * convenience, it is what makes approving from the workbench possible at all.
         */
        readonly assessmentFingerprint?: string;
    }[];
    /**
     * The full expectation the approve route requires, built from the facts above.
     *
     * `null` when it cannot be built (no bound publishing account, no assessment, no snapshot) —
     * and then the workbench must *not* offer an approve button, because the record it would create
     * could never authorise the publish it claims to.
     */
    readonly approveExpectation?: Record<string, unknown> | null;
    /** Why the expectation is unavailable, when it is. */
    readonly approveBlocked?: string;
    /** Why the page cannot render a workbench at all, when it cannot. */
    readonly blockers: readonly string[];
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
        readonly kind: 'official_read' | 'manual_import';
        readonly label: string;
        readonly provenance: string;
        readonly canProveCompleteness: boolean;
        readonly canProveAuthorship: boolean;
        readonly allowsWrite: boolean;
        readonly caution: string;
    };
    /**
     * 人工导入的十一步进度（v0.2.30 §二）。
     *
     * 只在 `source.kind === 'manual_import'` 时出现。步骤由服务端从存下来的事实推导
     * （`stepOf`），页面照画即可——存一个 `step` 字段会让刷新后显示一个与候选、
     * 批准、编辑记录三者都可能不一致的进度。
     */
    readonly manualFlow?: {
        readonly step: string;
        readonly stepTitle: string;
        readonly steps: readonly {
            readonly id: string;
            readonly title: string;
            readonly done: boolean;
            readonly current: boolean;
        }[];
        /** 四种人格，页面渲染成选择器。 */
        readonly personas: readonly {
            readonly id: string;
            readonly name: string;
            readonly summary: string;
            readonly approach: string;
        }[];
        /**
         * 可选论证打法（v0.2.38）。
         *
         * 与人格**并列而不是嵌在人格里**：这是两层，页面要能分别选。嵌进去就又会变成
         * 「选人格顺带决定打法」——那正是这一版要拆开的东西。
         */
        readonly strategies?: readonly {
            readonly id: string;
            readonly name: string;
            readonly summary: string;
        }[];
        /** 这份讨论里出现过的人，按分析结果。 */
        readonly participants: readonly {
            readonly name: string;
            readonly postCount: number;
            readonly isOwner: boolean;
            readonly isOpponent: boolean;
        }[];
        /** 导入内容的来源形式与时间。 */
        readonly importedAt?: string;
        readonly importSource?: string;
        /** 复制前必须看得见的目标。 */
        readonly copyTarget?: {
            readonly author?: string;
            readonly excerpt: string;
            readonly postId: string;
        };
        /** 这段正文能不能安全复制；不能时 `copyBlockers` 说明为什么。 */
        readonly copyAllowed?: boolean;
        readonly copyBlockers?: readonly string[];
    };
}
export interface SettingsService {
    writable: boolean;
    update(namespace: string, patch: Record<string, unknown>): Promise<unknown>;
    mutate(namespace: string, ops: readonly {
        op: 'unset';
        path: readonly string[];
    }[]): Promise<unknown>;
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
    readonly ok: boolean;
    /**
     * The account the live session **actually** reports right now (v0.2.21 P0-2).
     *
     * Absent when the session could not be read. It is deliberately not filled from configuration:
     * the panel used to show the configured id under this name, which told the owner "this is who
     * is logged in" when nobody had checked. A verification cannot proceed on an unknown account,
     * so the absence has to survive into the view.
     */
    readonly liveAccountId?: string;
    /** The configured posting identity. Separate field, because it is a *different fact*. */
    readonly configuredAccountId?: string;
    readonly liveAccountName?: string;
    readonly adapterVersion?: string;
    readonly capabilities: readonly {
        readonly capability: string;
        readonly declared: string;
        readonly effective: string;
        readonly reason: string;
    }[];
    readonly records: readonly {
        readonly key: string;
        readonly platform: string;
        readonly capability: string;
        readonly authorizedAccountId: string;
        readonly authorizedThreadId: string;
        readonly startedAt: string;
        readonly outcome: string;
        readonly publishedPostId?: string;
        readonly readBack?: {
            readonly postFound: boolean;
            readonly authorMatched: boolean;
            readonly textMatched: boolean;
            readonly parentMatched: boolean;
            readonly notes: readonly string[];
        };
        readonly failure?: string;
    }[];
    /** One line per reason this deployment cannot verify right now. Empty means "can try". */
    readonly blockers: readonly string[];
    /**
     * The machine-readable half (§四).
     *
     * Same numbers the prose uses, in a shape a script can read: which capabilities are claimed,
     * which were actually proven, and which are still only declared. `null` never appears here —
     * an unknown state is `'unverified'`, because a script that sees `null` will treat it as "fine".
     */
    readonly report: {
        readonly platform: string;
        readonly generatedAt: string;
        readonly capabilities: readonly {
            readonly name: string;
            readonly declared: string;
            readonly effective: string;
            readonly evidence: readonly {
                readonly at: string;
                readonly accountId: string;
                readonly adapterVersion: string;
            }[];
        }[];
    };
}
/** Result of probing the configured model endpoint. */
export interface ModelProbe {
    readonly ok: boolean;
    readonly baseUrl: string;
    readonly model: string;
    readonly latencyMs?: number;
    readonly message: string;
    readonly sample?: string;
    /**
     * Which wire protocol the probe actually spoke (v0.2.27).
     *
     * A diagnostic that only says "failed" hides the most common real problem: the Base URL
     * points at something that is not a chat-completions endpoint. Naming the protocol and the
     * URL it was sent to makes that visible without reading the source.
     */
    readonly protocol?: string;
    /** The classified failure, when it failed. Same vocabulary the runtime acts on. */
    readonly errorCode?: string;
    /** HTTP status, when the failure had one. */
    readonly status?: number;
    /** What the owner can do about it. Empty when nothing is actionable. */
    readonly suggestions?: readonly string[];
    /** Token usage reported by this probe, when the endpoint returns it. */
    readonly inputTokens?: number;
    readonly outputTokens?: number;
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
        readonly ok: boolean;
        readonly message: string;
        /** Fields the contract required but the answer did not carry. */
        readonly missingFields?: readonly string[];
        /** Latency of this second call, in ms. */
        readonly latencyMs?: number;
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        /** A short excerpt of what the model actually returned, for the owner to read. */
        readonly sample?: string;
    };
    /** Total wall-clock time of the whole probe, including both calls. */
    readonly totalMs?: number;
    /**
     * 这次探测实际走的是哪条路（v0.2.36 §3.2）。
     *
     * 必须显示：同一个「连接正常」，走宿主和走自己配置的接口是两件不同的事 ——
     * 前者花的是宿主那边的额度，后者花的是填在插件里的那把 key。
     */
    readonly source?: 'host' | 'custom' | 'none';
    /** 宿主是否有可用的模型服务，即使这次没走它。 */
    readonly hostAvailable?: boolean;
    /** 实际用到的模型标识（`provider/model`），由客户端回报。 */
    readonly provider?: string;
}
/** Result of probing the Tieba login state. */
export interface LoginProbe {
    readonly ok: boolean;
    readonly authenticated: boolean;
    readonly message: string;
    readonly userName?: string;
    readonly userId?: string;
    readonly cookieNames: readonly string[];
}
/** One persona's preview against a fixed, non-published exchange. */
export interface PersonaPreview {
    readonly style: string;
    readonly name: string;
    readonly summary: string;
    readonly sample: string;
    readonly promptShape: string;
}
/** The live status block the diagnostics panel renders. */
export interface Diagnostics {
    readonly enabled: boolean;
    readonly storePath: string;
    /**
     * How `storePath` was chosen (v0.2.24).
     *
     * `configured` > `host` > `dsh_home` > `default`, in that order. Surfaced because
     * the v0.2.23 bug was invisible: the page showed a path, the path looked plausible,
     * and nothing said it had been resolved from the OS home rather than from the
     * instance the user was running.
     */
    readonly storeDirSource?: 'configured' | 'host' | 'dsh_home' | 'default';
    /** `DSH_HOME` as the plugin saw it, echoed for the same reason. */
    readonly dshHome?: string;
    readonly sessions: {
        total: number;
        active: number;
        awaitingConfirmation: number;
        published: number;
    };
    readonly publishLedger: {
        total: number;
        confirmed: number;
        pending: number;
        failed: number;
        overCapacity: boolean;
    };
    readonly usage: {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        failures: number;
    };
    readonly recentErrors: readonly {
        at: string;
        message: string;
    }[];
    readonly rateLimit: {
        limited: boolean;
        note: string;
    };
    readonly dshVersion?: string;
    readonly pluginVersion: string;
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
    readonly platforms?: readonly PlatformDiagnosticBlock[];
}
/** One platform's diagnostic, shaped by the adapter that produced it. */
export interface PlatformDiagnosticBlock {
    readonly platform: string;
    readonly displayName: string;
    /** Present only when the adapter answered. Absent means "no probe ran". */
    readonly state?: unknown;
    /** Why there is no state, when there is none. */
    readonly error?: string;
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
export declare function isTrustedRequest(request: IncomingMessage): boolean;
/**
 * The redacted settings view.
 *
 * `secrets` carries per-reference status only: `configured`, where it came from,
 * whether it is writable, and a four-character tail. The value itself is never
 * read here — `describeSecrets` is given a reader that returns the *legacy
 * config* field, which is already in the profile file and therefore not a
 * disclosure, and the store value never leaves `describe`.
 */
export declare function viewOfSettings(deps: SettingsRouteDeps): Promise<Record<string, unknown>>;
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
export declare function makeSettingsRoutes(deps: SettingsRouteDeps): readonly WebRoute[];
/** Re-export so the client bundle comment and the tests agree on one spelling. */
export declare const ROUTE_SETTINGS = "/api/dsh-ai-debate/settings";
export declare const ROUTE_SECRETS = "/api/dsh-ai-debate/secrets";
export declare const ROUTE_STATUS = "/api/dsh-ai-debate/status";
export declare const ROUTE_ACTION = "/api/dsh-ai-debate/action";
export declare const ROUTE_APPROVE = "/api/dsh-ai-debate/approve";
export declare const ROUTE_VERIFICATION = "/api/dsh-ai-debate/verification";
export declare const ROUTE_WORKBENCH = "/api/dsh-ai-debate/workbench";
/** A masked tail, exposed for the diagnostics panel's credential rows. */
export { maskedTail };
/** The config the route family serves, resolved from a raw row config. */
export declare function resolvedForRoute(raw: unknown): ResolvedConfig;
//# sourceMappingURL=settings-routes.d.ts.map