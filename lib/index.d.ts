/**
 * dsh-ai-debate — AI代吵架.
 *
 * Entry point. Responsibilities, in order of importance:
 *
 * 1. Register the nine tools inside an `effect`, so unloading the plugin
 *    removes them and leaves no half-mounted state.
 * 2. Build the runtime eagerly but cheaply: constructing the store does no
 *    disk I/O (the first `ready()` does), so mount stays fast while every tool
 *    gets a fully-formed runtime synchronously.
 * 3. Add a system-prompt section telling the agent the tools exist and when to
 *    reach for them — without it an agent has no reason to use them.
 * 4. On dispose, drop the registrations and release the runtime. Persisted
 *    state is already committed per mutation, so there is nothing to flush.
 */
import { Config, DEFAULT_CONFIG, resolveConfig } from './config.js';
import { loggerOf, type PluginContext } from './host.js';
import { DebateStore } from './store.js';
import { type Runtime } from './runtime.js';
import { PlatformRegistry } from './platforms/registry.js';
/** Stable Loader identity; matches the row id in `cordis.patch.yml`. */
export declare const name = "dsh-ai-debate";
/** Services required before the tools can mount. */
export declare const inject: string[];
/** Re-export the config schema so the Host can render settings. */
export { Config, DEFAULT_CONFIG, resolveConfig };
/** What the agent is told about this plugin. */
export declare const DEBATE_GUIDANCE: string;
/**
 * Resolve the state directory from config, creating it.
 *
 * Delegates to {@link resolveStoreDirStrict}, which prefers an explicit `storeDir`,
 * then a host-provided directory, then `DSH_HOME`, then the historical default. The
 * v0.2.23 code used `homedir()` unconditionally, so an isolated `DSH_HOME` still wrote
 * into the real `~/.dsh` — the bug this indirection removes.
 *
 * `get` is the plugin context's service lookup, passed in so the host-probe can run
 * without this function depending on the whole context.
 */
export declare function resolveStoreDir(config: ReturnType<typeof resolveConfig>, get?: ((name: string) => unknown) | undefined): string;
/**
 * Build the runtime synchronously; disk reads happen on first use.
 *
 * Multi-platform: no adapter is constructed here. `PlatformRuntime.adapterFor`
 * builds one per platform on demand, from that platform's own settings and
 * credentials, so the platform a URL resolves to is the platform whose adapter
 * actually reads and publishes.
 *
 * @param registry the platform registry
 * @param resolveSettings per-platform settings (may default to the whole config)
 */
export declare function buildRuntime(resolve: () => ReturnType<typeof resolveConfig>, log: ReturnType<typeof loggerOf>, registry: PlatformRegistry, resolveSettings?: (config: ReturnType<typeof resolveConfig>, platform: string) => Readonly<Record<string, unknown>>, options?: {
    /**
     * Platform-scoped credential lookup.
     *
     * Passed in rather than read here because the credential mirror belongs to the
     * mounted plugin instance. The manager wraps it so a provider can only reach
     * its own namespace.
     */
    resolveCredential?: (platform: string, ref: string) => Promise<string | undefined>;
    /** 宿主的模型服务；宿主没提供时省略（v0.2.36）。 */
    hostLlm?: import('./host-llm.js').HostLlmLike;
    /** 出网守卫；省略时不做限制（测试与旧调用方，v0.2.36）。 */
    egress?: import('./net-audit.js').EgressGuard;
    /**
     * Share an existing store instead of opening the file again.
     *
     * ## Why this exists (v0.2.7)
     *
     * `buildRuntime` is called on every config or credential change, and each call
     * used to construct its own `DebateStore`. Two objects then pointed at the same
     * `state.json` and each held a private copy of the document, so whichever wrote
     * second overwrote whatever the first had added — including `confirmed` dedupe
     * rows (the double-post guard) and approval records (the publish authorisation).
     *
     * The single-writer rule fixes that at the source: within one process there is
     * exactly one store per directory, and a rebuild hands the new runtime the
     * existing instance. Cross-process writers are handled separately by the
     * advisory lock in `mutate`.
     */
    store?: DebateStore;
}): Runtime;
/**
 * Mount the plugin.
 *
 * @param ctx the Host plugin context
 * @param config raw plugin config; volatile fields arrive as references
 * @returns the disposer that unmounts everything
 */
export declare function apply(ctx: PluginContext, config?: unknown): () => void;
//# sourceMappingURL=index.d.ts.map