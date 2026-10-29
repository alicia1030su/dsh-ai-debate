/**
 * The Weibo provider: link routing, capability declaration, adapter construction.
 *
 * ## What changed in v0.2.12
 *
 * v0.2.11 shipped a CLI layer (`cli.ts`) that nothing called, and an adapter whose every
 * read threw. Installing the CLI and logging in would have changed nothing, because there
 * was no code path from the probe to `getThread`.
 *
 * v0.2.12 wires them together: the adapter resolves a **read plan** by probing the CLI,
 * discovering the catalog, and validating each candidate command's required parameters
 * before deciding whether a read may run. The projection from Weibo's payloads to
 * `Thread`/`Floor`/`NestedReply` lives in `projection.ts` so it is testable without a CLI.
 *
 * ## What is still claimed and what is not
 *
 * - A read that has never run is **not** `supported`. It is `unverified` at best: the code
 *   exists, no real account proved it.
 * - A command is only used after `inspectCommand` confirms we can fill its required
 *   parameters. A name that matches a regex is a *candidate*, not a permission.
 * - `publishReply` always throws. There is no Weibo write path in this build; the platform
 *   requires an explicit AI-content label plus a write scope this plugin does not request.
 * - Nothing here buys credit, runs a face scan, or starts an OAuth flow. Those need a human.
 */
import type { PlatformProvider } from '../contracts.js';
/** The error every unimplemented read throws. Named so callers can branch on it. */
export declare class WeiboNotAuthorisedError extends Error {
    readonly code = "weibo_not_authorised";
    constructor(what: string);
}
/**
 * A CLI-backed read failed, with the reason preserved.
 *
 * ## Why this is a separate error class from `WeiboNotAuthorisedError` (v0.2.12)
 *
 * v0.2.11 threw `weibo_not_authorised` for everything, including "the CLI is not
 * installed". Those two states need different actions from the owner — install a tool
 * versus obtain a grant — and collapsing them meant the actionable one was hidden behind
 * a message that said "go get authorisation" when no authorisation would help.
 *
 * The `code` is the CLI's own status, so a caller can branch without parsing prose.
 */
export declare class WeiboCliError extends Error {
    readonly code: string;
    /** The next steps for the owner, when this failure has a known remedy. */
    readonly steps: readonly string[];
    constructor(status: string, message: string, steps?: readonly string[]);
}
/** Thrown when the account is authorised but lacks the specific read command. */
export declare class WeiboCommandUnavailableError extends Error {
    readonly code = "command_unavailable";
    constructor(message: string);
}
/** The provider the registry holds. */
export declare const weiboProvider: PlatformProvider;
//# sourceMappingURL=provider.d.ts.map