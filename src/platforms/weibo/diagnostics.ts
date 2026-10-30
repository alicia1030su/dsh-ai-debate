/**
 * Diagnostics for the Weibo platform (v0.2.12 §二).
 *
 * ## Why this is not folded into `healthCheck()`
 *
 * The general health report answers "is the plugin configured". A Weibo diagnostic has to
 * answer a different question: **how far along the authorisation chain did we get** — and
 * those are not the same failure. "The CLI is not installed", "the CLI is installed but you
 * never logged in", "you logged in but the service is not activated" and "the service is
 * active but this account lacks the command" each need a different action from the owner.
 *
 * The task book is explicit that `unverified` must not be used to hide a missing
 * implementation. So each field here is derived from a probe that actually ran, and the state
 * distinguishes *not implemented* from *not available right now*.
 *
 * ## What this can and cannot see
 *
 * It can see: whether the binary exists, its version, whether `doctor` passes, which commands
 * the catalog lists, and whether each candidate's required parameters are fillable.
 *
 * It cannot see: the remaining credit balance. The official manual exposes that through
 * `me`/`credit ledger`, and this plugin deliberately does not call a billing command on the
 * owner's behalf — reading a balance spends nothing but the command is not part of the read
 * path, and calling it would be doing account management the task book says not to automate.
 * The field is therefore reported as `unsupported` with that reason, not omitted silently.
 */

import type { WeiboCliStatus } from './cli.js'

/**
 * The distinct diagnoses.
 *
 * `not_implemented` is separate from every runtime failure because it is the one state the
 * owner cannot fix by installing or authorising anything — and the task book requires it to
 * be visible rather than hidden behind `unverified`.
 */
export type WeiboDiagnosisState =
  /** The adapter has no read path at all for this feature. */
  | 'not_implemented'
  /** `weibo-cli` is not on PATH. */
  | 'cli_missing'
  /** Installed, but no OAuth login is bound to this machine. */
  | 'not_authorised'
  /** Logged in, but developer qualification or service activation is missing. */
  | 'service_inactive'
  /** Authorised and active, but this account's catalog lacks the command. */
  | 'permission_insufficient'
  /** The command exists and runs, but the quota or rate limit is exhausted. */
  | 'quota_exhausted'
  /** A read actually completed. */
  | 'read_ok'
  /** Something else went wrong; `message` carries the detail. */
  | 'failed'
  /**
   * The platform answered with a *different* post than the one requested (v0.2.14 §二).
   *
   * Distinct from `malformed_response`: the payload was perfectly readable, it was simply not
   * the target. Conflating the two would hide an identity problem inside a parsing problem.
   */
  | 'target_mismatch'

/** One line of the diagnostic. */
export interface WeiboDiagnosticLine {
  readonly state: WeiboDiagnosisState
  /** What to show the owner, already safe to display. */
  readonly message: string
  /** What the owner can do about it, when there is something. */
  readonly steps: readonly string[]
}

/** The full Weibo diagnostic block. */
export interface WeiboDiagnostics {
  /** Whether `weibo-cli` was found. */
  readonly cliInstalled: boolean
  /** The CLI's own version string, when it answered. */
  readonly cliVersion?: string
  /** Whether an OAuth login is bound. */
  readonly oauthLoggedIn: boolean
  /** Whether the developer qualification and service are usable. */
  readonly serviceActive: boolean
  /** The catalog entry that would drive `getThread`, when one validated. */
  readonly threadCommand?: string
  /** The catalog entry that would drive `getReplies`, when one validated. */
  readonly commentCommand?: string
  /** Credit or plan information — only when an official command exposes it. */
  readonly quota: WeiboDiagnosticLine
  /** The most recent real read, when one happened this process. */
  readonly lastRead?: {
    readonly ok: boolean
    readonly at: string
    /** How far it got: `thread` or `comments`. */
    readonly stage: string
    readonly message: string
  }
  /** The most recent error, whichever stage produced it. */
  readonly lastError?: {
    readonly at: string
    readonly state: WeiboDiagnosisState
    readonly message: string
  }
  /** One line per aspect, for direct rendering. */
  readonly lines: readonly WeiboDiagnosticLine[]
}

