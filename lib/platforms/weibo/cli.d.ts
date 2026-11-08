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
    /**
     * `doctor` 的三行报告，原样带出来（v0.2.30）。
     *
     * ## 为什么不能只带一个 `status`
     *
     * `doctor` 打印的是**三步**：注册或登录 / 完成开发者认证 / 开通服务。
     * 这个函数过去把它们压成一个 `status`，于是「没登录」和「没开通服务」在
     * 面板上长得一样——而它们对应完全不同的下一步动作（登录 vs 去控制台开通）。
     *
     * 带出原始三行，让八项诊断能把三项分开报。`undefined` 表示 `doctor` 没跑；
     * 空数组表示跑了但没有可识别的步骤行——两者都是「没有证据」，不是「全部通过」。
     */
    readonly doctorSteps?: readonly DoctorStep[];
    /** `doctor` 的退出码，用于「解析不出步骤」时的兜底措辞。 */
    readonly doctorExitCode?: number;
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
/** 读当前计数。返回副本，调用方改不动内部状态。 */
export declare function cliMetrics(): {
    readonly invocations: number;
    readonly totalMs: number;
    readonly queueWaitMs: number;
};
/** 归零。**测试 only**：一个测试不该看见上一个测试的进程数。 */
export declare function __resetCliMetrics(): void;
/**
 * 暴露给测试的分类函数。**测试 only**：它只回答「这条命令会不会去解析令牌」，
 * 不改任何状态、不启动任何进程。
 */
export declare function __needsTokenForTest(args: readonly string[]): boolean;
/**
 * ## 为什么这里**没有**版本号缓存（v0.2.33 §七 的实测结论）
 *
 * 第一版给 `version` 加了 5 分钟缓存，理由是「版本号描述磁盘上那个文件，
 * 不描述账号状态，几十秒内不会变」。理由本身没错，但代价比收益大：
 *
 * - 收益是每次探测少一个 0.6 秒的子进程；
 * - 代价是**多一份需要失效的全局状态**，而它已经让两个测试互相污染了一次
 *   （换了假 CLI 的脚本，却读到上一个脚本的版本号）。
 *
 * 这正是这份代码一直在消灭的那类 bug 的形状：为了省一点时间，引入一个
 * 「什么时候该忘掉它」的问题。真正的 40 秒来自**串行的 4 次探测 + 2 次
 * 深度检查**，把它们并发掉就够了；省 0.6 秒不值得换一个状态。
 *
 * 所以：一次读取里每个子进程只启动一次，且每次读取都重新启动——
 * 不缓存任何描述「现在」的东西。
 */
/**
 * Point the CLI layer at a stand-in executable. **Tests only.**
 *
 * Call with `undefined` to restore the hardcoded `weibo-cli`. Deliberately not exported
 * from the package index, so a plugin consumer cannot reach it through configuration.
 */
/**
 * 平台子进程的出网否决（v0.2.36 §4）。
 *
 * CLI 的 socket 在它自己的进程里，插件拦不到。所以这里拦的是**启动**这件事：
 * 在 `manual` / `offline` 模式下，平台 CLI 一次都不许起来。进程没起来，就不可能
 * 有流量 —— 这比「起来了但没发请求」更容易验证，也更强。
 *
 * 与 `__setCliInvocation` 一样是测试/装配用钩子，不从包索引导出。
 */
export declare function __setCliEgressVeto(next: ((argv: readonly string[]) => string | undefined) | undefined): void;
export declare function __setCliInvocation(next: CliInvocation | undefined): void;
/**
 * Run one CLI command and capture stdout/stderr.
 *
 * Uses `execFile`, which takes an argument array and spawns the binary directly — the
 * documented way to invoke a tool without a shell. `shell` is never enabled, so no
 * character in any argument can be reinterpreted as syntax.
 *
 * ## Windows cannot spawn `weibo-cli` at all, and that is not "not installed" (v0.2.28)
 *
 * npm installs a CLI as three shims in `node_modules/.bin`: `weibo-cli` (a POSIX shell
 * script), `weibo-cli.cmd` (a cmd.exe batch file) and `weibo-cli.ps1`. There is **no**
 * extension-less executable on Windows, so `execFile('weibo-cli', …)` fails with `ENOENT`
 * even though the CLI is installed and works from a terminal — cmd.exe appends `.cmd` via
 * `PATHEXT`, and `execFile` does not.
 *
 * Measured on this machine with `@weibo-ai/weibo-cli@0.9.8` installed and on PATH:
 *
 *     execFile('weibo-cli', ['version'])  → ENOENT, empty stderr
 *
 * The plugin therefore told every Windows user 「没有安装 weibo-cli」 and printed
 * `npm install -g …` — advice they had already followed. That is worse than a missing
 * feature: it sends the owner to re-do the one thing that was already correct.
 *
 * The fix keeps `shell: false` (the security property that matters) and adds exactly one
 * fallback: when the bare name is ENOENT **on win32**, retry through the `.cmd` shim. The
 * argument array stays an array; nothing is concatenated into a command line, and the
 * only value that changes is the program's resolved name.
 */
