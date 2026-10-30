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
/**
 * Head nouns that mark a debatable object.
 *
 * The list is deliberately short and concrete. A wide list would start matching ordinary nouns
 * and produce confident nonsense; a narrow one simply falls through to `unknown`, which is the
 * safe direction.
 */
const HEAD_NOUNS = [
    '方案',
    '建议',
    '计划',
    '做法',
    '思路',
    '观点',
    '说法',
    '提议',
    '选择',
    '路线',
    '价格',
    '报价',
    '成本',
    '预算',
    '产品',
    '设计',
    '结论',
    '判断',
    '理由',
    '解释',
];
/** Modifiers that point at something instead of naming it. */
const DEICTIC = /^(这个|那个|该|此|上述|这|那|其|本)$/;
/**
 * Words that end a modifier: a verb, a pronoun, or a preposition before the object.
 *
 * ## Why a boundary list is needed at all
 *
 * The head noun is found by string search, so the characters before it may include the *predicate*
 * of the sentence. `我支持张三的建议` would otherwise yield the modifier `我支持张三`, and
 * `A 方案` would yield nothing at all because of the space. Taking everything after the last
 * boundary word gives `张三` and `A` respectively — which is the actual object.
 *
 * The list contains only words that cannot be part of a noun phrase. Polarity words (`不`,
 * `很`, `太`) are deliberately excluded: they are part of the judgement, not a boundary, and
 * treating them as one would truncate `不算贵的报价`.
 */
const MODIFIER_BOUNDARY = /(?:我|你|他|她|它|支持|反对|认为|觉得|表示|指出|关于|对于|针对|采纳|否定|拒绝|同意)/g;
/**
 * Split a matched phrase into modifier and head.
 *
 * The regex captures one to six characters before the head noun. What precedes them is the
 * modifier; when the match starts at the beginning of the text, the modifier is treated as
 * absent and the whole match is a deictic-less bare noun (e.g. `方案可行` → head `方案`,
 * modifier `''`).
 */
export function splitPhrase(phrase) {
    for (const head of HEAD_NOUNS) {
        if (!phrase.endsWith(head))
            continue;
        return { head, modifier: phrase.slice(0, phrase.length - head.length) };
    }
    return undefined;
}
/**
 * Take the modifier that immediately precedes a head noun.
 *
 * Returns `''` when nothing plausible precedes it, which is a legitimate answer: `方案不可行`
 * is a statement about *the* plan under discussion, and inventing a modifier there would
 * manufacture a distinction.
 */
