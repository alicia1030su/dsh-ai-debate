/**
 * 一次生成的**结果分类**（v0.2.39 §3.1）。
 *
 * ## 为什么需要第五种状态
 *
 * v0.2.38 及以前，一次生成只有两种下场：落了一条候选，或者报了个错。这两件事都说不清
 * 真实发生了什么：
 *
 * - 模型认真回答「材料不够，我需要你补上对方那条被删的评论」—— 这是一次**正确**的行为，
 *   却被记成失败，页面上一行红字，采集器里一条空正文。
 * - 模型明明有六条对方论据可打，却回了一句「信息不足无法回应」—— 这是**错误**的拒绝，
 *   却和上一种长得一模一样，于是没人能统计「它到底在偷懒还是在守规矩」。
 * - 模型给了正文，但里面有一个追不回原文的数字 —— 这是**不合格**的草稿，不是故障。
 * - 接口超时、返回被截断、JSON 解析不了 —— 这才是**故障**，和模型的判断无关。
 *
 * 四种不同的事实，混在「成功/失败」两个桶里，于是「这一版比上一版好吗」这个问题在数据上
 * 无法回答：两版的失败率一样，可能一版是拒绝得对，另一版是编造得多。
 *
 * ## 分类的边界
 *
 * 这里**不判断**「拒绝是否合理」之外的任何质量维度。一条 `valid_draft` 只是说「它产出了
 * 一条可用的候选」，不代表论证好 —— 那是盲评的事（`scripts/blind-review.mjs`）。
 * 把这两件事混在一起，就会得到「没有违规 = 质量高」这种没人能验证的结论。
 */
/** 一次生成的结果。五选一，互斥。 */
export type GenerationOutcome = 
/** 产出了一条可用候选：有正文、没有硬违规、目标对得上。 */
'valid_draft'
/** 模型判断材料不足并说明缺什么。材料确实不足时，这是**正确**结果。 */
 | 'needs_more_context'
/** 材料够，模型仍然拒绝。这是缺陷，不是谨慎。 */
 | 'unjustified_refusal'
/** 产出了正文，但违反事实、目标或安全要求。 */
 | 'invalid_draft'
/** 超时、异常、输出截断、解析失败等技术故障。与模型判断无关。 */
 | 'technical_failure';
/** 判断材料是否「足够到可以要求它写一条回复」。 */
export interface EvidenceSufficiency {
    /**
     * 简报里可引用的对方论据条数。
     *
     * 这是「够不够」的主要依据：有一条明确论据，就有东西可回应；一条都没有，追问才是对的。
     */
    readonly opponentArgumentCount: number;
    /** 对方提出、主人尚未回答的问题数。有的话也是可打的材料。 */
    readonly unansweredByOpponent: number;
    /** 是否已确认回应对象。目标不明时，拒绝是合理的。 */
    readonly targetConfirmed: boolean;
}
/**
 * 材料是否足以支撑一条有信息量的回复。
 *
 * ## 这个判据是有意保守的
 *
 * 只要求「有一条可引用的论据」或「有一个未答问题」，并且目标已确认。它不评价这些材料
 * 好不好打 —— 问「这个论据值不值得回应」需要语义判断，那是模型该做的，不是分类器该做的。
 *
 * 保守的方向很重要：判「材料够」而模型拒绝 → 记为缺陷；判「材料不够」而模型拒绝 →
 * 记为正确。如果判据过于宽松，就会把大量合理的拒绝记成缺陷，于是这个指标再也说明不了
 * 问题。所以宁可漏判，不可错判。
 */
export declare function evidenceIsSufficient(sufficiency: EvidenceSufficiency): boolean;
/** 分类所需的事实。全部来自已经算出来的东西，不额外读任何状态。 */
export interface OutcomeInput {
    /** 模型是否主动要求补充信息。 */
    readonly needsInput: boolean;
    /** 候选正文。空串表示没有产出。 */
    readonly reply: string;
    readonly violations: readonly {
        readonly code: string;
    }[];
    readonly evidence: EvidenceSufficiency;
    /**
     * 模型拒绝时给出的理由里是否点到**具体缺的东西**。
     *
     * 只说「信息不足」而不说缺什么，不构成一次合格的追问 —— 用户没法照做。这条判据来自
     * 产品要求本身（「缺失的事实应追问」），不是文风偏好。
     */
    readonly needsInputReason?: string;
    /**
     * 用户是否已明确要求「就按现有材料写一条」。
     *
     * 为真时，模型说「材料不足」不再被判成缺陷 —— 它已经被告知要试，拒绝时给出的
     * 具体缺口仍然是给用户的信息，但「材料够却不肯写」这个判断需要语义能力，
     * 计数规则做不到。
     *
     * 缺省为假：自动链路（例如后台批量生成）没有用户意图，保守判成缺陷可以接受。
     */
    readonly forceAttempt?: boolean;
}
/**
 * 模型是否点明了它缺什么。
 *
 * 与分类无关（分类看材料够不够），但与**用户能不能照做**有关：一条 `needs_more_context`
 * 的界面上如果只有「信息不足」四个字，用户能做的只有放弃。这个判定让页面可以说
 * 「它说缺 X，去补 X」或者「它只说信息不足，没说是哪里」。
 */
export declare function reasonNamesGap(reason: string | undefined): boolean;
export declare function classifyOutcome(input: OutcomeInput): GenerationOutcome;
/**
 * 每种结果在界面上的一句话。
 *
 * 写在这里而不是散在页面里，是因为「同一个状态在三个地方说法不同」比没有状态更坏：
 * 用户会以为是三件不同的事。
 */
export declare const OUTCOME_LABELS: Readonly<Record<GenerationOutcome, string>>;
/**
 * 这个结果是否需要用户做点什么。
 *
 * `valid_draft` 之外都需要，但原因不同 —— 页面据此决定显示「去补材料」还是「重试」还是
 * 「换个目标」。
 */
export declare function outcomeNeedsAction(outcome: GenerationOutcome): boolean;
//# sourceMappingURL=outcome.d.ts.map