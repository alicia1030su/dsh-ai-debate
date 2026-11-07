/**
 * 导入结构的可读快照：预览、工作台、纠错界面共用一份（v0.2.31 §三/§四）。
 *
 * ## 为什么必须共用
 *
 * 「预览里看到的关系」与「确认后的关系」必须是同一份数据算出来的。上一版已经
 * 因为预览不经过落盘而漏报了截断，这一版如果让预览和纠错界面各算一次关系，
 * 同一个问题会以更隐蔽的方式回来：**预览说「3 条在回复某人」，纠错界面说
 * 「2 条」，而两处都自称来自同一份解析结果。**
 *
 * 所以这里只有一个函数 `describeImport()`：输入一份（已应用修正的）讨论，
 * 输出给界面看的结构。预览、工作台、纠错后的重新预览，全部调它。
 *
 * ## 关系分三档，不是两档
 *
 * | 档位 | 含义 | 界面措辞 |
 * | --- | --- | --- |
 * | `stated` | 有 id 依据（结构化 JSON 里给了 `replyToKind: 'id'`） | 「回复 X」 |
 * | `inferred` | 只有昵称，且能唯一解析 | 「可能是在回 X」＋依据 |
 * | `unresolved` | 说了在回谁，但解析不出来（找不到 / 重名） | 「说在回 X，但确定不了是哪一条」 |
 *
 * 三档必须分开显示。合并成两档时，`unresolved` 会被并到 `inferred` 里，
 * 于是「这条关系断了」变成「这条关系是猜的」——前者需要人补料，后者不需要。
 */

import { buildTimeline } from '../collector.js'
import type { CollectedThread } from '../collector.js'
import type { ImportedComment, ImportedDiscussion } from './manual.js'
import { MANUAL_PLATFORM, stableSlug, toCollectedThread } from './manual.js'

/** 一条发言在界面上的样子。 */
export interface PreviewNode {
  /** `local:1` 或用户给的 id。 */
  readonly id: string
  readonly author: string
  readonly text: string
  /** 正文摘录，用于列表。 */
  readonly excerpt: string
  readonly floor?: number
  readonly createdAt?: string
  /** 原文（含作者行）。用户可以拿它核对解析结果有没有乱动。 */
  readonly raw?: string
  readonly rawLine?: number
  /** 它在回谁。缺席表示没说在回谁。 */
  readonly replyTo?: string
  /** 回复目标的 id，能解析到具体发言时才有。 */
  readonly replyToId?: string
  /** 关系强度。缺席表示没有关系。 */
  readonly certainty?: 'stated' | 'inferred' | 'unresolved'
  /** 依据，一句话。`stated` 也有，说清凭什么。 */
  readonly basis?: string
  /** 用户标记了「确认不了」。 */
  readonly unconfirmed?: boolean
  /** 这条是原帖还是评论。 */
  readonly kind: 'root' | 'comment'
}

/** 一条关系边，供面板画图或列表。 */
export interface PreviewEdge {
  readonly from: string
  readonly to: string
  readonly kind: 'contains' | 'replies_to'
  readonly certainty: 'stated' | 'inferred'
  readonly basis?: string
}

/** 一份导入的完整可读结构。 */
export interface ImportStructure {
  readonly threadId: string
  readonly title: string
  readonly root: PreviewNode
  readonly comments: readonly PreviewNode[]
  readonly edges: readonly PreviewEdge[]
  /** 出现过的作者名，按首次出现排序。 */
  readonly participants: readonly string[]
  /**
   * 同名的人。
   *
   * 单独列出来，因为它是「需要人工决定」的那一类：导入内容里没有账号 id，
   * 同名两条会被当成一个人。用户必须知道这件事才能判断要不要拆。
   */
  readonly sharedNames: readonly { readonly name: string; readonly ids: readonly string[] }[]
  /** 统计，界面顶部那行用它。 */
  readonly stats: {
    readonly comments: number
    readonly floors: number
    readonly nested: number
    readonly stated: number
    readonly inferred: number
    readonly unresolved: number
    readonly unconfirmed: number
  }
  /** 解析与修正过程里发现的问题。 */
  readonly issues: readonly { readonly severity: string; readonly code: string; readonly message: string }[]
}

