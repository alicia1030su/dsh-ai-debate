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

import { credentialEnvForCli } from './credential-state.js'

/** The binary name; resolved through PATH exactly as the manual documents it. */
const BINARY = 'weibo-cli'

/** How long one CLI invocation may take before it is killed. */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 进程创建失败的错误码（v0.2.33）。
 *
 * 与 ENOENT 分开：ENOENT 是「路径上没有这个程序」，而这几个是「机器当时创建不出
 * 进程」。前者要装东西，后者要等一等或关掉一些程序——两件事的下一步没有任何交集。
 */
const SPAWN_RESOURCE_ERRORS: ReadonlySet<string> = new Set([
  'EAGAIN', // 进程数/句柄耗尽（Windows 上常见于并发很高的时刻）
  'EMFILE', // 文件/句柄描述符用尽
  'ENFILE', // 系统级句柄用尽
  'EPERM', // 安全软件或策略拦住进程创建
  'ENOMEM', // 内存不足
])

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
 * 本进程启动过多少次 CLI 子进程，以及它们一共占了多少毫秒（v0.2.33 §七）。
 *
 * ## 为什么要数次数
 *
 * 耗时随机器负载浮动，同一份代码在两台机器上可以差一倍；**次数是结构性的**。
 * 一次读取启动 9 个 `weibo-cli`，就是 9 次进程创建、9 次 PowerShell 凭据读取——
 * 这是可以直接对着代码审查的量，也是本版真正要降下来的量。
 *
 * 计数点在真正 spawn 的地方（`attempt` 内部），不在函数入口：被只读守卫拦下的调用
 * 没有创建任何进程，把它算进去会让「子进程次数」这个数字失去意义。
 */
let cliInvocations = 0
let cliTotalMs = 0
/**
 * 在队列里等别人先跑完的毫秒数（v0.2.34）。
 *
 * 与 `cliTotalMs` 分开记：前者是「我们的调度」，后者是「子进程自己的耗时」。
 * 混在一起会让「这次读取为什么慢」又变成一个只能猜的问题。
 */
let cliQueueWaitMs = 0

/** 读当前计数。返回副本，调用方改不动内部状态。 */
export function cliMetrics(): {
  readonly invocations: number
  readonly totalMs: number
  readonly queueWaitMs: number
} {
  return { invocations: cliInvocations, totalMs: cliTotalMs, queueWaitMs: cliQueueWaitMs }
}

/** 归零。**测试 only**：一个测试不该看见上一个测试的进程数。 */
export function __resetCliMetrics(): void {
  cliInvocations = 0
  cliTotalMs = 0
  cliQueueWaitMs = 0
}

/**
 * ## 为什么子进程要排队，而不是并发（v0.2.34 实测推翻了 v0.2.33 的做法）
 *
 * v0.2.33 把 `probeWeiboCli()` 与 `listAvailableCommands()` 改成了并发，理由是
 * 「两条探测互不依赖」。理由没错，但**收益是零，代价是真实的**：
 *
 * `@weibo-ai/weibo-cli@0.9.8` 的每个进程都要自己解析一次令牌（`resolveToken` →
 * `getAccessToken`），而它的访问令牌缓存是**进程内**的 —— 于是每启动一个
 * `weibo-cli`，就完整刷新一次：拿文件锁 + 读保管库 + POST + 写保管库。
 *
 * 本机实测（development 命名空间，避免碰真实登录）：
 *
 * | 操作 | 耗时 |
 * | --- | --- |
 * | `keychainGet` | 1876 ms |
 * | `keychainSet` | 3597 ms |
 * | 一次刷新持锁合计 | ≈ 5.5 s |
 * | CLI 自己的等锁上限 | 15 s |
 *
 * 于是并发 2 个：一个先拿锁刷 5.5 秒，另一个等 5.5 秒再刷一次 —— **和串行一样快**，
 * 却多刷了一次令牌。并发 3 个：第三个要等 11 秒，再遇上机器慢一点就撞上 15 秒上限，
 * `getAccessToken` 在超时分支 `catch` 掉异常返回 null，CLI 于是打印
 * 「缺少登录令牌」。主人看到的是**登录状态消失了**，而真正发生的是排队超时。
 *
 * 受控实验（8 个进程、假 OAuth 服务、一次性 refresh token）：
 * 并发时服务端收到 8 次刷新、7 次 `invalid_grant`；串行后 0 次。
 *
 * 所以这里改回串行 —— 不是为了保守，是因为并发在这个 CLI 上**没有可换取的收益**。
 * `version` / `help` 不解析令牌，不进队列（它们不该被一次 6 秒的 doctor 堵住）。
 */
