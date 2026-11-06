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

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

/** The binary name; resolved through PATH exactly as the manual documents it. */
const BINARY = 'weibo-cli'

/** How long one CLI invocation may take before it is killed. */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * The states a CLI-backed read can be in.
 *
 * Each one exists because it needs a *different* message to the owner. Collapsing them
 * into "failed" is what makes a missing install look like a network problem.
 */
export type WeiboCliStatus =
  | 'ok'
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
  | 'failed'

/** One probe result: what we can actually do right now. */
export interface WeiboCliReadiness {
  readonly status: WeiboCliStatus
  /** Human-readable, already safe to show and to log. */
  readonly message: string
  /** Present when the CLI answered `version`. */
  readonly version?: string
  /** True only when a real read could be attempted. */
  readonly canRead: boolean
  /**
   * The exact next step for the owner, when one is needed.
   *
   * Kept separate from `message` so the settings page can show "what you must do" as a
   * list of steps rather than one long sentence.
   */
  readonly steps: readonly string[]
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
  readonly doctorSteps?: readonly DoctorStep[]
  /** `doctor` 的退出码，用于「解析不出步骤」时的兜底措辞。 */
  readonly doctorExitCode?: number
}

/** One JSON payload the CLI printed. */
export interface WeiboCliCall<T> {
  readonly status: WeiboCliStatus
  readonly message: string
  /** Parsed stdout, only present when `status === 'ok'`. */
  readonly data?: T
  /** Whether this call consumed quota, when the CLI said so. */
  readonly billed?: boolean
}

/**
 * Anything that looks like a credential, removed from text we might show.
 *
 * The CLI's own manual warns against putting tokens in logs; the same rule applies to
 * its stderr, which can echo request headers on failure. Scrubbing here means a future
 * caller cannot accidentally forward one.
 */
export function scrubCredentials(text: string): string {
  return text
    // Bearer tokens and bare OAuth access/refresh tokens.
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>')
    .replace(/\b(access_token|refresh_token|token|code|client_secret)=([^&\s"']+)/gi, '$1=<redacted>')
    // Anything shaped like a long opaque secret (Weibo tokens are long base64ish).
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>')
}

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
  readonly file: string
  readonly prefixArgs: readonly string[]
}

const DEFAULT_INVOCATION: CliInvocation = { file: BINARY, prefixArgs: [] }
let invocation: CliInvocation = DEFAULT_INVOCATION

/**
 * Point the CLI layer at a stand-in executable. **Tests only.**
 *
 * Call with `undefined` to restore the hardcoded `weibo-cli`. Deliberately not exported
 * from the package index, so a plugin consumer cannot reach it through configuration.
 */
export function __setCliInvocation(next: CliInvocation | undefined): void {
  invocation = next ?? DEFAULT_INVOCATION
}

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
export type CliVerb = 'version' | 'doctor' | 'commands' | 'auth'

/**
 * The read commands, expressed as `group action` pairs.
 *
 * A `commands` call is allowed only for `list` / `show`; the pair is checked, not just
 * the verb, because `commands` is a group name that could later grow a mutating action.
 */
const ALLOWED_INVOCATIONS: readonly { readonly verb: CliVerb; readonly action?: string }[] = [
  { verb: 'version' },
  { verb: 'doctor' },
  { verb: 'commands', action: 'list' },
  { verb: 'commands', action: 'show' },
  { verb: 'auth', action: 'whoami' },
]

/**
 * The command groups this CLI actually has, taken from its own `GROUP_DESCRIPTIONS`.
 *
 * ## Why an unknown group must be refused even when its action looks like a read (v0.2.29)
 *
 * The first version of the guard let anything whose action began with `list`/`show`
 * through, reasoning that "the account's catalog decides what is callable". That is true
 * for *whether* a command works, and false for *whether we should try*: a group we have
 * never seen is a group whose actions we have never read, so `mystery list` would be
 * executed on the strength of its name. Default-deny is the task book's rule and also the
 * only rule that stays true when the CLI grows a group.
 *
 * These nine are the groups `@weibo-ai/weibo-cli@0.9.8` ships, read out of its
 * `help.js`. A future version that adds a group will be refused until this list is
 * updated — which is the intended behaviour: adding a capability should require a
 * deliberate edit, not arrive silently.
 */
const KNOWN_GROUPS: ReadonlySet<string> = new Set([
  'attitudes',
  'comments',
  'friendships',
  'search',
  'short_url',
  'statuses',
  'tags',
  'users',
  'wbindex',
])

/**
 * What a command name is allowed to look like.
 *
 * ## The `list && create` case (v0.2.29)
 *
 * `execFile` takes an argument array and never involves a shell, so a segment like
 * `list && create` is passed through as one literal argv entry and does nothing. That is
 * a real property and it is not the one being relied on here: the guard is supposed to
 * answer "is this a command we recognise", and a string carrying a shell operator is
 * evidence that it is not. Letting it through because a *different* layer happens to be
 * safe is how a boundary quietly becomes "safe as long as nobody changes this other file".
 *
 * The pattern also rejects `--`-prefixed strings, path separators and quotes, so nothing
 * that could be mistaken for a flag or a path is ever read as a command name.
 */
const COMMAND_SEGMENT_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z][A-Za-z0-9_]*)?$/

/**
 * Read verbs the *business* commands use, checked as the action segment.
 *
 * These are not hardcoded endpoint names — the account's own catalog decides which one
 * is actually callable (see `classifyCommands`). This list only answers "is this the
 * shape of a read", so that the executor can refuse a write verb it has never seen.
 * A name that is neither here nor in the catalog is refused, never executed.
 *
 * Matched on the segment before any `/`: the CLI's own actions include suffixes such as
 * `show_batch/biz`, where `biz` is a scope qualifier rather than a different verb. The
 * `_batch` suffix is part of the verb itself (a batch form of the same read), so it is
 * allowed explicitly rather than by a looser prefix match — `showanything` must not pass.
 */
const READ_ACTION_PATTERN =
  /^(list|show|get|read|detail|search|query|counts?|timeline|expand)(_batch)?$/i

/**
 * Verbs that would change something at the platform, named so the refusal can be
 * specific instead of "not allowed".
 *
 * This is a **deny** list that adds clarity, not the boundary itself: the boundary is
 * "only `READ_ACTION_PATTERN` actions may run". Listing the dangerous ones separately
 * means the audit trail says which write was attempted, which matters when a prompt
 * injection is trying them.
 */
const WRITE_ACTION_PATTERN =
  /^(create|post|publish|send|reply|comment|repost|forward|like|unlike|favourite|favorite|delete|destroy|remove|update|edit|follow|unfollow|block|report|upload)/i

