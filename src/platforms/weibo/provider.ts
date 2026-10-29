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

import type {
  Floor,
  NestedReply,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformId,
  ThreadRef,
} from '../../types.js'
import type {
  CapabilityDeclaration,
  CapabilityName,
  PlatformCapabilityMatrix,
  PlatformContext,
  PlatformProvider,
} from '../contracts.js'
import {
  buildDiagnosticLines,
  createDiagnosticRecorder,
  diagnosisOfStatus,
  type WeiboDiagnostics,
  type WeiboDiagnosticRecorder,
} from './diagnostics.js'
import {
  classifyCommands,
  inspectCommand,
  listAvailableCommands,
  probeWeiboCli,
  runReadCommand,
  type WeiboCliReadiness,
} from './cli.js'
import {
  projectCommentAsFloor,
  projectCommentAsNested,
  projectThread,
  unwrapComments,
  unwrapStatus,
} from './projection.js'
import { parseWeiboUrl, weiboCanHandleUrl } from './url.js'

const PLATFORM: PlatformId = 'weibo'

/**
 * Translate a classified CLI failure into a throw.
 *
 * Every status keeps its own identity: `cli_missing` tells the owner to install something,
 * `not_authenticated` to log in, `service_inactive` to activate the service, and
 * `quota_exhausted` to top up. Merging them would hide the only actionable information.
 */
function guardRead(status: string, message: string): void {
  if (status === 'ok') return
  throw new WeiboCliError(status, message)
}

/** Honour an abort signal between steps; the CLI call itself is not cancellable. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error('微博读取已被取消。')
    error.name = 'AbortError'
    throw error
  }
}

/**
 * Why the read rows say what they say (v0.2.11).
 *
 * Two separate facts, and the task book asks for them to stay separate:
 *
 * 1. **The CLI adapter exists.** `cli.ts` can detect the binary, discover commands,
 *    parse JSON, classify failures, scrub credentials and enforce a timeout. That is
 *    code, and it has tests.
 * 2. **No read has ever run against the live platform.** This machine has no
 *    `weibo-cli`, no developer qualification and no OAuth login. So none of the read
 *    rows may say `supported`.
 *
 * `unverified` is exactly the state that means "implemented, never confirmed against a
 * real account" — which is the truth for the read path as of this version, and it is a
 * deliberate change from v0.2.10's blanket `permission_required`: the permission story
 * is now concrete (a CLI login plus a service entitlement), not a hypothetical.
 */
const READ_REASON =
  '微博只读接入走官方 weibo-cli。本机构建尚未安装 CLI、也没有开发者认证与 OAuth 登录，' +
  '所以这条读取路径的代码已经存在但从未对真实接口执行过——状态是「已实现、未验证」，不是「可用」。'

/** Why nothing can be written: no write scope, and the AI-content labelling rule. */
const WRITE_REASON =
  '微博的写能力需要评论写入授权，且平台要求对 AI 生成内容做显式标识；' +
  '本版明确不开放微博真实发表。'

function row(state: CapabilityDeclaration['state'], reason: string, extra: Partial<CapabilityDeclaration> = {}): CapabilityDeclaration {
  return { state, reason, ...extra }
}

/**
 * The capability matrix.
 *
 * ## The four distinct states now in use
 *
 * - `unverified` — code exists (a CLI adapter plus projection), never run against the
 *   platform. The honest label for every read row.
 * - `permission_required` — nothing can be done from code alone: a developer
 *   qualification and a service entitlement are required first.
 * - `unavailable` — the platform genuinely does not expose it to third parties.
 * - `degraded` — would work, but returns less than the platform has.
 *
 * Nothing is `supported`. That word has one meaning in this project — exercised against
 * the real platform — and no Weibo call has been.
 */