const NO_TOKEN_COMMANDS: ReadonlySet<string> = new Set(['version', 'help'])

function needsToken(args: readonly string[]): boolean {
  const head = (args[0] ?? '').toLowerCase()
  return !NO_TOKEN_COMMANDS.has(head)
}

/**
 * 暴露给测试的分类函数。**测试 only**：它只回答「这条命令会不会去解析令牌」，
 * 不改任何状态、不启动任何进程。
 */
export function __needsTokenForTest(args: readonly string[]): boolean {
  return needsToken(args)
}

let cliQueue: Promise<unknown> = Promise.resolve()

/**
 * 排队等一个「会解析令牌」的槽位。
 *
 * 排队的代价只有一种：一次读取里的几次探测从「同时开始」变成「依次开始」。
 * 收益是**每个子进程少一次完整刷新**（本机 ≈ 5.5 s 加一次保管库写入），
 * 以及不再出现「第三个进程等锁超时 → 被报成没登录」。
 *
 * `version` / `help` 不走这里：它们不解析令牌，因此不该被一次 6 秒的 `doctor`
 * 堵在队列里——那条路径是诊断面板的响应速度，不是账号状态的探测。
 */
function withTokenSlot<T>(task: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now()
  const run = cliQueue.then(task, task)
  cliQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run.then((value) => {
    cliQueueWaitMs += Math.max(0, Date.now() - queuedAt)
    return value
  })
}

/**
 * 子进程该带什么环境。
 *
 * ## 只改一件事：把 `NODE_ENV` 钉到「凭据实际所在的那套」
 *
 * CLI 用 `NODE_ENV` 同时决定配置目录与保管库服务名，两套凭据互不可见。宿主是
 * 开发构建（或从设了 `NODE_ENV=development` 的终端启动）时，子进程会去
 * `~/.weibo-cli-dev` 找一个从没存在过的登录记录，然后如实回答「缺少登录令牌」。
 *
 * 检测结果为空（两套都没有记录）时**不动环境**：那种情况下「没登录」是真的，
 * 替用户猜一个环境只会把错误藏起来。
 */
