/**
 * 离线讨论的会话层（v0.2.30 §二）。
 *
 * ## 这个文件负责什么，不负责什么
 *
 * 负责：把一份 `ImportedDiscussion` 变成一个**普通会话**——存进同一个 store、
 * 带同一套 `comments` / `readQuality` / `ownerKey`，于是工作台、评论列表、编辑、
 * 安全评估、候选版本全部照旧工作。
 *
 * 不负责：分析、生成、评估。那三件事分别由 `analyzeDispute`、`generateReply`、
 * `guardOutput` 做，一行都不用重写。任务书要求「不得另建辩论引擎」，落到实处就是
 * 这个文件里**没有任何**判断「谁在跟谁吵」的代码。
 *
 * ## 三条必须说清楚的事
 *
 * 1. **平台是 `manual`，注册表里没有它。** 所以 `adapterFor` 会抛错，
 *    离线会话在结构上无法触达任何真实平台。发表路径另外还有一道显式拒绝。
 * 2. **主人身份只能是昵称，因此永远是 `unverified`。** 粘贴的内容里没有平台
 *    签发的账号 id，把昵称说成「已核验」是这类工具最典型的谎。它只影响「能不能
 *    发表」，而离线流程本来就不发表。
 * 3. **导入的正文要落盘，否则刷新就丢。** 但落盘的是它的**上限版本**：
 *    条数与单条长度都有截断，且截断会被记进 `readQuality.reasons`，
 *    不会悄悄少几条。
 */

import type { CollectedThread } from '../collector.js'
import { buildCommentList } from '../comment-list.js'
import type { Dispute } from '../analyzer.js'
import { analyzeDispute } from '../analyzer.js'
import type { StoredSession } from '../store.js'
import { newSessionId } from '../store.js'
import type { ReplyContext, TargetSnapshot } from '../types.js'
import type { ImportedComment, ImportedDiscussion, ImportIssue } from './manual.js'
import { MANUAL_PLATFORM, toCollectedThread } from './manual.js'
import type { CorrectionAudit, ImportCorrections } from './corrections.js'
import { applyCorrections } from './corrections.js'

/**
 * 落盘时的上限。
 *
 * 这些数字不是「能存多少」的技术限制，而是「存不下时要不要说」的界线：
 * 超出的部分会被丢掉，并且**必须**出现在 `readQuality.reasons` 里。
 * 悄悄截断会让用户在刷新之后看到一个比刚才短、但看起来同样权威的讨论。
 */
export const MAX_IMPORTED_COMMENTS = 400
export const MAX_IMPORTED_CHARS = 4000

/** 会话里保存的导入内容。 */
export interface StoredImport {
  readonly source: 'text' | 'json' | 'file'
  readonly title: string
  readonly url?: string
  /** 导入时间，界面上要说「这份内容是什么时候进来的」。 */
  readonly importedAt: string
  readonly root: {
    readonly id?: string
    readonly author: string
    readonly authorId?: string
    readonly text: string
    readonly createdAt?: string
  }
  /** 原帖在原文里的样子（v0.2.31）。有它才能在预览里核对解析器有没有改原文。 */
  readonly rootRaw?: string
  readonly comments: readonly ImportedComment[]
  /** 因上限被丢掉的条数。0 表示全都存下了。 */
  readonly droppedComments: number
  /** 被截断正文的条数。 */
  readonly truncatedComments: number
  /**
   * 用户的修正清单（v0.2.31 §四）。
   *
   * ## 为什么存清单而不是存修正后的结果
   *
   * 存结果就只能回答「现在是什么样」；存清单还能回答「原来是什么样、谁改的、
   * 改了什么」。而且清单更小，重放的结果也确定（`applyCorrections` 是纯函数）。
   */
  readonly corrections?: ImportCorrections
}

/** 把导入内容压到可落盘的尺寸，并如实记录丢了多少。 */
export function toStoredImport(discussion: ImportedDiscussion, now: string): StoredImport {
  const kept: ImportedComment[] = []
  let dropped = 0
  let truncated = 0

  for (const comment of discussion.comments) {
    if (kept.length >= MAX_IMPORTED_COMMENTS) {
      dropped += 1
      continue
    }
    if (comment.text.length > MAX_IMPORTED_CHARS) {
      truncated += 1
      kept.push({ ...comment, text: `${comment.text.slice(0, MAX_IMPORTED_CHARS)}…` })
      continue
    }
    kept.push(comment)
  }

  const rootText =
    discussion.root.text.length > MAX_IMPORTED_CHARS
      ? `${discussion.root.text.slice(0, MAX_IMPORTED_CHARS)}…`
      : discussion.root.text
  if (discussion.root.text.length > MAX_IMPORTED_CHARS) truncated += 1

  return {
    source: discussion.source,
    title: discussion.title,
    ...(discussion.url === undefined ? {} : { url: discussion.url }),
    importedAt: now,
    root: {
      ...(discussion.root.id === undefined ? {} : { id: discussion.root.id }),
      author: discussion.root.author,
      ...(discussion.root.authorId === undefined ? {} : { authorId: discussion.root.authorId }),
      text: rootText,
      ...(discussion.root.createdAt === undefined ? {} : { createdAt: discussion.root.createdAt }),
    },
    ...(discussion.rootRaw === undefined ? {} : { rootRaw: discussion.rootRaw }),
    comments: kept,
    droppedComments: dropped,
    truncatedComments: truncated,
    ...(discussion.corrections === undefined ? {} : { corrections: discussion.corrections }),
  }
}

