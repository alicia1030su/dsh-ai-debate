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
import type { CollectedThread } from '../collector.js';
import type { Dispute } from '../analyzer.js';
import type { StoredSession } from '../store.js';
import type { ReplyContext, TargetSnapshot } from '../types.js';
import type { ImportedComment, ImportedDiscussion, ImportIssue } from './manual.js';
import type { CorrectionAudit, ImportCorrections } from './corrections.js';
/**
 * 落盘时的上限。
 *
 * 这些数字不是「能存多少」的技术限制，而是「存不下时要不要说」的界线：
 * 超出的部分会被丢掉，并且**必须**出现在 `readQuality.reasons` 里。
 * 悄悄截断会让用户在刷新之后看到一个比刚才短、但看起来同样权威的讨论。
 */
export declare const MAX_IMPORTED_COMMENTS = 400;
export declare const MAX_IMPORTED_CHARS = 4000;
/** 会话里保存的导入内容。 */
export interface StoredImport {
    readonly source: 'text' | 'json' | 'file';
    readonly title: string;
    readonly url?: string;
    /** 导入时间，界面上要说「这份内容是什么时候进来的」。 */
    readonly importedAt: string;
    readonly root: {
        readonly id?: string;
        readonly author: string;
        readonly authorId?: string;
        readonly text: string;
        readonly createdAt?: string;
    };
    /** 原帖在原文里的样子（v0.2.31）。有它才能在预览里核对解析器有没有改原文。 */
    readonly rootRaw?: string;
    readonly comments: readonly ImportedComment[];
    /** 因上限被丢掉的条数。0 表示全都存下了。 */
    readonly droppedComments: number;
    /** 被截断正文的条数。 */
    readonly truncatedComments: number;
    /**
     * 用户的修正清单（v0.2.31 §四）。
     *
     * ## 为什么存清单而不是存修正后的结果
     *
     * 存结果就只能回答「现在是什么样」；存清单还能回答「原来是什么样、谁改的、
     * 改了什么」。而且清单更小，重放的结果也确定（`applyCorrections` 是纯函数）。
     */
    readonly corrections?: ImportCorrections;
}
/** 把导入内容压到可落盘的尺寸，并如实记录丢了多少。 */
export declare function toStoredImport(discussion: ImportedDiscussion, now: string): StoredImport;
/** 还原成解析层的形状，供重新投影使用。 */
export declare function fromStoredImport(stored: StoredImport): ImportedDiscussion;
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
export declare function correctedDiscussion(stored: StoredImport): {
    readonly discussion: ImportedDiscussion;
    readonly audit: readonly CorrectionAudit[];
    readonly issues: readonly ImportIssue[];
};
/**
 * 会话的线程 id。
 *
 * 从导入内容现算，而不是存一份：`toCollectedThread` 里的 id 必须与这里一致，
 * 否则重启之后「会话说是 A、重新投影算出 B」，目标校验会全部失败。
 */
export declare function threadIdOf(stored: StoredImport): string;
/** 离线会话从存下来的内容重建 `CollectedThread`。 */
export declare function collectedFromStored(stored: StoredImport): CollectedThread;
/**
 * 主人身份。
 *
 * 只能按昵称。这里刻意**不**接受作者 id：粘贴内容里的 id 是用户手打的，
 * 它既不是平台签发的，也没有任何东西能证明它属于输入的这个人。
 * 把它当成 id 用会让 `resolveOwnerKey` 走 id 分支并给出 `verified`，
 * 而那是一个关于真实平台的断言。
 */
export declare function manualOwnerName(imported: StoredImport, chosen?: string): string;
/** 导入内容里出现过的作者名，按首次出现排序，去重。 */
export declare function importedAuthors(imported: StoredImport): readonly string[];
/**
 * 从离线内容解析出争论结构。
 *
 * 只有一步：调分析器。**没有**任何兜底分支去「自己猜」——因为分析器已经覆盖了
 * 「主人没在这个帖子里说过话」「一条发言都没有」这些情况，它们各自有明确的错误。
 * 在这里再补一套判断，就是任务书禁止的第二个引擎。
 */
export declare function analyzeImported(input: {
    readonly collected: CollectedThread;
    readonly ownerName: string;
    readonly targetPostId?: string;
    readonly aiAccountName?: string;
    readonly now?: () => number;
}): {
    readonly dispute: Dispute;
    readonly targetPostId: string;
};
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
export declare function localTargetResolver(collected: CollectedThread): {
    readonly id: string;
    getReplyContext(ref: {
        readonly platform: string;
        readonly threadId: string;
    }, postId: string, signal?: AbortSignal, options?: {
        readonly forceFresh?: boolean;
    }): Promise<ReplyContext>;
};
/** 离线会话的目标快照。由 `resolveTarget` 产出，不在这里另算。 */
export declare function snapshotOf(snapshot: TargetSnapshot): TargetSnapshot;
/**
 * 一条离线会话。
 *
 * 用 `StoredSession` 这个既有形状，而不是新类型：工作台、评论列表、编辑、
 * 候选版本、安全记录全部按它工作，换一个类型意味着这些都要分支。
 * `platform` 是 `manual` 就是它与真实会话唯一的、也是决定性的区别。
 */
export declare function buildManualSession(input: {
    readonly imported: StoredImport;
    readonly collected: CollectedThread;
    readonly dispute: Dispute;
    readonly targetPostId: string;
    readonly persona: {
        readonly style: string;
        readonly intensity: number;
        readonly maxLength: number;
    };
    readonly now?: () => number;
}): StoredSession;
/**
 * 离线会话的「可以复制的那段文字」。
 *
 * 刻意只返回文本与目标描述，不返回任何发表相关的东西：这个流程的终点是剪贴板。
 * 返回值里带 `target` 是为了让界面能说清「这段话是回给谁的」——复制之前必须
 * 看得见目标，否则用户会把它贴到别处。
 */
export interface CopyableReply {
    readonly sessionId: string;
    readonly candidateId: string;
    readonly text: string;
    readonly target: {
        readonly author?: string;
        readonly excerpt: string;
        readonly postId: string;
    };
    readonly persona: string;
    /** 这段文字是否通过了安全评估。没通过时 `blockers` 非空，界面不得提供一键复制。 */
    readonly safe: boolean;
    readonly blockers: readonly string[];
}
/** 目标摘录长度。够让人认出是哪条，又不至于把界面撑爆。 */
export declare const TARGET_EXCERPT_CHARS = 80;
export declare function excerptOf(text: string): string;
//# sourceMappingURL=session.d.ts.map