function childEnv(): NodeJS.ProcessEnv | undefined {
  const env = credentialEnvForCli()
  if (env === undefined) return undefined
  if (env === (process.env.NODE_ENV === 'development' ? 'development' : 'production')) return undefined
  return { ...process.env, NODE_ENV: env }
}

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
export function __setCliInvocation(next: CliInvocation | undefined): void {
  invocation = next ?? DEFAULT_INVOCATION
  // 换了可执行文件，上一份读到的 schema 也不再描述这台机器了。
  schemaCache.clear()
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

async function runCliOnce(
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
      // 计数点在真正 spawn 的地方，不在函数入口：被只读守卫拦下的调用没有创建任何
      // 进程，把它算进去会让「这次读取启动了几个子进程」这个数字失去意义。
      const spawnStartedAt = Date.now()
      const settle = (result: CliResult): void => {
        /**
         * ## `ENOENT` / `EINVAL` 不算一次子进程
         *
         * 这两种失败都发生在**进程创建之前**：`CreateProcess` 直接拒绝，
         * 没有任何进程被启动。把它们算进「本次读取启动了几个子进程」会让
         * Windows 上的每一次 CLI 调用看起来都是两次——那个数字就不再是
         * 可以被代码审查对照的量了。
         *
         * 它们仍然消耗时间，但那是另一件事（路径解析），不该混进进程账。
         */
        const spawned = result.errorCode !== 'ENOENT' && result.errorCode !== 'EINVAL'
        if (spawned) {
          cliInvocations += 1
          cliTotalMs += Date.now() - spawnStartedAt
        }
        resolve(result)
      }
      try {
        execFile(
          file,
          argv,
          {
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            // 只有「这个客户端要的令牌在另一套环境里」时才改环境；其余情况继承。
            ...(childEnv() === undefined ? {} : { env: childEnv() }),
          },
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
            /**
             * ## 超时（kill 掉的进程）要单独说出来，不能算「调用失败」
             *
             * 实测形状：`timeout` 触发后 `error.code` 是 `null`、`error.killed` 是 `true`、
             * `signal` 是 `SIGTERM`，`stderr` 是空的。按 `code` 分类的话，它会一路掉进
             * `classifyFailure` 的兜底分支，变成「weibo-cli 调用失败。」——一句什么都
             * 没说的话。
             *
             * 这里的区别是有意义的：**超时说明这台机器在 20 秒内没答完**（负载高、
             * 杀毒扫描、网络慢都可能），而「失败」暗示 CLI 自己报错了。用户面对前者
             * 该做的是重试或换个时间，面对后者才需要看输出。混成一句，他会去查一个
             * 不存在的 bug。
             *
             * 这不是假想：一次带 16 个并发进程的测试运行里，`doctor` 超过 20 秒，
             * 测试就把 `failed` 当成了产品结论。而单独跑同一台机器只要 4.5 秒。
             */
            const timedOut = (error as { killed?: boolean } | null)?.killed === true
            settle({
              code: numeric,
              stdout: typeof stdout === 'string' ? stdout : '',
              stderr: typeof stderr === 'string' ? stderr : '',
              ...(timedOut
                ? { errorCode: 'ETIMEDOUT' }
                : typeof rawCode === 'string'
                  ? { errorCode: rawCode }
                  : {}),
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
  return attempt(process.execPath, [entry, ...invocation.prefixArgs, ...args])
}

/**
 * 跑一条 CLI 命令：先过只读守卫，再过令牌队列，最后交给 `runCliOnce`。
 *
 * 守卫在这里**仍然是最先执行的**：一条被拒绝的写命令不该在队列里排 6 秒，
 * 更不该因为排在别人后面而被判成「超时」。
 */
async function runCli(
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string; errorCode?: string }> {
  return needsToken(args)
    ? withTokenSlot(() => runCliOnce(args, timeoutMs))
    : runCliOnce(args, timeoutMs)
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

  /**
   * ## 超时不是「调用失败」
   *
   * `execFile` 在超时杀掉进程时给的是 `code: null` + `killed: true` + 空 stderr，
   * 所以它必须在这里被认出来（`runCli` 会把它标成 `ETIMEDOUT`）。
   *
   * 留在兜底之前是有意的：一台被负载压住的机器，`doctor` 可能 20 秒都答不完，
   * 而那句话会变成「weibo-cli 调用失败」。用户看不出该重试还是该查 bug，
   * 而这两种情况的动作完全不同。
   */
  if (errorCode === 'ETIMEDOUT') {
    return {
      status: 'failed',
      message:
        `weibo-cli 在 ${DEFAULT_TIMEOUT_MS / 1000} 秒内没有返回，已被终止。` +
        '这不是权限问题：可能是机器正忙、杀毒软件在扫描，或网络很慢。过一会儿重试；' +
        '如果每次都超时，在终端里手动运行同一条命令看它卡在哪一步。',
    }
  }

  /**
   * ## 进程根本没创建起来：这不是产品故障，也不是账号问题（v0.2.33）
   *
   * 全量测试并发跑时出现过一次偶发失败：同一个用例单独跑 5 次全过，并发跑时
   * 偶尔报「weibo-cli 调用失败。」——一句什么都没说的话。追下去发现 `error.code`
   * 是 `EAGAIN` / `EMFILE` 一类**进程创建失败**，`stderr` 是空的（没有进程能
   * 写它），于是落进了兜底分支。
   *
   * 这类失败有三个特征：与账号、权限、网络全都无关；重试一次通常会好；
   * 而且**把它说成「调用失败」会让人去查一个不存在的 bug**。
   *
   * 所以单列出来，把系统的原话带上，并明确说这是本机当时的资源状况。
   */
  if (errorCode !== undefined && SPAWN_RESOURCE_ERRORS.has(errorCode)) {
    return {
      status: 'failed',
      message:
        `这台机器当时无法创建 weibo-cli 进程（${errorCode}）。` +
        '这不是账号、权限或网络问题，也不是插件调错了命令：是系统资源（进程句柄、内存）' +
        '或安全软件拦住了进程创建。关掉一些程序后重试；连续出现时检查杀毒软件的白名单。',
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
  /**
   * ## 「缺少登录令牌」是本机实测的原话，之前的正则一条都没匹配上（v0.2.33 §六）
   *
   * `@weibo-ai/weibo-cli@0.9.8` 在没有可用令牌时的真实输出是：
   *
   * ```
   * 缺少登录令牌。请优先确认是否有账号，无账号请先注册，有账号请登录
   * A) 注册-没有微博账号：…
   * B) 登录-已有微博账号：请运行 `weibo-cli auth login`；…
   * ```
   *
   * 这段文字里**没有** `未登录`、`not logged in`、`oauth`、`unauthorized` 中的任何一个。
   * 于是 `commands list` 失败时被归到兜底的 `failed`，面板上写的是
   * 「读不到命令清单：weibo-cli 调用失败。」——一句什么都没说的话。
   *
   * 更糟的是它与「没登录」这个真实原因隔了一层：用户会去查网络、查安装、
   * 查版本，而下一步其实只有一件事：`auth login`。所以 `令牌`、`token`、
   * `auth login` 都要认进来。
   */
  if (
    /not logged in|未登录|no auth|oauth|授权码|login required|unauthori[sz]ed|缺少登录令牌|登录令牌|auth login|auth\s+login/i.test(
      text,
    )
  ) {
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
  /**
   * `version` 与 `doctor` 一次读，且**每次都读**（v0.2.33 §七）。
   *
   * 这两个命令互不依赖，读的也都是「现在」——`version` 说明装的是哪一版，
   * `doctor` 说明账号走到哪一步。并发能让它们共用一次等待窗口，但**不缓存**：
   * 缓存「现在」是这份代码反复出错的地方（CLI 卸载后仍报 ok、令牌失效后仍报
   * 已登录）。省下的 0.6 秒不值得多一份需要失效的状态。
   *
   * `version` 的失败仍然是 `cli_missing` 的第一证据：一个装了但坏掉的二进制
   * 与一个不存在的二进制，`classifyFailure` 分得开。
   */
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
    /**
     * 模板形态下只说一件事：没有令牌。
     *
     * 原来这里输出「注册或登录、完成开发者认证、开通服务 未完成」——把 CLI 的
     * 一句模板当成三个检查结论。而主人可能已经完成认证、体验服务也已经是
     * 「当前服务」，他看到这句话会去重做已经做过的事。
     */
    const template = doctorSteps.length > 0 && doctorStepsAreTemplate(doctorSteps)
    return {
      status,
      message: template
        ? 'weibo-cli 没有可用令牌：这台机器上取不到登录凭据。' +
          '开发者认证与服务开通的状态**本次没有检查**（CLI 没有令牌时会跳过这两项），' +
          '登录之后才能确认。'
        : failed.length > 0
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

/**
 * `doctor` 在没有令牌时给出的三项，是**模板**不是检查结果。
 *
 * ## 这是怎么回事（读 CLI 源码得到的，不是猜的）
 *
 * `@weibo-ai/weibo-cli@0.9.8` 的 `doctor` 是这样写的：
 *
 * ```js
 * if (!token) {
 *   console.log(`${READY_MISSING} 注册或登录`);
 *   console.log(`${READY_MISSING} 完成开发者认证`);
 *   console.log(`${READY_MISSING} 开通服务`);
 *   return;                      // ← 没有令牌就直接返回，后两项一次都没查
 * }
 * const payload = await requestJson(baseUrl, '/cli/whoami', { token });
 * const verified = isDeveloperVerified(identity);
 * const hasService = serviceStatus?.kind === 'trial_active' || ...
 * ```
 *
 * 也就是说：**没有令牌时，后两项是硬编码的 ×，不代表任何事实**。真正被检查过
 * 的只有「注册或登录」这一项。
 *
 * ## 为什么必须在这里处理，不能原样转述
 *
 * v0.2.32 实测撞到了后果：主人已经在开放平台完成开发者实名认证、控制台的
 * 「我的服务」显示体验服务为「当前服务」，而插件的诊断面板写着
 * 「注册或登录、完成开发者认证、开通服务 未完成」——后两句是假的，
 * 而且正好与他要看到的相反。他会以为自己的认证没生效，回去重做一遍。
 *
 * 把这些行原样转述，等于**用 CLI 的一句模板冒充三个检查结论**。
 */
function doctorStepsAreTemplate(steps: readonly DoctorStep[]): boolean {
  if (steps.length < 3) return false
  const login = steps[0]
  if (login === undefined || login.ok) return false
  // 登录没过时，CLI 在 `if (!token)` 里一次性打印三项后返回。
  // 判据是「第一项是登录且三项全 ×」——这正是那段模板的形状。
  return steps.every((step) => !step.ok)
}

/** Turn the unfinished steps into instructions, in the order the CLI lists them. */
function doctorNextSteps(steps: readonly DoctorStep[]): readonly string[] {
  if (steps.length === 0) {
    return ['运行 weibo-cli doctor 查看具体缺哪一步', '完成认证 / 开通服务 / 登录后重试']
  }
  /**
   * 模板形态：只把「登录」当成事实，后两项不写成待办。
   *
   * 让主人去「完成开发者认证」和「开通服务」是有代价的：那两件事要么要本人
   * 实名、要么要付费。在没有证据的情况下催他做，是这份诊断能犯的最贵的错。
   */
  if (doctorStepsAreTemplate(steps)) {
    return [
      '先运行 weibo-cli auth login 重新授权（令牌不在本机，这是唯一确定缺的东西）',
      '登录成功后再运行 weibo-cli doctor —— 它会用 whoami 真正检查认证与服务',
      '在那之前，「开发者认证」与「服务开通」两项的状态是未检查，不是未完成',
    ]
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
 * 命令 schema 的短期缓存（v0.2.33 §七）。
 *
 * ## 一份 schema 在一次读取里被读了两次
 *
 * `resolveReadPlan()` 对正文与评论各走一遍 `choose()`，每次 `inspectCommand`
 * 都是一次真实的 `commands show`（本机实测每次 3 秒以上）。而选择阶段**已经**读过
 * 选中命令的 schema，`getThread()` / `getReplies()` 又从计划里取出参数直接调用——
 * 也就是说，同一次读取里同一份 schema 不该被读第二遍。
 *
 * 缓存键是 `group/action`，值是 schema 本身（**不含任何令牌、不含任何响应正文**）。
 * 有效期 60 秒，与 `plan-cache` 的 `READY_TTL_MS` 同一量级：计划缓存过期时，
 * schema 缓存也一起过期，不会出现「计划说这命令能读、schema 说不能」的分裂。
 *
 * ## 为什么缓存 schema 是安全的，而缓存 doctor 不是
 *
 * schema 描述的是**这条命令的接口形状**（哪些参数必填），它属于 CLI 版本，不属于
 * 账号状态。服务到期、权限被收回时，命令会从 `commands list --available` 里消失，
 * 这一步**每次都重读**，所以凭据状态没有因此被缓存。真正会变的「你能不能用它」
 * 仍然由清单决定。
 */
const SCHEMA_TTL_MS = 60_000

interface SchemaCacheEntry {
  readonly value: WeiboCliCommandSchema
  /** 读到的时刻。过期之后重新读，不让一份旧 schema 永远生效。 */
  readonly at: number
}

const schemaCache = new Map<string, SchemaCacheEntry>()

/** 清空 schema 缓存。**测试 only**。 */
export function __resetSchemaCache(): void {
  schemaCache.clear()
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
  const cacheKey = `${command.group}/${command.action}`
  const cached = schemaCache.get(cacheKey)
  /**
   * 命中条件：还在有效期内，且同一个 `context` 下算出来的结论仍然成立。
   *
   * ## 为什么不能只按命令名命中
   *
   * `usable` 与 `reason` 依赖 `context`（是否分页、要传哪个 id）。同一个命令在
   * 「要页码」和「不要页码」两种上下文里可以给出不同结论。只按命令名缓存，
   * 会把「不能分页」缓存在「不分页」的调用上，或者反过来。所以缓存的是
   * **解析后的 schema**，`usable` 仍按调用方的 context 重新算——见下面的
   * `usableFor()`。
   */
  if (cached !== undefined && Date.now() - cached.at < SCHEMA_TTL_MS) {
    return { status: 'ok', message: `已读取 ${cacheKey} 的参数（缓存命中）。`, data: usableFor(cached.value, context) }
  }

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

  const nestedFlag = nestedFilterSupported(parameters)

  /**
   * 解析结果本身与 `context` 无关，`usable` 才与它有关。
   *
   * 所以缓存里放的是**解析结果**（参数表、必填表、证据层次），`usable` 每次按调用方的
   * context 现算。这样同一个命令在「要页码」和「不要页码」两种上下文里各得各的结论，
   * 而 `commands show` 的进程只启动一次。
   */
  const parsedSchema: WeiboCliCommandSchema = {
    name,
    parameters,
    required,
    typedParameters: typed,
    evidence,
    ...(nestedFlag === undefined ? {} : { nestedFilterFlag: nestedFlag }),
    usable: false,
  }
  schemaCache.set(cacheKey, { value: parsedSchema, at: Date.now() })
  return { status: 'ok', message: `已读取 ${name} 的参数。`, data: usableFor(parsedSchema, context) }
}

/**
 * 把「解析出来的 schema」按本次调用上下文补上 `usable` 与 `reason`。
 *
 * 抽出来是因为它有两个调用点：真读一次之后、命中缓存时。两处必须给出**同一种**
 * 结论，否则「第二次调用和第一次调用不一样」会变成一个只在缓存命中时才出现的 bug。
 */
function usableFor(schema: WeiboCliCommandSchema, context: ReadArgContext): WeiboCliCommandSchema {
  const unfillable = schema.required.filter((param) => !canFillArgument(param, context))
  // A schema we could not parse can never be "usable": the whole point of this check is to
  // confirm the shape before invoking.
  if (schema.evidence === 'unknown') {
    return {
      ...schema,
      usable: false,
      reason:
        `命令 ${schema.name} 返回的参数 schema 结构无法识别，不能据此断定可以调用；` +
        '无法确认要传哪些参数时不调用，猜测等于伪造请求。',
    }
  }
  if (unfillable.length === 0) {
    const { reason: _drop, ...rest } = schema
    void _drop
    return { ...rest, usable: true }
  }
  return {
    ...schema,
    usable: false,
    reason:
      `命令 ${schema.name} 要求必填参数 ${unfillable.join('、')}，本插件只会传帖子 id 与 --page；` +
      '猜一个值去调用等于伪造请求，所以不调用。',
  }
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