/** 还原成解析层的形状，供重新投影使用。 */
export function fromStoredImport(stored: StoredImport): ImportedDiscussion {
  return {
    platform: MANUAL_PLATFORM,
    source: stored.source,
    title: stored.title,
    ...(stored.url === undefined ? {} : { url: stored.url }),
    root: stored.root,
    ...(stored.rootRaw === undefined ? {} : { rootRaw: stored.rootRaw }),
    comments: stored.comments,
    ...(stored.corrections === undefined ? {} : { corrections: stored.corrections }),
  }
}

/**
 * 应用修正后的讨论。
 *
 * ## 唯一的入口
 *
 * 所有需要「真实的当前内容」的地方都必须走这里，而不是 `fromStoredImport`：
 * 后者给的是**解析结果**，用户的修正不在里面。两处各读一个，就会出现
 * 「分析用的是修正后的、目标校验用的是修正前的」——目标校验会立刻失败，
 * 而错误消息会说是「内容被改动过」。
 */
export function correctedDiscussion(stored: StoredImport): {
  readonly discussion: ImportedDiscussion
  readonly audit: readonly CorrectionAudit[]
  readonly issues: readonly ImportIssue[]
} {
  const applied = applyCorrections(fromStoredImport(stored), stored.corrections)
  return { discussion: applied.discussion, audit: applied.audit, issues: applied.issues }
}

/**
 * 会话的线程 id。
 *
 * 从导入内容现算，而不是存一份：`toCollectedThread` 里的 id 必须与这里一致，
 * 否则重启之后「会话说是 A、重新投影算出 B」，目标校验会全部失败。
 */
export function threadIdOf(stored: StoredImport): string {
  return toCollectedThread(correctedDiscussion(stored).discussion).thread.id
}

/** 离线会话从存下来的内容重建 `CollectedThread`。 */
export function collectedFromStored(stored: StoredImport): CollectedThread {
  return toCollectedThread(correctedDiscussion(stored).discussion)
}

/**
 * 主人身份。
 *
 * 只能按昵称。这里刻意**不**接受作者 id：粘贴内容里的 id 是用户手打的，
 * 它既不是平台签发的，也没有任何东西能证明它属于输入的这个人。
 * 把它当成 id 用会让 `resolveOwnerKey` 走 id 分支并给出 `verified`，
 * 而那是一个关于真实平台的断言。
 */
export function manualOwnerName(imported: StoredImport, chosen?: string): string {
  if (chosen !== undefined && chosen.trim() !== '') return chosen.trim()
  return imported.root.author
}

/** 导入内容里出现过的作者名，按首次出现排序，去重。 */
export function importedAuthors(imported: StoredImport): readonly string[] {
  const seen: string[] = []
  const push = (name: string): void => {
    if (name.trim() === '') return
    if (!seen.includes(name)) seen.push(name)
  }
  push(imported.root.author)
  for (const comment of imported.comments) push(comment.author)
  return seen
}

/**
 * 从离线内容解析出争论结构。
 *
 * 只有一步：调分析器。**没有**任何兜底分支去「自己猜」——因为分析器已经覆盖了
 * 「主人没在这个帖子里说过话」「一条发言都没有」这些情况，它们各自有明确的错误。
 * 在这里再补一套判断，就是任务书禁止的第二个引擎。
 */
export function analyzeImported(input: {
  readonly collected: CollectedThread
  readonly ownerName: string
  readonly targetPostId?: string
  readonly aiAccountName?: string
  readonly now?: () => number
}): { readonly dispute: Dispute; readonly targetPostId: string } {
  const { collected } = input
  const timeline = collected.floors
  if (timeline.length === 0) {
    throw new Error(
      '这份导入内容里没有任何评论，无法分析。' +
        '请至少导入一条别人说的话——只有原帖时没有可回复的对象。',
    )
  }

  // 目标：显式指定优先，否则取最后一条发言。
  //
  // 「最后一条」是导入场景里唯一合理的默认：用户粘贴的通常是一段已经结束的争论，
  // 他要回的是最新那句话。这与真实平台的「主人召唤」不同，那里有明确的召唤动作。
  const targetPostId = input.targetPostId ?? lastPostIdOf(collected)

  const dispute = analyzeDispute(
    collected,
    { platform: MANUAL_PLATFORM, userName: input.ownerName },
    {
      postId: targetPostId,
      content: findContent(collected, targetPostId),
      ...(input.aiAccountName === undefined ? {} : { aiAccountName: input.aiAccountName }),
    },
  )
  return { dispute, targetPostId }
}

