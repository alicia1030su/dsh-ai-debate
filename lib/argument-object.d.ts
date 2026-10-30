/**
 * v0.2.14 §六：区分论点对象。
 *
 * ## 为什么需要这一层
 *
 * v0.2.13 的判定只看「两者有没有共同词」。这在一类句子上必然出错：
 *
 * | 主人 | 对方 | v0.2.13 判定 | 实际 |
 * | --- | --- | --- | --- |
 * | A 方案可行。 | B 方案不可行。 | contradiction | 两个不同对象，**不矛盾** |
 * | 我支持张三的建议。 | 我反对李四的建议。 | contradiction | 两个人，**不矛盾** |
 * | 这个方案可行。 | 这个方案不可行。 | unknown | 同一个对象，**明确矛盾** |
 *
 * 第一、二行的病根是「方案」「建议」这两个词重叠，第三行的病根是「这个」无法解析。
 * 换句话说，**词语重叠不等于同一个争论对象**，而**指代词不解析就无法判断对象是否相同**。
 *
 * ## 这一层做什么
 *
 * 把每句话的「论点对象」抽成结构：`(修饰语, 中心词)`。
 *
 * - 中心词相同、修饰语是两个**具体**值且不同 → 不同对象（`different_topics`）。
 * - 两边都用**指代**（这个/该/上述）指向同一个先行词 → 可能是同一对象，但需要对话关系确认，
 *   因此报 `clarification_needed` 而不是直接判矛盾。
 * - 两边修饰语相同 → 同一对象，交给极性判断。
 * - 抽不出对象 → 不创造对象，退回 `unknown`。
 *
 * ## 保守原则
 *
 * 任务书 §6.2 要求「无法明确解析对象时，不得创造原文里不存在的对象」。所以这一层只做
 * **否定**判断（证明「不是同一个对象」），从不做**肯定**判断（断言「就是同一个对象」）。
 * 唯一的例外是两边修饰语字面相同，那不需要推断。
 */
/** A noun phrase that a statement is about. */
export interface ArgumentObject {
    /** The phrase as it appeared, e.g. `A方案`. */
    readonly phrase: string;
    /** The head noun, e.g. `方案`. */
    readonly head: string;
    /** What precedes the head noun — a label (`A`), a name (`张三`), or a pointer (`这个`). */
    readonly modifier: string;
    /**
     * Whether the modifier points at something said earlier instead of naming it.
     *
     * A deictic cannot establish identity on its own: `这个方案` is the same object only if the
     * conversation says so. Treating it as self-identifying is how a machine invents agreement.
     */
    readonly deictic: boolean;
}
/**
 * Split a matched phrase into modifier and head.
 *
 * The regex captures one to six characters before the head noun. What precedes them is the
 * modifier; when the match starts at the beginning of the text, the modifier is treated as
 * absent and the whole match is a deictic-less bare noun (e.g. `方案可行` → head `方案`,
 * modifier `''`).
 */
export declare function splitPhrase(phrase: string): {
    head: string;
    modifier: string;
} | undefined;
/**
 * Extract every argument object a statement mentions.
 *
 * ## The matching strategy
 *
 * A head noun is found, then up to six preceding characters are taken as its modifier — but the
 * modifier must not cross a punctuation or another head noun, or `我支持张三的建议` would yield
 * the nonsense modifier `我支持张三`.
 *
 * The result is ordered by position so a caller can reason about the first-mentioned object.
 */
export declare function extractArgumentObjects(text: string): ArgumentObject[];
/** How two statements' objects relate. */
export type ObjectRelation = 
/** Both name the same object, or name different objects of the same kind. */
'same_object' | 'different_objects'
/** Both point with a deictic; identity depends on the conversation, which we do not have. */
 | 'same_reference'
/** Nothing extractable. Never a basis for a claim. */
 | 'unknown';
/** The verdict of comparing two statements' argument objects. */
export interface ObjectComparison {
    readonly relation: ObjectRelation;
    /** The objects found on each side, for the reason line. */
    readonly owner: readonly ArgumentObject[];
    readonly opponent: readonly ArgumentObject[];
    /** Plain-language explanation, shown to the reviewer. */
    readonly reason: string;
}
/**
 * Compare the objects two statements are about.
 *
 * ## The asymmetry that makes this safe
 *
 * `different_objects` requires **positive evidence**: both sides name a concrete object of the
 * same kind, and the names differ. Everything else is `unknown` or `same_reference`, neither of
 * which licenses a contradiction claim.
 *
 * That asymmetry is deliberate. Missing an object costs a `clarification_needed` that a human
 * resolves; inventing sameness produces a confident accusation against a stranger's post.
 */
export declare function compareArgumentObjects(ownerText: string, opponentText: string): ObjectComparison;
//# sourceMappingURL=argument-object.d.ts.map