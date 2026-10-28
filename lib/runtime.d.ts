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
import { type PlatformAdapter, type PlatformCapabilities, type ThreadRef } from './types.js';
import type { RegistryDiagnostics } from './platforms/registry.js';
import { type PlatformAccountBinding } from './platforms/accounts.js';
import { type Dispute, type OwnerIdentity } from './analyzer.js';
import { type CollectedThread } from './collector.js';
import { type LlmClient } from './llm.js';
import { type PersonaConfig } from './persona.js';
import { type PublishReport } from './publisher.js';
import { type InteractionPolicy } from './safety.js';
import { DebateStore, type StoredCandidate, type StoredSession } from './store.js';
import type { ResolvedConfig } from './config.js';
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
    readonly adapter: PlatformAdapter;
    readonly store: DebateStore;
    readonly policy: InteractionPolicy;
    readonly config: () => ResolvedConfig;
    /** Model client factory, replaceable in tests. */
    readonly llm: () => LlmClient;
    readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
    /**
     * The platform registry, when the shell has one.
     *
     * Optional so the many v0.1.x tests that build a `Runtime` from a bare adapter
     * keep compiling. When present, URL resolution, adapter selection and capability
     * checks all go through it; when absent, {@link resolveThreadRef} falls back to
     * the adapter's own id, which is enough for a single-platform deployment.
     */
    readonly platforms?: PlatformRuntime;
    /**
     * The credential state, when this deployment can report one.
     *
     * Absent in tests and in a deployment without `ctx.credentials`, where the
     * cookie comes from config and there is nothing to be uncertain about. When
     * present, the publisher refuses to send while it is unproven.
     */
    readonly credentialState?: () => {
        readonly phase: string;
        readonly canPublish: boolean;
        readonly error?: string;
    };
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
    resolveUrl(url: string): ThreadRef;
    /** The registry's diagnostics, for the health report. */
    diagnostics(): RegistryDiagnostics;
    /** The rich capability matrix for one platform. */
    capabilitiesOf(platform: string): import('./platforms/contracts.js').PlatformCapabilityMatrix;
    /**
     * Build (or reuse) the adapter for one platform.
     *
     * This is the method that makes multi-platform operation real: the adapter is
     * chosen by platform id and created from *that platform's* configuration and
     * credentials, so two platforms in one process cannot share an identity.
     */
    adapterFor(platform: string): PlatformAdapter;
    /**
     * Check a capability before a write, throwing when it is not proven.
     *
     * Present here so the publish path has one mandatory gate rather than relying
     * on each caller to remember. `supported` is required; `unverified`,
     * `degraded`, `permission_required` and `unavailable` all refuse.
     */
    assertCapability(platform: string, capability: import('./platforms/contracts.js').CapabilityName): void;
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
export declare function resolveThreadRef(runtime: Runtime, url: string): ThreadRef;
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
export declare function adapterFor(runtime: Runtime, platform: string): PlatformAdapter;
/**
 * Check that a platform may perform a write, before anything irreversible.
 *
 * Runs the registry's capability gate when there is a registry. A bare Runtime
 * (a test double) has no declarations to check against, so it passes — that is
 * not a bypass for production: production always has a registry, and the
 * publisher's other checks (identity, target snapshot, idempotency, credential
 * phase) all still run.
 */
export declare function assertPlatformCapability(runtime: Runtime, platform: string, capability: import('./platforms/contracts.js').CapabilityName): void;
/** A progress callback the tools pass through to the UI. */
export type Progress = (message: string) => void;
/** Result of an analyze run. */
export interface AnalysisOutput {
    readonly sessionId: string;
    readonly thread: {
        readonly threadId: string;
        readonly title: string;
        readonly forumName: string;
        readonly url: string;
        readonly declaredReplyCount?: number;
        readonly readFloors: number;
    };
    readonly dispute: Dispute;
    readonly ownerClaims: readonly string[];
    readonly participants: readonly {
        displayName: string;
        postCount: number;
        isOwner: boolean;
        isOpponent: boolean;
    }[];
    readonly issues: readonly string[];
    readonly securityNotes: readonly string[];
    readonly collected: CollectedThread;
}
/** Build the LLM client from configuration, or throw a clear error. */
export declare function buildLlm(config: ResolvedConfig): LlmClient;
/**
 * The owner identity for one platform, from configuration.
 *
 * v0.2.2 derives this from a per-platform binding table rather than from global
 * fields. The reason is a real failure, not tidiness: a user id only identifies
 * someone inside one platform (Tieba `user_id` and Weibo `uid` are both 9–10
 * digit decimals in unrelated namespaces), so a single global id compared against
 * whatever platform the link pointed at could match a stranger and make the
 * plugin argue on their behalf under the owner's name.
 *
 * A platform with no binding yields an identity carrying only the platform — the
 * analyzer then reports that the owner was not found rather than reusing another
 * platform's id.
 *
 * @param platform the platform this identity will be matched against
 */
export declare function ownerIdentity(config: ResolvedConfig, platform: string): OwnerIdentity;
/**
 * The per-platform binding table for a resolved config.
 *
 * Exposed so the publisher, the summon check and the diagnostics page all read
 * the same structure — three separate readings of the global fields is how they
 * drifted apart in the first place.
 */