function lastPostIdOf(collected: CollectedThread): string {
  const entry = collected.floors[collected.floors.length - 1]
  if (entry === undefined) return collected.thread.id
  const nested = entry.nested[entry.nested.length - 1]
  return nested?.postId ?? entry.floor.postId
}

function findContent(collected: CollectedThread, postId: string): string | undefined {
  if (postId === collected.thread.id) return collected.thread.content
  for (const entry of collected.floors) {
    if (entry.floor.postId === postId) return entry.floor.content
    const nested = entry.nested.find((reply) => reply.postId === postId)
    if (nested !== undefined) return nested.content
  }
  return undefined
}

/**
 * 一个只读本地的目标解析器。
 *
 * ## 为什么复用 `resolveTarget` 而不是直接构造快照
 *
 * `resolveTarget` 里的每一项检查——帖子对得上、楼层对得上、是楼层还是楼中楼、
 * 作者还是不是同一个人、正文有没有被改过——都是「防发错人」的语义。
 * 离线场景不发表，但这些检查仍然有价值：它们保证**生成的回复是针对当前这份内容
 * 写的**，而不是针对一个已经被编辑过的旧版本。绕开它们另写一份，就等于让
 * 「目标已验证」在离线路径上变成一句空话。
 *
 * 所以这里只实现 `getReplyContext`：把 `ReplyContext` 从内存里的
 * `CollectedThread` 拼出来，剩下的全部交给 `resolveTarget`。
 */
export function localTargetResolver(collected: CollectedThread): {
  readonly id: string
  getReplyContext(
    ref: { readonly platform: string; readonly threadId: string },
    postId: string,
    signal?: AbortSignal,
    options?: { readonly forceFresh?: boolean },
  ): Promise<ReplyContext>
} {
  return {
    id: MANUAL_PLATFORM,
    async getReplyContext(ref, postId): Promise<ReplyContext> {
      if (ref.threadId !== collected.thread.id) {
        throw new Error(
          `目标 ${postId} 不属于这个导入的讨论（会话记录的是 ${collected.thread.id}，` +
            `本次重建得到 ${ref.threadId}）。导入内容可能在两次读取之间被改动过。`,
        )
      }
      // 目标是原帖本身：它自己就是容器，且没有楼层号。
      if (postId === collected.thread.id) {
        return {
          thread: collected.thread,
          floor: {
            platform: MANUAL_PLATFORM,
            postId: collected.thread.id,
            ...(collected.thread.authorName === undefined
              ? {}
              : { authorName: collected.thread.authorName }),
            ...(collected.thread.authorId === undefined
              ? {}
              : { authorId: collected.thread.authorId }),
            content: collected.thread.content,
            ...(collected.thread.createdAt === undefined
              ? {}
              : { createdAt: collected.thread.createdAt }),
            images: [],
          },
          ancestors: [],
          siblings: [],
        }
      }
      for (const entry of collected.floors) {
        if (entry.floor.postId === postId) {
          return {
            thread: collected.thread,
            floor: entry.floor,
            ancestors: [],
            siblings: entry.nested,
          }
        }
        const nested = entry.nested.find((reply) => reply.postId === postId)
        if (nested !== undefined) {
          return {
            thread: collected.thread,
            floor: entry.floor,
            nested,
            ancestors: [],
            siblings: entry.nested.filter((reply) => reply.postId !== postId),
          }
        }
      }
      throw new Error(`目标 ${postId} 不在这个导入的讨论里`)
    },
  }
}

/** 离线会话的目标快照。由 `resolveTarget` 产出，不在这里另算。 */
export function snapshotOf(snapshot: TargetSnapshot): TargetSnapshot {
  return { ...snapshot, capturedAt: new Date().toISOString() }
}

/**
 * 一条离线会话。
 *
 * 用 `StoredSession` 这个既有形状，而不是新类型：工作台、评论列表、编辑、
 * 候选版本、安全记录全部按它工作，换一个类型意味着这些都要分支。
 * `platform` 是 `manual` 就是它与真实会话唯一的、也是决定性的区别。
 */