function modifierBefore(text, at) {
    // Trailing whitespace and punctuation belong to the sentence, not the noun phrase.
    let window = text.slice(Math.max(0, at - 8), at).replace(/[\s，。；：、！？"'「」（）().]+$/, '');
    // Cut at the last predicate/pronoun boundary: what follows it is the object itself.
    let boundaryEnd = -1;
    MODIFIER_BOUNDARY.lastIndex = 0;
    for (;;) {
        const match = MODIFIER_BOUNDARY.exec(window);
        if (match === null)
            break;
        boundaryEnd = match.index + match[0].length;
    }
    if (boundaryEnd >= 0)
        window = window.slice(boundaryEnd);
    // Strip anything that is not a name/label character.
    const match = window.match(/[A-Za-z0-9\u4e00-\u9fa5]+$/);
    let modifier = match === null ? '' : match[0];
    // A modifier longer than four characters is a clause, not a label.
    if (modifier.length > 4)
        modifier = modifier.slice(-4);
    return modifier;
}
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
export function extractArgumentObjects(text) {
    const out = [];
    for (const head of HEAD_NOUNS) {
        // Find each occurrence of the head noun and take the modifier that precedes it.
        let from = 0;
        for (;;) {
            const at = text.indexOf(head, from);
            if (at === -1)
                break;
            from = at + head.length;
            // The modifier must be the characters immediately before the head, and must not contain
            // punctuation or another head noun (which would mean we crossed into a different phrase).
            let modifier = modifierBefore(text, at);
            // A modifier that contains another head noun means we are looking at the wrong phrase.
            if (HEAD_NOUNS.some((other) => other !== head && modifier.includes(other))) {
                modifier = '';
            }
            const phrase = `${modifier}${head}`;
            if (out.some((entry) => entry.phrase === phrase))
                continue;
            out.push({
                phrase,
                head,
                modifier,
                deictic: DEICTIC.test(modifier),
            });
        }
    }
    return out;
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
export function compareArgumentObjects(ownerText, opponentText) {
    const ownerObjects = extractArgumentObjects(ownerText);
    const opponentObjects = extractArgumentObjects(opponentText);
    if (ownerObjects.length === 0 || opponentObjects.length === 0) {
        return {
            relation: 'unknown',
            owner: ownerObjects,
            opponent: opponentObjects,
            reason: '有一方没有可识别的论点对象，无法判断是否在谈同一件事。',
        };
    }
    // Compare over the head nouns both sides share: those are the candidate disputed kinds.
    const sharedHeads = ownerObjects
        .map((entry) => entry.head)
        .filter((head) => opponentObjects.some((entry) => entry.head === head));
    if (sharedHeads.length === 0) {
        return {
            relation: 'different_objects',
            owner: ownerObjects,
            opponent: opponentObjects,
            reason: '双方谈论的对象种类不同，没有共同的讨论对象。',
        };
    }
    for (const head of sharedHeads) {
        const mine = ownerObjects.filter((entry) => entry.head === head);
        const theirs = opponentObjects.filter((entry) => entry.head === head);
        // Both sides point rather than name: identity is real but only the conversation establishes
        // it. This is the `这个方案` case — a genuine disagreement we must not call settled.
        if (mine.every((entry) => entry.deictic) && theirs.every((entry) => entry.deictic)) {
            const minePointers = new Set(mine.map((entry) => entry.modifier));
            const shared = theirs.some((entry) => minePointers.has(entry.modifier));
            return {
                // ## Two different pointers are NOT evidence of two objects
                //
                // The first version returned `different_objects` here while its own reason line said
                // "无法确认是否同一件事" — a `different_objects` verdict is a claim, and the sentence
                // under it admitted we could not make one. Two people saying `这个方案` and `那个方案`
                // usually mean the same plan, and sometimes do not. That is "clarification needed", not
                // "different topics".
                relation: shared ? 'same_reference' : 'unknown',
                owner: ownerObjects,
                opponent: opponentObjects,
                reason: shared
                    ? `双方都用指代（${[...minePointers].join('、')}${head}）指向同一个对象；` +
                        '这通常表示在讨论同一件事，但指代指向仍需结合上下文确认。'
                    : `双方用了不同的指代（${[...minePointers].join('、')}${head} / ` +
                        `${theirs.map((entry) => entry.modifier).join('、')}${head}），` +
                        '无法确认是否指同一件事，因此不做判断。',
            };
        }
        // Both name concretely: identical modifiers mean the same object, different ones do not.
        const mineNamed = mine.filter((entry) => !entry.deictic).map((entry) => entry.modifier);
        const theirsNamed = theirs.filter((entry) => !entry.deictic).map((entry) => entry.modifier);
        if (mineNamed.length > 0 && theirsNamed.length > 0) {
            const identical = mineNamed.some((value) => theirsNamed.includes(value));
            if (identical) {
                return {
                    relation: 'same_object',
                    owner: ownerObjects,
                    opponent: opponentObjects,
                    reason: `双方都明确指向${head}「${mineNamed.find((value) => theirsNamed.includes(value))}」。`,
                };
            }
            return {
                relation: 'different_objects',
                owner: ownerObjects,
                opponent: opponentObjects,
                reason: `双方谈的${head}不同：一方说「${mineNamed.join('、')}${head}」，` +
                    `另一方说「${theirsNamed.join('、')}${head}」。不同的对象可以同时成立，不构成矛盾。`,
            };
        }
        // One side names, the other points. The pointer might refer to the named object, or not.
        return {
            relation: 'unknown',
            owner: ownerObjects,
            opponent: opponentObjects,
            reason: `一方明确指向某个${head}，另一方只用指代，无法确认是否同一对象。`,
        };
    }
    return {
        relation: 'unknown',
        owner: ownerObjects,
        opponent: opponentObjects,
        reason: '无法确定双方是否在谈同一个对象。',
    };
}
//# sourceMappingURL=argument-object.js.map