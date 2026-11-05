/**
 * 人工导入的离线讨论（v0.2.30 §一）。
 *
 * ## 为什么这个模块只做「解析 + 投影」，不碰分析
 *
 * 任务书要求「复用 ConversationGraph 与分析器，不得另建辩论引擎」。这句话在本项目里
 * 有一个非常具体的含义：**导入的讨论必须变成 `CollectedThread`**，因为
 * `analyzeDispute` / `compressContext` / `buildBrief` / `generateReply` / `guardOutput`
 * 全部以它为输入。只要导入产出的是同一个结构，这条链上的每一道校验（证据引用必须存在、
 * 主人身份必须可解析、第三方的发言不能算进任一方）都自动生效，一行都不用重写。
 *
 * 所以在离线场景里唯一新写的东西是：**把用户粘贴的那段文本变成 `CollectedThread`**。
 * 分析、生成、安全评估、候选版本、人工确认全部是既有代码。
 *
 * ## 三件必须诚实标出来的事
 *
 * 1. **没有平台核验**。导入的内容来自用户的剪贴板，不是平台的接口。所以
 *    `authorSource` 一律留空（空 = 没有记录来源 = 下游判为 `unverified`），
 *    `completeness.sourceComplete` 一律 `false`。伪造一个来源标签，会让工作台把
 *    「我不知道是谁说的」显示成「已核验」，而那正是本项目一直在修的那类错误。
 *
 * 2. **没有真实 ID 时用 `local:` 命名空间**。用户没给 id 的帖子编号为
 *    `local:1`、`local:2`…；给了的按原样保留。两种都不会被当成平台 id 使用——
 *    离线会话的平台是 `manual`，`adapterFor(runtime, 'manual')` 会抛错，
 *    所以任何代码都不可能在真实平台上定位到这些 id。
 *
 * 3. **无法证明讨论是完整的**。粘贴的一定是片段。`declaredReplyCount` 不填，
 *    `missingCount` 不填，只在 `issues` 里说清楚「这份内容有多少条是导入的」。
 */

import type { CollectedThread, FloorWithNested } from '../collector.js'
import type { ConversationGraph } from '../conversation.js'
import { toConversationGraph } from '../conversation-bridge.js'
import type { Floor, NestedReply, PlatformId, Thread } from '../types.js'

/**
 * 离线来源的平台标识。
 *
 * 刻意不是 `weibo`：会话的 `platform` 决定哪个适配器去读它（`adapterFor`），
 * 用 `weibo` 意味着生成阶段会去调真实 CLI——一次离线导入就变成一次真实读取。
 * 用 `manual` 让这件事在类型和运行时都做不到：注册中心里没有这个平台，
 * 取适配器会抛错，而不是悄悄联网。
 */
export const MANUAL_PLATFORM = 'manual' as const

/** 界面上给 `manual` 用的名字。平台注册表里没有它，所以这里自带一份。 */
export const MANUAL_DISPLAY_NAME = '人工导入' as const

/** 一条导入的发言。 */
export interface ImportedComment {
  /** 平台 id（用户给的）或 `local:` 编号。 */
  readonly id: string
  readonly author: string
  /** 作者 id，仅当用户明确给出时才有。 */
  readonly authorId?: string
  readonly text: string
  readonly createdAt?: string
  /** 这条在回复哪一条（id 或昵称，由 `replyToKind` 说明是哪一种）。 */
  readonly replyTo?: string
  /**
   * `replyTo` 是 id 还是昵称。
   *
   * 分开记录，是因为两者的证据强度不同：id 是 `stated`，昵称只能算 `inferred`。
   * 合成一个字段会让图上两种边长得一样，而下游据此决定「能不能说对方讲过这句话」。
   */
  readonly replyToKind?: 'id' | 'name'
}

/** 一段导入的讨论。 */
export interface ImportedDiscussion {
  readonly platform: PlatformId
  /** 输入形式，用于界面说明「你是从哪儿导进来的」。 */
  readonly source: 'text' | 'json' | 'file'
  readonly title: string
  /** 用户填的原帖链接，仅作展示与去重提示，从不据此读取。 */
  readonly url?: string
  readonly root: {
    readonly id?: string
    readonly author: string
    readonly authorId?: string
    readonly text: string
    readonly createdAt?: string
  }
  readonly comments: readonly ImportedComment[]
}