function describeCapabilities(): PlatformCapabilityMatrix {
  const capabilities: Record<CapabilityName, CapabilityDeclaration> = {
    'thread.read': row('unverified', `${READ_REASON}读取单条微博正文是第一步。`, {
      requiredPermissions: ['weibo-cli OAuth 登录', '开发者认证 + 服务开通（体验或积分包）'],
      limits: ['体验服务按接口限次（读取类通常 5 次/接口），正式服务按积分计费'],
    }),
    'comment.list': row('unverified', `${READ_REASON}评论列表读取同样只到代码层。`, {
      requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
      limits: ['体验服务读取类通常 5 次/接口'],
    }),
    'comment.paginate': row('unverified', `${READ_REASON}分页逻辑按官方 CLI 的 page/cursor 语义实现。`, {
      requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
      limits: ['官方说明：关系类分页不是快照，total_number 不等于去重后可见条数；必须按 idstr 去重'],
    }),
    'comment.nested': row('unverified', `${READ_REASON}评论下的回复读取依赖同一条命令的回复参数。`, {
      requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
    }),
    'comment.locate': row('unverified', `${READ_REASON}按 id 定位单条评论依赖读取命令的筛选参数。`, {
      requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
    }),
    'identity.verify': row('unverified', '确认登录账号走 weibo-cli 的账号命令；本机未登录，故未验证。', {
      requiredPermissions: ['weibo-cli OAuth 登录'],
    }),
    'event.mentions': row('unavailable', '微博的艾特通知不对外开放给第三方读取；请让主人手动提供微博链接。'),
    'comment.publish': row('permission_required', `${WRITE_REASON}评论发表本版不开放。`, {
      requiredPermissions: ['评论写入授权', 'AI 生成内容标识'],
      limits: ['未经授权时不会尝试任何发送'],
    }),
    'comment.reply': row('permission_required', `${WRITE_REASON}回复评论本版同样不开放。`, {
      requiredPermissions: ['评论写入授权', 'AI 生成内容标识'],
    }),
    'publish.verify': row('unavailable', `${WRITE_REASON}没有写入能力，回读验证无从谈起。`),
    'media.read': row('unavailable', '本构建不解析图片与视频内容，只保留它们的地址。'),
    'user.profile': row('unverified', `${READ_REASON}作者资料读取走同一条 CLI 链路。`, {
      requiredPermissions: ['weibo-cli OAuth 登录', '服务开通'],
    }),
  }
  return { platform: PLATFORM, declaredAt: new Date().toISOString(), capabilities }
}

/** The error every unimplemented read throws. Named so callers can branch on it. */
export class WeiboNotAuthorisedError extends Error {
  readonly code = 'weibo_not_authorised'
  constructor(what: string) {
    super(
      `微博的「${what}」需要开放平台授权，本构建没有可用凭据，因此不会尝试请求。` +
        '这不是网络故障：授权到位之前，插件不会读取也不会发表任何微博内容。',
    )
    this.name = 'WeiboNotAuthorisedError'
  }
}

function notAuthorised(what: string): never {
  throw new WeiboNotAuthorisedError(what)
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
export class WeiboCliError extends Error {
  readonly code: string
  /** The next steps for the owner, when this failure has a known remedy. */
  readonly steps: readonly string[]
  constructor(status: string, message: string, steps: readonly string[] = []) {
    super(message)
    this.name = 'WeiboCliError'
    this.code = status
    this.steps = steps
  }
}

/** Thrown when the account is authorised but lacks the specific read command. */
export class WeiboCommandUnavailableError extends Error {
  readonly code = 'command_unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'WeiboCommandUnavailableError'
  }
}

/**
 * One resolved read plan: which command to call, and whether we may claim completeness.
 *
 * Built once per adapter so a single read does not re-validate the catalog on every page.
 */
interface WeiboReadPlan {
  readonly readiness: WeiboCliReadiness
  readonly threadCommand?: string
  readonly commentCommand?: string
  /**
   * The flag the comment command uses to scope a read to one parent comment.
   *
   * Discovered from the catalog (`inspectCommand` → `nestedFilterFlag`), never assumed.
   * Absent means nested reads must refuse: an invented flag either fails or is silently
   * ignored, and an ignored flag returns top-level comments that then get mistaken for
   * replies.
   */
  readonly nestedFilterFlag?: string
  /** Why a given read is unavailable, when it is. */
  readonly threadProblem?: string
  readonly commentProblem?: string
}

