/**
 * Composition for the one-off publish verification (v0.2.21 §三).
 *
 * `verification.ts` is the rules, `verification-runner.ts` is the order of operations, and this
 * file is the wiring: it binds the runner to the store, the registry and the adapter manager so
 * that the settings page (the owner) can actually start one. Before v0.2.21 the flow existed but
 * nothing called it — a rule with no caller is a rule that protects nothing.
 *
 * ## Why this is not exposed as an agent tool
 *
 * The task book requires that the owner, not the model, provide the account, the thread, the
 * target and the exact text. A tool's arguments are written by the model, so a tool that accepts
 * "publish this text to this thread to prove publishing works" is a tool that lets the model pick
 * where to post. The entry point therefore lives on the owner-only settings route, and the model
 * cannot reach it — the same reasoning that keeps approval ids out of tool outputs.
 *
 * ## What the caller must pass
 *
 * Everything. There is no default account, no default thread, no generated text. See
 * `describeAuthorizationRequirements` in `verification.ts` for the text shown to the owner.
 */
import { type CapabilityEvidenceRecord } from './capability-evidence.js';
import type { CapabilityName, CapabilityState } from './platforms/contracts.js';
import type { PlatformAdapter } from './types.js';
import type { VerificationAuthorization, VerificationRecord } from './verification.js';
import { type VerificationRecordStore, type VerificationRunResult } from './verification-runner.js';
/** What the wiring needs from the host. All of it already exists in the plugin. */
export interface VerificationServiceDeps {
    /** The adapter for one platform, or `undefined` when the platform is not registered. */
    readonly adapterFor: (platform: string) => PlatformAdapter | undefined;
    /** The static declaration — the ceiling that evidence may lift but never edit. */
    readonly declaredState: (platform: string, capability: CapabilityName) => CapabilityState;
    /** The account the owner configured as this platform's posting identity. */
    readonly configuredAccountId: (platform: string) => string | undefined;
    /** The live session's account, read fresh each attempt. */
    readonly liveAccountId: (platform: string) => Promise<string | undefined>;
    /** Durable records. */
    readonly records: VerificationRecordStore;
    /** ISO clock. */
    readonly now: () => string;
}
/** Why a verification could not even be attempted, distinct from a platform refusal. */
export interface VerificationUnavailable {
    readonly ok: false;
    readonly code: 'unknown_platform' | 'no_adapter' | 'no_account';
    readonly message: string;
}
export interface VerificationService {
    /** The account + adapter version this deployment would verify against. */
    describe(platform: string): {
        accountId: string | undefined;
        adapterVersion: string | undefined;
        capability: Record<CapabilityName, {
            declared: CapabilityState;
            effective: CapabilityState;
            reason: string;
        }>;
    };
    /** Records, for the diagnostics panel and the machine-readable report. */
    history(): readonly VerificationRecord[];
    /** Run exactly one attempt. Returns rather than throwing for every expected refusal. */
    verify(authorization: VerificationAuthorization, signal?: AbortSignal): Promise<VerificationRunResult | VerificationUnavailable>;
    /** The evidence rows `capability-evidence.ts` joins with the declaration. */
    evidenceFor(platform: string, capability: CapabilityName, accountId: string, adapterVersion: string): readonly CapabilityEvidenceRecord[];
}
/**
 * Build the service.
 *
 * Deliberately stateless apart from what `deps` owns: every call re-reads the store and the
 * adapter, because both can change (a reload, a cookie update) between the page rendering and
 * the owner pressing the button.
 */
export declare function buildVerificationService(deps: VerificationServiceDeps): VerificationService;
//# sourceMappingURL=verification-service.d.ts.map