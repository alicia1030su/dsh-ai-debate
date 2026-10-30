/**
 * The single authority for "what argv do we send".
 *
 * ## The three defects this replaces (v0.2.14, all independently reproduced)
 *
 * ### 1. Pagination was invented from the wrong evidence
 *
 * `provider.ts` decided whether to send `--page` with:
 *
 *     if (commentCommand.flags?.includes('page') === true || resolved.countFlag !== undefined)
 *
 * The `|| countFlag !== undefined` is a non-sequitur: a command that declares `count` says
 * nothing about whether it accepts `page`. Reproduced both ways:
 *
 * | command declares | we sent | correct |
 * | --- | --- | --- |
 * | `id`, `count` | `--id … --page 2 --count 20` | no `--page` (undeclared → CLI hard-errors) |
 * | `id`, `page` | `--id …` | `--page 2` (declared, and we dropped it) |
 *
 * The second row is the worse one: we silently read page 1 again while the collector believed it
 * had page 2, so a truncated conversation could be reported as complete.
 *
 * ### 2. Two sources of truth drifted apart
 *
 * `commands list` carries a `flags` array, and `commands show` carries a richer one. The adapter
 * read *some* flags from the listing and *some* from the inspected schema, so a flag present in
 * one and absent in the other produced a request neither source would have allowed.
 *
 * ### 3. Nested-reply capability was inferred from the wrong thing
 *
 * `getCapabilities()` said `nestedReplies: resolved.comment !== undefined` — "we can list
 * comments, therefore we can list replies to one comment". Reproduced: with a comment command
 * that declares **no** parent-scoping flag, capabilities said `true` while `getNestedReplies()`
 * refused. The page advertised a capability the code knew it did not have.
 *
 * ## What this module is
 *
 * One `CommandInvocationPlan` per command, built **only** from the `commands show` schema that
 * `inspectCommand` verified. It answers two questions and nothing else:
 *
 * - "what argv do I send for this read?" — `argsFor()`
 * - "can I claim this capability?" — the plan's own `capabilities`
 *
 * Every parameter that is sent is in `parameters`; every parameter in `parameters` was in the
 * verified schema. There is no other path from a name to an argv token, so "we sent a flag the
 * command does not declare" becomes unrepresentable rather than merely forbidden.
 */

/** One parameter, as the verified schema described it. */
export interface PlanParameter {
  /** The name to send, exactly as the schema spells it (lowercased). */
  readonly name: string
  /** The type the schema declared, when it declared one. */
  readonly type?: string
  /** Whether the command requires it. */
  readonly required: boolean
}

/**
 * Why a capability is or is not claimed.
 *
 * Every answer carries its evidence, because the platform page renders this: a badge without a
 * reason is indistinguishable from a guess.
 */
export interface CapabilityClaim {
  readonly available: boolean
  /** `verified` = the schema supports it; `unavailable` = the schema says no; `unverified` = unknown. */
  readonly state: 'verified' | 'unavailable' | 'unverified'
  /** Plain-language reason, shown in the diagnostic panel. */
  readonly reason: string
}

/** What a read needs from a command. */
export interface ReadIntent {
  /** The post id this read is about. */
  readonly threadId: string
  /**
   * The parent comment id, for a nested read.
   *
   * Present means "this is a nested read" and the plan must send the parent flag; absent means
   * the plan must not.
   */
  readonly parentCommentId?: string
  /** 1-based page number. Sent only when the plan knows how to page. */
  readonly page: number
  /** Requested page size. Clamped and sent only when `count` is declared. */
  readonly pageSize?: number
}

/** A resolved argv plus the record of what was omitted and why. */
export interface PlanInvocation {
  /** The flag/value pairs to append after `group action`. */
  readonly args: readonly string[]
  /**
   * True when the caller asked for a page this command cannot express.
   *
   * The caller must then treat the read as page 1 and report truncation, never claim it advanced.
   */
  readonly pagingUnsupported: boolean
  /** Parameters the read wanted but the command does not declare, with the reason. */
  readonly omitted: readonly { readonly name: string; readonly reason: string }[]
}

/** Everything one verified command can do. */
export interface CommandInvocationPlan {
  readonly group: string
  readonly action: string
  /** `group action`, for logs and diagnostics. */
  readonly name: string
  readonly parameters: readonly PlanParameter[]
  /** Whether the schema was readable at all. An unreadable schema grants nothing. */
  readonly schemaVerified: boolean
  /** How the id is passed, when the command declares an id-shaped flag. */
  readonly idFlag?: PlanParameter
  /** How a page number is passed, when declared. */
  readonly pageFlag?: PlanParameter
  /** How a page size is passed, when declared. */
  readonly countFlag?: PlanParameter
  /** How a parent comment id is passed, when declared. */
  readonly parentFlag?: PlanParameter
  readonly capabilities: {
    readonly readThread: CapabilityClaim
    readonly readComments: CapabilityClaim
    readonly readNested: CapabilityClaim
  }
  /** Build the argv for one read. Throws nothing; reports what it could not do. */
  readonly argsFor: (intent: ReadIntent) => PlanInvocation
}