/** 一条解析问题。`severity` 决定它出现在预览的哪一栏。 */
export interface ImportIssue {
  readonly severity: 'error' | 'warning' | 'info'
  readonly code: string
  readonly message: string
  /** 出问题的原文行号（1 起），文本解析时才有。 */
  readonly line?: number
}

/** 解析结果。`discussion` 缺席表示一行都没解析出来。 */
export interface ParseResult {
  readonly discussion?: ImportedDiscussion
  readonly issues: readonly ImportIssue[]
}

/** 导入请求，与界面表单一一对应。 */
export interface ImportRequest {
  readonly kind: 'text' | 'json' | 'file'
  /** 粘贴的正文。`kind === 'file'` 时由调用方先读文件填进来。 */
  readonly content: string
  /** 可选：原帖链接。 */
  readonly url?: string
  /** 可选：标题。不填时从正文首行或文件名推。 */
  readonly title?: string
  /** 文件模式的原始文件名，仅用于展示。 */
  readonly fileName?: string
}

// ---------------------------------------------------------------------------
// 纯文本
// ---------------------------------------------------------------------------

/**
 * 粘贴文本的语法。
 *
 * 刻意做得宽松，因为真实用户的粘贴不会遵循任何规范。规则有五条：
 *
 * 1. `作者：内容`（全角或半角冒号，作者最多 32 字）开启一条发言。
 * 2. `作者 回复 某人：内容` 里的「作者」是前半段——不这样做，整串
 *    「路人乙 回复 路人甲」会变成一个作者名，而它在分析器眼里是一个从未出现过的陌生人。
 * 3. 不以「作者：」开头的非空行，接到上一条发言的正文后面（保留换行）。
 * 4. 单独一行 `---`（三个及以上短横）把**原帖**和**评论**分开：
 *    分隔线之前的最后一段是原帖，之后的全是评论。没有分隔线时，第一条是原帖。
 * 5. 以 `#` 开头的行是 Markdown 标题，当标题用，不算发言。
 */
const AUTHOR_LINE = /^([^：:]{1,40})[：:]\s*([\s\S]*)$/
const REPLY_IN_AUTHOR = /^(.{1,32}?)\s+回复\s*@?\s*(.{1,32})$/
const SEPARATOR = /^\s*-{3,}\s*$/
const HEADING = /^\s*#{1,6}\s*(.*)$/
const REPLY_PREFIX = /^回复\s*@?\s*([^：:\s]{1,32})\s*[：:]?\s*([\s\S]*)$/

/** 剥掉网页复制常带的行首装饰。 */
function stripDecoration(line: string): string {
  return line.replace(/^\s*(?:[>|｜]\s*)+/, '').replace(/^\s*【[^】]{0,12}】\s*/, '')
}

interface RawBlock {
  readonly author: string
  /** `作者 回复 目标：` 里的目标。 */
  readonly replyToName?: string
  readonly lines: string[]
  readonly startLine: number
}