/** What the guard decided about one argv. */
export interface CliGuardVerdict {
  readonly allowed: boolean
  /** Why it was refused, in words that name the command and the rule. */
  readonly reason?: string
  /** True when the refused verb looks like a write; false when it is merely unknown. */
  readonly looksLikeWrite?: boolean
}

/**
 * Decide whether an argv may be executed.
 *
 * Pure and exported so the rule can be tested directly, and so a caller can ask before
 * building a command. `runCli` calls it too — the exported version is for tests and for
 * pre-flight checks, not a second implementation.
 */
export function guardCliInvocation(args: readonly string[]): CliGuardVerdict {
  const [verb, second] = args
  if (verb === undefined) {
    return { allowed: false, reason: '拒绝执行：没有指定任何命令。' }
  }

  // `commands list|show` and `auth whoami` are the discovery/identity surface.
  const entry = ALLOWED_INVOCATIONS.find(
    (candidate) => candidate.verb === verb && (candidate.action === undefined || candidate.action === second),
  )
  if (entry !== undefined) return { allowed: true }

  // ## Business reads: `<group> <action> [flags]`
  //
  // Two independent conditions, both required:
  //   1. the group is one this CLI actually has, and
  //   2. the action's verb is a read, not a write.
  //
  // Checking only the action let `mystery list` through — a group whose actions were
  // never read, executed because its second word happened to look harmless.
  if (second !== undefined && !second.startsWith('--')) {
    // A segment that is not a plain name (contains `&&`, `;`, `|`, a path separator)
    // is not a command we know, whatever it starts with.
    if (!COMMAND_SEGMENT_PATTERN.test(second)) {
      return {
        allowed: false,
        reason: `拒绝执行 weibo-cli ${verb} ${second}：命令名不是合法的命令标识。`,
      }
    }
    const verbSegment = second.split('/')[0]!.toLowerCase()
    if (WRITE_ACTION_PATTERN.test(verbSegment)) {
      return {
        allowed: false,
        reason:
          `拒绝执行 weibo-cli ${verb} ${second}：本版只做真实只读接入，` +
          '发表、评论、转发、点赞、删除等写操作一律不执行。这是代码里的边界，不是界面上的。',
        looksLikeWrite: true,
      }
    }
    if (!KNOWN_GROUPS.has(verb.toLowerCase())) {
      return {
        allowed: false,
        reason: `拒绝执行 weibo-cli ${verb}：这个命令分组不在已知列表内，未执行。`,
      }
    }
    if (READ_ACTION_PATTERN.test(verbSegment)) return { allowed: true }
    return {
      allowed: false,
      reason: `拒绝执行 weibo-cli ${verb} ${second}：这不是一个已登记的只读命令。`,
    }
  }

  return {
    allowed: false,
    reason: `拒绝执行 weibo-cli ${verb}：不在只读允许列表内。`,
  }
}

async function runCli(
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string; errorCode?: string }> {
  type CliResult = { code: number; stdout: string; stderr: string; errorCode?: string }

  // ## The guard runs before the spawn, not after (v0.2.29)
  //
  // A refused command that still executed is a write that already happened. Checking
  // here means every path in this module — current and future — inherits the boundary,
  // because `runCli` is the only way out of this process.
  const verdict = guardCliInvocation(args)
  if (!verdict.allowed) {
    return {
      code: 1,
      stdout: '',
      stderr: JSON.stringify({
        success: false,
        code: verdict.looksLikeWrite === true ? 'WRITE_FORBIDDEN' : 'COMMAND_NOT_ALLOWED',
        message: verdict.reason ?? '拒绝执行。',
      }),
      errorCode: verdict.looksLikeWrite === true ? 'WRITE_FORBIDDEN' : 'COMMAND_NOT_ALLOWED',
    }
  }


  const attempt = (file: string, argv: readonly string[]): Promise<CliResult> =>
    new Promise((resolve) => {
      const settle = (result: CliResult): void => resolve(result)
      try {
        execFile(
          file,
          argv,
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) => {
            // ## Why the raw `error.code` is kept (v0.2.11)
            //
            // `execFile` reports a missing binary as `error.code === 'ENOENT'` with an
            // **empty stderr** — there is no process to write one. Collapsing everything to
            // a number turned "not installed" into a generic failure, and the owner then got
            // "调用失败" instead of "去装一下". The string code is the only place that
            // distinction survives.
            const rawCode = (error as NodeJS.ErrnoException | null)?.code
            const numeric = typeof rawCode === 'number' ? rawCode : error === null ? 0 : 1
            settle({
              code: numeric,
              stdout: typeof stdout === 'string' ? stdout : '',
              stderr: typeof stderr === 'string' ? stderr : '',
              ...(typeof rawCode === 'string' ? { errorCode: rawCode } : {}),
            })
          },
        )
      } catch (error) {
        // ## `spawn EINVAL` is thrown, not delivered to the callback (v0.2.28)
        //
        // Since the CVE-2024-27980 fix, Node refuses to spawn a `.cmd`/`.bat` without
        // `shell: true` and does so by **throwing synchronously**. An unhandled throw here
        // escaped the promise and became an uncaught exception in the plugin host — a
        // crashed read instead of a reported one.
        const rawCode = (error as NodeJS.ErrnoException).code
        settle({
          code: 1,
          stdout: '',
          stderr: '',
          errorCode: typeof rawCode === 'string' ? rawCode : 'EINVAL',
        })
      }
    })

  const first = await attempt(invocation.file, [...invocation.prefixArgs, ...args])
  // Only the bare name is worth a second try: a test-provided stand-in already names a real
  // file, and re-resolving it would change what the tests exercise.
  if (first.errorCode !== 'ENOENT' || process.platform !== 'win32' || invocation.file !== BINARY) {
    return first
  }

  // ## Windows has no extension-less executable for an npm CLI (v0.2.28)
  //
  // npm writes three shims into `node_modules/.bin`: `weibo-cli` (a POSIX shell script),
  // `weibo-cli.cmd` (cmd.exe batch) and `weibo-cli.ps1`. `execFile('weibo-cli')` therefore
  // fails with `ENOENT` on a machine where the CLI is installed and works — cmd.exe appends
  // `.cmd` through `PATHEXT`, `execFile` does not. Measured here with
  // `@weibo-ai/weibo-cli@0.9.8` on PATH: `ENOENT`, empty stderr.
  //
  // Spawning the `.cmd` directly is not available either (`spawn EINVAL`, above), and
  // enabling `shell: true` would throw away the one property this module is built around.
  // What the shim itself does, per its own body, is run `node <pkg>/dist/index.js "$@"` —
  // so that is what happens here: resolve the entry and pass it to `process.execPath` as an
  // ordinary argument. No shell, no concatenated command line, argument array intact.
  const entry = resolveWindowsEntry()
  if (entry === undefined) return first
  const viaNode = await attempt(process.execPath, [entry, ...invocation.prefixArgs, ...args])
  return viaNode.errorCode === 'ENOENT' ? first : viaNode
}

