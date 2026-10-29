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
 * Run one CLI command and capture stdout/stderr.
 *
 * Uses `execFile`, which takes an argument array and spawns the binary directly — the
 * documented way to invoke a tool without a shell. `shell` is never enabled, so no
 * character in any argument can be reinterpreted as syntax.
 */
async function runCli(
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string; errorCode?: string }> {
  return new Promise((resolve) => {
    execFile(
      BINARY,
      [...args],
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
        resolve({
          code: numeric,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          ...(typeof rawCode === 'string' ? { errorCode: rawCode } : {}),
        })
      },
    )
  })
}

/**
 * Classify a failed invocation by what its stderr says.
 *
 * The CLI's own vocabulary, per the manual: it "prompts the specific reason" when the
 * balance is short, the service is not activated, or qualification is missing. We match
 * on those words rather than on exit codes, because the manual does not promise distinct
 * codes and guessing one would be worse than matching text.
 */
function classifyFailure(
  stderr: string,
  stdout: string,
  errorCode?: string,
): { status: WeiboCliStatus; message: string } {
  const text = scrubCredentials(`${stderr}\n${stdout}`).toLowerCase()

  // A missing binary has an empty stderr — the `error.code` is the only evidence.
  if (errorCode === 'ENOENT' || /enoent|command not found|不是内部或外部命令/.test(text)) {
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
 * Parse one JSON document out of CLI output.
 *
 * The CLI prints JSON when asked (`--output json`); some commands may precede it with a
 * progress line, so this takes the first `{`…last `}` span rather than assuming the whole
 * stdout is the document. A payload that does not parse is a hard failure — returning a
 * partial object would let a caller treat "unreadable" as "empty".
 */
export function parseCliJson<T>(stdout: string): { ok: true; data: T } | { ok: false; reason: string } {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, reason: 'CLI 没有输出 JSON 对象' }
  const slice = stdout.slice(start, end + 1)
  try {
    return { ok: true, data: JSON.parse(slice) as T }
  } catch (error) {
    return { ok: false, reason: `CLI 输出的 JSON 无法解析：${(error as Error).message}` }
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
  if (doctor.code !== 0) {
    const classified = classifyFailure(doctor.stderr, doctor.stdout, doctor.errorCode)
    return {
      status: classified.status,
      message: classified.message,
      version: versionText,
      canRead: false,
      steps: [
        '运行 weibo-cli doctor 查看具体缺哪一步',
        '完成认证 / 开通服务 / 登录后重试',
      ],
    }
  }

  // `doctor` succeeding means authentication and service are in place. It is still one
  // more local check than a real read, so the caller must not advertise `supported` on
  // the strength of this alone.
  return {
    status: 'ok',
    message: 'weibo-cli 已就绪（认证与服务均已通过本地检查）。',
    version: versionText,
    canRead: true,
    steps: [],
  }
}

/** One row of `commands list --available`. */
export interface WeiboCliCommand {
  readonly name: string
  readonly description?: string
  readonly priceType?: string
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
    // The manual shows `users show/biz` style names; accept whichever field carries it.
    const name = [record.name, record.command, record.path].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    )
    if (name === undefined) continue
    commands.push({
      name,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(typeof record.price_type === 'string' ? { priceType: record.price_type } : {}),
    })
  }
  return { status: 'ok', message: `发现 ${commands.length} 条可用命令。`, data: commands }
}

/**
 * Whether the available list contains a read command we could use.
 *
 * Used to decide capability states. Deliberately matches on family words the manual uses
 * rather than on an exact string this file invented — the catalog's exact spelling comes
 * from the server, so we look for the *shape* of a status/comment read and let the owner
 * see the raw list if nothing matches.
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
