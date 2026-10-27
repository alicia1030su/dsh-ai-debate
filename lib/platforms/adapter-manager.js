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
/**
 * The credential reference a platform may ask for.
 *
 * Every platform's secrets live under `DSH_AI_DEBATE_<PLATFORM>_<WHAT>`, so a
 * reference is *derivable* from the platform id rather than being a free string.
 * That is what makes "a provider cannot read another platform's credential" a
 * property of the code instead of a convention.
 */
export function credentialRefFor(platform, what) {
    return `DSH_AI_DEBATE_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${what.toUpperCase()}`;
}
/** True when a reference belongs to the given platform's namespace. */
export function refBelongsToPlatform(ref, platform) {
    const prefix = `DSH_AI_DEBATE_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
    return ref.startsWith(prefix);
}
/** Stable fingerprint of a settings object: sorted keys, JSON-encoded values. */
function fingerprintOf(settings) {
    const keys = Object.keys(settings).sort();
    const parts = [];
    for (const key of keys) {
        const value = settings[key];
        // A function or a symbol in settings would make this unstable; there are none
        // today, and encoding them as a marker keeps that from silently changing.
        const encoded = typeof value === 'string'
            ? `s:${value}`
            : typeof value === 'number' || typeof value === 'boolean' || value === null
                ? `p:${String(value)}`
                : value === undefined
                    ? 'u:'
                    : `j:${JSON.stringify(value)}`;
        parts.push(`${key}=${encoded}`);
    }
    return parts.join('\u0000');
}
/**
 * Owns one adapter per platform and rebuilds them when their settings move.
 *
 * Not a singleton: the plugin builds one per mount and every test builds its own,
 * so two tests in one process cannot see each other's adapters.
 */
export class AdapterManager {
    deps;
    cache = new Map();
    /** Platforms whose adapter construction failed, with the reason kept. */
    failures = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * The adapter for one platform.
     *
     * @throws when no provider is registered for the platform, or the provider's
     *   factory throws. Both are configuration errors: retrying will not help, and
     *   silently falling back to another platform would be the v0.2.0 bug.
     */
    adapterFor(platform) {
        const settings = this.deps.settingsFor(platform);
        const fingerprint = fingerprintOf(settings);
        const cached = this.cache.get(platform);
        if (cached !== undefined && cached.fingerprint === fingerprint)
            return cached.adapter;
        // A rebuilt adapter replaces the old one; the old cookie jar is dropped with
        // it, which is the point of rebuilding rather than mutating.
        if (cached !== undefined) {
            this.deps.log?.('info', `平台「${platform}」的配置已变化，正在重建适配器`);
        }
        try {
            const adapter = this.build(platform, settings);
            this.cache.set(platform, { adapter, fingerprint });
            this.failures.delete(platform);
            return adapter;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Keep the failure so diagnostics can explain it, but do NOT keep a stale
            // adapter: serving the previous instance after a failed rebuild would use
            // credentials the user just changed.
            this.cache.delete(platform);
            this.failures.set(platform, message);
            throw error;
        }
    }
    /** Construct one adapter through the registry. */
    build(platform, settings) {
        const provider = this.deps.registry.require(platform);
        return provider.createAdapter({
            settings,
            // The credential closure is scoped to this platform. A provider that asks
            // for a reference outside its namespace gets `undefined` and an error log,
            // rather than another platform's secret.
            ...(this.deps.resolveCredential === undefined
                ? {}
                : {
                    resolveCredential: async (ref) => {
                        const resolver = this.deps.resolveCredential;
                        if (resolver === undefined)
                            return undefined;
                        if (!refBelongsToPlatform(ref, platform)) {
                            throw new Error(`平台「${platform}」不能读取凭据「${ref}」：该凭据属于其他平台的命名空间`);
                        }
                        return resolver(platform, ref);
                    },
                }),
            ...(this.deps.log === undefined ? {} : { log: this.deps.log }),
            ...(this.deps.signal === undefined ? {} : { signal: this.deps.signal }),
        });
    }
    /** Drop one platform's adapter, so the next call rebuilds it. */
    invalidate(platform) {
        this.cache.delete(platform);
    }
    /** Drop every adapter; used when the credential mirror settles. */
    invalidateAll() {
        this.cache.clear();
    }
    /** Platforms with a live adapter, for diagnostics. */
    activePlatforms() {
        return [...this.cache.keys()].sort();
    }
    /** Construction failures, so the health page can explain a missing platform. */
    failureReport() {
        return [...this.failures.entries()].map(([platform, reason]) => ({ platform, reason }));
    }
}
//# sourceMappingURL=adapter-manager.js.map