/**
 * Find the CLI's JavaScript entry point on Windows.
 *
 * Looks for the npm package in the two layouts npm uses, relative to each `PATH` directory:
 * a global install puts shims in `<prefix>` and the package under `<prefix>/node_modules`,
 * a local one puts shims in `node_modules/.bin` and the package one level up.
 *
 * Deliberately narrow: it only ever accepts a path that ends in
 * `@weibo-ai/weibo-cli/dist/index.js` and actually exists. That keeps the "no arbitrary
 * program" property — the caller cannot steer this at anything but the official CLI.
 */
function resolveWindowsEntry(): string | undefined {
  const pathEntries = (process.env['PATH'] ?? '').split(delimiter).filter((entry) => entry !== '')
  for (const dir of pathEntries) {
    const candidates = [
      join(dir, 'node_modules', '@weibo-ai', 'weibo-cli', 'dist', 'index.js'),
      join(dir, '..', '@weibo-ai', 'weibo-cli', 'dist', 'index.js'),
      join(dir, '..', 'lib', 'node_modules', '@weibo-ai', 'weibo-cli', 'dist', 'index.js'),
    ]
    for (const candidate of candidates) {
      const resolved = resolve(candidate)
      if (!resolved.endsWith(join('@weibo-ai', 'weibo-cli', 'dist', 'index.js'))) continue
      try {
        if (statSync(resolved).isFile()) return resolved
      } catch {
        // Not there; try the next candidate.
      }
    }
  }
  return undefined
}

/**
 * Classify a failed invocation by what its stderr says.
 *
 * The CLI's own vocabulary, per the manual: it "prompts the specific reason" when the
 * balance is short, the service is not activated, or qualification is missing. We match
 * on those words rather than on exit codes, because the manual does not promise distinct
 * codes and guessing one would be worse than matching text.
 */
/**
 * The error codes the official CLI emits, and what each one means for this plugin.
 *
 * ## Why the code beats text matching (v0.2.13)
 *
 * The official `formatError` writes a JSON envelope to **stderr** when `--output` is explicit:
 *
 *     { success: false, status, code, message, trace_id?, response_body? }
 *
 * v0.2.12 only ever ran keyword regexes over the combined stderr/stdout, so an exact machine
 * field — `code: 'SERVICE_REQUIRED'` — was thrown away and re-inferred from prose. That is both
 * less reliable (the messages are Chinese prose that changes between versions) and less safe (a
 * token echoed into a message could match the wrong branch).
 *
 * The envelope is now parsed first; the regexes stay as a fallback for a CLI that answered
 * without one (an older version, or a crash before the request).
 */
const ERROR_CODE_STATUS: Readonly<Record<string, { status: WeiboCliStatus; message: string }>> = {
  /**
   * The local read-only guard refused the command (v0.2.29).
   *
   * Given its own code rather than folded into `failed`, because the owner needs to read
   * 「本版不允许写操作」 and not 「调用失败，请重试」 — one of those is not a fault, and the
   * other is the one message that would encourage someone to push harder on a blocked path.
   */
  WRITE_FORBIDDEN: {
    status: 'command_unavailable',
    message:
      '本版只做真实只读接入，发表、评论、转发、点赞、删除等写操作不会执行。' +
      '这条拒绝发生在调用 weibo-cli 之前，所以没有任何请求到达平台。',
  },
  /** The local guard refused a subcommand that is not on the read allowlist (v0.2.29). */
  COMMAND_NOT_ALLOWED: {
    status: 'command_unavailable',
    message: '这条命令不在本版的只读允许列表内，未执行。',
  },
  IP_GEO_DENIED: {
    status: 'not_authenticated',
    message: '当前网络位置被微博拒绝：请在你的常用网络环境下使用，不要通过代理访问。',
  },
  DEVELOPER_IDENTITY_REQUIRED: {
    status: 'service_inactive',
    message: '还没有完成开发者身份认证：需要在微博开放平台控制台完成扫脸认证。',
  },
  DEVELOPER_DISABLED: {
    status: 'service_inactive',
    message: '开发者身份已被停用：请到微博开放平台查看账号状态。',
  },
  SERVICE_REQUIRED: {
    status: 'service_inactive',
    message: '还没有开通服务：需要在控制台领取体验服务或购买积分包。',
  },
  TRIAL_ALREADY_CLAIMED: {
    status: 'service_inactive',
    message: '体验服务已经领取过：如需继续使用需要购买积分包。',
  },
  TRIAL_EXPIRED: {
    status: 'service_inactive',
    message: '体验服务已过期：需要购买积分包才能继续调用。',
  },
  TRIAL_API_NOT_ALLOWED: {
    status: 'command_unavailable',
    message: '这条接口不在体验服务的白名单里：需要购买对应的积分包。',
  },
  TRIAL_API_QUOTA_EXCEEDED: {
    status: 'quota_exhausted',
    message: '体验服务的接口次数已用完：本次读取未执行。',
  },
  QUOTA_EXCEEDED: { status: 'quota_exhausted', message: '积分余额不足：本次读取未执行。' },
  COUNT_EXCEEDS_MAX: {
    status: 'failed',
    message: '请求的分页条数超过接口上限：这属于本插件构造的请求有问题，不是账号问题。',
  },
  UNAUTHORIZED: {
    status: 'not_authenticated',
    message: 'weibo-cli 尚未登录或登录已失效：请运行 weibo-cli auth login。',
  },
  TOKEN_EXPIRED: {
    status: 'not_authenticated',
    message: '登录凭证已过期：请重新运行 weibo-cli auth login。',
  },
}

/** Pull the `code` out of an official error envelope on stderr, if there is one. */
/**
 * 从失败信封里取错误码与说明，顶层与 `error` 里都看（v0.2.30）。
 *
 * ## 为什么必须两处都读
 *
 * `@weibo-ai/weibo-cli@0.9.8` 真实的失败输出是：
 *
 * ```json
 * { "success": false,
 *   "error": { "code": "NOT_FOUND",
 *              "message": "CLI command not found: statuses show",
 *              "trace_id": "…" } }
 * ```
 *
 * v0.2.29 的实现只读顶层 `record.code`，那里是 `undefined`。于是**每一条真实
 * 错误**都掉进后面的文本匹配，而 `CLI command not found` 命中
 * `/command not found/`，被判成 `cli_missing`——用户看到
 * 「没有找到 weibo-cli 可执行文件，请先安装」，而 CLI 明明装着；真正的原因是
 * 那个子命令在当前账号下不可用（开发者认证与服务未开通）。
 *
 * 这个缺陷只在真实 CLI 上出现：测试里的假 CLI 一直按顶层形状注入错误码，
 * 所以 1910 条测试全绿而真实环境第一句话就是错的。修它的同时补了回归测试
 * （`v0230-cli-envelope.test.ts`），样本是真实 stderr 原文。
 *
 * 顶层优先：那是本地只读守卫自己写的形状，而且它的消息比官方 CLI 的更贴合本版
 * 语义（「本版只做只读接入，写操作不会执行」）。
 */