/**
 * The only CLI subcommands this build is allowed to run.
 *
 * ## Why a list, when `publishReply` already throws (v0.2.29)
 *
 * The adapter refuses to publish. That protects the paths that go *through the adapter*
 * — and nothing else. Every read in this file ends up in `runCli`, which is a general
 * "spawn this argv" function: whoever can reach it can reach `statuses` / `comments` /
 * `users` and, on a CLI that grows a write command, would reach that too. A boundary
 * enforced only at the layer above will be bypassed by the first new caller.
 *
 * So the guard sits at the point of execution, where it cannot be stepped around.
 *
 * ## What is on the list, and why each entry is there
 *
 * Only what this build actually calls, plus the two local readiness commands. Nothing
 * is listed "in case it is useful later" — an unused entry is an unused capability, and
 * the way an allowlist rots is by accumulating entries nobody audited.
 *
 * - `version` / `doctor` — local checks, no network write, no quota.
 * - `commands list` / `commands show` — catalog discovery; the manual's own mechanism.
 * - `auth whoami` — reads the bound identity. Listed so the identity check does not have
 *   to shell out around the guard; it cannot modify anything.
 *
 * ## Why denial is checked before spawn, not after
 *
 * A rejected command that still ran is a write that happened. The check therefore
 * happens in `runCli` *before* `execFile`, and returns a classified refusal in the same
 * shape as every other failure — so a caller cannot distinguish "blocked" from "the CLI
 * said no" by the shape of the result, only by the message, which names the guard.
 */
export type CliVerb = 'version' | 'doctor' | 'commands' | 'auth';
/** What the guard decided about one argv. */
export interface CliGuardVerdict {
    readonly allowed: boolean;
    /** Why it was refused, in words that name the command and the rule. */
    readonly reason?: string;
    /** True when the refused verb looks like a write; false when it is merely unknown. */
    readonly looksLikeWrite?: boolean;
}
/**
 * Decide whether an argv may be executed.
 *
 * Pure and exported so the rule can be tested directly, and so a caller can ask before
 * building a command. `runCli` calls it too — the exported version is for tests and for
 * pre-flight checks, not a second implementation.
 */
