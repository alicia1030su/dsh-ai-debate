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
import { capabilityFailure, matrixFromLegacy, stateOf, } from './contracts.js';
/** Raised when a URL belongs to no registered platform. */
export class UnknownPlatformUrlError extends Error {
    url;
    knownPlatforms;
    constructor(url, knownPlatforms) {
        super(`无法识别这个链接属于哪个平台：${url}` +
            (knownPlatforms.length > 0
                ? `。当前已接入：${knownPlatforms.join('、')}`
                : '。当前没有注册任何平台'));
        this.name = 'UnknownPlatformUrlError';
        this.url = url;
        this.knownPlatforms = knownPlatforms;
    }
}
/** Raised when an id is looked up and no provider holds it. */
export class PlatformNotRegisteredError extends Error {
    platform;
    knownPlatforms;
    constructor(platform, knownPlatforms) {
        super(`平台「${platform}」没有注册` +
            (knownPlatforms.length > 0 ? `。已注册：${knownPlatforms.join('、')}` : ''));
        this.name = 'PlatformNotRegisteredError';
        this.platform = platform;
        this.knownPlatforms = knownPlatforms;
    }
}
/**
 * The registry.
 *
 * Not a singleton: tests build their own with fake platforms, and the plugin
 * builds one per mount. A module-level global would make two tests in one
 * process see each other's fakes.
 */
export class PlatformRegistry {
    providers = new Map();
    order = [];
    rejected = [];
    /**
     * Register a provider.
     *
     * Refuses duplicates instead of overwriting: a silent overwrite is how the
     * wrong platform ends up handling a URL, and there is no way to notice it from
     * the outside.
     *
     * @returns a disposer that unregisters this exact provider
     */
    register(provider) {
        const id = provider.id;
        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new Error('平台 id 不能为空');
        }
        if (this.providers.has(id)) {
            throw new Error(`平台「${id}」已经注册过了；注册相同的 id 会静默替换处理器`);
        }
        if (typeof provider.canHandleUrl !== 'function' || typeof provider.parseUrl !== 'function') {
            throw new Error(`平台「${id}」必须实现 canHandleUrl/parseUrl`);
        }
        if (typeof provider.createAdapter !== 'function') {
            throw new Error(`平台「${id}」必须实现 createAdapter`);
        }
        this.providers.set(id, provider);
        this.order.push(id);
        return () => {
            this.unregister(id);
        };
    }
    /**
     * Remove a provider.
     *
     * @returns true when something was removed. Idempotent, because a disposer may
     *   run twice when a mount fails halfway.
     */
    unregister(id) {
        if (!this.providers.delete(id))
            return false;
        const at = this.order.indexOf(id);
        if (at >= 0)
            this.order.splice(at, 1);
        return true;
    }
    /** Look a provider up by id. */
    get(id) {
        return this.providers.get(id);
    }
    /** Look a provider up by id, throwing a typed error when absent. */
    require(id) {
        const found = this.providers.get(id);
        if (found === undefined)
            throw new PlatformNotRegisteredError(id, this.listIds());
        return found;
    }
    /** Every provider, in resolution order. */
    list() {
        return this.order
            .map((id) => this.providers.get(id))
            .filter((entry) => entry !== undefined);
    }
    /** Every registered id, in resolution order. */
    listIds() {
        return [...this.order];
    }
    /** True when nothing is registered. */
    get isEmpty() {
        return this.providers.size === 0;
    }
    /**
     * Find the platform that owns a URL.
     *
     * @returns the provider, or `undefined` when no platform claims it. Throwing
     *   here would force every caller to pre-check, and the "no platform" case is
     *   an ordinary user mistake (pasting the wrong link), not a failure.
     */
    resolveFromUrl(url) {
        if (typeof url !== 'string' || url.trim().length === 0)
            return undefined;
        for (const id of this.order) {
            const provider = this.providers.get(id);
            if (provider === undefined)
                continue;
            // A provider that throws on a URL it does not own must not take down the
            // whole resolution: the next provider still gets its turn.
            try {
                if (provider.canHandleUrl(url))
                    return provider;
            }
            catch {
                continue;
            }
        }
        return undefined;
    }
    /**
     * Find the platform that owns a URL, or throw with a message that names what
     * *is* supported — which is what makes a wrong paste recoverable.
     */
    requireFromUrl(url) {
        const found = this.resolveFromUrl(url);
        if (found === undefined)
            throw new UnknownPlatformUrlError(url, this.listIds());
        return found;
    }
    /**
     * Parse a URL into a thread reference, using whichever platform claims it.
     *
     * The returned ref carries the provider's id, so a caller never has to look
     * the platform up a second time.
     */
    parseUrl(url) {
        return this.requireFromUrl(url).parseUrl(url);
    }
    /** The capability matrix for one platform, or a typed error. */
    getCapabilities(platform) {
        return this.require(platform).describeCapabilities();
    }
    /**
     * Build an adapter for one platform.
     *
     * @param platform the provider id
     * @param context everything the adapter may see. Deliberately narrow: no store,
     *   no model client, no publisher.
     */
    createAdapter(platform, context) {
        return this.require(platform).createAdapter(context);
    }
    /**
     * Throw unless a capability is advertised *and* proven.
     *
     * `unverified` is refused here on purpose: every write path funnels through
     * this check, and "the code exists" is not enough to send bytes to a stranger.
     */
    assertCapability(platform, capability) {
        const matrix = this.getCapabilities(platform);
        const declaration = stateOf(matrix, capability);
        if (declaration.state === 'supported')
            return;
        throw capabilityFailure(platform, capability, declaration);
    }
    /** The registry as plain JSON, for the settings and diagnostics pages. */
    diagnostics() {
        return {
            platforms: this.list().map((provider, index) => ({
                id: provider.id,
                displayName: provider.displayName,
                shape: provider.shape,
                order: index,
                capabilities: provider.describeCapabilities(),
            })),
            rejected: [...this.rejected],
        };
    }
    /** Record a provider that could not be registered, so the page can explain it. */
    recordRejection(id, reason) {
        this.rejected.push({ id, reason });
    }
}
/**
 * Build the v0.2.0 registry from a list of providers.
 *
 * Tolerant on purpose: a broken provider is recorded as rejected and the rest
 * still register. One misbehaving future platform must not stop Tieba from
 * working.
 */
export function buildRegistry(providers) {
    const registry = new PlatformRegistry();
    for (const provider of providers) {
        try {
            registry.register(provider);
        }
        catch (error) {
            const id = typeof provider?.id === 'string' ? provider.id : '(unknown)';
            registry.recordRejection(id, error.message);
        }
    }
    return registry;
}
/**
 * Bridge a v0.1.x adapter instance into a provider.
 *
 * This is what makes the migration incremental: the existing `TiebaAdapter` is
 * a perfectly good `PlatformAdapter` and needs no rewrite, so it is wrapped in a
 * provider and registered like any future one. Its boolean capabilities become
 * `unverified` rows rather than `supported` ones — see {@link matrixFromLegacy}.
 */
export function providerFromLegacy(input) {
    return {
        id: input.id,
        displayName: input.displayName,
        shape: input.shape,
        canHandleUrl: input.canHandleUrl,
        parseUrl: input.parseUrl,
        describeCapabilities: () => matrixFromLegacy(input.id, input.legacyCapabilities()),
        createAdapter: input.createAdapter,
    };
}
//# sourceMappingURL=registry.js.map