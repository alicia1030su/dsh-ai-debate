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
/** 归一化后的数字 token：去掉空白，全角百分号写成半角。 */
function normalise(raw) {
    return raw.replace(/\s+/g, '').replace(/％/g, '%');
}
/** 文本里出现的所有数字，按出现顺序去重。 */
export function numbersInText(text) {
    const seen = new Set();
    const out = [];
    for (const match of text.matchAll(/\d+(?:\.\d+)?%?/g)) {
        const value = normalise(match[0]);
        if (seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
/** 数值化的 token，百分号单独记。 */
function numeric(token) {
    const percent = token.endsWith('%');
    const body = percent ? token.slice(0, -1) : token;
    const value = Number(body);
    if (!Number.isFinite(value))
        return undefined;
    return { value, percent };
}
/** 保留最多两位小数的字符串，避免浮点尾数污染比较。 */
function format(value) {
    return String(Math.round(value * 100) / 100);
}
/**
 * 判断回复里的每个数字能不能追回给定的输入。
 *
 * @param reply 回复正文
 * @param sources 模型实际看到的文本（上下文、简报、目标帖）
 */
export function traceNumbers(reply, sources) {
    const literal = new Set();
    const sourceNumbers = [];
    for (const source of sources) {
        for (const token of numbersInText(source)) {
            literal.add(token);
            const parsed = numeric(token);
            if (parsed !== undefined)
                sourceNumbers.push({ token, ...parsed });
        }
    }
    return numbersInText(reply).map((token) => {
        if (literal.has(token))
            return { value: token, kind: 'quoted', basis: '原文里有这个数字' };
        const parsed = numeric(token);
        if (parsed === undefined)
            return { value: token, kind: 'unknown', basis: '无法解析为数值' };
        // 同类型的两个数才能相减：18 和 26 可以，18 和 26% 不行。
        for (let i = 0; i < sourceNumbers.length; i += 1) {
            for (let j = 0; j < sourceNumbers.length; j += 1) {
                if (i === j)
                    continue;
                const a = sourceNumbers[i];
                const b = sourceNumbers[j];
                // 差值：要求三个数同一类型。
                const diff = a.value - b.value;
                if (a.percent === parsed.percent && b.percent === parsed.percent && diff !== 0) {
                    if (Math.abs(diff - parsed.value) <= 0.5) {
                        const shown = parsed.percent ? `${format(diff)}%` : format(diff);
                        if (shown === token) {
                            return {
                                value: token,
                                kind: 'derived',
                                basis: `由原文的 ${a.token} 与 ${b.token} 相减得到（${format(a.value)} − ${format(b.value)}）`,
                            };
                        }
                    }
                }
                // 涨幅：(a − b) / b。结果是百分数，两个操作数必须是普通数。
                if (parsed.percent && !a.percent && !b.percent && b.value !== 0) {
                    const ratio = ((a.value - b.value) / b.value) * 100;
                    const rounded = Math.round(ratio * 100) / 100;
                    if (Math.abs(rounded - parsed.value) <= 0.5) {
                        return {
                            value: token,
                            kind: 'derived',
                            basis: `由原文的 ${a.token} 与 ${b.token} 算出涨幅（(${format(a.value)} − ${format(b.value)}) ÷ ${format(b.value)}）`,
                        };
                    }
                }
            }
        }
        return { value: token, kind: 'unknown', basis: '原文里没有，也无法从原文的数字算出' };
    });
}
/** 追不回去的数字，按出现顺序。 */
export function untraceableNumbers(reply, sources) {
    return traceNumbers(reply, sources).filter((verdict) => verdict.kind === 'unknown');
}
/** 量词：数字后面跟着这些字，才算在陈述一个数量。 */
const QUANTITY_UNITS = /[倍万元块人天年个月亿万美]/;
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
export function isQuantifiedClaim(token, reply) {
    if (token.endsWith('%'))
        return true;
    const index = reply.indexOf(token);
    if (index === -1)
        return false;
    const after = reply.slice(index + token.length).trimStart()[0];
    return after !== undefined && QUANTITY_UNITS.test(after);
}
/** 回复里那些在陈述数量、但追不回输入的数字。 */
export function untraceableQuantityClaims(reply, sources) {
    return untraceableNumbers(reply, sources).filter((verdict) => isQuantifiedClaim(verdict.value, reply));
}
//# sourceMappingURL=number-trace.js.map