export declare function guardCliInvocation(args: readonly string[]): CliGuardVerdict;
/**
 * Parse one JSON document out of CLI output.
 *
 * The CLI prints JSON when asked (`--output json`); some commands may precede it with a
 * progress line, so this takes the outermost span rather than assuming the whole stdout
 * is the document. A payload that does not parse is a hard failure — returning a partial
 * object would let a caller treat "unreadable" as "empty".
 *
 * ## The top level can be an array, and the first version could not read one (v0.2.29)
 *
 * The old implementation searched for the first `{` and the last `}`. For a list-shaped
 * response — which is what the CLI produces for any `list`/`timeline`/`*_batch` command,
 * and what its own README documents:
 *
 *     weibo statuses friends_timeline/biz --output json | jq '.[] | .text'
 *
 * …that span starts at the first object inside the array and ends at the last, yielding
 * `{…},{…}`. `JSON.parse` rejects it, the caller reports `failed`, and every list-shaped
 * read fails on perfectly valid output. Measured against the real binary's documented
 * shape: `[{"id":"1"},{"id":"2"}]` → `CLI 输出的 JSON 无法解析`.
 *
 * The fix: work out which bracket opened the document, and take the span from that one
 * to its own closer. Comparing positions is what distinguishes the two cases without
 * guessing:
 *
 *     [{"id":"1"}]        first `[` before first `{`  → the document is the array
 *     {"comments":[{}]}   first `{` before first `[`  → the document is the object
 *
 * The other span is still tried as a fallback, because stdout can legitimately contain
 * a bracketed log prefix (`[INFO] {…}`) that is not part of the document.
 *
 * ## But a fallback must not truncate (v0.2.29)
 *
 * The fallback has one dangerous case. Given a **truncated** array —
 *
 *     [{"id":"6001"},{"id":"6002"
 *
 * — there is no closing `]`, so the array span is unavailable and the object span picks
 * up `{"id":"6001"}`. That parses, and the caller receives a *shorter list* than the
 * platform sent. A short list reads downstream as "the platform has fewer comments",
 * which is a wrong fact rather than a failure, and wrong facts are the ones that get
 * acted on.
 *
 * So the fallback is only taken when the outer bracket clearly did not open a document.
 * `looksLikeJsonStart` decides that by looking at the character after the bracket: a real
 * container is followed by `{`, `[`, `"`, `-`, a digit, or one of `t/f/n`. `[INFO]` fails
 * that test (an `I`), which is exactly the log-prefix case the fallback exists for.
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
/** One line of `doctor`'s readiness report. */
export interface DoctorStep {
    readonly label: string;
    readonly ok: boolean;
}
/**
 * Parse `doctor`'s human-readable readiness report.
 *
 * The report is the only place the real verdict appears — the exit code says nothing (see
 * above). The marker is wrapped in ANSI colour, which is the detail that broke the first
 * version of this parser:
 *
 *     "\u001b[33m×\u001b[0m 注册或登录"
 *
 * An anchored `^[×...]` therefore never matched, the step list came back empty, and the
 * caller treated "cannot confirm" as "ready" — the same false pass, one layer down. Stripping
 * the escape sequences before matching is what makes the existing `^` correct rather than
 * lucky.
 *
 * A body with no recognisable step line returns `[]`, which the caller must treat as
 * "cannot confirm readiness" rather than "ready".
 */
export declare function parseDoctorReport(output: string): readonly DoctorStep[];
/**
 * One row of `commands list --available`.
 *
 * ## Why it is a pair, not a name
 *
 * The official CLI invokes `weibo <group> <action> [flags]`, and `action` itself may contain a
 * slash (`show_batch/other`). Keeping the pair separate is what lets `commands show` receive the
 * two arguments it requires, and what lets the reader tell `statuses` (the group) from
 * `user_timeline/biz` (the action).
 */
export interface WeiboCliCommand {
    readonly group: string;
    readonly action: string;
    /** `group action`, for display and for the fake CLI's matching. */
    readonly name: string;
    readonly description?: string;
    readonly priceType?: string;
    /** `allowed` / `locked` as the catalog reports it. Locked rows are listed but not callable. */
    readonly access?: string;
    /** Flag names this command accepts, when the catalog row already carried them. */
    readonly flags?: readonly string[];
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
     * The same parameters with the type the catalog declared.
     *
     * `parameters` remains the flat name list because dozens of call sites and tests use it. This
     * carries the extra facts the invocation plan needs — chiefly whether a parameter is required —
     * so the plan does not have to re-derive them from two parallel arrays.
     */
    readonly typedParameters: readonly {
        readonly name: string;
        readonly type?: string;
        readonly required: boolean;
    }[];
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
    /** The post id this read is about. Placed **as a flag value**, never positionally. */
    readonly threadId: string;
    /** Whether this read pages at all. */
    readonly paged: boolean;
    /** The page number for this read; ignored when `paged` is false. */
    readonly page: number;
    /** Page size, when the command declares a `count` flag. */
    readonly count?: number;
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
/** 清空 schema 缓存。**测试 only**。 */
export declare function __resetSchemaCache(): void;
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
export declare function inspectCommand(command: {
    readonly group: string;
    readonly action: string;
}, context?: ReadArgContext): Promise<WeiboCliCall<WeiboCliCommandSchema>>;
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
export declare function runReadCommand<T>(command: {
    readonly group: string;
    readonly action: string;
    readonly name?: string;
}, args: readonly string[], options?: {
    readonly timeoutMs?: number;
}): Promise<WeiboCliRead<T>>;
export {};
//# sourceMappingURL=cli.d.ts.map