function splitBlocks(content: string): {
  readonly blocks: readonly RawBlock[]
  readonly headings: readonly string[]
  readonly separatorAt?: number
} {
  const blocks: RawBlock[] = []
  const headings: string[] = []
  let current: RawBlock | undefined
  let separatorAt: number | undefined
  const lines = content.split(/\r?\n/)

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1
    const line = stripDecoration(rawLine)
    if (line.trim() === '') {
      // 空行结束当前发言。续行靠「紧跟其后」判断，空行之后的裸行属于下一条。
      current = undefined
      continue
    }
    // 标题先行：`# 标题` 里的冒号（如果有）不该让它变成一条发言。
    const heading = line.match(HEADING)
    if (heading !== null) {
      const text = (heading[1] ?? '').trim()
      if (text !== '') headings.push(text)
      current = undefined
      continue
    }
    if (SEPARATOR.test(line)) {
      separatorAt = lineNumber
      current = undefined
      continue
    }
    const match = line.match(AUTHOR_LINE)
    // 作者行必须同时满足「有冒号」和「作者部分不含前导空格」——后者防止把
    // 「2024 年 1 月：……」这种正文误判成作者行。
    if (match !== null && !/^\s/.test(match[1]!) && match[1]!.trim() !== '') {
      const rawAuthor = match[1]!.trim()
      // `A 回复 B` 拆成作者 + 被回复人。只在 B 部分不含空格且长度合理时才拆，
      // 避免把「支持 回复 反对 双方都有理」这类正常昵称切坏。
      const replyInAuthor = rawAuthor.match(REPLY_IN_AUTHOR)
      const author = replyInAuthor === null ? rawAuthor : replyInAuthor[1]!.trim()
      const target = replyInAuthor === null ? undefined : replyInAuthor[2]!.trim()
      current = {
        author: author === '' ? '匿名' : author,
        ...(target === undefined || target === '' ? {} : { replyToName: target }),
        lines: [match[2] ?? ''],
        startLine: lineNumber,
      }
      blocks.push(current)
      continue
    }
    if (current !== undefined) {
      current.lines.push(line)
      continue
    }
    // 没有作者行开头的裸文本：当作「匿名」的一条，而不是丢掉。
    current = { author: '匿名', lines: [line], startLine: lineNumber }
    blocks.push(current)
  }

  return {
    blocks,
    headings,
    ...(separatorAt === undefined ? {} : { separatorAt }),
  }
}

/**
 * 解析粘贴文本。
 *
 * 分隔线之前的块是原帖候选，之后的都是评论。没有分隔线时第一块是原帖。
 * 都不成立（没有任何块）时返回空结果，并说明原因——「读不到」和「没有内容」
 * 必须是两种不同的回答。
 */
export function parseText(content: string): ParseResult {
  const issues: ImportIssue[] = []
  const trimmed = content.trim()
  if (trimmed === '') {
    return {
      issues: [{ severity: 'error', code: 'empty', message: '内容是空的：请粘贴讨论正文。' }],
    }
  }

  const { blocks, headings, separatorAt } = splitBlocks(content)
  if (blocks.length === 0) {
    return {
      issues: [
        {
          severity: 'error',
          code: 'no_blocks',
          message: '没有从这段内容里识别出任何发言。每一条请写成「作者：内容」。',
        },
      ],
    }
  }

  /**
   * 谁是原帖。
   *
   * 分隔线的语义是「分割原帖与评论」，所以**分隔线之前的最后一段**是原帖，
   * 之后的全是评论。这与用户直觉一致：先写原帖，划一条线，再写下面的评论。
   *
   * 没有分隔线时第一条是原帖——这是另一种直觉（「从上往下读，先看到的就是原帖」），
   * 而且两种规则必须分开写：用「前者的最后一段」去套没有分隔线的情形，
   * 会把最后一条评论当成原帖（第一次实现就是这么错的）。
   */
  const beforeSeparator =
    separatorAt === undefined ? [] : blocks.filter((block) => block.startLine < separatorAt)
  const root =
    separatorAt === undefined
      ? blocks[0]
      : (beforeSeparator[beforeSeparator.length - 1] ?? blocks[0])

  if (root === undefined) {
    return {
      issues: [
        {
          severity: 'error',
          code: 'root_missing',
          message: '这段内容里只有分隔线，没有可识别的发言。',
        },
      ],
    }
  }

  const rootText = root.lines.join('\n').trim()
  if (rootText === '') {
    issues.push({
      severity: 'warning',
      code: 'root_empty',
      message: `原帖「${root.author}」的正文是空的，导入后会影响分析。`,
    })
  }

  /**
   * 评论：除原帖之外的每一条，按原文顺序。
   *
   * `回复 @某人` 或 `回复 某人` 开头的正文会被解析成「在回复某人」（按昵称，
   * 因此下游只能算 `inferred`）；`作者 回复 目标：` 那种写法已经在
   * `splitBlocks` 里拆好了，两条路径的结果一致。
   */
  const commentBlocks = blocks.filter((block) => block !== root)
  const comments: ImportedComment[] = commentBlocks.map((block, index) => {
    let text = block.lines.join('\n').trim()
    let replyTo = block.replyToName
    const reply = text.match(REPLY_PREFIX)
    if (reply !== null) {
      // 正文里的「回复 @某人」比作者名里的更明确，覆盖它。
      replyTo = reply[1]!.trim()
      text = (reply[2] ?? '').trim()
    }
    return {
      id: `local:${index + 1}`,
      author: block.author,
      text,
      ...(replyTo === undefined ? {} : { replyTo, replyToKind: 'name' as const }),
    }
  })

  // 分隔线之前的非原帖内容：用户可能把说明、时间戳之类写在了前面。
  // 信息级提示，不猜它们是什么。
  const skippedBefore = beforeSeparator.slice(0, -1)
  if (skippedBefore.length > 0) {
    issues.push({
      severity: 'info',
      code: 'before_separator',
      message:
        `分隔线之前原帖上方还有 ${skippedBefore.length} 段内容，已忽略。` +
        '它们是说明文字还是别的发言，从文本本身判断不了。',
    })
  }

  return {
    discussion: {
      platform: MANUAL_PLATFORM,
      source: 'text',
      title: headings[0] ?? deriveTitle(rootText, root.author),
      root: { author: root.author, text: rootText },
      comments,
    },
    issues,
  }
}

