/**
 * 回复里的数字，哪些能追回输入，哪些是凭空冒出来的。
 *
 * ## 为什么需要区分「原文有的」和「算出来的」
 *
 * 「涨了 8 块」如果原文写的是「从 18 涨到 26」，这 8 不是编的 —— 它是一次减法。
 * 同理「44% 的涨幅」是 8/18 的商。把它们一律判成「上下文没有的数字」，会让
 * **一处正确的推算和一个正确的引用同样算错**（v0.2.37 的 `weibo/06` 就是这么被判红的）。
 *
 * 但放宽成「只要是算术结果都算」也不行：那等于允许模型先编一个数再倒推一个算式。
 * 所以这里只接受**两个方向上可复算**的派生值，并且把算式写进依据里 ——
 * 人能拿原文的两位数当场验算，模型不能靠模糊的「差不多」蒙过去。
 *
 * ## 只做两种运算，理由
 *
 * - **差值**：a − b。价格、人数、时间的对比几乎都是这个形状。
 * - **涨幅/占比**：(a − b) / b。这是论坛争论里唯一常见的比例。
 *
 * 不做乘法、不做复合运算：可复算的范围越大，编造越容易藏进来。范围窄，但每一步
 * 都能被人用眼睛核对，这比覆盖面重要。
 */
/** 文本里出现的所有数字，按出现顺序去重。 */
export declare function numbersInText(text: string): string[];
/** 一个数字的可追溯结果。 */
export interface NumberVerdict {
    /** 归一化后的 token。 */
    readonly value: string;
    /** `quoted` 原文里就有；`derived` 由原文两个数算出；`unknown` 追不回去。 */
    readonly kind: 'quoted' | 'derived' | 'unknown';
    /** 依据：原文命中，或算式（`26 − 18 = 8`）。 */
    readonly basis: string;
}
/**
 * 判断回复里的每个数字能不能追回给定的输入。
 *
 * @param reply 回复正文
 * @param sources 模型实际看到的文本（上下文、简报、目标帖）
 */
export declare function traceNumbers(reply: string, sources: readonly string[]): NumberVerdict[];
/** 追不回去的数字，按出现顺序。 */
export declare function untraceableNumbers(reply: string, sources: readonly string[]): NumberVerdict[];
/**
 * 这条数字是不是在**陈述一个数量**。
 *
 * ## 为什么产品侧只拦量词数字
 *
 * 「第 3 节」「2024 版」里的数字是编号，不是事实主张。把它们也算成「必须能在原文
 * 找到的数字」，会让一条完全正确的回复因为「第 3 节」被判红 —— 而真正该拦的
 * 「涨了 44%」「贵了两倍」反而混在一堆编号里看不出来。
 *
 * 所以拦截面收窄到：**带百分号，或后面紧跟量词**。这是「编造统计数据」的形状，
 * 也是这一版要挡的东西。收窄是有代价的（「三点五个亿」这种写法漏网），
 * 但宁可漏掉一种写法，也不要让正常回复被误杀 —— 误杀会让主人关掉这条检查。
 */
export declare function isQuantifiedClaim(token: string, reply: string): boolean;
/** 回复里那些在陈述数量、但追不回输入的数字。 */
export declare function untraceableQuantityClaims(reply: string, sources: readonly string[]): NumberVerdict[];
//# sourceMappingURL=number-trace.d.ts.map