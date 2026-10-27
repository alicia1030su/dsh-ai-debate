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
    /** Probe the Tieba login state. */
    checkLogin(): Promise<LoginProbe>;
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
}
/** What a real "stop everything now" call actually managed to do. */
export interface PauseOutcome {
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
/** A masked tail, exposed for the diagnostics panel's credential rows. */
export { maskedTail };
/** The config the route family serves, resolved from a raw row config. */
export declare function resolvedForRoute(raw: unknown): ResolvedConfig;
//# sourceMappingURL=settings-routes.d.ts.map