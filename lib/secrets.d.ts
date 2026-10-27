/**
 * The credential seam: where Cookie and API key actually live.
 *
 * Why not the config schema: a Cordis patch is plain YAML on disk, and the
 * profile file is the one thing users paste into issues, screenshot and sync.
 * A `.role('secret')` field keeps the value out of the *wire*, but it is still
 * in the patch. The Host's own credential store (`ctx.credentials`) is the
 * place designed for exactly this: values never enter a config document, never
 * enter the browser, and can be rotated without editing YAML.
 *
 * Two facts shape this module:
 *
 * 1. `ctx.credentials` is **async**, while `resolveConfig` is sync and the
 *    adapter is built synchronously at mount. So the credential values are
 *    mirrored into a small in-memory overlay that `resolveConfig` reads
 *    synchronously, and the overlay is refreshed on mount and on every
 *    `credentials/reference-updated` event.
 * 2. A deployment may have **no** credential service at all (headless CLI, a
 *    stripped composition). Then the overlay stays empty, the legacy config
 *    fields keep working, and nothing throws — a plugin that refuses to mount
 *    because an optional service is missing is worse than one without the
 *    feature.
 *
 * Backward compatibility: v0.1.5 users have `tiebaCookie` / `llmApiKey` in
 * their patch. Those still resolve. But once a value is stored in the
 * credential store it wins, and the plugin reports the config copy as
 * superseded rather than silently ignoring it.
 */
/**
 * Credential reference names. POSIX-identifier shaped, as the seam requires.
 *
 * The platform-scoped one is *derived* from the platform id rather than written
 * out, so the namespace rule (`DSH_AI_DEBATE_<PLATFORM>_<WHAT>`) is a fact about
 * the code rather than a convention in a comment. `COOKIE_REF` keeps its literal
 * for backward compatibility with profiles that already have that exact name
 * stored; the derivation is asserted to agree with it in the tests.
 */
export declare const COOKIE_REF = "DSH_AI_DEBATE_TIEBA_COOKIE";
export declare const LLM_KEY_REF = "DSH_AI_DEBATE_LLM_API_KEY";
/**
 * Build the credential reference for one platform's secret.
 *
 * Any platform may ask for `credentialRefFor('weibo', 'TOKEN')`; the adapter
 * manager refuses to resolve a reference outside the asking platform's prefix, so
 * the derivation is what puts the boundary in reach of an actual check.
 */
export declare function credentialRefFor(platform: string, what: string): string;
/** True when a reference belongs to the given platform's namespace. */
export declare function refBelongsToPlatform(ref: string, platform: string): boolean;
/** Every reference this plugin owns, in display order. */
export declare const SECRET_REFS: readonly SecretRefName[];
/** The reference names this plugin owns. */
export type SecretRefName = typeof COOKIE_REF | typeof LLM_KEY_REF;
/** Human-facing label and hint for each reference. */
export declare const SECRET_LABELS: Readonly<Record<SecretRefName, {
    label: string;
    hint: string;
    configField: string;
}>>;
/** What `describe()` answers for one reference, plus our own overlay state. */
export interface SecretStatus {
    /** The reference this row describes. */
    readonly ref: SecretRefName;
    /** Whether a value exists in *any* layer (credential store, config fallback, env). */
    readonly configured: boolean;
    /** Where the resolved value comes from: `store`, `config`, `environment`. */
    readonly source?: string;
    /** Whether the credential store itself can be written in this deployment. */
    readonly writable: boolean;
    /** True when a legacy config value exists but the store value wins. */
    readonly configSuperseded: boolean;
    /** True when the store holds nothing and only the config fallback applies. */
    readonly fromConfigFallback: boolean;
    /** Length of the stored value, never the value. 0 when unconfigured. */
    readonly length: number;
    /** A short masked preview, e.g. `…a1b2` — the last four characters only. */
    readonly tail?: string;
}
/**
 * The credential operations this plugin needs, declared structurally.
 *
 * Same reason as `host.ts`: the package must compile and pack without pinning a
 * Harness build, and the seam's own type exports have moved between releases.
 * Anything not declared here is not called.
 */
export interface CredentialSeam {
    describe(ref: string): Promise<{
        configured: boolean;
        source?: string;
        writable: boolean;
    }>;
    resolve(ref: string): Promise<{
        value: string;
        source: string;
    } | undefined>;
    set(ref: string, value: string): Promise<void>;
    unset(ref: string): Promise<void>;
}
/** The synchronous overlay `resolveConfig` reads. */
export interface SecretOverlay {
    readonly cookie: string;
    readonly llmApiKey: string;
    /** Which refs came from the store (as opposed to config fallback). */
    readonly stored: ReadonlySet<SecretRefName>;
}
/** An empty overlay: no stored values, config fallbacks apply. */
export declare const EMPTY_OVERLAY: SecretOverlay;
/** Read the overlay value for a reference. */
export declare function overlayValue(overlay: SecretOverlay, ref: SecretRefName): string;
/** Replace one reference in an overlay, returning a new overlay. */
export declare function withOverlayValue(overlay: SecretOverlay, ref: SecretRefName, value: string): SecretOverlay;
/**
 * A masked tail for recognition only.
 *
 * Four characters is enough for a person to tell "the key I pasted yesterday"
 * from "a stale one", and short enough that leaking it to a screenshot or a
 * support thread is not a credential disclosure. Values shorter than eight
 * characters return no tail at all — masking four of six characters is not a
 * mask.
 */
export declare function maskedTail(value: string): string | undefined;
/**
 * Refresh the overlay from the credential store.
 *
 * @param seam the credential service, or undefined when the deployment has none
 * @returns the overlay to install, and per-reference diagnostics for the UI
 */
export declare function loadOverlay(seam: CredentialSeam | undefined): Promise<{
    overlay: SecretOverlay;
    statuses: readonly SecretStatus[];
    error?: string;
    /** References the store reports as configured whose value did not resolve. */
    unresolved?: readonly SecretRefName[];
    /** True when no reference produced a value; see the retry note at the tail. */
    empty: boolean;
}>;
/**
 * Describe every reference for the settings page.
 *
 * @param seam the credential service, or undefined
 * @param overlay the overlay currently in force (for the config-fallback check)
 * @param configValue reads the legacy config field for one reference
 */
export declare function describeSecrets(seam: CredentialSeam | undefined, overlay: SecretOverlay, configValue: (ref: SecretRefName) => string): Promise<readonly SecretStatus[]>;
/**
 * Store one secret.
 *
 * @param seam the credential service (required — a caller without one must not
 *   pretend the value was saved)
 * @param ref which reference
 * @param value the non-empty secret
 * @throws when the seam is absent or rejects the write
 */
export declare function storeSecret(seam: CredentialSeam | undefined, ref: SecretRefName, value: string): Promise<void>;
/**
 * Remove one stored secret.
 *
 * @param seam the credential service
 * @param ref which reference
 * @returns whether the deployment could clear it
 */
export declare function clearSecret(seam: CredentialSeam | undefined, ref: SecretRefName): Promise<{
    cleared: boolean;
    note?: string;
}>;
/**
 * Locate the credential service on a Host context.
 *
 * A loose `get` on purpose: a strict one misses in early-activating or headless
 * mounts, and `credentials` is not in this plugin's `inject` list, so it is
 * genuinely optional.
 */
export declare function findCredentialSeam(ctx: {
    get?: (name: string, strict?: boolean) => unknown;
}): CredentialSeam | undefined;
//# sourceMappingURL=secrets.d.ts.map