/** 摘录长度。够认出是哪条，又不至于把列表撑爆。 */
const EXCERPT_CHARS = 60

function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= EXCERPT_CHARS ? collapsed : `${collapsed.slice(0, EXCERPT_CHARS)}…`
}

/**
 * 从讨论算出结构。
 *
 * 接受一个已经应用过修正的 `ImportedDiscussion`：修正不是这里做的
 * （`applyCorrections` 负责），这里只负责把它讲清楚。
 */
export function describeImport(discussion: ImportedDiscussion): ImportStructure {
  const collected = toCollectedThread(discussion)
  return describeCollected(discussion, collected)
}

/**
 * 从已经投影好的 `CollectedThread` 算结构。
 *
 * 工作台手上只有 `StoredImport`，它重建时会顺手得到 `CollectedThread`；
 * 再走一遍 `toCollectedThread` 是白算一次 6000 条的投影（实测 200ms）。
 */
export function describeCollected(
  discussion: ImportedDiscussion,
  collected: CollectedThread,
): ImportStructure {
  const byId = new Map<string, ImportedComment>()
  for (const comment of discussion.comments) byId.set(comment.id, comment)

  /**
   * 判定每条评论的关系档位。
   *
   * 与 `toCollectedThread` 里的 `resolutionOf` 同一套规则，但这里要的是
   * 「怎么跟用户说」，所以额外算出 `replyToId` 与 `certainty`。
   * 两边规则必须一致——所以这里读的是投影出来的 `nested`，而不是重新解析一遍：
   * 投影已经把「解析不到」变成 `issues` 与独立成层，重解析会让两份结论漂移。
   */
  const nestedOf = new Map<string, { floorId: string; replyToPostId?: string; replyToName?: string; replyBasis?: string; relationUncertain?: boolean }>()
  for (const entry of collected.floors) {
    for (const reply of entry.nested) {
      nestedOf.set(reply.postId, {
        floorId: entry.floor.postId,
        ...(reply.replyToPostId === undefined ? {} : { replyToPostId: reply.replyToPostId }),
        ...(reply.replyToName === undefined ? {} : { replyToName: reply.replyToName }),
        ...(reply.replyBasis === undefined ? {} : { replyBasis: reply.replyBasis }),
        ...(reply.relationUncertain === undefined ? {} : { relationUncertain: reply.relationUncertain }),
      })
    }
  }

  const comments: PreviewNode[] = discussion.comments.map((comment) => {
    const nested = nestedOf.get(comment.id)
    const claim = comment.replyTo?.trim()
    let certainty: PreviewNode['certainty']
    let replyToId: string | undefined
    let basis: string | undefined

    if (claim === undefined || claim === '') {
      certainty = undefined
    } else if (nested === undefined) {
      // 投影没给它建边。两种可能：说在回某条但解析不到（unresolved），
      // 或者说在回原帖（原帖不是评论，本来就没有嵌套边）。
      const rootAuthor = discussion.root.author.trim()
      certainty = claim === rootAuthor ? 'inferred' : 'unresolved'
      basis =
        claim === rootAuthor
          ? `按昵称「${claim}」认作在回原帖`
          : comment.replyBasis ?? `说在回「${claim}」，但这次导入里找不到能对上的一条`
    } else if (nested.replyToPostId !== undefined) {
      certainty = 'stated'
      replyToId = nested.replyToPostId
      basis = comment.replyBasis ?? '按 id 指定，可信度最高'
    } else {
      certainty = 'inferred'
      replyToId = nested.floorId
      basis = comment.replyBasis ?? `按昵称「${claim}」认作在回这一条`
    }

    if (comment.replyUnconfirmed === true) certainty = certainty === undefined ? undefined : 'unresolved'
    if (comment.replyUnconfirmed === true) basis = '你标记了这条关系无法确认'

    return {
      id: comment.id,
      author: comment.author,
      text: comment.text,
      excerpt: excerpt(comment.text),
      ...(comment.floor === undefined ? {} : { floor: comment.floor }),
      ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
      ...(comment.raw === undefined ? {} : { raw: comment.raw }),
      ...(comment.rawLine === undefined ? {} : { rawLine: comment.rawLine }),
      ...(claim === undefined || claim === '' ? {} : { replyTo: claim }),
      ...(replyToId === undefined ? {} : { replyToId }),
      ...(certainty === undefined ? {} : { certainty }),
      ...(basis === undefined ? {} : { basis }),
      ...(comment.replyUnconfirmed === true ? { unconfirmed: true } : {}),
      kind: 'comment',
    }
  })

  const rootNode: PreviewNode = {
    id: discussion.root.id ?? `local:thread-${stableSlug(discussion.title)}`,
    author: discussion.root.author,
    text: discussion.root.text,
    excerpt: excerpt(discussion.root.text),
    ...(discussion.rootFloor === undefined ? {} : { floor: discussion.rootFloor }),
    ...(discussion.root.createdAt === undefined ? {} : { createdAt: discussion.root.createdAt }),
    ...(discussion.rootRaw === undefined ? {} : { raw: discussion.rootRaw }),
    kind: 'root',
  }

  const participants: string[] = []
  const push = (name: string): void => {
    if (name.trim() === '') return
    if (!participants.includes(name)) participants.push(name)
  }
  push(discussion.root.author)
  for (const comment of discussion.comments) push(comment.author)

  const idsByName = new Map<string, string[]>()
  for (const comment of discussion.comments) {
    const list = idsByName.get(comment.author) ?? []
    list.push(comment.id)
    idsByName.set(comment.author, list)
  }
  const sharedNames = [...idsByName.entries()]
    .filter(([name, ids]) => ids.length > 1 && name !== discussion.root.author)
    .map(([name, ids]) => ({ name, ids }))

  const edges: PreviewEdge[] = []
  for (const entry of collected.floors) {
    edges.push({
      from: rootNode.id,
      to: entry.floor.postId,
      kind: 'contains',
      certainty: 'stated',
    })
    for (const reply of entry.nested) {
      edges.push({
        from: entry.floor.postId,
        to: reply.postId,
        kind: 'contains',
        certainty: 'stated',
      })
      if (reply.replyToPostId !== undefined) {
        edges.push({
          from: reply.postId,
          to: reply.replyToPostId,
          kind: 'replies_to',
          certainty: 'stated',
          // 依据来自解析/修正层，不是"按 id 指定"一句话概括：手工指定的边
          // 与结构化 JSON 里写明 id 的边都是 `stated`，但前者多了一句「你指定的」。
          basis: reply.replyBasis ?? '按 id 指定',
        })
      } else if (reply.replyToName !== undefined) {
        edges.push({
          from: reply.postId,
          to: entry.floor.postId,
          kind: 'replies_to',
          certainty: 'inferred',
          basis: `按昵称「${reply.replyToName}」推断`,
        })
      }
    }
  }

  const stated = comments.filter((node) => node.certainty === 'stated').length
  const inferred = comments.filter((node) => node.certainty === 'inferred').length
  const unresolved = comments.filter((node) => node.certainty === 'unresolved').length

  const issues: { severity: string; code: string; message: string }[] = []

  // 原帖正文为空：分析器会把它当成「没有可引用的对手发言」，用户会看不懂为什么。
  if (discussion.root.text.trim() === '') {
    issues.push({
      severity: 'warning',
      code: 'root_text_empty',
      message: '原帖的正文是空的。分析能用，但引用原帖时没有内容可引。',
    })
  }
  for (const entry of sharedNames) {
    issues.push({
      severity: 'info',
      code: 'shared_name',
      message:
        `「${entry.name}」出现了 ${entry.ids.length} 次（${entry.ids.join('、')}）。` +
        '导入内容里没有账号 id，所以这些发言会被当成同一个人。' +
        '如果确实是两个人，请在这个人的第二条上点「这是另一个人」，给它们分开的标签。',
    })
  }
  if (unresolved > 0) {
    issues.push({
      severity: 'warning',
      code: 'unresolved_relation',
      message:
        `有 ${unresolved} 条发言说了在回谁，但确定不了是哪一条。` +
        '它们会单独成层，争论链在这里断了。你可以在下面的列表里手工指定回复目标。',
    })
  }

  return {
    threadId: collected.thread.id,
    title: discussion.title,
    root: rootNode,
    comments,
    edges,
    participants,
    sharedNames,
    stats: {
      comments: comments.length,
      floors: collected.floors.length,
      nested: collected.floors.reduce((sum, entry) => sum + entry.nested.length, 0),
      stated,
      inferred,
      unresolved,
      unconfirmed: comments.filter((node) => node.unconfirmed === true).length,
    },
    issues,
  }
}