/** Mutable diagnostics recorder, kept per adapter instance. */
export interface WeiboDiagnosticRecorder {
  readonly recordRead: (ok: boolean, stage: string, message: string) => void
  readonly recordError: (state: WeiboDiagnosisState, message: string) => void
  readonly snapshot: () => Pick<WeiboDiagnostics, 'lastRead' | 'lastError'>
}

/**
 * Create a recorder.
 *
 * Kept as a small object rather than module state so two adapters (a test one and a real one)
 * cannot overwrite each other's history.
 */
export function createDiagnosticRecorder(): WeiboDiagnosticRecorder {
  let lastRead: WeiboDiagnostics['lastRead']
  let lastError: WeiboDiagnostics['lastError']
  return {
    recordRead(ok, stage, message) {
      lastRead = { ok, at: new Date().toISOString(), stage, message }
      if (!ok) lastError = { at: new Date().toISOString(), state: 'failed', message }
    },
    recordError(state, message) {
      lastError = { at: new Date().toISOString(), state, message }
    },
    snapshot() {
      return {
        ...(lastRead === undefined ? {} : { lastRead }),
        ...(lastError === undefined ? {} : { lastError }),
      }
    },
  }
}

/**
 * Map a CLI status to a diagnosis state.
 *
 * The CLI layer already distinguishes six statuses; this is the mapping into the vocabulary
 * the settings page speaks. Keeping it a pure function means the mapping is testable without
 * spawning anything.
 */
export function diagnosisOfStatus(status: WeiboCliStatus): WeiboDiagnosisState {
  switch (status) {
    case 'ok':
      return 'read_ok'
    case 'cli_missing':
      return 'cli_missing'
    case 'not_authenticated':
      return 'not_authorised'
    case 'service_inactive':
      return 'service_inactive'
    case 'command_unavailable':
      return 'permission_insufficient'
    case 'quota_exhausted':
      return 'quota_exhausted'
    case 'failed':
      return 'failed'
  }
}

