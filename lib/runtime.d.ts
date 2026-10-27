/**
 * The orchestration layer: one place where the pieces are wired into a task.
 *
 * The tools in `tools.ts` are thin wrappers over these functions so the
 * pipeline is testable without a Host, a network or a model. Every stage
 * records its state in the store, so a failure halfway through leaves a
 * session a human can inspect rather than a stack trace and nothing else.
 */
import { type PlatformCapabilities } from './types.js';
import { TiebaAdapter } from './platforms/tieba/adapter.js';
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
    readonly adapter: TiebaAdapter;
    readonly store: DebateStore;
    readonly policy: InteractionPolicy;
    readonly config: () => ResolvedConfig;
    /** Model client factory, replaceable in tests. */
    readonly llm: () => LlmClient;
    readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}
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
/** The owner identity from configuration. */
export declare function ownerIdentity(config: ResolvedConfig): OwnerIdentity;
/** The persona from configuration. */
export declare function personaFromConfig(config: ResolvedConfig): PersonaConfig;
/** The interaction policy from configuration. */
export declare function policyFromConfig(config: ResolvedConfig): InteractionPolicy;
/**
 * Build a platform adapter for one configuration snapshot.
 *
 * The adapter owns a cookie jar and a cache of forum metadata, so it cannot be
 * reused across a config change: a new `tiebaCookie` would be ignored and paging
 * would keep the old timeouts. Callers rebuild on every config version instead.
 */
export declare function makeAdapter(config: ResolvedConfig): TiebaAdapter;
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
/** Check whether an id may summon. */
export declare function isAllowedOwner(config: ResolvedConfig, userId: string | undefined): boolean;
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