/**
 * Resolve which catalog entry drives which read, by validating each candidate.
 *
 * ## Why the candidate is inspected rather than accepted
 *
 * The task book forbids "name looks right → assume we have the permission". A catalog
 * entry is a *listing*: it can be present while the entitlement behind it is inactive, and
 * its required parameters may not be ones we can supply. So every candidate goes through
 * `inspectCommand`, and only a candidate whose required parameters we can actually fill
 * becomes a plan.
 */
async function resolveReadPlan(): Promise<WeiboReadPlan> {
  const readiness = await probeWeiboCli()
  if (!readiness.canRead) return { readiness }

  const listed = await listAvailableCommands()
  if (listed.status !== 'ok' || listed.data === undefined) {
    return { readiness, threadProblem: listed.message, commentProblem: listed.message }
  }

  const candidates = classifyCommands(listed.data)
  const plan: {
    readiness: WeiboCliReadiness
    threadCommand?: string
    commentCommand?: string
    nestedFilterFlag?: string
    threadProblem?: string
    commentProblem?: string
  } = { readiness }

  // The catalog's exact spelling is server-owned, so pick by the same family shapes the
  // classifier used, then validate the winner.
  const pick = (family: 'status' | 'comment'): string | undefined => {
    const names = listed.data!.map((command) => command.name)
    return family === 'status'
      ? names.find((name) => /status|weibo|post/i.test(name) && /show|get|read|detail/i.test(name))
      : names.find((name) => /comment/i.test(name) && /list|show|get|read/i.test(name))
  }

  const statusName = candidates.statuses ? pick('status') : undefined
  if (statusName === undefined) {
    plan.threadProblem = '当前账号的可用命令里没有能读取微博正文的命令。'
  } else {
    const schema = await inspectCommand(statusName)
    if (schema.status !== 'ok' || schema.data === undefined) {
      plan.threadProblem = `无法校验命令 ${statusName}：${schema.message}`
    } else if (!schema.data.usable) {
      plan.threadProblem = schema.data.reason ?? `命令 ${statusName} 的参数无法满足。`
    } else {
      plan.threadCommand = statusName
    }
  }

  const commentName = candidates.comments ? pick('comment') : undefined
  if (commentName === undefined) {
    plan.commentProblem = '当前账号的可用命令里没有能读取评论的命令。'
  } else {
    const schema = await inspectCommand(commentName)
    if (schema.status !== 'ok' || schema.data === undefined) {
      plan.commentProblem = `无法校验命令 ${commentName}：${schema.message}`
    } else if (!schema.data.usable) {
      plan.commentProblem = schema.data.reason ?? `命令 ${commentName} 的参数无法满足。`
    } else {
      plan.commentCommand = commentName
      // Carried into the plan so `getNestedReplies` uses the discovered flag rather than a
      // hardcoded guess. When the catalog lists none, nested reads refuse.
      if (schema.data.nestedFilterFlag !== undefined) {
        plan.nestedFilterFlag = schema.data.nestedFilterFlag
      }
    }
  }

  return plan
}

/**
 * The stateful adapter.
 *
 * ## What changed in v0.2.12
 *
 * v0.2.11 threw `WeiboNotAuthorisedError` from every method, unconditionally. The CLI layer
 * existed but was never called, so installing the CLI and logging in would have changed
 * nothing.
 *
 * Now the adapter resolves a **read plan** on first use: probe the CLI, discover the
 * catalog, validate the candidates' argument shapes, and only then decide whether
 * `getThread`/`getReplies` can run. Every failure keeps its own code so the owner can tell
 * "install it" from "log in" from "buy credit".
 *
 * ## What is still refused
 *
 * `publishReply` throws, always. There is no Weibo write path in this build: the platform
 * requires an explicit AI-content label and a write scope this plugin does not request.
 */