function nestedError(record: Record<string, unknown>): {
  readonly code?: string
  readonly message?: string
} {
  const error =
    typeof record.error === 'object' && record.error !== null
      ? (record.error as Record<string, unknown>)
      : undefined
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined
  const code = text(record.code) ?? text(error?.code)
  const message = text(error?.message) ?? text(record.message)
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  }
}

/**
 * 解析失败信封，同时给出错误码与 CLI 自己的说明。
 *
 * 抽出 `errorEnvelope` 是因为错误码与说明要一起用：只知道码不知道说了什么，
 * 一句「返回错误码 NOT_FOUND」会让用户以为帖子不存在，而真实含义可能是
 * 「这个子命令在当前账号下不可用」。
 */
function errorEnvelope(stderr: string): { readonly code?: string; readonly message?: string } {
  const text = stderr.trim()
  if (text === '') return {}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return {}
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    // `success: true` means the call worked; whatever else is in the body is not an error.
    if (record.success === true) return {}
    return nestedError(record)
  } catch {
    return {}
  }
}

function classifyFailure(
  stderr: string,
  stdout: string,
  errorCode?: string,
): { status: WeiboCliStatus; message: string } {
  // A missing binary has an empty stderr — `error.code` is the only evidence, so it comes first.
  if (errorCode === 'ENOENT') {
    return {
      status: 'cli_missing',
      message: '没有找到 weibo-cli 可执行文件。请先安装：npm install -g @weibo-ai/weibo-cli',
    }
  }

  // ## The machine-readable code first
  const envelope = errorEnvelope(stderr)
  if (envelope.code !== undefined) {
    /**
     * ## `NOT_FOUND` 有两个完全不同的意思（v0.2.30，真实 CLI 实测）
     *
     * 真实的两种输出：
     *
     * ```
     * CLI command not found: statuses show      ← 命令不可用
     * 微博不存在或已被删除                        ← 帖子不存在
     * ```
     *
     * 两者都可能是 `NOT_FOUND`。把它们当成同一件事，用户会在「帖子删了」和
     * 「这个命令你用不了」之间拿到错误的那一个——而这两件事的下一步动作毫无交集。
     *
     * 判据是 CLI 自己的 message：提到 command 的是前者。这是**按内容判别**，
     * 不是按码判别，因为码本身没有区分。
     */
    if (envelope.code === 'NOT_FOUND' && /command/i.test(envelope.message ?? '')) {
      return {
        status: 'command_unavailable',
        message:
          `当前账号的可用命令里没有这一条（${scrubCredentials(envelope.message ?? '')}）：` +
          '先确认开发者认证与服务开通已完成，再看 weibo-cli commands list --available 里有没有它。',
      }
    }
    const mapped = ERROR_CODE_STATUS[envelope.code]
    if (mapped !== undefined) return mapped
    /**
     * 未知错误码：把 CLI 自己的说明带上，而不是只说「返回错误码 X」。
     *
     * 只报一个码，用户无从判断下一步；带上原文（已 scrub）才可能自己解决。
     */
    return {
      status: 'failed',
      message:
        envelope.message === undefined
          ? `weibo-cli 返回错误码 ${envelope.code}。`
          : `weibo-cli 返回错误码 ${envelope.code}：${scrubCredentials(envelope.message)}`,
    }
  }

  const text = scrubCredentials(`${stderr}\n${stdout}`).toLowerCase()

  /**
   * `CLI command not found: …` 不是「没装 CLI」，是「这个子命令不可用」。
   *
   * ## 这两件事必须分开判断（v0.2.30）
   *
   * 真实输出是 `CLI command not found: statuses show`，它含有 `command not found`。
   * 下面那条「装没装」的判断用的是同一个短语，所以一条真实的「命令不可用」
   * 会被报成「没有找到 weibo-cli，请先安装」——用户会去重装一个已经装好的东西，
   * 而真正的原因（开发者认证与服务未开通）在更上游。
   *
   * 顺序上把它放在最前面：只有在确认不是子命令问题之后，才去判断 CLI 本身。
   * 判据是「有没有说出具体是哪个子命令」——`CLI command not found: X` 有，
   * shell 的 `weibo-cli: command not found` 没有。
   */
  if (/cli command not found|command not found:\s*\S/.test(text)) {
    const named = text.match(/command not found:\s*([a-z0-9_/ ]{1,60})/)
    return {
      status: 'command_unavailable',
      message:
        named === null
          ? '当前账号的可用命令里没有这一条：先确认开发者认证与服务开通已完成。'
          : `当前账号的可用命令里没有「${named[1]!.trim()}」：先确认开发者认证与服务开通已完成，` +
            '再看 weibo-cli commands list --available 里有没有它。',
    }
  }
  if (/enoent|command not found|不是内部或外部命令/.test(text)) {
    return {
      status: 'cli_missing',
      message: '没有找到 weibo-cli 可执行文件。请先安装：npm install -g @weibo-ai/weibo-cli',
    }
  }
  if (/not logged in|未登录|no auth|oauth|授权码|login required|unauthori[sz]ed/.test(text)) {
    return { status: 'not_authenticated', message: 'weibo-cli 尚未登录：请运行 weibo-cli auth login。' }
  }
  if (/认证|qualification|developer|未开通|not activated|service inactive|no service/.test(text)) {
    return {
      status: 'service_inactive',
      message: '开发者认证或服务未开通：需要在控制台完成扫脸认证并领取体验服务或购买积分包。',
    }
  }
  if (/quota|额度|余额|balance|insufficient|credit|超出|exceeded|rate limit|频率/.test(text)) {
    return { status: 'quota_exhausted', message: '额度或频率不足：本次读取未执行。' }
  }
  if (/unknown command|not available|no such command|不可用/.test(text)) {
    return { status: 'command_unavailable', message: '当前账号的可用命令里没有这一条。' }
  }
  return { status: 'failed', message: 'weibo-cli 调用失败。' }
}

/**
 * Whether the character after a bracket could open a JSON value.
 *
 * Used to tell a document from a bracketed log prefix: `[{"id":…` is a document, `[INFO]`
 * is not. Only the first non-space character matters — a container always starts with
 * `{`, `[`, `"`, `-`, a digit, or one of `t`/`f`/`n` (`true` / `false` / `null`).
 */
