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
 * How one CLI invocation is spawned.
 *
 * ## Why this is a mutable module-level value (v0.2.12)
 *
 * Production **must** invoke exactly `weibo-cli` — a configurable binary is an attack
 * surface, because whatever can set it can point it at any program on the machine.
 *
 * But a test has to run the whole command pipeline without the real CLI installed. The
 * two needs are met by keeping the default hardcoded and exposing the override under a
 * `__`-prefixed name that only this project's tests call. No setting, no environment
 * variable, no config field reaches this: the only way to change it is to import the
 * module and call the function.
 */
interface CliInvocation {
    readonly file: string;
    readonly prefixArgs: readonly string[];
}
/**
 * Point the CLI layer at a stand-in executable. **Tests only.**
 *
 * Call with `undefined` to restore the hardcoded `weibo-cli`. Deliberately not exported
 * from the package index, so a plugin consumer cannot reach it through configuration.
 */
export declare function __setCliInvocation(next: CliInvocation | undefined): void;
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
 * ## Why this is only a *candidate* filter (v0.2.12)
 *
 * The task book is explicit: matching a command *name* with a regex does not establish
 * that the account can call it, and it certainly does not establish that its argument
 * shape matches what we would send. A catalog entry named `statuses/show` could require a
 * parameter this file does not know about, or be listed while the entitlement behind it is
 * inactive.
 *
 * So this function answers "which entries *look like* a status read or a comment read",
 * and {@link inspectCommand} must confirm the argument shape before anything is invoked.
 * `classifyCommands` alone must never be used to advertise a capability.
 */
export declare function classifyCommands(commands: readonly WeiboCliCommand[]): {
    readonly statuses: boolean;
    readonly comments: boolean;
};
/** What one command's own schema says it accepts. */
export interface WeiboCliCommandSchema {
    readonly name: string;
    /** Parameter names the command accepts, lowercased. */
    readonly parameters: readonly string[];
    /** Which of them the catalog marks as required. */
    readonly required: readonly string[];
    /**
     * Whether the parameter list was actually parsed, or the response shape was unrecognised.
     *
     * `unknown` must never be treated as "no required parameters": a schema we could not read is
     * a schema we have not verified, which is the opposite of what `usable` is for.
     */
    readonly evidence: 'parsed' | 'unknown';
    /**
     * The flag this CLI uses to scope a comment read to one parent comment, when the catalog
     * lists one. Absent means "we never learned how", and a nested read must then refuse rather
     * than invent a flag name.
     */
    readonly nestedFilterFlag?: string;
    /** True when every required parameter is one this layer can actually supply. */
    readonly usable: boolean;
    /** Why it is not usable, when it is not. */
    readonly reason?: string;
}
/** What the caller knows when it asks "can I build a valid invocation?". */
export interface ReadArgContext {
    /** Whether this read pages at all. */
    readonly paged: boolean;
    /** The page number for this read; ignored when `paged` is false. */
    readonly page: number;
    /**
     * The flag this CLI uses to scope a comment read to one parent comment, once discovered.
     *
     * Absent means "we never learned how to ask for nested replies", and a call that needs it
     * must refuse rather than invent a flag name.
     */
    readonly nestedFilterFlag?: string;
}
/**
 * Whether a required parameter name is one we can actually supply.
 *
 * Kept as a function so the table lookup is the only way in — a caller cannot accidentally
 * reintroduce a pattern match.
 */
export declare function canFillArgument(name: string, context: ReadArgContext): boolean;
/** Whether the CLI can express "replies to this one comment" at all. */
export declare function nestedFilterSupported(parameters: readonly string[]): string | undefined;
/**
 * Read one command's schema with `commands show` and decide whether we can drive it.
 *
 * ## What "usable" means here
 *
 * We send a post id and a page number, nothing else. A command is usable only if **every
 * required parameter appears in `FILLABLE_ARGUMENTS`**. Anything else means we cannot
 * construct a valid call, and inventing a value would be forging a request.
 *
 * ## The `unknown` case the first version got backwards
 *
 * An earlier version did `rawParams = asArray(...) ?? []`, so a schema whose shape we failed to
 * parse produced `required = []`, which read as "no required parameters" and therefore
 * `usable: true`. That is the exact opposite of what this function exists for: a schema we
 * could not parse is a schema we have **not** verified. It is now `evidence: 'unknown'` and
 * refused.
 */
export declare function inspectCommand(name: string, context?: ReadArgContext): Promise<WeiboCliCall<WeiboCliCommandSchema>>;
/**
 * A read that actually ran.
 *
 * `data` is present only on success; every other field combination is a refusal with a
 * reason, which is what lets the caller report *why* instead of "failed".
 */
export interface WeiboCliRead<T> {
    readonly status: WeiboCliStatus;
    readonly message: string;
    readonly data?: T;
    /** The command that was invoked, for the diagnostic panel. */
    readonly command?: string;
    /** Milliseconds the invocation took. */
    readonly elapsedMs?: number;
}
/**
 * Invoke one already-validated read command.
 *
 * ## What this deliberately does not do
 *
 * - It does not discover or validate: the caller must have run {@link inspectCommand}
 *   first. Keeping validation and invocation apart means a caller cannot accidentally
 *   execute a command whose argument shape was never checked.
 * - It does not retry. A retry after a timeout is how the same comment gets read twice and
 *   then counted twice; the caller decides, with the dedupe rules in hand.
 * - It does not treat a non-zero exit as a soft failure. Every failure keeps its classified
 *   status so the caller can distinguish quota from auth from upstream.
 */
export declare function runReadCommand<T>(command: string, args: readonly string[], options?: {
    readonly timeoutMs?: number;
}): Promise<WeiboCliRead<T>>;
export {};
//# sourceMappingURL=cli.d.ts.map