/**
 * Flag names that plausibly carry a post id.
 *
 * Kept as data; the plan uses a declared name, never a guessed one. Order matters only for
 * resolving ambiguity when a command declares several, and the plural form comes first because
 * the official batch read uses `--ids`.
 */
export const ID_FLAG_NAMES: readonly string[] = [
  'ids',
  'id',
  'idstr',
  'mid',
  'status_id',
  'weibo_id',
  'post_id',
]

/**
 * Flag names that plausibly carry a parent comment id.
 *
 * ## Why this list alone is not enough (v0.2.14 §四)
 *
 * A name match is *candidate evidence*, not proof: `cid` could equally mean a client id, and
 * `reply_to` could be a boolean. The task book is explicit that the meaning must be confirmed
 * before the capability is claimed, so `parentFlag` is reported as `unverified` unless the
 * command also declares something that makes the parent-scoping reading coherent — see
 * `nestedClaimOf`.
 */
export const PARENT_FLAG_NAMES: readonly string[] = [
  'cid',
  'parent_id',
  'comment_id',
  'reply_to',
  'to_comment',
  'root_id',
  'parent_cid',
]

/** Flag names that plausibly carry a page number. */
export const PAGE_FLAG_NAMES: readonly string[] = ['page', 'page_no', 'pagenum']

/** Flag names that plausibly carry a page size. */
export const COUNT_FLAG_NAMES: readonly string[] = ['count', 'limit', 'page_size', 'pagesize']

/**
 * Page sizes above this are refused by the server with `COUNT_EXCEEDS_MAX`.
 *
 * Documented for the read commands that declare a cap; when a command does not, this still
 * bounds the request so a mistake cannot ask for the whole timeline.
 */
export const MAX_PAGE_SIZE = 20

