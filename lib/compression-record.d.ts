/**
 * 压缩前后的结构快照：哪六样东西必须留到最后。
 *
 * ## 这个模块存在的理由
 *
 * v0.2.37 的评测记录里有一条「长上下文无法保留论证结构」。那时没有工具回答一个
 * 很具体的问题：**压缩之后，到底丢了什么？** 只能看最终分数掉没掉，而分数掉可能是因为
 * 模型变差、也可能是因为材料被裁掉，两者混在一个数字里。
 *
 * 所以这里把「必须留住的东西」拆成六项，逐项记录压缩前 / 压缩后是否还在：
 *
 * | 项 | 为什么它不能丢 |
 * | --- | --- |
 * | 目标评论 | 答错对象是硬失败，不是质量问题 |
 * | 主人立场 | 丢了就会替主人改口 |
 * | 对手论据 | 丢了就只能空转，或编一个来反驳 |
 * | 来源 id | 丢了就没法核对「这句话是谁说的」 |
 * | 核心争议 | 丢了会答成另一场争论 |
 * | 不确定信息 | 丢了会把「没读到」写成「不存在」 |
 *
 * ## 「在」是怎么判定的
 *
 * 按**原文片段**判定，不按语义：一段话要么带着那句话，要么没有。这样判定是可复现的，
 * 不依赖任何模型。代价是它认不出同义改写 —— 而压缩器本来就不改写，它只裁剪，
 * 所以这个代价在这里等于零。
 *
 * ## 它不做什么
 *
 * 它不负责让压缩更好。它只负责让「这一轮压缩留下了什么」变成可核对的记录。
 * 谁想改压缩策略，先看这份记录掉了哪一项，再决定改哪一行。
 */
import type { DebateBrief } from './brief.js';
import type { CompressedContext } from './compressor.js';
import type { Dispute } from './analyzer.js';
/** 六项里的一项。 */
export interface PreservedItem {
    readonly key: 'target' | 'ownerPosition' | 'opponentArgument' | 'sourceId' | 'dispute' | 'uncertainty';
    readonly label: string;
    /** 压缩前是否可得（材料里本来就有）。 */
    readonly before: boolean;
    /** 压缩后是否仍然可得。 */
    readonly after: boolean;
    /** 用来判定的原文片段；没有片段时说明为什么无法判定。 */
    readonly probe: string;
    /**
     * 这一项的判定是否可信。
     *
     * `proxy` 表示用「相关字符出现过」来做代理（例如核心争议没有逐字原文可对，
     * 只能看双方立场句是否都在），这种结果只能当参考，不能当结论。
     */
    readonly basis: 'exact' | 'proxy' | 'absent';
}
/** 一份压缩记录。 */
export interface CompressionRecord {
    readonly items: readonly PreservedItem[];
    /** 压缩后丢掉的项。 */
    readonly lost: readonly PreservedItem['key'][];
    /** 压缩器自己报告的裁剪（原样带出，不加工）。 */
    readonly omissions: readonly string[];
    readonly tokens: number;
    readonly budget: number;
}
/**
 * 记录压缩前后的结构保留情况。
 *
 * @param brief 已通过校验的简报（压缩**前**的结构）
 * @param targetContent 目标评论的正文
 * @param context 压缩结果（压缩**后**的对话材料）
 * @param briefText 渲染后的简报文本，**与 context 一起**构成模型真正看到的东西
 *
 * ## 为什么必须把简报算进来
 *
 * 第一版只检查 `context.text`，于是 `baseline/03` 被记成「对手论据丢失」——
 * 而那条论据其实就在简报的「对方论据：…（9200000030）」那一行里，模型看得到。
 * 只量对话段会让记录和事实相反，而这种相反的记录比没有记录更坏。
 *
 * 模型看到的是两段之和，判定就必须对两段之和做。
 */
export declare function recordCompression(brief: DebateBrief, targetContent: string | undefined, context: CompressedContext, briefText?: string): CompressionRecord;
/**
 * 把记录渲染成一段可读的说明，供报告与界面使用。
 *
 * 一行一项，丢了的打「丢」。不写「通过 / 失败」：丢了某一项不一定是 bug
 * （预算小的时候核心争议本来就装不下），但必须让人看见。
 */
export declare function renderCompressionRecord(record: CompressionRecord, dispute?: Dispute): string;
//# sourceMappingURL=compression-record.d.ts.map