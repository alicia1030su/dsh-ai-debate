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
export interface PlatformView {
    readonly id: string;
    readonly displayName: string;
    readonly shape: string;
    /** True when an adapter exists and is registered right now. */
    readonly implemented: boolean;
    /** True when this is the platform the plugin currently talks to. */
    readonly active: boolean;
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
/** A masked tail, exposed for the diagnostics panel's credential rows. */
export { maskedTail };
/** The config the route family serves, resolved from a raw row config. */
export declare function resolvedForRoute(raw: unknown): ResolvedConfig;
//# sourceMappingURL=settings-routes.d.ts.map