/** Assemble the display lines from the probe facts. */
export function buildDiagnosticLines(input: {
  readonly cliInstalled: boolean
  readonly cliVersion?: string
  readonly oauthLoggedIn: boolean
  readonly serviceActive: boolean
  readonly threadCommand?: string
  readonly commentCommand?: string
  readonly threadProblem?: string
  readonly commentProblem?: string
  readonly readinessState: WeiboDiagnosisState
  readonly readinessMessage: string
  readonly readinessSteps: readonly string[]
  readonly lastRead?: WeiboDiagnostics['lastRead']
  readonly lastError?: WeiboDiagnostics['lastError']
  /**
   * Why each command was chosen, when more than one candidate existed (v0.2.14 §五.9).
   *
   * Rendered as its own line so the owner sees the choice, not just its result: a read that
   * fails because the wrong command was picked looks identical to one that fails for lack of
   * permission, and only this text tells them apart.
   */
  readonly selectionNotes?: readonly string[]
  /**
   * Why nested replies are or are not available (v0.2.14 §四.8).
   *
   * The capability table says yes or no; this says why, which is what turns an "unverified"
   * answer into something the owner can act on.
   */
  readonly nestedCapability?: {
    readonly available: boolean
    readonly state: string
    readonly reason: string
  }
}): WeiboDiagnosticLine[] {
  const lines: WeiboDiagnosticLine[] = []

  lines.push(
    input.cliInstalled
      ? {
          state: 'read_ok',
          message: `weibo-cli 已安装${input.cliVersion === undefined ? '' : `（${input.cliVersion}）`}`,
          steps: [],
        }
      : {
          state: 'cli_missing',
          message: 'weibo-cli 未安装：本机没有这个命令。',
          steps: ['运行 npm install -g @weibo-ai/weibo-cli（需要 Node.js 18 或更高）'],
        },
  )

  // ## Why "unknown" is its own line rather than "not completed"
  //
  // When the CLI is absent, its `doctor` never ran, so we have **no evidence** about the
  // OAuth login or the service entitlement. Reporting them as "未完成" would be a claim we
  // cannot support, and the owner would go look for a login problem that may not exist.
  // `not_implemented` is the honest label: this build could not find out.
  if (!input.cliInstalled) {
    const unknown = '未知：CLI 未安装，这一项无法检查'
    lines.push({ state: 'not_implemented', message: `OAuth 登录：${unknown}`, steps: [] })
    lines.push({ state: 'not_implemented', message: `开发者认证与服务：${unknown}`, steps: [] })
  } else {
    lines.push(
      input.oauthLoggedIn
        ? { state: 'read_ok', message: 'OAuth 登录：已完成', steps: [] }
        : {
            state: 'not_authorised',
            message: 'OAuth 登录：未完成',
            steps: ['运行 weibo-cli auth login（桌面环境会打开浏览器）'],
          },
    )

    lines.push(
      input.serviceActive
        ? { state: 'read_ok', message: '开发者认证与服务：可用', steps: [] }
        : {
            state: 'service_inactive',
            message: '开发者认证或服务：未开通',
            steps: [
              '在微博控制台用微博客户端扫码完成开发者认证',
              '在「我的服务」领取体验服务（7 天），或购买积分包',
            ],
          },
    )
  }

  lines.push(
    input.threadCommand === undefined
      ? {
          state: input.cliInstalled ? 'permission_insufficient' : 'cli_missing',
          message: `正文读取命令：不可用${input.threadProblem === undefined ? '' : `（${input.threadProblem}）`}`,
          steps: input.cliInstalled ? ['运行 weibo-cli commands list --available 查看本账号可用的命令'] : [],
        }
      : { state: 'read_ok', message: `正文读取命令：${input.threadCommand}`, steps: [] },
  )

  lines.push(
    input.commentCommand === undefined
      ? {
          state: input.cliInstalled ? 'permission_insufficient' : 'cli_missing',
          message: `评论读取命令：不可用${input.commentProblem === undefined ? '' : `（${input.commentProblem}）`}`,
          steps: input.cliInstalled ? ['同上：先确认命令清单，再确认它的必填参数'] : [],
        }
      : { state: 'read_ok', message: `评论读取命令：${input.commentCommand}`, steps: [] },
  )

  // The summary line: the single most useful sentence about whether a read can run now.
  lines.push({
    state: input.readinessState,
    message: input.readinessMessage,
    steps: input.readinessSteps,
  })

  if (input.lastRead !== undefined) {
    lines.push({
      state: input.lastRead.ok ? 'read_ok' : 'failed',
      message:
        `最近一次真实读取（${input.lastRead.stage}）：` +
        `${input.lastRead.ok ? '成功' : '失败'} · ${input.lastRead.at} · ${input.lastRead.message}`,
      steps: [],
    })
  } else {
    lines.push({
      state: 'not_implemented',
      message: '最近一次真实读取：本进程内还没有执行过（不代表失败，也不代表成功）',
      steps: [],
    })
  }

  if (input.lastError !== undefined) {
    lines.push({
      state: input.lastError.state,
      message: `最后一次错误：${input.lastError.message}（${input.lastError.at}）`,
      steps: [],
    })
  }

  // ## The two answers the capability booleans cannot give
  if (input.nestedCapability !== undefined) {
    const nested = input.nestedCapability
    lines.push({
      // `unverified` is deliberately not `read_ok`: the page must not show a green badge for a
      // capability the schema did not confirm.
      state: nested.available
        ? 'read_ok'
        : nested.state === 'unverified'
          ? 'not_implemented'
          : 'permission_insufficient',
      message: `子评论读取：${nested.available ? '可用' : nested.state === 'unverified' ? '未确认' : '不可用'}`,
      steps: [nested.reason],
    })
  }

  if (input.selectionNotes !== undefined && input.selectionNotes.length > 0) {
    lines.push({
      state: 'read_ok',
      message: '命令选择',
      steps: [...input.selectionNotes],
    })
  }

  return lines
}