function looksLikeJsonStart(text: string, bracketAt: number): boolean {
  for (let index = bracketAt + 1; index < text.length; index += 1) {
    const char = text[index]!
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') continue
    return /[{[":\-0-9tfn]/.test(char)
  }
  // An empty container (`[]` / `{}`) closes immediately; that is a document too.
  return true
}

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
export function parseCliJson<T>(stdout: string): { ok: true; data: T } | { ok: false; reason: string } {
  const objectStart = stdout.indexOf('{')
  const objectEnd = stdout.lastIndexOf('}')
  const arrayStart = stdout.indexOf('[')
  const arrayEnd = stdout.lastIndexOf(']')

  const objectSpan: [number, number] | undefined =
    objectStart >= 0 && objectEnd > objectStart ? [objectStart, objectEnd + 1] : undefined
  const arraySpan: [number, number] | undefined =
    arrayStart >= 0 && arrayEnd > arrayStart ? [arrayStart, arrayEnd + 1] : undefined

  // Which bracket opened the document? The first one to appear, unless it is obviously
  // not a document opener (`[INFO] ready` — an `I` after the bracket).
  const firstBracket = Math.min(
    objectStart === -1 ? Number.POSITIVE_INFINITY : objectStart,
    arrayStart === -1 ? Number.POSITIVE_INFINITY : arrayStart,
  )
  const documentIsArray = firstBracket === arrayStart && firstBracket !== Number.POSITIVE_INFINITY
  const openerIsJson = firstBracket !== Number.POSITIVE_INFINITY && looksLikeJsonStart(stdout, firstBracket)

  const spans: [number, number][] = []
  if (openerIsJson) {
    // The document is whatever the first bracket opened, and only that. A truncated
    // array must fail here rather than degrade into its first object: a shorter list
    // reads as "the platform sent fewer comments", which is a wrong fact, not an error.
    const chosen = documentIsArray ? arraySpan : objectSpan
    if (chosen !== undefined) spans.push(chosen)
  } else {
    // A log prefix occupied the outer position. Fall back to whichever span closes.
    if (objectSpan !== undefined) spans.push(objectSpan)
    if (arraySpan !== undefined) spans.push(arraySpan)
  }

  if (spans.length === 0) return { ok: false, reason: 'CLI 没有输出 JSON 对象或数组' }

  let lastError: unknown
  for (const [from, to] of spans) {
    const slice = stdout.slice(from, to)
    try {
      return { ok: true, data: JSON.parse(slice) as T }
    } catch (error) {
      // Remember the first failure and try the other span shape. A stdout that contains
      // both `{}` and `[]` is either a list of objects (array span wins) or an object
      // with arrays inside (object span wins); trying both is how the two are told apart
      // without guessing from the text.
      lastError ??= error
    }
  }
  {
    const error = lastError
    // ## The parse error carries a fragment of the input (v0.2.12 audit)
    //
    // `classifyFailure` scrubs stderr and stdout, but this path did not — and modern V8
    // includes a slice of the malformed input in the message:
    //
    //     Unexpected token 'a', "eyJhbGciOiJIUzI1NiIs..." is not valid JSON
    //
    // This `reason` becomes a `WeiboCliError.message`, which reaches logs, the diagnostic
    // panel and the model's context. Scrub it here too; the module's contract says nothing
    // token-shaped leaves through an error message.
    return { ok: false, reason: scrubCredentials(`CLI 输出的 JSON 无法解析：${(error as Error).message}`) }
  }
}

/**
 * Probe what this machine can actually do, without spending quota.
 *
 * Runs `version` and `doctor`, both of which the manual describes as local checks. The
 * result is the input to the capability matrix: a deployment where this says
 * `cli_missing` must not advertise any read as `supported`.
 */
export async function probeWeiboCli(): Promise<WeiboCliReadiness> {
  const version = await runCli(['version'])
  if (version.code !== 0) {
    const classified = classifyFailure(version.stderr, version.stdout, version.errorCode)
    // The common case on a machine that never installed the CLI deserves its own
    // wording: "install it" is a different instruction from "fix your auth".
    const missing = classified.status === 'cli_missing'
    return {
      status: classified.status,
      message: missing
        ? '没有安装 weibo-cli。这是最可能的原因：本机没有这个命令。'
        : classified.message,
      canRead: false,
      steps: missing
        ? [
            '安装 CLI：npm install -g @weibo-ai/weibo-cli（需要 Node.js 18+）',
            '在微博控制台用微博客户端扫码完成开发者认证',
            '在「我的服务」领取体验服务（7 天）或购买积分包',
            '运行 weibo-cli auth login 完成 OAuth 登录',
            '运行 weibo-cli doctor 确认状态为就绪',
          ]
        : ['运行 weibo-cli doctor 查看具体缺哪一步', '完成对应步骤后重试'],
    }
  }

  const versionText = version.stdout.trim().split(/\r?\n/)[0] ?? ''

  const doctor = await runCli(['doctor'])

  // ## `doctor` exits 0 while reporting failure, so the exit code is not the verdict (v0.2.28)
  //
  // Measured against `@weibo-ai/weibo-cli@0.9.8` on a machine with the CLI installed and
  // nothing else set up:
  //
  //     $ weibo-cli doctor ; echo $?
  //     × 注册或登录
  //     × 完成开发者认证
  //     × 开通服务
  //     0
  //
  // Every readiness step failed and the process still exited 0. Reading `code !== 0` as the
  // only failure signal therefore reported **「已就绪」** for an installation that had never
  // logged in — the plugin would advertise a working Weibo read and then fail on the first
  // call, which is precisely the "permission problem disguised as success" this module is
  // supposed to prevent.
  //
  // So the verdict comes from the report body, and the exit code is only a secondary hint.
  const doctorSteps = parseDoctorReport(`${doctor.stdout}\n${doctor.stderr}`)
  if (doctor.code !== 0 || doctorSteps.some((step) => !step.ok)) {
    const classified = classifyFailure(doctor.stderr, doctor.stdout, doctor.errorCode)
    const failed = doctorSteps.filter((step) => !step.ok).map((step) => step.label)
    // ## The report outranks the text classifier
    //
    // `classifyFailure` matches words, and `doctor`'s guidance block contains several of
    // them at once (`认证`, `服务`, `登录`), so it reported `service_inactive` for an
    // installation whose *first* unfinished step was 「注册或登录」 — telling the owner to
    // sort out a service plan when the actual next action was to log in. When the report
    // parsed, its ordered steps are the precise answer; the classifier is only the fallback
    // for output that could not be parsed.
    const status = doctorSteps.length > 0 ? doctorStatusOf(doctorSteps) : classified.status
    return {
      status,
      message:
        failed.length > 0
          ? `weibo-cli 尚未就绪：${failed.join('、')} 未完成。`
          : classified.message,
      version: versionText,
      canRead: false,
      steps: doctorNextSteps(doctorSteps),
      doctorSteps,
      doctorExitCode: doctor.code,
    }
  }

  // `doctor` passing means authentication and service are in place. It is still one more
  // local check than a real read, so the caller must not advertise `supported` on the
  // strength of this alone.
  return {
    status: 'ok',
    message: 'weibo-cli 已就绪（认证与服务均已通过本地检查）。',
    version: versionText,
    canRead: true,
    steps: [],
    doctorSteps,
    doctorExitCode: doctor.code,
  }
}

/** One line of `doctor`'s readiness report. */
export interface DoctorStep {
  readonly label: string
  readonly ok: boolean
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
export function parseDoctorReport(output: string): readonly DoctorStep[] {
  const steps: DoctorStep[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    // CSI sequences (`\u001b[33m`, `\u001b[0m`, `\u001b[2m`) carry no meaning here.
    const line = stripAnsi(rawLine).trim()
    if (line === '') continue
    // `× 注册或登录` / `✓ 完成开发者认证` / `x ...` / `√ ...`
    //
    // `match` rather than `exec`: this module's own source-shape test forbids a bare
    // `exec(` anywhere in the file (it is there to catch `child_process.exec`), and a
    // regex `.exec(` is indistinguishable from that by text. Using `match` keeps the
    // guard meaningful instead of teaching the next reader to add an exception.
    const match = line.match(/^([×✗✘xX√✓✔])\s*(.+)$/)
    if (match === null) continue
    const marker = match[1]!
    const label = match[2]!.trim()
    if (label === '') continue
    steps.push({ label, ok: marker === '√' || marker === '✓' || marker === '✔' })
  }
  return steps
}

/** Drop ANSI escape sequences. Kept local: this module has no other use for them. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching ESC is the whole point
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

/** The `WeiboCliStatus` that best describes a partially-complete `doctor` report. */
function doctorStatusOf(steps: readonly DoctorStep[]): WeiboCliStatus {
  if (steps.length === 0) return 'failed'
  const missing = steps.filter((step) => !step.ok).map((step) => step.label)
  // The first unfinished step is the one to act on, so it decides the status.
  const first = missing[0] ?? ''
  if (/登录|注册|login|auth/i.test(first)) return 'not_authenticated'
  if (/认证|开发者|certif/i.test(first)) return 'service_inactive'
  if (/开通|服务|plan|subscri/i.test(first)) return 'service_inactive'
  return 'failed'
}

/** Turn the unfinished steps into instructions, in the order the CLI lists them. */
function doctorNextSteps(steps: readonly DoctorStep[]): readonly string[] {
  if (steps.length === 0) {
    return ['运行 weibo-cli doctor 查看具体缺哪一步', '完成认证 / 开通服务 / 登录后重试']
  }
  return steps
    .filter((step) => !step.ok)
    .map((step) => `完成「${step.label}」后重试`)
    .concat(['然后运行 weibo-cli doctor 确认全部为 ✓'])
}

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
  readonly group: string
  readonly action: string
  /** `group action`, for display and for the fake CLI's matching. */
  readonly name: string
  readonly description?: string
  readonly priceType?: string
  /** `allowed` / `locked` as the catalog reports it. Locked rows are listed but not callable. */
  readonly access?: string
  /** Flag names this command accepts, when the catalog row already carried them. */
  readonly flags?: readonly string[]
}

/**
 * The account's available command list.
 *
 * This is the only authority on "what can I call". Nothing in this module hard-codes a
 * command name for a *read*: the manual gives `commands list` / `commands show` as the
 * discovery mechanism, and inventing an endpoint path from memory is exactly what the
 * task book forbids.
 */
export async function listAvailableCommands(): Promise<WeiboCliCall<readonly WeiboCliCommand[]>> {
  const result = await runCli(['commands', 'list', '--available', '--output', 'json'])
  if (result.code !== 0) {
    const classified = classifyFailure(result.stderr, result.stdout)
    return { status: classified.status, message: classified.message }
  }
  const parsed = parseCliJson<{ commands?: unknown; data?: unknown }>(result.stdout)
  if (!parsed.ok) return { status: 'failed', message: parsed.reason }

  const source = parsed.data
  const list = Array.isArray(source)
    ? source
    : Array.isArray((source as { commands?: unknown }).commands)
      ? ((source as { commands: unknown[] }).commands as unknown[])
      : Array.isArray((source as { data?: unknown }).data)
        ? ((source as { data: unknown[] }).data as unknown[])
        : undefined
  if (list === undefined) {
    return { status: 'failed', message: 'CLI 的命令清单结构与预期不符：找不到命令数组。' }
  }

  const commands: WeiboCliCommand[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    // ## The fields are `group` and `action` (v0.2.13, verified against official source)
    //
    // v0.2.12 looked for `name` / `command` / `path`, none of which the catalog sends, so every
    // row was skipped and the list was always empty — the capability check then reported "no read
    // command" for an account that had one.
    const group = typeof record.group === 'string' ? record.group.trim() : ''
    const action = typeof record.action === 'string' ? record.action.trim() : ''
    if (group === '' || action === '') continue
    const flags: string[] = []
    if (Array.isArray(record.flags)) {
      for (const flag of record.flags) {
        if (typeof flag === 'object' && flag !== null) {
          const name = (flag as { name?: unknown }).name
          if (typeof name === 'string' && name.trim() !== '') flags.push(name.trim().toLowerCase())
        } else if (typeof flag === 'string' && flag.trim() !== '') {
          flags.push(flag.trim().toLowerCase())
        }
      }
    }
    commands.push({
      group,
      action,
      name: `${group} ${action}`,
      ...(flags.length === 0 ? {} : { flags }),
      ...(typeof record.access === 'string' ? { access: record.access } : {}),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(typeof record.price_type === 'string' ? { priceType: record.price_type } : {}),
    })
  }
  return { status: 'ok', message: `发现 ${commands.length} 条可用命令。`, data: commands }
}

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
export function classifyCommands(
  commands: readonly WeiboCliCommand[],
): { readonly statuses: boolean; readonly comments: boolean } {
  const names = commands.map((command) => command.name.toLowerCase())
  return {
    statuses: names.some((name) => /status|weibo|post/.test(name) && /show|get|read|detail/.test(name)),
    comments: names.some((name) => /comment/.test(name) && /list|show|get|read/.test(name)),
  }
}

/** What one command's own schema says it accepts. */
export interface WeiboCliCommandSchema {
  readonly name: string
  /** Parameter names the command accepts, lowercased. */
  readonly parameters: readonly string[]
  /** Which of them the catalog marks as required. */
  readonly required: readonly string[]
  /**
   * The same parameters with the type the catalog declared.
   *
   * `parameters` remains the flat name list because dozens of call sites and tests use it. This
   * carries the extra facts the invocation plan needs — chiefly whether a parameter is required —
   * so the plan does not have to re-derive them from two parallel arrays.
   */
  readonly typedParameters: readonly {
    readonly name: string
    readonly type?: string
    readonly required: boolean
  }[]
  /**
   * Whether the parameter list was actually parsed, or the response shape was unrecognised.
   *
   * `unknown` must never be treated as "no required parameters": a schema we could not read is
   * a schema we have not verified, which is the opposite of what `usable` is for.
   */
  readonly evidence: 'parsed' | 'unknown'
  /**
   * The flag this CLI uses to scope a comment read to one parent comment, when the catalog
   * lists one. Absent means "we never learned how", and a nested read must then refuse rather
   * than invent a flag name.
   */
  readonly nestedFilterFlag?: string
  /** True when every required parameter is one this layer can actually supply. */
  readonly usable: boolean
  /** Why it is not usable, when it is not. */
  readonly reason?: string
}

/**
 * The argument names this layer is able to supply, and what it sends for each.
 *
 * ## Why a table rather than a regex (v0.2.12 audit)
 *
 * The first version decided "can we fill this?" with two patterns. That was wrong twice over:
 *
 * 1. **A name that looks like paging is not a name we can feed.** `PAGE_LIKE` matched
 *    `cursor` / `since` / `max_id` / `count` / `limit`, but `provider.ts` only ever sends
 *    `--page`. So a command whose *required* parameter was `cursor` was declared usable and
 *    then invoked **without it** — the guard did nothing while claiming to have checked.
 *
 * 2. **Unanchored substring matching.** `discount` contains `count`, `homepage_id` contains
 *    `page`. A required `--discount` looked fillable.
 *
 * The table below is the single source of truth: a name is fillable **only** if it appears
 * here, and the argv builder for it is the same one the adapter uses. If a future read needs a
 * new parameter, it has to be added here *and* in the invocation — the two cannot drift.
 */
/**
 * The argument names this layer can supply, and the argv each one produces.
 *
 * ## Positional arguments do not work here (v0.2.13, verified against official source)
 *
 * v0.2.12 asserted "the catalog's own invocation form is `statuses/show <id>`" and returned an
 * empty argv for every id-shaped parameter, expecting the id to be appended positionally.
 *
 * The official dispatcher is `handleInvoke = async (group, action, flags) => …` called as
 * `handleInvoke(command, subcommand, flags)` — **there is no `rest` parameter**. A positional
 * argument after the action is therefore **silently dropped**: the request goes out with no id at
 * all, and the CLI reports no error. That is worse than a rejection, because it looks like a
 * successful call.
 *
 * Every business parameter is a flag, and the body the CLI sends is built from `flags` alone. So
 * each entry below produces `['--name', value]`.
 *
 * ## Why names are plural-aware
 *
 * The official examples use `--ids` (plural) for the batch status read and `--id` for comments.
 * Both spellings are accepted here; which one is used is decided by what the command's own
 * `flags[]` lists, so we never send a flag the command does not declare.
 */
const FILLABLE_ARGUMENTS: Readonly<Record<string, (context: ReadArgContext) => readonly string[]>> = {
  id: (context) => ['--id', context.threadId],
  idstr: (context) => ['--idstr', context.threadId],
  mid: (context) => ['--mid', context.threadId],
  status_id: (context) => ['--status_id', context.threadId],
  weibo_id: (context) => ['--weibo_id', context.threadId],
  post_id: (context) => ['--post_id', context.threadId],
  ids: (context) => ['--ids', context.threadId],
  // Paging. `page` is the knob the adapter turns; `count` is sent when the command offers it.
  page: (context) => (context.paged ? ['--page', String(context.page)] : []),
  count: (context) => (context.count === undefined ? [] : ['--count', String(context.count)]),
}

/** What the caller knows when it asks "can I build a valid invocation?". */
export interface ReadArgContext {
  /** The post id this read is about. Placed **as a flag value**, never positionally. */
  readonly threadId: string
  /** Whether this read pages at all. */
  readonly paged: boolean
  /** The page number for this read; ignored when `paged` is false. */
  readonly page: number
  /** Page size, when the command declares a `count` flag. */
  readonly count?: number
  /**
   * The flag this CLI uses to scope a comment read to one parent comment, once discovered.
   *
   * Absent means "we never learned how to ask for nested replies", and a call that needs it
   * must refuse rather than invent a flag name.
   */
  readonly nestedFilterFlag?: string
}

/**
 * Whether a required parameter name is one we can actually supply.
 *
 * Kept as a function so the table lookup is the only way in — a caller cannot accidentally
 * reintroduce a pattern match.
 */
export function canFillArgument(name: string, context: ReadArgContext): boolean {
  const builder = FILLABLE_ARGUMENTS[name]
  if (builder === undefined) return false
  // `page` only makes sense for a paged read; requiring it on an unpaged one would make every
  // such command look unusable.
  if (name === 'page' && !context.paged) return true
  return builder(context) !== undefined
}

/** Whether the CLI can express "replies to this one comment" at all. */
export function nestedFilterSupported(parameters: readonly string[]): string | undefined {
  // These are the plausible spellings. The point is not to guess which one the server uses —
  // it is to accept only a name the catalog actually lists, and report `undefined` otherwise.
  const candidates = ['parent_id', 'comment_id', 'reply_to', 'to_comment', 'root_id', 'cid']
  return candidates.find((candidate) => parameters.includes(candidate))
}

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
export async function inspectCommand(
  command: { readonly group: string; readonly action: string },
  context: ReadArgContext = { threadId: '', paged: true, page: 1 },
): Promise<WeiboCliCall<WeiboCliCommandSchema>> {
  // ## Two positional arguments, not one (v0.2.13, verified against official source)
  //
  // The official CLI reads `const group = rest[0]; const action = rest[1]` and throws
  // `Usage: weibo-cli commands show <group> <action>` when either is missing. v0.2.12 passed a
  // single combined name, so every call threw before any catalog information was read — the
  // capability check could never succeed regardless of the account's real permissions.
  //
  // Both values come from the catalog, not from user input, but they still go in as separate
  // argv elements — never concatenated into a command line.
  const result = await runCli([
    'commands',
    'show',
    command.group,
    command.action,
    '--output',
    'json',
  ])
  const name = `${command.group} ${command.action}`
  if (result.code !== 0) {
    const classified = classifyFailure(result.stderr, result.stdout, result.errorCode)
    return { status: classified.status, message: classified.message }
  }
  const parsed = parseCliJson<Record<string, unknown>>(result.stdout)
  if (!parsed.ok) return { status: 'failed', message: parsed.reason }

  const body = parsed.data
  // ## Where the parameter list actually lives (v0.2.13, verified against official source)
  //
  // The official `commands show` payload puts the command's parameters in **`flags`**, each
  // `{name, type, required, description, enum}`. v0.2.12 never looked there — it searched
  // `params` / `parameters` / `schema.params` / `properties`, none of which the CLI sends — so
  // even after the two-argument fix every command would have parsed as "no parameters", and the
  // "can I supply the required ones" check would have answered from an empty list.
  //
  // The other shapes stay in the chain because a differently-versioned CLI may answer in one of
  // them, and accepting several costs nothing as long as `flags` is tried first.
  const parsedParams =
    asArray(body.flags) ??
    asArray(body.params) ??
    asArray(body.parameters) ??
    asArray((body.command as Record<string, unknown> | undefined)?.flags) ??
    asArray(body) ??
    asArray((body.schema as Record<string, unknown> | undefined)?.params) ??
    asArray((body.schema as Record<string, unknown> | undefined)?.parameters) ??
    asArray((body.schema as Record<string, unknown> | undefined)?.properties) ??
    asArray((body.input as Record<string, unknown> | undefined)?.params) ??
    asArray((body.input as Record<string, unknown> | undefined)?.properties)

  // `undefined` (unrecognised shape) is different from `[]` (a genuinely parameterless
  // command), and the two must not collapse into the same verdict.
  const evidence: 'parsed' | 'unknown' = parsedParams === undefined ? 'unknown' : 'parsed'
  const rawParams = parsedParams ?? []

  const parameters: string[] = []
  const required: string[] = []
  const typed: { name: string; type?: string; required: boolean }[] = []
  /** Record one parameter once, merging a later sighting into the earlier row. */
  const note = (name: string, type: string | undefined, isRequired: boolean): void => {
    const lower = name.toLowerCase()
    if (!parameters.includes(lower)) parameters.push(lower)
    if (isRequired && !required.includes(lower)) required.push(lower)
    const existing = typed.find((row) => row.name === lower)
    if (existing === undefined) {
      typed.push({
        name: lower,
        ...(type === undefined ? {} : { type }),
        required: isRequired,
      })
      return
    }
    // A parameter that appears twice (property list + sibling `required` array) is required if
    // either sighting says so.
    if (isRequired) existing.required = true
    if (existing.type === undefined && type !== undefined) existing.type = type
  }

  for (const entry of rawParams) {
    if (typeof entry === 'string') {
      note(entry, undefined, false)
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const paramName = [record.name, record.key, record.param].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    )
    if (paramName === undefined) continue
    const declaredType = [record.type, record.value_type].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    )
    note(paramName, declaredType, record.required === true || record.is_required === true)
  }

  // A JSON-schema-style sibling `required: ["mid"]` array names parameters without repeating
  // them per property. The first version only read each property's own `required` flag, so a
  // standard schema always yielded an empty list. Merging both sources is what makes that
  // shape readable.
  const siblingRequired = [body.required, (body.schema as Record<string, unknown> | undefined)?.required]
  for (const candidate of siblingRequired) {
    if (!Array.isArray(candidate)) continue
    for (const name of candidate) {
      if (typeof name !== 'string') continue
      note(name, undefined, true)
    }
  }

  const unfillable = required.filter((param) => !canFillArgument(param, context))
  const nestedFlag = nestedFilterSupported(parameters)

  const schema: WeiboCliCommandSchema = {
    name,
    parameters,
    required,
    typedParameters: typed,
    evidence,
    ...(nestedFlag === undefined ? {} : { nestedFilterFlag: nestedFlag }),
    // A schema we could not parse can never be "usable": the whole point of this check is to
    // confirm the shape before invoking.
    usable: evidence === 'parsed' && unfillable.length === 0,
    ...(evidence === 'unknown'
      ? {
          reason:
            `命令 ${name} 返回的参数 schema 结构无法识别，不能据此断定可以调用；` +
            '无法确认要传哪些参数时不调用，猜测等于伪造请求。',
        }
      : unfillable.length === 0
        ? {}
        : {
            reason:
              `命令 ${name} 要求必填参数 ${unfillable.join('、')}，本插件只会传帖子 id 与 --page；` +
              '猜一个值去调用等于伪造请求，所以不调用。',
          }),
  }
  return { status: 'ok', message: `已读取 ${name} 的参数。`, data: schema }
}

/** Accept an array stored directly or under a `properties`-style wrapper. */
function asArray(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null) {
    const properties = (value as { properties?: unknown }).properties
    if (Array.isArray(properties)) return properties
    if (typeof properties === 'object' && properties !== null) {
      // JSON-schema `properties` is a map; the parameter names are its keys.
      return Object.keys(properties as Record<string, unknown>).map((key) => {
        const spec = (properties as Record<string, unknown>)[key]
        const required =
          typeof spec === 'object' && spec !== null && (spec as { required?: unknown }).required === true
        return { name: key, required }
      })
    }
  }
  return undefined
}

/**
 * A read that actually ran.
 *
 * `data` is present only on success; every other field combination is a refusal with a
 * reason, which is what lets the caller report *why* instead of "failed".
 */
export interface WeiboCliRead<T> {
  readonly status: WeiboCliStatus
  readonly message: string
  readonly data?: T
  /** The command that was invoked, for the diagnostic panel. */
  readonly command?: string
  /** Milliseconds the invocation took. */
  readonly elapsedMs?: number
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
export async function runReadCommand<T>(
  command: { readonly group: string; readonly action: string; readonly name?: string },
  args: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): Promise<WeiboCliRead<T>> {
  const started = Date.now()
  const displayName = command.name ?? `${command.group} ${command.action}`
  // ## The group and the action are separate argv elements (v0.2.13)
  //
  // The official form is `weibo <group> <action> [flags]`. Passing a combined "group action"
  // string would make the CLI read the whole thing as the group and find no action.
  //
  // Everything after the pair is a flag. There is no positional id: the official dispatcher
  // (`handleInvoke = async (group, action, flags)`) has no `rest` parameter, so a positional
  // value is dropped without an error — the request would go out with no id at all.
  const result = await runCli(
    [command.group, command.action, ...args, '--output', 'json'],
    options.timeoutMs,
  )
  const elapsedMs = Date.now() - started
  if (result.code !== 0) {
    const classified = classifyFailure(result.stderr, result.stdout, result.errorCode)
    return { status: classified.status, message: classified.message, command: displayName, elapsedMs }
  }
  const parsed = parseCliJson<T>(result.stdout)
  if (!parsed.ok) return { status: 'failed', message: parsed.reason, command: displayName, elapsedMs }
  return { status: 'ok', message: `${displayName} 执行成功。`, data: parsed.data, command: displayName, elapsedMs }
}