/**
 * 目标上下文：这条发言前后是谁在说什么。
 *
 * ## 为什么要给上下文，而不是只给那一条
 *
 * 「回给谁」是离线流程里最容易搞错的一步：用户选了一个人，但他真正想回的是那个人
 * 刚说的那句话。只显示作者名时，两个都叫「甲」的不同发言看起来一模一样。
 * 上下文里有上一句、下一句和它所在的层，用户能认出是哪一处。
 */
export interface TargetContext {
  readonly postId: string
  readonly author?: string
  readonly text: string
  /** 它在第几层（楼层号或顺序号）。 */
  readonly floorLabel: string
  /** 同一层的其他发言，按顺序。 */
  readonly siblings: readonly { readonly postId: string; readonly author?: string; readonly excerpt: string }[]
  /** 原帖标题，让用户确认自己在哪个讨论里。 */
  readonly threadTitle: string
  /** 这条是楼层还是楼中楼。 */
  readonly kind: 'thread' | 'floor' | 'nested'
}

export function targetContextOf(
  collected: CollectedThread,
  postId: string,
  threadTitle: string,
): TargetContext | undefined {
  if (postId === collected.thread.id) {
    return {
      postId,
      ...(collected.thread.authorName === undefined ? {} : { author: collected.thread.authorName }),
      text: collected.thread.content,
      floorLabel: '原帖',
      siblings: [],
      threadTitle,
      kind: 'thread',
    }
  }
  for (const [index, entry] of collected.floors.entries()) {
    const floorLabel = `第 ${entry.floor.floorNumber ?? index + 1} 层`
    if (entry.floor.postId === postId) {
      return {
        postId,
        ...(entry.floor.authorName === undefined ? {} : { author: entry.floor.authorName }),
        text: entry.floor.content,
        floorLabel,
        siblings: entry.nested.map((reply) => ({
          postId: reply.postId,
          ...(reply.authorName === undefined ? {} : { author: reply.authorName }),
          excerpt: excerpt(reply.content),
        })),
        threadTitle,
        kind: 'floor',
      }
    }
    const nested = entry.nested.find((reply) => reply.postId === postId)
    if (nested !== undefined) {
      return {
        postId,
        ...(nested.authorName === undefined ? {} : { author: nested.authorName }),
        text: nested.content,
        floorLabel,
        siblings: [
          {
            postId: entry.floor.postId,
            ...(entry.floor.authorName === undefined ? {} : { author: entry.floor.authorName }),
            excerpt: excerpt(entry.floor.content),
          },
          ...entry.nested
            .filter((reply) => reply.postId !== postId)
            .map((reply) => ({
              postId: reply.postId,
              ...(reply.authorName === undefined ? {} : { author: reply.authorName }),
              excerpt: excerpt(reply.content),
            })),
        ],
        threadTitle,
        kind: 'nested',
      }
    }
  }
  return undefined
}

/** 把结构里的发言按「层」分组，供界面画两栏。 */
export function groupByFloor(
  structure: ImportStructure,
  collected: CollectedThread,
): readonly {
  readonly floorId: string
  readonly author?: string
  readonly excerpt: string
  readonly replies: readonly PreviewNode[]
}[] {
  const byId = new Map(structure.comments.map((node) => [node.id, node]))
  return collected.floors.map((entry) => ({
    floorId: entry.floor.postId,
    ...(entry.floor.authorName === undefined ? {} : { author: entry.floor.authorName }),
    excerpt: excerpt(entry.floor.content),
    replies: entry.nested
      .map((reply) => byId.get(reply.postId))
      .filter((node): node is PreviewNode => node !== undefined),
  }))
}

/** 供别的模块判断「这条发言属于哪个平台」。 */
export const IMPORT_PLATFORM = MANUAL_PLATFORM

/** 时间线里的发言条数，用于「导入后有多少条能进分析」。 */
export function timelineSize(collected: CollectedThread): number {
  return buildTimeline(collected).length
}
