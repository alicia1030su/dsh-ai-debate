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
import type { CollectedThread } from '../collector.js';
import type { ImportedDiscussion } from './manual.js';
/** 一条发言在界面上的样子。 */
export interface PreviewNode {
    /** `local:1` 或用户给的 id。 */
    readonly id: string;
    readonly author: string;
    readonly text: string;
    /** 正文摘录，用于列表。 */
    readonly excerpt: string;
    readonly floor?: number;
    readonly createdAt?: string;
    /** 原文（含作者行）。用户可以拿它核对解析结果有没有乱动。 */
    readonly raw?: string;
    readonly rawLine?: number;
    /** 它在回谁。缺席表示没说在回谁。 */
    readonly replyTo?: string;
    /** 回复目标的 id，能解析到具体发言时才有。 */
    readonly replyToId?: string;
    /** 关系强度。缺席表示没有关系。 */
    readonly certainty?: 'stated' | 'inferred' | 'unresolved';
    /** 依据，一句话。`stated` 也有，说清凭什么。 */
    readonly basis?: string;
    /** 用户标记了「确认不了」。 */
    readonly unconfirmed?: boolean;
    /** 这条是原帖还是评论。 */
    readonly kind: 'root' | 'comment';
}
/** 一条关系边，供面板画图或列表。 */
export interface PreviewEdge {
    readonly from: string;
    readonly to: string;
    readonly kind: 'contains' | 'replies_to';
    readonly certainty: 'stated' | 'inferred';
    readonly basis?: string;
}
/** 一份导入的完整可读结构。 */
export interface ImportStructure {
    readonly threadId: string;
    readonly title: string;
    readonly root: PreviewNode;
    readonly comments: readonly PreviewNode[];
    readonly edges: readonly PreviewEdge[];
    /** 出现过的作者名，按首次出现排序。 */
    readonly participants: readonly string[];
    /**
     * 同名的人。
     *
     * 单独列出来，因为它是「需要人工决定」的那一类：导入内容里没有账号 id，
     * 同名两条会被当成一个人。用户必须知道这件事才能判断要不要拆。
     */
    readonly sharedNames: readonly {
        readonly name: string;
        readonly ids: readonly string[];
    }[];
    /** 统计，界面顶部那行用它。 */
    readonly stats: {
        readonly comments: number;
        readonly floors: number;
        readonly nested: number;
        readonly stated: number;
        readonly inferred: number;
        readonly unresolved: number;
        readonly unconfirmed: number;
    };
    /** 解析与修正过程里发现的问题。 */
    readonly issues: readonly {
        readonly severity: string;
        readonly code: string;
        readonly message: string;
    }[];
}
/**
 * 从讨论算出结构。
 *
 * 接受一个已经应用过修正的 `ImportedDiscussion`：修正不是这里做的
 * （`applyCorrections` 负责），这里只负责把它讲清楚。
 */
export declare function describeImport(discussion: ImportedDiscussion): ImportStructure;
/**
 * 从已经投影好的 `CollectedThread` 算结构。
 *
 * 工作台手上只有 `StoredImport`，它重建时会顺手得到 `CollectedThread`；
 * 再走一遍 `toCollectedThread` 是白算一次 6000 条的投影（实测 200ms）。
 */
export declare function describeCollected(discussion: ImportedDiscussion, collected: CollectedThread): ImportStructure;
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
    readonly postId: string;
    readonly author?: string;
    readonly text: string;
    /** 它在第几层（楼层号或顺序号）。 */
    readonly floorLabel: string;
    /** 同一层的其他发言，按顺序。 */
    readonly siblings: readonly {
        readonly postId: string;
        readonly author?: string;
        readonly excerpt: string;
    }[];
    /** 原帖标题，让用户确认自己在哪个讨论里。 */
    readonly threadTitle: string;
    /** 这条是楼层还是楼中楼。 */
    readonly kind: 'thread' | 'floor' | 'nested';
}
export declare function targetContextOf(collected: CollectedThread, postId: string, threadTitle: string): TargetContext | undefined;
/** 把结构里的发言按「层」分组，供界面画两栏。 */
export declare function groupByFloor(structure: ImportStructure, collected: CollectedThread): readonly {
    readonly floorId: string;
    readonly author?: string;
    readonly excerpt: string;
    readonly replies: readonly PreviewNode[];
}[];
/** 供别的模块判断「这条发言属于哪个平台」。 */
export declare const IMPORT_PLATFORM: "manual";
/** 时间线里的发言条数，用于「导入后有多少条能进分析」。 */
export declare function timelineSize(collected: CollectedThread): number;
//# sourceMappingURL=preview.d.ts.map