// ---------------------------------------------------------------------------
// 结构化 JSON
// ---------------------------------------------------------------------------

/** JSON 只接受对象或数组；其余一律拒绝并说明期望的形状。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * 解析结构化 JSON。
 *
 * 接受两种形状，都是「作者的 id 与昵称分开」的：
 *
 * ```json
 * {
 *   "title": "……", "url": "……",
 *   "root":  { "id": "…", "author": "…", "authorId": "…", "text": "…" },
 *   "comments": [
 *     { "id": "…", "author": "…", "text": "…", "replyTo": "…", "replyToKind": "id" }
 *   ]
 * }
 * ```
 *
 * 以及顶层是数组的简写（第一条是原帖）：
 *
 * ```json
 * [ { "author": "…", "text": "…" }, { "author": "…", "text": "…" } ]
 * ```
 *
 * ## 为什么未知字段只警告不拒绝
 *
 * 用户可能从别处导出一份带 `likes`、`reposts` 的 JSON。那些字段对分析没用，但
 * 也不影响正确性。拒绝整份文件只会让用户去删字段，而删字段不会让导入更准确。
 * 真正必须拒绝的是**结构性错误**：没有正文、没有作者、comments 不是数组。
 */
export function parseJson(content: string): ParseResult {
  const issues: ImportIssue[] = []
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    return {
      issues: [
        {
          severity: 'error',
          code: 'json_invalid',
          message: `这份内容不是合法 JSON：${(error as Error).message}。如果要导入纯文本，请把格式选成「文本」。`,
        },
      ],
    }
  }

  const asArray = Array.isArray(raw) ? raw : undefined
  const record = asArray === undefined ? asRecord(raw) : undefined

  if (asArray === undefined && record === undefined) {
    return {
      issues: [
        {
          severity: 'error',
          code: 'json_shape',
          message: 'JSON 的顶层必须是对象或数组。对象用 { root, comments }，数组第一条当原帖。',
        },
      ],
    }
  }

  const rootRecord = asArray === undefined ? asRecord(record!.root) : asRecord(asArray[0])
  const commentsRaw = asArray === undefined ? record!.comments : asArray.slice(1)

  if (rootRecord === undefined) {
    return {
      issues: [
        {
          severity: 'error',
          code: 'json_root',
          message:
            asArray === undefined
              ? 'JSON 里缺少 root 对象（{ root: { author, text } }）。'
              : 'JSON 数组是空的：第一条应该是原帖。',
        },
      ],
    }
  }

  const rootAuthor = textOf(rootRecord.author) ?? textOf(rootRecord.authorName) ?? ''
  const rootText = textOf(rootRecord.text) ?? textOf(rootRecord.content) ?? ''
  if (rootText.trim() === '') {
    issues.push({
      severity: 'warning',
      code: 'json_root_text',
      message: '原帖的 text 是空的，导入后会影响分析。',
    })
  }

  if (commentsRaw !== undefined && !Array.isArray(commentsRaw)) {
    return {
      issues: [
        {
          severity: 'error',
          code: 'json_comments',
          message: 'comments 必须是数组。',
        },
      ],
    }
  }

  const list = Array.isArray(commentsRaw) ? commentsRaw : []
  const comments: ImportedComment[] = []
  const declaredIds = new Set<string>()
  for (const [index, entry] of list.entries()) {
    const item = asRecord(entry)
    if (item === undefined) {
      issues.push({
        severity: 'warning',
        code: 'json_comment_shape',
        message: `第 ${index + 1} 条评论不是对象，已跳过。`,
      })
      continue
    }
    const text = textOf(item.text) ?? textOf(item.content) ?? ''
    if (text.trim() === '') {
      issues.push({
        severity: 'warning',
        code: 'json_comment_text',
        message: `第 ${index + 1} 条评论没有正文（text 为空），已跳过。`,
      })
      continue
    }
    const given = textOf(item.id)
    const id = given !== undefined && given !== '' ? given : `local:${index + 1}`
    if (declaredIds.has(id)) {
      // 重复 id 会让图上出现两个同 id 节点，下游按 id 寻址时只会看到先出现的那个。
      issues.push({
        severity: 'warning',
        code: 'json_duplicate_id',
        message: `评论 id「${id}」重复出现，第二条起改用 local: 编号，避免图上出现同名节点。`,
      })
    }
    const finalId = declaredIds.has(id) ? `local:dup${index + 1}` : id
    declaredIds.add(finalId)
    const replyTo = textOf(item.replyTo) ?? textOf(item.replyToId) ?? textOf(item.replyToName)
    const replyToAuthor = textOf(item.replyToAuthor) ?? textOf(item.replyToName)
    const kind = item.replyToKind === 'name' ? 'name' : item.replyToKind === 'id' ? 'id' : replyTo === undefined ? undefined : 'id'
    comments.push({
      id: finalId,
      author: textOf(item.author) ?? textOf(item.authorName) ?? '匿名',
      ...(textOf(item.authorId) === undefined ? {} : { authorId: textOf(item.authorId)! }),
      text,
      ...(textOf(item.createdAt) === undefined ? {} : { createdAt: textOf(item.createdAt)! }),
      ...(replyTo === undefined
        ? replyToAuthor === undefined
          ? {}
          : { replyTo: replyToAuthor, replyToKind: 'name' as const }
        : { replyTo, ...(kind === undefined ? {} : { replyToKind: kind }) }),
    })
  }

  if (comments.length === 0 && list.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'json_no_comments',
      message: '所有评论都缺少正文，导入的只有原帖。',
    })
  }

  return {
    discussion: {
      platform: MANUAL_PLATFORM,
      source: 'json',
      title: textOf(record?.title) ?? deriveTitle(rootText, rootAuthor),
      ...(textOf(record?.url) === undefined ? {} : { url: textOf(record!.url)! }),
      root: {
        ...(textOf(rootRecord.id) === undefined ? {} : { id: textOf(rootRecord.id)! }),
        author: rootAuthor === '' ? '匿名' : rootAuthor,
        ...(textOf(rootRecord.authorId) === undefined ? {} : { authorId: textOf(rootRecord.authorId)! }),
        text: rootText,
        ...(textOf(rootRecord.createdAt) === undefined ? {} : { createdAt: textOf(rootRecord.createdAt)! }),
      },
      comments,
    },
    issues,
  }
}