export declare function bindingsOf(config: ResolvedConfig): PlatformAccountBinding;
/** The persona from configuration. */
export declare function personaFromConfig(config: ResolvedConfig): PersonaConfig;
/** The interaction policy from configuration. */
export declare function policyFromConfig(config: ResolvedConfig): InteractionPolicy;
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
export declare function platformSettingsOf(config: ResolvedConfig, platform: string): Readonly<Record<string, unknown>>;
/**
 * Run the full read + analyze stage.
 *
 * This never calls the model. It produces the structured reconstruction a human
 * can check before any text is generated, which is what makes the "wrong
 * opponent" failure visible instead of hidden inside a reply.
 */
export declare function runAnalysis(runtime: Runtime, input: {
    url: string;
    postId?: string;
    ownerInstruction?: string;
    signal?: AbortSignal;
    progress?: Progress;
}): Promise<AnalysisOutput>;
/**
 * Raised when live sessions already fill the configured cap.
 *
 * A distinct type rather than a plain `Error`, so tool handlers can report it as a
 * capacity condition with remediation ("finish or cancel a task, or raise
 * `maxSessions`") instead of a generic internal failure — and so no caller mistakes it
 * for "the platform refused", which would invite a retry that keeps failing.
 */
export declare class SessionCapacityError extends Error {
    readonly capacity: {
        active: number;
        cap: number;
        full: boolean;
        activeIds: readonly string[];
    };
    constructor(message: string, capacity: {
        active: number;
        cap: number;
        full: boolean;
        activeIds: readonly string[];
    });
}
/** Result of a generate run. */
export interface GenerateOutput {
    readonly sessionId: string;
    readonly candidateId: string;
    readonly text: string;
    readonly strategy: string;
    readonly confidence: number;
    readonly violations: readonly string[];
    readonly notes: readonly string[];
    readonly needsInput: boolean;
    readonly needsInputReason?: string;
    readonly contextTokens: number;
    /** The thread-context share of the budget, after fixed costs. */
    readonly budget: number;
    /** What the request spends outside the quoted thread. */
    readonly fixedCostTokens: number;
    /** The whole request budget the user configured. */
    readonly totalBudget: number;
    readonly omissions: readonly string[];
    readonly usage: {
        inputTokens: number;
        outputTokens: number;
        elapsedMs: number;
    };
}
/**
 * Generate a candidate reply for an analyzed session.
 *
 * The session is re-collected rather than trusting a cached copy: a floor can
 * be deleted or edited between analysis and generation, and replying to a
 * vanished post is exactly what the "wrong target" guard exists to prevent.
 */
export declare function runGeneration(runtime: Runtime, input: {
    sessionId: string;
    persona?: Partial<PersonaConfig>;
    ownerInstruction?: string;
    signal?: AbortSignal;
    progress?: Progress;
}): Promise<GenerateOutput>;
/** Publish an approved candidate. */
export declare function runPublish(runtime: Runtime, input: {
    sessionId: string;
    candidateId: string;
    approvedText: string;
    humanApproved: boolean;
    signal?: AbortSignal;
}): Promise<PublishReport>;
/** A readable session summary. */
export interface SessionView {
    readonly session: StoredSession;
    readonly candidates: readonly StoredCandidate[];
}
/** Read one session. */
export declare function getSession(runtime: Runtime, sessionId: string): Promise<SessionView>;
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
export declare function stopSession(runtime: Runtime, sessionId: string, reason?: string): Promise<StoredSession>;
/** Register a controller for one session's publish. */
export declare function registerInFlight(sessionId: string, controller: AbortController): () => void;
/** Abort every publish in flight for this session. */
export declare function cancelInFlight(sessionId: string): void;
/**
 * How many publishes are currently tracked.
 *
 * With a `sessionId`, counts only that session's — which is what the settings
 * page needs when it reports "aborted N requests". Without one, the whole
 * process; that form is a test seam.
 */
export declare function inFlightPublishCount(sessionId?: string): number;
/** The health report. */
export interface HealthReport {
    readonly ok: boolean;
    readonly enabled: boolean;
    readonly ownerBound: boolean;
    readonly llmConfigured: boolean;
    readonly storePath: string;
    readonly sessions: number;
    readonly usage: {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        failures: number;
    };
    readonly capabilities: PlatformCapabilities;
    readonly cookieNames: readonly string[];
    readonly notes: readonly string[];
}
/** Build a health report without touching the network. */
export declare function healthCheck(runtime: Runtime): Promise<HealthReport>;
/**
 * Check whether an account id may summon on a given platform.
 *
 * Scoped to the platform because a summon allow-list is a set of people, and a
 * Tieba user id identifies a different person on Weibo. The old signature had no
 * platform at all, so a Tieba allow-list silently applied everywhere.
 */
export declare function isAllowedOwner(config: ResolvedConfig, userId: string | undefined, platform: string): boolean;
/** Translate an arbitrary failure into a user-facing sentence. */
export declare function describeFailure(error: unknown): {
    message: string;
    pause: boolean;
};
/** Re-export for tools that build their own compressed context preview. */
export type { CompressedContext } from './compressor.js';
export type { CollectedThread } from './collector.js';
export type { GenerationResult } from './generator.js';
//# sourceMappingURL=runtime.d.ts.map