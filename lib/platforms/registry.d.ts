/**
 * The platform registry.
 *
 * One place answers four questions the rest of the plugin used to answer with
 * `import { TiebaAdapter }`:
 *
 *   - which platform owns this URL?
 *   - is this platform registered at all?
 *   - what can it do, in what state?
 *   - give me an adapter for it.
 *
 * The registry holds providers, not adapters. Constructing an adapter is the
 * expensive, stateful step (cookie jar, caches) and it must happen per
 * configuration generation, so the registry only builds one when asked.
 *
 * Design constraints this file exists to enforce:
 *
 * - **No platform may be named here.** A `if (id === 'tieba')` in this file is
 *   the architecture failing, and the contract tests exist to catch it.
 * - **Registration is explicit and ordered.** The first registered provider that
 *   claims a URL wins, so the order is documented rather than incidental.
 * - **Unknown is a state, not an error.** `resolveFromUrl` returning `undefined`
 *   means "no platform here", which callers must handle without throwing.
 */
import type { PlatformAdapter, ThreadRef } from '../types.js';
import { type CapabilityName, type CapabilityState, type LegacyCapabilityFlags, type PlatformCapabilityMatrix, type PlatformContext, type PlatformProvider } from './contracts.js';
/** Raised when a URL belongs to no registered platform. */
export declare class UnknownPlatformUrlError extends Error {
    readonly url: string;
    readonly knownPlatforms: readonly string[];
    constructor(url: string, knownPlatforms: readonly string[]);
}
/** Raised when an id is looked up and no provider holds it. */
export declare class PlatformNotRegisteredError extends Error {
    readonly platform: string;
    readonly knownPlatforms: readonly string[];
    constructor(platform: string, knownPlatforms: readonly string[]);
}
/** One row of the registry's diagnostics. */
export interface PlatformDiagnosticsEntry {
    readonly id: string;
    readonly displayName: string;
    readonly shape: PlatformProvider['shape'];
    /** Position in resolution order; lower wins. */
    readonly order: number;
    readonly capabilities: PlatformCapabilityMatrix;
}
/** The whole registry, as plain JSON for the settings/diagnostics page. */
export interface RegistryDiagnostics {
    readonly platforms: readonly PlatformDiagnosticsEntry[];
    /** Keys that were rejected at registration, with the reason kept. */
    readonly rejected: readonly {
        readonly id: string;
        readonly reason: string;
    }[];
}
/**
 * The registry.
 *
 * Not a singleton: tests build their own with fake platforms, and the plugin
 * builds one per mount. A module-level global would make two tests in one
 * process see each other's fakes.
 */
export declare class PlatformRegistry {
    private readonly providers;
    private readonly order;
    private readonly rejected;
    /**
     * Register a provider.
     *
     * Refuses duplicates instead of overwriting: a silent overwrite is how the
     * wrong platform ends up handling a URL, and there is no way to notice it from
     * the outside.
     *
     * @returns a disposer that unregisters this exact provider
     */
    register(provider: PlatformProvider): () => void;
    /**
     * Remove a provider.
     *
     * @returns true when something was removed. Idempotent, because a disposer may
     *   run twice when a mount fails halfway.
     */
    unregister(id: string): boolean;
    /** Look a provider up by id. */
    get(id: string): PlatformProvider | undefined;
    /** Look a provider up by id, throwing a typed error when absent. */
    require(id: string): PlatformProvider;
    /** Every provider, in resolution order. */
    list(): readonly PlatformProvider[];
    /** Every registered id, in resolution order. */
    listIds(): readonly string[];
    /** True when nothing is registered. */
    get isEmpty(): boolean;
    /**
     * Find the platform that owns a URL.
     *
     * @returns the provider, or `undefined` when no platform claims it. Throwing
     *   here would force every caller to pre-check, and the "no platform" case is
     *   an ordinary user mistake (pasting the wrong link), not a failure.
     */
    resolveFromUrl(url: string): PlatformProvider | undefined;
    /**
     * Find the platform that owns a URL, or throw with a message that names what
     * *is* supported — which is what makes a wrong paste recoverable.
     */
    requireFromUrl(url: string): PlatformProvider;
    /**
     * Parse a URL into a thread reference, using whichever platform claims it.
     *
     * The returned ref carries the provider's id, so a caller never has to look
     * the platform up a second time.
     */
    parseUrl(url: string): ThreadRef;
    /** The capability matrix for one platform, or a typed error. */
    getCapabilities(platform: string): PlatformCapabilityMatrix;
    /**
     * Build an adapter for one platform.
     *
     * @param platform the provider id
     * @param context everything the adapter may see. Deliberately narrow: no store,
     *   no model client, no publisher.
     */
    createAdapter(platform: string, context: PlatformContext): PlatformAdapter;
    /**
     * Throw unless a capability is advertised *and* proven.
     *
     * `unverified` is refused here on purpose: every write path funnels through
     * this check, and "the code exists" is not enough to send bytes to a stranger.
     *
     * ## Evidence may lift a declaration, but never edit it (v0.2.21 §三.9/.10)
     *
     * The declaration stays static — it is the ceiling, and nothing at runtime may rewrite it.
     * What a verification record can do is *satisfy* it: `evidence.effective` is computed by
     * `capability-evidence.ts` from a record that names the same platform, capability, account and
     * adapter build, and that carries complete read-back evidence. So the only way to turn
     * `unverified` into a pass here is to have actually published once and read the reply back
     * with the same build — which is exactly the requirement, expressed as code instead of as a
     * convention.
     *
     * An `evidence.effective` of anything other than `supported` is passed straight to
     * `capabilityFailure`, so `permission_required` keeps its own error type (the owner can act on
     * it) instead of being flattened into "unsupported".
     */
    assertCapability(platform: string, capability: CapabilityName, evidence?: {
        readonly effective: CapabilityState;
        readonly reason: string;
    }): void;
    /** The registry as plain JSON, for the settings and diagnostics pages. */
    diagnostics(): RegistryDiagnostics;
    /** Record a provider that could not be registered, so the page can explain it. */
    recordRejection(id: string, reason: string): void;
}
/**
 * Build the v0.2.0 registry from a list of providers.
 *
 * Tolerant on purpose: a broken provider is recorded as rejected and the rest
 * still register. One misbehaving future platform must not stop Tieba from
 * working.
 */
export declare function buildRegistry(providers: readonly PlatformProvider[]): PlatformRegistry;
/**
 * Bridge a v0.1.x adapter instance into a provider.
 *
 * This is what makes the migration incremental: the existing `TiebaAdapter` is
 * a perfectly good `PlatformAdapter` and needs no rewrite, so it is wrapped in a
 * provider and registered like any future one. Its boolean capabilities become
 * `unverified` rows rather than `supported` ones — see {@link matrixFromLegacy}.
 */
export declare function providerFromLegacy(input: {
    id: string;
    displayName: string;
    shape: PlatformProvider['shape'];
    canHandleUrl: (url: string) => boolean;
    parseUrl: (url: string) => ThreadRef;
    createAdapter: (context: PlatformContext) => PlatformAdapter;
    /** The old boolean flags, read from the adapter too when it can declare them. */
    legacyCapabilities: () => LegacyCapabilityFlags;
}): PlatformProvider;
//# sourceMappingURL=registry.d.ts.map