/**
 * Adapter selection: one adapter per platform, built from that platform's own
 * configuration and credentials.
 *
 * This module exists to close a specific hole. In v0.2.0 the registry could say
 * "this URL is Weibo" while `buildRuntime()` still handed every request a Tieba
 * adapter built once at mount. The platform was resolved correctly and then
 * ignored, which is worse than not resolving it at all: the log said one thing
 * and the network did another.
 *
 * Two properties matter and are both tested:
 *
 * 1. **Selection happens before credentials.** `adapterFor(platform)` is called
 *    with a platform id, and only then is that platform's credential requested.
 *    A Weibo adapter therefore cannot be holding a Tieba cookie, because it was
 *    never asked for one and never received one.
 * 2. **A changed configuration yields a new adapter.** Adapters hold cookie jars
 *    and caches, so a rotated credential or a changed timeout cannot be applied to
 *    a live instance. The manager keys its cache on a fingerprint of the
 *    platform-relevant settings and rebuilds when it moves.
 */
import type { PlatformAdapter } from '../types.js';
import type { PlatformRegistry } from './registry.js';
/**
 * What the manager needs from the surrounding plugin.
 *
 * Deliberately injected rather than imported: the manager must be testable
 * without a Host, and the credential lookup in particular has to be replaceable
 * so a test can prove isolation using fixtures instead of a real store.
 */
export interface AdapterManagerDeps {
    readonly registry: PlatformRegistry;
    /**
     * The platform-scoped settings for one platform.
     *
     * Must return *only* what that platform may see. Returning a shared object with
     * another platform's secrets is the exact leak this type is shaped to prevent.
     */
    settingsFor(platform: string): Readonly<Record<string, unknown>>;
    /**
     * Resolve one credential by its platform-namespaced reference.
     *
     * The manager passes the platform id alongside the reference so an
     * implementation can refuse a mismatched pair — and so a test can assert that
     * the wrong pair never happens rather than hoping it does not.
     */
    resolveCredential?: (platform: string, ref: string) => Promise<string | undefined>;
    readonly log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
    /** Cancellation for adapter construction. */
    readonly signal?: AbortSignal;
}
/**
 * The credential reference a platform may ask for.
 *
 * Defined in `./credentials.ts` and re-exported here because this is where the
 * check that uses it lives. v0.2.1 built the reference with a lossy normaliser
 * and decided ownership with `startsWith`; both were exploitable. See that
 * module's header for the analysis.
 */
export { credentialRefFor, refBelongsToPlatform, validatePlatformId } from './credentials.js';
/**
 * Owns one adapter per platform and rebuilds them when their settings move.
 *
 * Not a singleton: the plugin builds one per mount and every test builds its own,
 * so two tests in one process cannot see each other's adapters.
 */
export declare class AdapterManager {
    private readonly deps;
    private readonly cache;
    /** Platforms whose adapter construction failed, with the reason kept. */
    private readonly failures;
    constructor(deps: AdapterManagerDeps);
    /**
     * The adapter for one platform.
     *
     * @throws when no provider is registered for the platform, or the provider's
     *   factory throws. Both are configuration errors: retrying will not help, and
     *   silently falling back to another platform would be the v0.2.0 bug.
     */
    adapterFor(platform: string): PlatformAdapter;
    /** Construct one adapter through the registry. */
    private build;
    /** Drop one platform's adapter, so the next call rebuilds it. */
    invalidate(platform: string): void;
    /** Drop every adapter; used when the credential mirror settles. */
    invalidateAll(): void;
    /** Platforms with a live adapter, for diagnostics. */
    activePlatforms(): readonly string[];
    /** Construction failures, so the health page can explain a missing platform. */
    failureReport(): readonly {
        readonly platform: string;
        readonly reason: string;
    }[];
}
//# sourceMappingURL=adapter-manager.d.ts.map