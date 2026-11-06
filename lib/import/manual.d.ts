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
import type { CollectedThread } from '../collector.js';
import type { ConversationGraph } from '../conversation.js';
import type { PlatformId } from '../types.js';
/**
 * 离线来源的平台标识。
 *
 * 刻意不是 `weibo`：会话的 `platform` 决定哪个适配器去读它（`adapterFor`），
 * 用 `weibo` 意味着生成阶段会去调真实 CLI——一次离线导入就变成一次真实读取。
 * 用 `manual` 让这件事在类型和运行时都做不到：注册中心里没有这个平台，
 * 取适配器会抛错，而不是悄悄联网。
 */
export declare const MANUAL_PLATFORM: "manual";
/** 界面上给 `manual` 用的名字。平台注册表里没有它，所以这里自带一份。 */
export declare const MANUAL_DISPLAY_NAME: "\u4EBA\u5DE5\u5BFC\u5165";
/** 一条导入的发言。 */
export interface ImportedComment {
    /** 平台 id（用户给的）或 `local:` 编号。 */
    readonly id: string;
    readonly author: string;
    /** 作者 id，仅当用户明确给出时才有。 */
    readonly authorId?: string;
    readonly text: string;
    readonly createdAt?: string;
    /** 这条在回复哪一条（id 或昵称，由 `replyToKind` 说明是哪一种）。 */
    readonly replyTo?: string;
    /**
     * `replyTo` 是 id 还是昵称。
     *
     * 分开记录，是因为两者的证据强度不同：id 是 `stated`，昵称只能算 `inferred`。
     * 合成一个字段会让图上两种边长得一样，而下游据此决定「能不能说对方讲过这句话」。
     */
    readonly replyToKind?: 'id' | 'name';
}
/** 一段导入的讨论。 */
export interface ImportedDiscussion {
    readonly platform: PlatformId;
    /** 输入形式，用于界面说明「你是从哪儿导进来的」。 */
    readonly source: 'text' | 'json' | 'file';
    readonly title: string;
    /** 用户填的原帖链接，仅作展示与去重提示，从不据此读取。 */
    readonly url?: string;
    readonly root: {
        readonly id?: string;
        readonly author: string;
        readonly authorId?: string;
        readonly text: string;
        readonly createdAt?: string;
    };
    readonly comments: readonly ImportedComment[];
}
/** 一条解析问题。`severity` 决定它出现在预览的哪一栏。 */
export interface ImportIssue {
    readonly severity: 'error' | 'warning' | 'info';
    readonly code: string;
    readonly message: string;
    /** 出问题的原文行号（1 起），文本解析时才有。 */
    readonly line?: number;
}
/** 解析结果。`discussion` 缺席表示一行都没解析出来。 */
export interface ParseResult {
    readonly discussion?: ImportedDiscussion;
    readonly issues: readonly ImportIssue[];
}
/** 导入请求，与界面表单一一对应。 */
export interface ImportRequest {
    readonly kind: 'text' | 'json' | 'file';
    /** 粘贴的正文。`kind === 'file'` 时由调用方先读文件填进来。 */
    readonly content: string;
    /** 可选：原帖链接。 */
    readonly url?: string;
    /** 可选：标题。不填时从正文首行或文件名推。 */
    readonly title?: string;
    /** 文件模式的原始文件名，仅用于展示。 */
    readonly fileName?: string;
}
/**
 * 解析粘贴文本。
 *
 * 分隔线之前的块是原帖候选，之后的都是评论。没有分隔线时第一块是原帖。
 * 都不成立（没有任何块）时返回空结果，并说明原因——「读不到」和「没有内容」
 * 必须是两种不同的回答。
 */
export declare function parseText(content: string): ParseResult;
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
export declare function parseJson(content: string): ParseResult;
/** 标题从正文首句推，最多 40 字。推不出来时用作者名。 */
export declare function deriveTitle(text: string, author: string): string;
/** 按输入形式分派。`file` 由调用方读好内容后，按扩展名决定按哪种解析。 */
export declare function parseImport(request: ImportRequest): ParseResult;
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
export declare function toCollectedThread(discussion: ImportedDiscussion): CollectedThread;
/** 导入的讨论 → 平台中立的图。复用既有的桥，不另写一套。 */
export declare function toGraph(collected: CollectedThread): ConversationGraph;
/**
 * 从标题推导一个稳定的线程 id 片段。
 *
 * 稳定性是必要的：同一个标题重复导入应该落到同一个 `local:thread-…`，
 * 否则去重记录（按 threadId + triggerPostId 建键）会认为每次都是新讨论。
 */
export declare function stableSlug(seed: string): string;
/** 预览用的统计，让用户在确认之前就知道自己导入了什么。 */
export interface ImportStats {
    readonly comments: number;
    readonly floors: number;
    readonly nested: number;
    /** 出现过的作者名（去重后），按首次出现排序。 */
    readonly participants: readonly string[];
    /** 无法解析出目标的那几条发言。 */
    readonly orphans: number;
}
export declare function statsOf(discussion: ImportedDiscussion, collected?: CollectedThread): ImportStats;
//# sourceMappingURL=manual.d.ts.map