function pick(
  parameters: readonly PlanParameter[],
  names: readonly string[],
): PlanParameter | undefined {
  for (const name of names) {
    const found = parameters.find((parameter) => parameter.name === name)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Whether a declared parent-shaped flag is *enough* to claim nested reads.
 *
 * ## The honesty problem
 *
 * The reproduced defect was: `nestedReplies = commentCommand !== undefined`. Fixing it to
 * `parentFlag !== undefined` would be better but still a guess — a flag named `cid` might mean
 * something else entirely.
 *
 * This function therefore separates two answers:
 *
 * - **verified** — the command declares a parent-shaped flag *and* at least one paging or
 *   scoping flag, i.e. it is a comment-listing command parameterised by a specific comment.
 *   The shape is coherent: "list the children of X, one page at a time".
 * - **unverified** — a parent-shaped flag exists but nothing corroborates the reading. The
 *   capability is reported as `unverified`, and a nested read is refused rather than attempted
 *   on a guess.
 *
 * Neither branch claims more than the schema shows.
 */
function nestedClaimOf(parameters: readonly PlanParameter[]): {
  claim: CapabilityClaim
  flag?: PlanParameter
} {
  const parentFlag = pick(parameters, PARENT_FLAG_NAMES)
  if (parentFlag === undefined) {
    return {
      claim: {
        available: false,
        state: 'unavailable',
        reason:
          '这条评论命令没有声明任何「按父评论筛选」的参数，因此无法只读取某条评论下的回复。' +
          '把一级评论当成子回复会伪造对话结构，所以这里如实声明不可用。',
      },
    }
  }

  const corroborating = pick(parameters, PAGE_FLAG_NAMES) ?? pick(parameters, COUNT_FLAG_NAMES)
  if (corroborating === undefined) {
    return {
      claim: {
        available: false,
        state: 'unverified',
        reason:
          `命令声明了 ${parentFlag.name}，但没有配套的分页或范围参数，` +
          '无法确认它就是「按父评论筛选」。参数名相似不等于语义相同，因此不声明可用。',
      },
      flag: parentFlag,
    }
  }

  return {
    claim: {
      available: true,
      state: 'verified',
      reason:
        `命令声明的 ${parentFlag.name} 与 ${corroborating.name} 组合符合「按父评论分页读取」的形状；` +
        '回复的父子关系仍以平台返回的真实 id 为准。',
    },
    flag: parentFlag,
  }
}

/** Build a plan from a verified schema. */
export function buildInvocationPlan(input: {
  readonly group: string
  readonly action: string
  readonly name: string
  readonly schemaVerified: boolean
  readonly parameters: readonly PlanParameter[]
  /** Whether this command reads a thread (vs. comments). Decides the capability labels. */
  readonly kind: 'thread' | 'comments'
}): CommandInvocationPlan {
  const { group, action, name, schemaVerified, parameters, kind } = input

  const idFlag = pick(parameters, ID_FLAG_NAMES)
  const pageFlag = pick(parameters, PAGE_FLAG_NAMES)
  const countFlag = pick(parameters, COUNT_FLAG_NAMES)
  const nested = nestedClaimOf(parameters)

  const requiresId = parameters.some(
    (parameter) => parameter.required && ID_FLAG_NAMES.includes(parameter.name),
  )
  const requiresSomethingElse = parameters.some(
    (parameter) =>
      parameter.required &&
      !ID_FLAG_NAMES.includes(parameter.name) &&
      !PAGE_FLAG_NAMES.includes(parameter.name) &&
      !COUNT_FLAG_NAMES.includes(parameter.name) &&
      !PARENT_FLAG_NAMES.includes(parameter.name),
  )

  /** A read is claimable only with a verified schema, an id flag, and no unmet requirement. */
  const readable = (label: string): CapabilityClaim => {
    if (!schemaVerified) {
      return {
        available: false,
        state: 'unverified',
        reason: `命令 ${name} 的参数 schema 无法识别，不能据此判断能否${label}。`,
      }
    }
    if (idFlag === undefined || !requiresId) {
      return {
        available: false,
        state: 'unavailable',
        reason: `命令 ${name} 没有把 ${ID_FLAG_NAMES.slice(0, 3).join('/')} 作为必填参数，无法指定要${label}的对象。`,
      }
    }
    if (requiresSomethingElse) {
      return {
        available: false,
        state: 'unavailable',
        reason: `命令 ${name} 还有本插件无法提供的必填参数，调用会被拒绝。`,
      }
    }
    return {
      available: true,
      state: 'verified',
      reason: `命令 ${name} 的参数足够${label}。`,
    }
  }

  const capabilities = {
    readThread: kind === 'thread' ? readable('读取正文') : {
      available: false,
      state: 'unavailable' as const,
      reason: `命令 ${name} 是评论命令，不用于读取正文。`,
    },
    readComments: kind === 'comments' ? readable('读取评论') : {
      available: false,
      state: 'unavailable' as const,
      reason: `命令 ${name} 是正文命令，不用于读取评论。`,
    },
    readNested:
      kind === 'comments' && schemaVerified && idFlag !== undefined && !requiresSomethingElse
        ? nested.claim
        : {
            available: false,
            state: 'unavailable' as const,
            reason: `命令 ${name} 不能用于读取评论，因而也不能读取子回复。`,
          },
  }

  const argsFor = (intent: ReadIntent): PlanInvocation => {
    const args: string[] = []
    const omitted: { name: string; reason: string }[] = []
    let pagingUnsupported = false

    if (idFlag !== undefined) {
      args.push(`--${idFlag.name.replace(/_/g, '-')}`, intent.threadId)
    } else {
      omitted.push({ name: 'id', reason: `命令 ${name} 没有声明 id 参数。` })
    }

    // ## The parent flag is sent only when this is actually a nested read
    //
    // `intent.parentCommentId` present means the caller wants "replies to this comment". If the
    // plan has no verified parent flag, the read must not proceed as if it were a top-level list
    // — that is exactly the mis-mapping the task book forbids. The caller is told instead.
    if (intent.parentCommentId !== undefined) {
      if (nested.flag !== undefined && nested.claim.available) {
        args.push(`--${nested.flag.name.replace(/_/g, '-')}`, intent.parentCommentId)
      } else {
        omitted.push({
          name: 'parent',
          reason: nested.claim.reason,
        })
      }
    }

    // ## Paging: each flag is independent
    //
    // This is the fix for the reproduced defect. `page` is sent iff the command declares a page
    // flag; `count` is sent iff it declares a count flag. Neither implies the other.
    if (intent.page > 1) {
      if (pageFlag !== undefined) {
        args.push(`--${pageFlag.name.replace(/_/g, '-')}`, String(intent.page))
      } else {
        // Asking for page 2 without a page flag is a request this command cannot express. The
        // caller must not pretend it advanced.
        pagingUnsupported = true
        omitted.push({
          name: 'page',
          reason: `命令 ${name} 没有声明页码参数，无法读取第 ${intent.page} 页。`,
        })
      }
    }

    if (intent.pageSize !== undefined && countFlag !== undefined) {
      const size = Math.min(Math.max(1, Math.trunc(intent.pageSize)), MAX_PAGE_SIZE)
      args.push(`--${countFlag.name.replace(/_/g, '-')}`, String(size))
    } else if (intent.pageSize !== undefined) {
      omitted.push({
        name: 'count',
        reason: `命令 ${name} 没有声明条数参数，使用服务端默认条数（本插件不假设具体值）。`,
      })
    }

    return { args, pagingUnsupported, omitted }
  }

  return {
    group,
    action,
    name,
    parameters,
    schemaVerified,
    ...(idFlag === undefined ? {} : { idFlag }),
    ...(pageFlag === undefined ? {} : { pageFlag }),
    ...(countFlag === undefined ? {} : { countFlag }),
    ...(nested.flag === undefined ? {} : { parentFlag: nested.flag }),
    capabilities,
    argsFor,
  }
}
