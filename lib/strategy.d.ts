/**
 * 论证策略：这一句要**用什么打法**，与「用什么口吻说」彻底分开。
 *
 * ## 为什么必须分开
 *
 * v0.2.37 的真实四人格对决暴露了一件事：四种人格的措辞区分得开，但四条回复在做
 * 同一件事 —— 追问对方「翻倍的参照是什么」。人格只改了语气，没改打法。
 *
 * 根因不在模型，在结构：人格配置里混进了 `approach`（「先钉住对方最虚的那一句」），
 * 而它是**唯一的**打法来源。于是「换人格」等于「换打法」，「同一个人格换打法」不可
 * 表达，四种人格自然收敛到同一条路上。
 *
 * 这一层把打法拿出来，做成独立的、有证据门槛的选择：
 *
 * | 层 | 决定 | 变化维度 |
 * | --- | --- | --- |
 * | 人格 | 怎么说 | 语气、句长、用词、攻击性 |
 * | 策略 | 说什么 | 追依据 / 答核心 / 举反例 / 澄清定义 / 指矛盾 / 讲前提 / 反问 |
 *
 * 两者正交：同一个人格可以用任何策略，同一个策略可以用任何人格表达。
 *
 * ## 证据门槛是这一层的核心，不是附加项
 *
 * 「提出有出处的反例」这种策略听起来很好，但如果材料里没有反例，硬生成一个就是编造。
 * 所以每个策略都带 `requirements`：不满足就**不出现在候选里**，而不是出现了再降级。
 * 自动选择只从满足门槛的策略里挑；手工指定的策略不满足门槛时，报错并说清缺什么 ——
 * 不允许「为了多样性」强行生成。
 *
 * ## 为什么门槛写成函数而不是标签
 *
 * 标签（「需要反例」）要靠调用方理解，而调用方迟早会理解错。函数直接读简报里已经
 * 通过校验的字段，缺什么一眼可见，也顺便让「为什么这个策略不可用」变成可渲染的句子。
 */
import type { DebateBrief } from './brief.js';
/** 八种有明确证据形状的打法。 */
export type ArgumentStrategyId = 'demand_basis' | 'answer_core' | 'cite_counterexample' | 'clarify_definition' | 'point_out_contradiction' | 'point_out_repeated_question' | 'explain_premise' | 'ask_clarification';
/** 策略从哪个字段得到的依据。 */
export interface StrategyEvidence {
    /** 依据来自简报的哪个字段。 */
    readonly field: string;
    /** 相关发言的 post id，供人核对。 */
    readonly postIds: readonly string[];
    /** 一句话说明这个依据支持什么。 */
    readonly why: string;
}
/** 一个策略的定义。 */
export interface ArgumentStrategy {
    readonly id: ArgumentStrategyId;
    readonly name: string;
    /** 这个打法在做什么，一句话。 */
    readonly summary: string;
    /** 写给模型的指令：这次只按这个打法组织论证。 */
    readonly instruction: string;
    /**
     * 材料要满足什么，这个打法才成立。
     *
     * 返回 `undefined` 表示不成立，附带一句「缺什么」。
     */
    readonly requirements: (brief: DebateBrief) => StrategyEvidence | undefined;
}
/** 一次策略选择的结果。 */
export interface StrategyChoice {
    readonly id: ArgumentStrategyId;
    readonly name: string;
    /** 自动选的，还是主人指定的。 */
    readonly source: 'auto' | 'manual';
    /** 为什么选它 —— 自动：门槛怎么满足的；手工：主人指定。 */
    readonly reason: string;
    /** 依据，带 post id。手工指定时也照样记录，方便核对。 */
    readonly evidence: readonly StrategyEvidence[];
    /** 这个选择有多可靠：依据越硬越高。 */
    readonly confidence: 'high' | 'medium' | 'low';
}
/** 选择失败的原因。 */
export interface StrategyRejection {
    readonly id: ArgumentStrategyId;
    /** 缺什么。 */
    readonly missing: string;
}
/**
 * 策略目录。
 *
 * ## 顺序即优先级，而优先级的依据是「证据有多具体」，不是「打法有多精彩」
 *
 * 第一版把「直接回应核心论据」排在第三位，结果 80 个案例里 70 个都选它 —— 因为几乎
 * 每一层都有对方论据，这个门槛永远满足。那不是策略层，那是一个恒真的分支，四种人格
 * 照样走同一条路，等于什么都没改。
 *
 * 现在的规则是：**越具体、越少见的证据先选**。已核实的矛盾（要两段原文）比「有一句话
 * 可以回应」具体得多；「我们一起回答过这个问题」比「他有论据」具体得多。只有当这些
 * 更具体的形状都不存在时，才轮到「正面回答核心论据」这个通用打法。
 *
 * `answer_core` 因此被排到倒数第二，只比兜底高一位。这是刻意的：通用打法是**剩下**
 * 的选择，不是默认的选择。
 */
export declare const ARGUMENT_STRATEGIES: readonly ArgumentStrategy[];
/** 按 id 取策略。 */
export declare function strategyById(id: ArgumentStrategyId): ArgumentStrategy | undefined;
/** 所有策略 id，供校验和界面列举。 */
export declare const STRATEGY_IDS: readonly ArgumentStrategyId[];
/** 自动选择的结果，含被排除的策略与原因。 */
export interface StrategySelection {
    /** 选中的策略；无可用策略时为 `undefined`（理论上不会，因为兜底策略恒可用）。 */
    readonly choice?: StrategyChoice;
    /** 被排除的策略与缺什么，供界面和报告使用。 */
    readonly rejected: readonly StrategyRejection[];
}
/**
 * 选一个打法。
 *
 * @param brief 已通过 `validateBrief` 的简报
 * @param requested 主人手工指定的策略；不满足门槛时报错，不降级、不替换
 */
export declare function selectStrategy(brief: DebateBrief, requested?: ArgumentStrategyId): StrategySelection;
/** 把选择结果渲染成给模型的一段指令。 */
export declare function renderStrategy(choice: StrategyChoice): string;
//# sourceMappingURL=strategy.d.ts.map