function createAdapter(context: PlatformContext): PlatformAdapter {
  // `context` is not used yet on purpose: Weibo's read path needs no secret of its own,
  // because the official CLI owns its OAuth session on disk and this plugin never reads it.
  // Keeping the parameter documents that the adapter receives platform-scoped settings
  // without pretending to consume them.
  void context
  // The plan is resolved lazily and shared across calls: probing spawns processes, and a
  // single analysis reads the thread and several comment pages.
  const diagnostics: WeiboDiagnosticRecorder = createDiagnosticRecorder()
  let planPromise: Promise<WeiboReadPlan> | undefined
  const plan = (): Promise<WeiboReadPlan> => {
    if (planPromise === undefined) planPromise = resolveReadPlan()
    return planPromise
  }

  /**
   * Capabilities reflect what was *measured*, not what was hoped.
   *
   * Before the first read the plan is unknown, so everything that depends on the CLI is
   * reported false with a note saying it has not been probed yet. `getCapabilities()` is
   * synchronous by contract, so it cannot wait for a probe — the first async call fills the
   * cache and later calls see the real answer.
   */
  let cached: PlatformCapabilities | undefined
  const capabilities = (): PlatformCapabilities => {
    if (cached !== undefined) return cached
    return {
      thread: false,
      replies: false,
      nestedReplies: false,
      userProfile: false,
      mentions: false,
      publish: false,
      authCheck: false,
      notes: {
        thread: '尚未探测微博 CLI 状态；第一次读取时会自动探测。',
        replies: '尚未探测微博 CLI 状态。',
        publish: '本版不开放微博真实发表（需要写入授权与 AI 生成内容标识）。',
        mentions: '微博的艾特通知不对外开放给第三方读取。',
      },
    }
  }

  /**
   * Refresh the cached capabilities from a resolved plan.
   *
   * Called after every plan resolution so `getCapabilities()` — which the settings page and
   * the registry's gate read — tells the truth once a probe has run.
   */
  const remember = (resolved: WeiboReadPlan): void => {
    const ready = resolved.readiness.canRead
    cached = {
      thread: resolved.threadCommand !== undefined,
      replies: resolved.commentCommand !== undefined,
      nestedReplies: resolved.commentCommand !== undefined,
      userProfile: false,
      mentions: false,
      publish: false,
      authCheck: ready,
      notes: {
        ...(resolved.threadProblem === undefined ? {} : { thread: resolved.threadProblem }),
        ...(resolved.commentProblem === undefined ? {} : { replies: resolved.commentProblem }),
        ...(ready ? {} : { authCheck: resolved.readiness.message }),
        publish: '本版不开放微博真实发表（需要写入授权与 AI 生成内容标识）。',
        mentions: '微博的艾特通知不对外开放给第三方读取。',
      },
    }
  }

  /** Resolve the plan, cache the capabilities, and translate a refusal into a throw. */
  const requirePlan = async (): Promise<WeiboReadPlan> => {
    const resolved = await plan()
    remember(resolved)
    if (!resolved.readiness.canRead) {
      throw new WeiboCliError(
        resolved.readiness.status,
        resolved.readiness.message,
        resolved.readiness.steps,
      )
    }
    return resolved
  }

  return {
    id: PLATFORM,
    displayName: '微博',
    getCapabilities: capabilities,
    /**
     * The Weibo-specific diagnostic (v0.2.12 §二).
     *
     * Exposed as an optional member rather than part of `PlatformAdapter`: the generic
     * interface describes what every platform must do, and a diagnostic that only Weibo can
     * produce does not belong there. The settings page probes for it.
     */
    describeDiagnostics: async (): Promise<WeiboDiagnostics> => {
      const resolved = await plan()
      remember(resolved)

      // "Installed" is only true when the binary answered `version`; a missing binary has an
      // empty stderr, so the readiness status is the authority here.
      const cliInstalled = resolved.readiness.status !== 'cli_missing'
      const cliVersion = resolved.readiness.version
      const oauthLoggedIn =
        resolved.readiness.status !== 'cli_missing' &&
        resolved.readiness.status !== 'not_authenticated'
      const serviceActive = resolved.readiness.canRead
      const history = diagnostics.snapshot()

      const lines = buildDiagnosticLines({
        cliInstalled,
        ...(cliVersion === undefined ? {} : { cliVersion }),
        oauthLoggedIn,
        serviceActive,
        ...(resolved.threadCommand === undefined ? {} : { threadCommand: resolved.threadCommand }),
        ...(resolved.commentCommand === undefined ? {} : { commentCommand: resolved.commentCommand }),
        ...(resolved.threadProblem === undefined ? {} : { threadProblem: resolved.threadProblem }),
        ...(resolved.commentProblem === undefined ? {} : { commentProblem: resolved.commentProblem }),
        readinessState: diagnosisOfStatus(resolved.readiness.status),
        readinessMessage: resolved.readiness.message,
        readinessSteps: resolved.readiness.steps,
        ...history,
      })

      return {
        cliInstalled,
        ...(cliVersion === undefined ? {} : { cliVersion }),
        oauthLoggedIn,
        serviceActive,
        ...(resolved.threadCommand === undefined ? {} : { threadCommand: resolved.threadCommand }),
        ...(resolved.commentCommand === undefined ? {} : { commentCommand: resolved.commentCommand }),
        // ## Why quota is `not_implemented` rather than a number
        //
        // Reading the credit balance means calling a billing command (`me`, the credit
        // ledger). That is account management, not a read of the thread, and the task book
        // forbids automating account operations. Reporting `not_implemented` with the reason
        // is honest; showing a fake or stale number would not be.
        quota: {
          state: 'not_implemented',
          message:
            '本版不读取积分余额或套餐信息：那需要调用官方的账户/计费命令，属于账户管理操作，' +
            '插件不代为执行。需要查看余额时请在控制台「我的信息」页或运行 weibo-cli me。',
          steps: ['在微博控制台「我的信息」页查看积分余额', '或自行运行 weibo-cli me --output table'],
        },
        ...history,
        lines,
      }
    },
    checkAuthentication: async () => {
      // A read-only probe of the local CLI. It answers `false` with a reason rather than
      // throwing, because "am I logged in?" has a useful negative answer.
      const resolved = await plan()
      remember(resolved)
      return {
        authenticated: resolved.readiness.canRead,
        ...(resolved.readiness.canRead ? {} : { reason: resolved.readiness.message }),
      }
    },
    getThread: async (ref, signal) => {
      const resolved = await requirePlan()
      if (resolved.threadCommand === undefined) {
        const message = resolved.threadProblem ?? '当前账号没有可用的微博正文读取命令。'
        diagnostics.recordError('permission_insufficient', message)
        throw new WeiboCommandUnavailableError(message)
      }
      throwIfAborted(signal)
      const read = await runReadCommand<unknown>(resolved.threadCommand, [ref.threadId])
      if (read.status !== 'ok') {
        diagnostics.recordError(diagnosisOfStatus(read.status), read.message)
        guardRead(read.status, read.message)
      }
      const payload = unwrapStatus(read.data)
      if (payload === undefined) {
        const message = `${resolved.threadCommand} 的输出里找不到微博正文对象（可能字段名与预期不符）。`
        diagnostics.recordError('failed', message)
        throw new WeiboCliError('malformed_response', message)
      }
      diagnostics.recordRead(true, 'thread', `${resolved.threadCommand} 返回了正文`)
      return projectThread(payload, ref.threadId, ref.url)
    },
    getReplies: async (ref, page, signal) => {
      const resolved = await requirePlan()
      if (resolved.commentCommand === undefined) {
        throw new WeiboCommandUnavailableError(
          resolved.commentProblem ?? '当前账号没有可用的微博评论读取命令。',
        )
      }
      throwIfAborted(signal)
      const read = await runReadCommand<unknown>(resolved.commentCommand, [
        ref.threadId,
        '--page',
        String(page),
      ])
      guardRead(read.status, read.message)
      const page1 = unwrapComments(read.data)
      const floors: Floor[] = []
      for (const comment of page1.comments) {
        const floor = projectCommentAsFloor(comment)
        if (floor !== undefined) floors.push(floor)
      }
      // ## An unparseable paging state is reported, not smoothed over (v0.2.12 audit)
      //
      // When the payload carries neither `has_more` nor a cursor, we do not know whether more
      // comments exist. `pagingState === 'unknown'` therefore produces no `declaredTotal` and
      // no claim of completeness — the collector will see `hasMore: true` and either keep
      // paging or stop at its own cap, which ends as `inconsistent_pagination` rather than a
      // false `confirmed_end`.
      return {
        floors,
        page,
        hasMore: page1.hasMore,
        ...(page1.declaredTotal === undefined ? {} : { declaredTotal: page1.declaredTotal }),
        ...(page1.pagingState === 'unknown'
          ? {
              incomplete: true,
            }
          : {}),
      }
    },
    getNestedReplies: async (ref, floor, page, signal) => {
      const resolved = await requirePlan()
      if (resolved.commentCommand === undefined) {
        throw new WeiboCommandUnavailableError(
          resolved.commentProblem ?? '当前账号没有可用的微博评论读取命令。',
        )
      }
      // ## The nested filter flag is looked up, never invented (v0.2.12 audit)
      //
      // v0.2.11 hardcoded `--comment`, a flag that appears nowhere in the catalog and was
      // never validated. Sending an unvalidated flag either fails or — worse — is ignored, in
      // which case the CLI returns *top-level* comments and they get projected as replies.
      // Either the catalog lists a parent-scoping parameter or this read refuses.
      const nestedFlag = resolved.nestedFilterFlag
      if (nestedFlag === undefined) {
        const message =
          `当前账号的评论命令 ${resolved.commentCommand} 没有可识别的「按父评论筛选」参数，` +
          '无法读取楼中楼；发送一个未经校验的参数名等于猜测请求。'
        diagnostics.recordError('permission_insufficient', message)
        throw new WeiboCommandUnavailableError(message)
      }
      throwIfAborted(signal)
      const read = await runReadCommand<unknown>(resolved.commentCommand, [
        ref.threadId,
        `--${nestedFlag.replace(/_/g, '-')}`,
        floor.postId,
        '--page',
        String(page),
      ])
      guardRead(read.status, read.message)
      const nestedPage = unwrapComments(read.data)
      const replies: NestedReply[] = []
      for (const comment of nestedPage.comments) {
        const nested = projectCommentAsNested(comment, floor.postId)
        if (nested !== undefined) replies.push(nested)
      }
      // ## `incomplete` means "this page is a degraded subset", NOT "there is another page"
      //
      // v0.2.11 set `incomplete: true` whenever `hasMore` was true, which is the normal
      // pagination case. The collector treats `incomplete` as degradation, so every floor with
      // more than one page of replies was permanently reported as "楼中楼不完整" even after a
      // clean full walk. The flag is now reserved for the genuinely degraded case: a payload
      // whose paging state we could not read at all.
      return {
        replies,
        page,
        hasMore: nestedPage.hasMore,
        ...(nestedPage.declaredTotal === undefined ? {} : { declaredTotal: nestedPage.declaredTotal }),
        ...(nestedPage.pagingState === 'unknown' ? { incomplete: true } : {}),
      }
    },
    getUserProfile: async () => {
      // The catalog's user command is not wired: a profile read is not on the path this
      // version needs, and guessing its argument shape is what the task book forbids.
      throw new WeiboCommandUnavailableError('本版未接入微博用户资料读取命令。')
    },
    getMentions: async () => {
      throw new WeiboCommandUnavailableError('微博的艾特通知不对外开放给第三方读取。')
    },
    getReplyContext: async (ref, postId) => {
      // A precise summons needs to locate one comment. Without that command the honest
      // answer is a refusal, not a context assembled from a page that may not contain it.
      void postId
      void ref
      throw new WeiboCommandUnavailableError('本版未接入按 id 定位单条微博评论的命令。')
    },
    publishReply: async () => notAuthorised('发表评论'),
    // Present so a caller can parse a Weibo link through the adapter itself, the same
    // way a bare single-platform deployment does. This is pure and offline.
    parseUrl: (input: string): ThreadRef => {
      const ref = parseWeiboUrl(input)
      return { platform: PLATFORM, threadId: ref.threadId, url: ref.url }
    },
  } as PlatformAdapter
}

/** The provider the registry holds. */
export const weiboProvider: PlatformProvider = {
  id: PLATFORM,
  displayName: '微博',
  shape: 'microblog',
  canHandleUrl: weiboCanHandleUrl,
  parseUrl: (input: string): ThreadRef => {
    const ref = parseWeiboUrl(input)
    return { platform: PLATFORM, threadId: ref.threadId, url: ref.url }
  },
  describeCapabilities,
  createAdapter,
}
