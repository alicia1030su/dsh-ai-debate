/**
 * The host-half probes and diagnostics the settings page calls.
 *
 * Everything here is a *read*: `testModel` sends one tiny completion and counts
 * the round trip, `checkLogin` reads the account page, `previewPersonas` renders
 * the persona prompts locally without calling the model at all. None of them
 * publish, none of them touch the store's session list, and none of them return
 * a credential value.
 *
 * That restraint is the whole point of the module. A settings page with a
 * "test connection" button is a settings page that can be pressed carelessly, so
 * every probe is cheap, idempotent and unable to change the world beyond its own
 * network read.
 */
import type { ResolvedConfig } from './config.js';
import type { Diagnostics, LoginProbe, ModelProbe, PersonaPreview } from './settings-routes.js';
import type { Runtime } from './runtime.js';
/**
 * Plugin version, mirrored into the diagnostics panel.
 *
 * Read from the package manifest rather than typed here. The literal had drifted
 * — it still said 0.1.6 while the package was 0.1.8 — so the diagnostics panel
 * was confidently reporting a version that did not exist. Deriving it removes
 * the whole class of mistake; `test/version.test.ts` pins the result so a
 * packaging change that breaks the lookup fails loudly instead of silently
 * falling back.
 */
export declare const PLUGIN_VERSION: string;
/** The fixed exchange the persona preview renders against. */
declare const PREVIEW_EXCHANGE: {
    readonly opponent: "你这说法根本站不住脚，别拿个例当规律。";
    readonly claim: "对方用一个例子否定整体结论，忽略了样本本身不具代表性。";
};
/**
 * Render all four personas against the fixed exchange.
 *
 * Deliberately local: the preview exists so a user can compare *prompt shapes*
 * and register differences before spending tokens, and so a deployment with no
 * model configured still shows something true. The `sample` is the persona's own
 * calibration line, which is what generation is steered toward; the prompt shape
 * is the actual text the model receives, trimmed to its structure.
 */
export declare function previewPersonas(config: ResolvedConfig): Promise<readonly PersonaPreview[]>;
/**
 * Probe the configured model endpoint.
 *
 * One short completion with a token cap, so a misconfigured endpoint costs a few
 * hundred tokens rather than a full draft. A failure is reported as data, not
 * thrown: the page needs to show *why* it failed, and "the button did nothing"
 * is the outcome this exists to prevent.
 */
export declare function testModel(runtime: Runtime, config: ResolvedConfig): Promise<ModelProbe>;
/**
 * Probe the Tieba login state through the adapter.
 *
 * The adapter owns the cookie jar, so this is the only honest way to answer
 * "am I logged in": it makes the same request a real publish would, and reports
 * the account the platform says is logged in. A `ok: false` here is not a
 * failure of the *plugin* — an unauthenticated state still allows public reads —
 * so the message says what still works.
 */
export declare function checkLogin(runtime: Runtime): Promise<LoginProbe>;
/**
 * Assemble the diagnostics block.
 *
 * Counts come from the store snapshot and the publish ledger, which are the two
 * durable records. `recentErrors` reads the usage log's failed rows rather than a
 * separate error log, because that is where every failure already lands — keeping
 * a second list would guarantee the two disagree.
 */
export declare function collectDiagnostics(runtime: Runtime, config: ResolvedConfig, options?: {
    dshVersion?: string;
    rateLimited?: boolean;
}): Promise<Diagnostics>;
/** The fixed exchange the persona preview is written against. */
export { PREVIEW_EXCHANGE };
//# sourceMappingURL=diagnostics.d.ts.map