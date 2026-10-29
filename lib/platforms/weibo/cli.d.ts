/**
 * Weibo official CLI: read-only adapter layer.
 *
 * ## What this file is, and is not
 *
 * It wraps the **official** `weibo-cli` (`@weibo-ai/weibo-cli`) so the plugin can ask
 * "read this post and its comments" without encoding any HTTP knowledge of Weibo's
 * APIs. Everything it knows about the CLI comes from the official manual at
 * <https://open.weibo.com/cli/quickstart> and from `weibo-cli commands list/show` — the
 * two sources the manual itself tells you to use for discovery.
 *
 * It is **not** a stand-in for authorisation. The CLI requires a developer
 * qualification (face scan in the Weibo client), an activated service (free 7-day trial
 * or a paid credit pack), and an OAuth login binding this machine to an account. None of
 * that is something code can supply, and this module never pretends otherwise: every
 * read path answers `cli_missing` / `not_authenticated` / `service_inactive` /
 * `quota_exhausted` as distinct, actionable states rather than an empty list.
 *
 * ## Command injection
 *
 * Every invocation goes through `execFile` with an **argument array** — never a shell
 * string. A mid, a URL, a screen name or a comment body can contain anything; the only
 * values this module ever interpolates are ids it has already validated as
 * `[0-9A-Za-z]`, and even those go in as separate argv entries. There is no `shell: true`
 * anywhere, and no string concatenation into a command line.
 *
 * ## Token handling
 *
 * The CLI keeps its own OAuth session on disk; this module never reads it. It does not
 * pass tokens on the command line, does not print them, and scrubs anything that looks
 * like a bearer token or an OAuth code out of error output before it reaches an error
 * message that could end up in a log or in the model's context.
 */
/**
 * The states a CLI-backed read can be in.
 *
 * Each one exists because it needs a *different* message to the owner. Collapsing them
 * into "failed" is what makes a missing install look like a network problem.
 */
export type WeiboCliStatus = 'ok'
/** The `weibo-cli` executable was not found on PATH. */
 | 'cli_missing'
/** Installed, but no OAuth login bound to this machine. */
 | 'not_authenticated'
/** Logged in, but developer qualification or service activation is missing. */
 | 'service_inactive'
/** Credit/trial quota exhausted, or the per-interface free allowance is used up. */
 | 'quota_exhausted'
/** The command is not in this account's available command list. */
 | 'command_unavailable'
/** The CLI ran and failed for some other reason (rate limit, upstream error, timeout). */
 | 'failed';
/** One probe result: what we can actually do right now. */
export interface WeiboCliReadiness {
    readonly status: WeiboCliStatus;
    /** Human-readable, already safe to show and to log. */
    readonly message: string;
    /** Present when the CLI answered `version`. */
    readonly version?: string;
    /** True only when a real read could be attempted. */
    readonly canRead: boolean;
    /**
     * The exact next step for the owner, when one is needed.
     *
     * Kept separate from `message` so the settings page can show "what you must do" as a
     * list of steps rather than one long sentence.
     */
    readonly steps: readonly string[];
}
/** One JSON payload the CLI printed. */
export interface WeiboCliCall<T> {
    readonly status: WeiboCliStatus;
    readonly message: string;
    /** Parsed stdout, only present when `status === 'ok'`. */
    readonly data?: T;
    /** Whether this call consumed quota, when the CLI said so. */
    readonly billed?: boolean;
}
/**
 * Anything that looks like a credential, removed from text we might show.
 *
 * The CLI's own manual warns against putting tokens in logs; the same rule applies to
 * its stderr, which can echo request headers on failure. Scrubbing here means a future
 * caller cannot accidentally forward one.
 */
export declare function scrubCredentials(text: string): string;
/**
 * Parse one JSON document out of CLI output.
 *
 * The CLI prints JSON when asked (`--output json`); some commands may precede it with a
 * progress line, so this takes the first `{`…last `}` span rather than assuming the whole
 * stdout is the document. A payload that does not parse is a hard failure — returning a
 * partial object would let a caller treat "unreadable" as "empty".
 */
export declare function parseCliJson<T>(stdout: string): {
    ok: true;
    data: T;
} | {
    ok: false;
    reason: string;
};
/**
 * Probe what this machine can actually do, without spending quota.
 *
 * Runs `version` and `doctor`, both of which the manual describes as local checks. The
 * result is the input to the capability matrix: a deployment where this says
 * `cli_missing` must not advertise any read as `supported`.
 */
export declare function probeWeiboCli(): Promise<WeiboCliReadiness>;
/** One row of `commands list --available`. */
export interface WeiboCliCommand {
    readonly name: string;
    readonly description?: string;
    readonly priceType?: string;
}
/**
 * The account's available command list.
 *
 * This is the only authority on "what can I call". Nothing in this module hard-codes a
 * command name for a *read*: the manual gives `commands list` / `commands show` as the
 * discovery mechanism, and inventing an endpoint path from memory is exactly what the
 * task book forbids.
 */
export declare function listAvailableCommands(): Promise<WeiboCliCall<readonly WeiboCliCommand[]>>;
/**
 * Whether the available list contains a read command we could use.
 *
 * Used to decide capability states. Deliberately matches on family words the manual uses
 * rather than on an exact string this file invented — the catalog's exact spelling comes
 * from the server, so we look for the *shape* of a status/comment read and let the owner
 * see the raw list if nothing matches.
 */
export declare function classifyCommands(commands: readonly WeiboCliCommand[]): {
    readonly statuses: boolean;
    readonly comments: boolean;
};
//# sourceMappingURL=cli.d.ts.map