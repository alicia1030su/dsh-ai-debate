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
     * Candidates that are waiting for a human approval, newest first.
     *
     * This is what makes the approval section possible: the page cannot approve something
     * it cannot see, and it must not be told "approve candidate X" by the agent — the list
     * comes from the store, so what the owner sees is what is actually waiting.
     *
     * Optional so existing route tests keep compiling. When absent the page says there is
     * nothing to approve rather than inventing an empty success.
     */
    pendingApprovals?(): readonly PendingApprovalView[];
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
export interface SettingsService {
    writable: boolean;
    update(namespace: string, patch: Record<string, unknown>): Promise<unknown>;
    mutate(namespace: string, ops: readonly {
        op: 'unset';
        path: readonly string[];
    }[]): Promise<unknown>;
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
/** A masked tail, exposed for the diagnostics panel's credential rows. */
export { maskedTail };
/** The config the route family serves, resolved from a raw row config. */
export declare function resolvedForRoute(raw: unknown): ResolvedConfig;
//# sourceMappingURL=settings-routes.d.ts.map