export function buildManualSession(input: {
  readonly imported: StoredImport
  readonly collected: CollectedThread
  readonly dispute: Dispute
  readonly targetPostId: string
  readonly persona: { readonly style: string; readonly intensity: number; readonly maxLength: number }
  readonly now?: () => number
}): StoredSession {
  const now = new Date(input.now?.() ?? Date.now()).toISOString()
  const { collected, dispute, imported } = input
  const comments = buildCommentList(collected)

  const reasons = [...collected.completeness.reasons]
  if (imported.droppedComments > 0) {
    reasons.push(
      `导入时只保存了前 ${Math.min(imported.comments.length, MAX_IMPORTED_COMMENTS)} 条，` +
        `另有 ${imported.droppedComments} 条没有保存——刷新之后它们不会出现。`,
    )
  }
  if (imported.truncatedComments > 0) {
    reasons.push(
      `有 ${imported.truncatedComments} 条正文超过 ${MAX_IMPORTED_CHARS} 字，已截断保存。`,
    )
  }

  const participants = [
    dispute.owner,
    ...(dispute.opponent === undefined ? [] : [dispute.opponent]),
    ...dispute.bystanders,
  ].map((person) => ({
    name: person.displayName,
    postCount: person.postCount,
    isOwner: person.key === dispute.owner.key,
    isOpponent: person.key === dispute.opponent?.key,
  }))

  return {
    id: newSessionId(`manual:${collected.thread.id}`),
    platform: MANUAL_PLATFORM,
    threadId: collected.thread.id,
    threadUrl: imported.url ?? '',
    threadTitle: imported.title,
    // 人工导入没有「吧」。空字符串是诚实的表示，界面上会退回显示「人工导入」。
    forumName: '',
    ownerKey: dispute.owner.key,
    ownerName: dispute.owner.displayName,
    ...(dispute.opponent === undefined
      ? {}
      : { opponentKey: dispute.opponent.key, opponentName: dispute.opponent.displayName }),
    ...(dispute.opponent?.lastPostId === undefined
      ? {}
      : { targetKind: targetKindOf(collected, dispute.opponent.lastPostId) }),
    ownerIdentityAssurance: dispute.ownerIdentityAssurance,
    ownerIdentityEvidence: dispute.ownerIdentityEvidence,
    disputeFloorPostId: dispute.floorPostId,
    disputeFloorNumber: dispute.floorNumber ?? 0,
    triggerPostId: input.targetPostId,
    /**
     * 状态是 `ANALYZING`——「分析过、还没生成」。
     *
     * 不是 `DETECTED`：状态机不允许 `DETECTED → GENERATING`，而离线流程的下一个
     * 动作就是生成，用 `DETECTED` 会让第一次生成静默失败（`transition` 拒绝后
     * 状态原地不动，候选却已经写进去了）。也不是 `READY`：那是「可以发表」，
     * 而这条会话永远不发表。
     */
    state: 'ANALYZING',
    statusText: '人工导入：内容来自剪贴板，未经平台核验',
    persona: {
      style: input.persona.style,
      intensity: input.persona.intensity,
      maxLength: input.persona.maxLength,
    },
    candidates: [],
    comments: comments.comments,
    readQuality: {
      floorsRead: collected.floors.length,
      nestedRead: collected.floors.reduce((sum, entry) => sum + entry.nested.length, 0),
      // 导入的永远不是「完整读取」：内容来自剪贴板，没有平台来证明它没被裁剪。
      truncated: true,
      reasons,
      observationOverflow: [],
    },
    sentTexts: [],
    publishedPostIds: [],
    imported,
    participants,
    createdAt: now,
    updatedAt: now,
  }
}

function targetKindOf(collected: CollectedThread, postId: string): 'floor' | 'nested' {
  for (const entry of collected.floors) {
    if (entry.nested.some((reply) => reply.postId === postId)) return 'nested'
  }
  return 'floor'
}

/**
 * 离线会话的「可以复制的那段文字」。
 *
 * 刻意只返回文本与目标描述，不返回任何发表相关的东西：这个流程的终点是剪贴板。
 * 返回值里带 `target` 是为了让界面能说清「这段话是回给谁的」——复制之前必须
 * 看得见目标，否则用户会把它贴到别处。
 */
export interface CopyableReply {
  readonly sessionId: string
  readonly candidateId: string
  readonly text: string
  readonly target: {
    readonly author?: string
    readonly excerpt: string
    readonly postId: string
  }
  readonly persona: string
  /** 这段文字是否通过了安全评估。没通过时 `blockers` 非空，界面不得提供一键复制。 */
  readonly safe: boolean
  readonly blockers: readonly string[]
}

/** 目标摘录长度。够让人认出是哪条，又不至于把界面撑爆。 */
export const TARGET_EXCERPT_CHARS = 80

export function excerptOf(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= TARGET_EXCERPT_CHARS
    ? collapsed
    : `${collapsed.slice(0, TARGET_EXCERPT_CHARS)}…`
}
