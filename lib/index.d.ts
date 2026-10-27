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
/** Resolve the state directory from config, creating it. */
export declare function resolveStoreDir(config: ReturnType<typeof resolveConfig>): string;
/**
 * Build the runtime synchronously; disk reads happen on first use.
 *
 * @param registry the platform registry. Every adapter is built through it, so
 *   this function no longer names a concrete platform class.
 */
export declare function buildRuntime(resolve: () => ReturnType<typeof resolveConfig>, log: ReturnType<typeof loggerOf>, registry: PlatformRegistry): Runtime;
/**
 * Mount the plugin.
 *
 * @param ctx the Host plugin context
 * @param config raw plugin config; volatile fields arrive as references
 * @returns the disposer that unmounts everything
 */
export declare function apply(ctx: PluginContext, config?: unknown): () => void;
//# sourceMappingURL=index.d.ts.map