/** 标题从正文首句推，最多 40 字。推不出来时用作者名。 */
export function deriveTitle(text: string, author: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? ''
  if (firstLine === '') return `${author} 的发言`
  return firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 40)}…`
}

/** 按输入形式分派。`file` 由调用方读好内容后，按扩展名决定按哪种解析。 */
export function parseImport(request: ImportRequest): ParseResult {
  const looksJson =
    request.kind === 'json' ||
    (request.kind === 'file' && /\.json$/i.test(request.fileName ?? '')) ||
    (request.kind === 'text' && /^\s*[[{]/.test(request.content))

  const result = looksJson ? parseJson(request.content) : parseText(request.content)
  if (result.discussion === undefined) return result

  // 表单上的标题/链接优先于正文推断：用户明确填了，就不该被首行覆盖。
  const title = request.title?.trim()
  const url = request.url?.trim()
  const discussion: ImportedDiscussion = {
    ...result.discussion,
    source: request.kind === 'file' ? 'file' : result.discussion.source,
    ...(title === undefined || title === '' ? {} : { title }),
    ...(url === undefined || url === '' ? {} : { url }),
  }
  return { discussion, issues: result.issues }
}

// ---------------------------------------------------------------------------
// 投影：导入的讨论 → CollectedThread → ConversationGraph
// ---------------------------------------------------------------------------

/**
 * 把导入的讨论投影成 `CollectedThread`。
 *
 * ## 两处刻意的「不填」
 *
 * - `authorSource` 不填。填了就等于声称这份数据来自某个平台界面，而它来自剪贴板。
 *   下游 `identityOf` / `resolveOwnerKey` 正是靠这个字段判 `verified` 的，
 *   填上会把「不知道是谁」变成「已核验」。
 * - `declaredReplyCount` / `missingCount` 不填。粘贴一定不完整，但我们不知道
 *   缺多少——编一个数字比不写更糟。
 *
 * 关系上：回复某条评论的，挂到那条评论所在的那一层下面；找不到目标的（回复了
 * 一个不在本次导入里的 id）单独成层，并在 `issues` 里点名。静默丢弃会让争论链
 * 看起来比实际更短。
 */
export function toCollectedThread(discussion: ImportedDiscussion): CollectedThread {
  const issues: string[] = []
  const threadId = `local:thread-${stableSlug(discussion.title)}`

  const thread: Thread = {
    platform: MANUAL_PLATFORM,
    // 人工导入没有「吧」。空字符串是诚实的表示：界面上会退回显示平台名。
    forum: { platform: MANUAL_PLATFORM, name: '' },
    id: threadId,
    title: discussion.title,
    content: discussion.root.text,
    // 原帖是这个讨论的根，评论挂在它下面——和微博一样的形状。
    bodyNode: 'standalone',
    ...(discussion.root.authorId === undefined ? {} : { authorId: discussion.root.authorId }),
    authorName: discussion.root.author,
    ...(discussion.root.createdAt === undefined ? {} : { createdAt: discussion.root.createdAt }),
    url: discussion.url ?? '',
    images: [],
  }

  // 每条评论先按 id 建索引，才能把「回复某条」解析成父子关系。
  const byId = new Map<string, ImportedComment>()
  for (const comment of discussion.comments) byId.set(comment.id, comment)

  /**
   * 一条评论在回谁。
   *
   * ## 为什么要分成四种，而不是「找到 / 没找到」
   *
   * - `none`：没说在回谁。它就是一层。
   * - `root`：说在回原帖。它也是一层——原帖不是评论。
   * - `comment`：解析到了一条具体评论。
   * - `unresolved`：**说了**在回谁，但解析不出来（id 不在、昵称重名）。
   *
   * 最后一种必须与 `none` 分开：它自己成层（没有别的地方可挂），但同时要在
   * `issues` 里点名。把「说了但说不清」当成「没说」，会让一份残缺的转录看起来
   * 完整——而这正是这份内容最容易被误信的地方。
   */
  type Resolution =
    | { readonly kind: 'none' }
    | { readonly kind: 'root' }
    | { readonly kind: 'comment'; readonly comment: ImportedComment }
    | { readonly kind: 'unresolved'; readonly reason: 'not_found' | 'ambiguous'; readonly claim: string }

  const resolutionOf = (comment: ImportedComment): Resolution => {
    const claim = comment.replyTo?.trim() ?? ''
    if (claim === '') return { kind: 'none' }
    if (claim === discussion.root.id) return { kind: 'root' }

    // 先按 id 找。id 是用户写的引用，不需要唯一性判断。
    const byIdentifier = byId.get(claim)
    if (byIdentifier !== undefined && byIdentifier.id !== comment.id) {
      return { kind: 'comment', comment: byIdentifier }
    }
    if (comment.replyToKind !== 'name') {
      return { kind: 'unresolved', reason: 'not_found', claim }
    }
    // 只有昵称：必须唯一，否则指哪一条是猜的。
    const matches = discussion.comments.filter(
      (candidate) => candidate.id !== comment.id && candidate.author === claim,
    )
    if (matches.length === 1) return { kind: 'comment', comment: matches[0]! }
    return { kind: 'unresolved', reason: matches.length === 0 ? 'not_found' : 'ambiguous', claim }
  }

  /** 一条评论是不是自己成层（没有可挂的父评论）。 */
  const isFloor = (comment: ImportedComment): boolean => {
    const resolution = resolutionOf(comment)
    return resolution.kind !== 'comment'
  }

  const nestedByFloor = new Map<string, NestedReply[]>()
  const unresolvable: { readonly id: string; readonly claim: string; readonly ambiguous: boolean }[] = []

  /**
   * 回复了某条评论的，挂到**目标所在的那一层**下面。
   *
   * 目标是顶层评论时直接挂它；目标是一条嵌套回复时，挂到那条回复所属的层，
   * 并把 `replyToPostId` 指向真正的目标。这保住了「谁在回谁」，也正是 Tieba
   * 两层的同一套处理方式。
   *
   * 先算好分组再建 `floors`，避免回头去改已经构造出来的只读对象：
   * 那种写法在运行时能通过，但会让「这一层的 nested 是什么」取决于循环顺序。
   */
  const floorOwnerOf = (comment: ImportedComment): string | undefined => {
    let cursor = resolutionOf(comment)
    const seen = new Set<string>()
    while (cursor.kind === 'comment') {
      if (seen.has(cursor.comment.id)) return undefined
      seen.add(cursor.comment.id)
      if (isFloor(cursor.comment)) return cursor.comment.id
      cursor = resolutionOf(cursor.comment)
    }
    return undefined
  }

  for (const comment of discussion.comments) {
    const resolution = resolutionOf(comment)
    if (resolution.kind === 'none' || resolution.kind === 'root') continue
    if (resolution.kind === 'unresolved') {
      unresolvable.push({
        id: comment.id,
        claim: resolution.claim,
        ambiguous: resolution.reason === 'ambiguous',
      })
      continue
    }
    const ownerId = floorOwnerOf(comment)
    if (ownerId === undefined) {
      // 目标链本身有环或断在某个无法解析的节点上。与「找不到」同样处理：
      // 自己成层，并记下来。
      unresolvable.push({ id: comment.id, claim: resolution.comment.id, ambiguous: false })
      continue
    }
    const targetId = resolution.comment.id
    const nested: NestedReply = {
      platform: MANUAL_PLATFORM,
      postId: comment.id,
      parentPostId: ownerId,
      // 只有「按 id 解析到」时才写 `replyToPostId`；昵称解析来的关系写
      // `replyToName` 并标 `relationUncertain`——它建立在一个可能重名、
      // 也可能被改掉的昵称上。下游据此决定能不能把「对方说过这句话」当成事实。
      ...(comment.replyToKind === 'id' ? { replyToPostId: targetId } : {}),
      authorName: comment.author,
      ...(comment.authorId === undefined ? {} : { authorId: comment.authorId }),
      ...(comment.replyToKind === 'name' ? { replyToName: comment.replyTo } : {}),
      content: comment.text,
      ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
      ...(comment.replyToKind === 'name' ? { relationUncertain: true } : {}),
    }
    const bucket = nestedByFloor.get(ownerId) ?? []
    bucket.push(nested)
    nestedByFloor.set(ownerId, bucket)
  }

  const floors: FloorWithNested[] = []
  for (const comment of discussion.comments) {
    if (!isFloor(comment)) continue
    const floor: Floor = {
      platform: MANUAL_PLATFORM,
      postId: comment.id,
      authorName: comment.author,
      ...(comment.authorId === undefined ? {} : { authorId: comment.authorId }),
      content: comment.text,
      ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
      images: [],
    }
    const nested = nestedByFloor.get(comment.id) ?? []
    floors.push({ floor, nested, nestedComplete: true })
  }

  // ## 未解析的回复关系必须说出来
  //
  // 这是「静默丢失」最容易发生的地方：一条说「回复张三」的发言，如果解析不到张三，
  // 最省事的做法是当成普通一层。用户看到的是完整的两层结构，实际上争论链断了。
  if (unresolvable.length > 0) {
    const ambiguous = unresolvable.filter((entry) => entry.ambiguous)
    const missing = unresolvable.filter((entry) => !entry.ambiguous)
    if (missing.length > 0) {
      issues.push(
        `有 ${missing.length} 条发言说自己在回复某条评论，但那条评论不在这次导入里` +
          `（${missing
            .slice(0, 5)
            .map((entry) => `${entry.id} → ${entry.claim}`)
            .join('、')}${missing.length > 5 ? ' 等' : ''}）。` +
          '它们被单独列为一层，争论链在这里断了。',
      )
    }
    if (ambiguous.length > 0) {
      const names = [...new Set(ambiguous.map((entry) => entry.claim))]
      issues.push(
        `有 ${ambiguous.length} 条发言只写了「回复 ${names.join('、')}」，` +
          '而这个名字在导入内容里对应不止一个人——无法确定在回谁，因此没有生成回复关系。' +
          '如果要用 id 精确指定，请改用结构化 JSON 并给每条填 id。',
      )
    }
  }

  // ## 同名不同人：说清我们分不开
  //
  // 导入内容里没有账号 id，所以两条都署名「甲」的发言会被分析器当成同一个人
  // （这是 `indexParticipants` 的既定规则：没有账号标识时，昵称就是键）。
  // 那不一定错——可能真的是同一个人发言两次——但用户必须知道这个假设。
  //
  // 不说的话，一份「两个不同的人都叫小王」的转录会显示出一个人说了很多话，
  // 而分析出的立场是两个人的混合。
  const nameCounts = new Map<string, number>()
  for (const comment of discussion.comments) {
    nameCounts.set(comment.author, (nameCounts.get(comment.author) ?? 0) + 1)
  }
  const duplicated = [...nameCounts.entries()].filter(([, count]) => count > 1)
  if (duplicated.length > 0) {
    issues.push(
      `有 ${duplicated.length} 个名字出现了不止一次（${duplicated
        .slice(0, 5)
        .map(([name, count]) => `「${name}」${count} 次`)
        .join('、')}${duplicated.length > 5 ? ' 等' : ''}）。` +
        '导入内容里没有账号 id，所以同名发言会被当成同一个人。' +
        '如果确实是不同的人，请改用结构化 JSON 并给每条填不同的 id。',
    )
  }

  return {
    thread,
    floors,
    // 导入的内容永远不是「平台证明过的完整」。说 true 会让缺省提示全部消失。
    complete: false,
    completeness: {
      sourceComplete: false,
      // 「读到的都留下了」这一条对导入是成立的：没有分页，没有上限截断。
      retainedComplete: true,
      // 争论链是否完整：只有当所有「我在回复某条」都能解析时才算。
      analysisComplete: unresolvable.length === 0,
      nestedComplete: true,
      reasons: ['人工导入：内容来自剪贴板，无法证明与平台上的讨论一致或完整。'],
    },
    issues,
    stopReason: 'confirmed_end',
  }
}

/** 导入的讨论 → 平台中立的图。复用既有的桥，不另写一套。 */
export function toGraph(collected: CollectedThread): ConversationGraph {
  return toConversationGraph(collected)
}

/**
 * 从标题推导一个稳定的线程 id 片段。
 *
 * 稳定性是必要的：同一个标题重复导入应该落到同一个 `local:thread-…`，
 * 否则去重记录（按 threadId + triggerPostId 建键）会认为每次都是新讨论。
 */
export function stableSlug(seed: string): string {
  let hash = 0
  for (const char of seed) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  }
  return hash.toString(36)
}

/** 预览用的统计，让用户在确认之前就知道自己导入了什么。 */
export interface ImportStats {
  readonly comments: number
  readonly floors: number
  readonly nested: number
  /** 出现过的作者名（去重后），按首次出现排序。 */
  readonly participants: readonly string[]
  /** 无法解析出目标的那几条发言。 */
  readonly orphans: number
}

export function statsOf(discussion: ImportedDiscussion, collected?: CollectedThread): ImportStats {
  const names = new Set<string>()
  names.add(discussion.root.author)
  for (const comment of discussion.comments) names.add(comment.author)
  const nested = collected === undefined ? 0 : collected.floors.reduce((sum, entry) => sum + entry.nested.length, 0)
  return {
    comments: discussion.comments.length,
    floors: collected === undefined ? 0 : collected.floors.length,
    nested,
    participants: [...names],
    orphans: collected === undefined ? 0 : collected.floors.filter((entry) => entry.nested.length === 0).length,
  }
}
