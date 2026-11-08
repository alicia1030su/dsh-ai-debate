/**
 * The argument structure: what the two sides actually said, and what is missing.
 *
 * ## Why this is a separate pass rather than more prompt text
 *
 * v0.2.34 added `opponentArguments` to the brief and that fixed one thing: the model could
 * finally see the opponent's claims one by one. It did not fix the other nine. A reply could
 * still demand evidence the opponent had already given, re-answer a question the owner had
 * already answered, or treat a quoted third party as the opponent's own position — because
 * none of those relationships were *computed*, and a model asked to "be careful" about
 * them is being asked to do bookkeeping it cannot verify.
 *
 * So this module computes them from the collected text, and every finding carries the exact
 * substring and post id it came from. `validateBrief` then checks that every quote really
 * occurs in the post it names. A finding that cannot quote its source does not exist.
 *
 * ## What this is not
 *
 * It is not a second debate engine. It reads the same `Dispute` the analyzer built and the
 * same `CollectedThread` the collector read; it adds no new notion of who is arguing with
 * whom, no new identity resolution, and no model call. Its output is a set of *cited
 * observations* whose only consumers are the brief renderer and the reviewer.
 *
 * ## The rule that keeps the fallacy list honest
 *
 * "The opponent is wrong, therefore the opponent committed a fallacy" is the failure mode
 * this file is most likely to have. Two rules prevent it:
 *
 * 1. **Every detector requires a textual marker**, not a stance. `hasty_generalization`
 *    needs a universal quantifier *and* a single-case marker in the same sentence;
 *    `self_contradiction` needs two sentences that survive negation-stripping into the same
 *    predicate. Disagreeing with the owner is never a marker.
 * 2. **Confidence is reported, and low confidence is the common case.** The prompt tells the
 *    model these are leads, not verdicts, and that naming a fallacy is usually worse than
 *    answering the point.
 */
import { isSubstantive, looksLikeQuestion } from './analyzer.js';
/**
 * Sentences of a post, trimmed, **with their terminator kept**.
 *
 * ## Why the punctuation stays
 *
 * The first version split on `[。！？!?]` and threw the delimiter away, which made every
 * question invisible to `looksLikeQuestion`: 「那你算过三年期的总成本吗？」 became
 * 「…总成本吗」 with no `？`, and the keyword list does not contain 「吗」 because a
 * statement can end in it too. The result was a ledger that never recorded a single
 * question — and the tests that only counted *contradictions* still passed.
 *
 * Keeping the terminator makes the question mark the signal it is, and costs nothing
 * anywhere else: the quotes stored in the brief are still substrings of the post.
 */
export function sentencesOf(content) {
    const out = [];
    for (const match of content.matchAll(/[^。！？!?\n]+[。！？!?]?/g)) {
        const sentence = match[0].trim();
        if (sentence.length >= 4)
            out.push(sentence);
    }
    return out;
}
/** CJK bigrams, Latin words and numbers — enough to compare subjects without a segmenter. */
const STOP_BIGRAMS = new Set([
    '这个', '那个', '就是', '不是', '什么', '我们', '你们', '他们', '自己', '现在',
    '然后', '因为', '所以', '但是', '可以', '一个', '没有', '还是', '这么', '那么',
    '这样', '那样', '时候', '问题', '觉得', '知道', '说的', '说了', '起来', '出来',
    '的话', '其实', '真的', '已经', '应该', '如果', '虽然', '而且', '或者', '以及',
    '不是', '一样', '一点', '有点', '怎么', '为什么', '是不是', '有没有',
]);
/** Content tokens used to compare two sentences' subjects. */
export function subjectTokens(text) {
    const tokens = new Set();
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}/g)) {
        tokens.add(match[0].toLowerCase());
    }
    for (const match of text.matchAll(/\d+(?:\.\d+)?%?/g))
        tokens.add(match[0]);
    const cjk = [...text.replace(/[^\u4e00-\u9fff]/g, '')];
    for (let index = 0; index + 1 < cjk.length; index += 1) {
        const bigram = `${cjk[index]}${cjk[index + 1]}`;
        if (STOP_BIGRAMS.has(bigram))
            continue;
        tokens.add(bigram);
    }
    return tokens;
}
/** How many tokens two sets share. */
function overlap(a, b) {
    let count = 0;
    for (const token of a)
        if (b.has(token))
            count += 1;
    return count;
}
/**
 * Longest common substring length, capped — used to tell "same claim" from "same word".
 */
function sharedRun(a, b) {
    const left = a.replace(/\s+/g, '');
    const right = b.replace(/\s+/g, '');
    if (left === '' || right === '')
        return 0;
    let best = 0;
    let previous = new Array(right.length + 1).fill(0);
    for (let i = 1; i <= left.length; i += 1) {
        const current = new Array(right.length + 1).fill(0);
        for (let j = 1; j <= right.length; j += 1) {
            if (left[i - 1] === right[j - 1]) {
                const size = previous[j - 1] + 1;
                current[j] = size;
                if (size > best)
                    best = size;
            }
        }
        previous = current;
    }
    return best;
}
/**
 * The longest substring the two texts share, as text.
 *
 * Needed as *text* rather than as a length, because "is this the same claim?" is decided by
 * whether the shared part carries a content word. 「这个方案」 is shared by both sentences
 * in the classic contradiction fixture, and a length-only test treats those four characters
 * as the claim.
 */
function longestCommonSubstring(a, b) {
    const left = a.replace(/\s+/g, '');
    const right = b.replace(/\s+/g, '');
    if (left === '' || right === '')
        return '';
    let bestEnd = 0;
    let bestLen = 0;
    let previous = new Array(right.length + 1).fill(0);
    for (let i = 1; i <= left.length; i += 1) {
        const current = new Array(right.length + 1).fill(0);
        for (let j = 1; j <= right.length; j += 1) {
            if (left[i - 1] === right[j - 1]) {
                const size = previous[j - 1] + 1;
                current[j] = size;
                if (size > bestLen) {
                    bestLen = size;
                    bestEnd = i;
                }
            }
        }
        previous = current;
    }
    return left.slice(bestEnd - bestLen, bestEnd);
}
/** Negation markers that flip a predicate, longest first so `不会` wins over `会`. */
const NEGATIONS = [
    '不可能', '不一定', '不应该', '不需要', '不可以', '不同意', '不支持', '不值得',
    '不会', '不能', '不是', '没有', '从不', '从未', '并非', '毫无', '绝不', '根本不',
];
/** Remove negation markers so two sentences can be compared on their claim. */
function stripNegation(text) {
    let out = text.replace(/\s+/g, '');
    for (const marker of NEGATIONS)
        out = out.split(marker).join('');
    return out;
}
/** Which negation markers a sentence contains. */
function negationsOf(text) {
    const found = new Set();
    const flat = text.replace(/\s+/g, '');
    for (const marker of NEGATIONS)
        if (flat.includes(marker))
            found.add(marker);
    return found;
}
/** Quote spans a post uses: 「…」, “…” and "…". */
export function quotedSpans(text) {
    const spans = [];
    const patterns = [/「([^」]{2,120})」/g, /“([^”]{2,120})”/g, /"([^"]{2,120})"/g];
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const span = (match[1] ?? '').trim();
            if (span !== '' && !spans.includes(span))
                spans.push(span);
        }
    }
    return spans;
}
/** Attributions that introduce somebody who is not in the argument. */
const ATTRIBUTION_MARKERS = [
    '专家', '教授', '医生说', '研究', '报告', '新闻', '媒体', '官方', '统计', '数据表明',
    '网上', '大家', '很多人', '有人说', '网友', '朋友说', '同事说', '老师',
];
/** Explicit signs the speaker is changing the subject. */
const SHIFT_MARKERS = [
    '先不说这个', '不说这个', '换个话题', '说点别的', '另外', '顺便说', '话说回来',
    '回到正题之前', '这些都不重要', '别扯这些', '不管这个',
];
/** Words that mark a claim as empirical, which needs a source. */
const EVIDENCE_MARKERS = [
    '来源', '链接', 'http', '数据', '统计', '报告', '论文', '截图', '新闻', '原文',
    '调查', '实验', '样本', '引用', '出处',
];
/** Universal quantifiers, half of the `hasty_generalization` signal. */
const UNIVERSAL_MARKERS = /(都|所有|全部|全都|一律|从来|根本|任何|每个|无一例外|必然|一定)/;
/** Single-case markers, the other half. */
const SINGLE_CASE_MARKERS = /(我朋友|我同事|我身边|我认识|有一次|有个|一个例子|我上次|我自己就|我见过)/;
/** Temporal-adjacency markers that often stand in for a causal argument. */
const TEMPORAL_MARKERS = /(自从|后来|之后|那以后|打那以后)/;
/** A mechanism word, which makes a causal claim an actual argument rather than a coincidence. */
const MECHANISM_MARKERS = /(因为|导致|造成|机制|通过|原理|由于|从而|进而)/;
/** `after X, Y happened, therefore X caused Y` — needs both halves and no mechanism. */
function isFalseCause(text) {
    const causal = /(所以|因此|可见|说明|证明)/.test(text);
    return causal && TEMPORAL_MARKERS.test(text) && !MECHANISM_MARKERS.test(text);
}
/** Marginal, single-case reasoning presented as a general rule. */
function isHastyGeneralization(text) {
    return UNIVERSAL_MARKERS.test(text) && SINGLE_CASE_MARKERS.test(text);
}
/**
 * A hard empirical claim with no source in the same post.
 *
 * ## Why a bare number is not enough
 *
 * 「一次性支出 30 万」 is how people talk; demanding a citation for every figure would make
 * this detector fire on ordinary conversation and teach the reviewer to ignore it. What
 * actually needs backing is a claim that *quantifies a conclusion* — a multiple, a
 * percentage, an absolute quantifier — because those are the ones a reply can be built on.
 *
 * So the trigger is: a multiplier / percentage / very large magnitude, **or** a number tied
 * to a universal quantifier. A plain figure with no such framing is left alone.
 */
function isUnsupportedClaim(text) {
    const quantified = /(\d+(?:\.\d+)?\s*(?:倍|%|％|亿))/.test(text);
    const absolute = /\d/.test(text) && /(都|所有|全部|一律|必然|一定|根本)/.test(text);
    if (!quantified && !absolute)
        return false;
    return !EVIDENCE_MARKERS.some((marker) => text.toLowerCase().includes(marker));
}
/**
 * The subject of the argument, as tokens.
 *
 * Built from each side's *first substantive* post rather than from every post: the exchange
 * carries asides, and a subject set polluted by them would make every aside look on-topic.
 * Passing the two sides in explicitly is what keeps the owner's opening claim from being
 * read as the opponent's subject.
 */
function disputeSubject(owner, opponent) {
    const tokens = new Set();
    const firstSubstantive = (statements) => statements.find((statement) => statement.content.trim().length >= 6)?.content;
    const sources = [];
    const mine = firstSubstantive(owner);
    const theirs = firstSubstantive(opponent);
    if (mine !== undefined)
        sources.push(mine);
    if (theirs !== undefined)
        sources.push(theirs);
    for (const text of sources)
        for (const token of subjectTokens(text))
            tokens.add(token);
    return tokens;
}
/** Statements from one author key, oldest first. */
function byAuthor(statements, key) {
    if (key === undefined)
        return [];
    return statements.filter((statement) => statement.authorKey === key);
}
/**
 * Questions asked by `asker`, and the first later substantive reply from `answerer`.
 *
 * ## Ordering comes from the exchange, not from guesswork
 *
 * `Dispute.exchange` is the interleaved owner/opponent exchange, oldest first — the only
 * ordered view of the argument the analyzer produces. Walking it once is what makes "did
 * anyone answer this?" answerable at all; comparing two separate per-author lists has no
 * shared clock, and `Statement.createdAt` is absent on most platforms.
 *
 * The approximation is deliberate and coarse: *any* later substantive post counts as a
 * response. Claiming "he answered this specific point" would need semantics we do not have,
 * and every entry carries its post id so a human can check what actually happened.
 */
function questionLedger(exchange, askerKey, answererKey) {
    if (askerKey === undefined || answererKey === undefined)
        return [];
    const out = [];
    for (const [index, statement] of exchange.entries()) {
        if (statement.authorKey !== askerKey)
            continue;
        for (const sentence of sentencesOf(statement.content)) {
            if (!looksLikeQuestion(sentence))
                continue;
            /**
             * ## A later reply is not automatically an answer
             *
             * This is the correction that makes the ledger useful. The first version counted any
             * later substantive post as the answer, so 「反正我身边做这行的人都这么说」 closed a
             * question about where a number came from — and the brief then could not show the one
             * thing the reply most needed to say: you replied, but you did not answer.
             *
             * The test is subject overlap: a real answer shares a topic token with the question.
             * When it does not, the post is recorded as an evasion instead, with both quotes.
             */
            const response = exchange
                .slice(index + 1)
                .find((candidate) => candidate.authorKey === answererKey && isSubstantive(candidate.content));
            const questionTokens = subjectTokens(sentence);
            const answered = response === undefined ? false : overlap(questionTokens, subjectTokens(response.content)) > 0;
            out.push({
                quote: sentence.slice(0, 160),
                postId: statement.postId,
                ...(response === undefined
                    ? {}
                    : answered
                        ? { answerPostId: response.postId, answerQuote: response.content.slice(0, 120) }
                        : { evasionPostId: response.postId, evasionQuote: response.content.slice(0, 120) }),
            });
            if (out.length >= 8)
                return out;
        }
    }
    return out;
}
/**
 * Places the opponent left the subject.
 *
 * Requires both: an earlier opponent statement *on* the subject, and a later one with no
 * subject token at all. A first post that happens to be off-topic is not a shift — it is
 * just how the person talks.
 */
function findTopicShifts(opponent, subject) {
    const out = [];
    let lastOnTopic;
    for (const statement of opponent) {
        const tokens = subjectTokens(statement.content);
        const same = overlap(tokens, subject);
        if (same === 0 && lastOnTopic !== undefined && statement.content.trim().length >= 12) {
            const marker = SHIFT_MARKERS.find((candidate) => statement.content.includes(candidate));
            const previousQuote = sentencesOf(lastOnTopic.content)[0] ?? lastOnTopic.content.slice(0, 80);
            out.push({
                postId: statement.postId,
                quote: statement.content.slice(0, 160),
                previousPostId: lastOnTopic.postId,
                previousQuote: previousQuote.slice(0, 120),
                ...(marker === undefined ? {} : { marker }),
            });
            if (out.length >= 3)
                return out;
            continue;
        }
        if (same > 0)
            lastOnTopic = statement;
    }
    return out;
}
/**
 * Two of the opponent's own statements that cannot both hold.
 *
 * ## Why this needs a grammatical test, not a topic test
 *
 * Two posts about the same price are not a contradiction — one can say it rose and the
 * other that it is still cheap. The only deterministic contradiction is the same predicate
 * asserted with and without a negation, so this compares the sentences with negations
 * stripped and requires the remaining claim to match closely.
 */
function findContradictions(opponent) {
    const out = [];
    const entries = [];
    for (const statement of opponent) {
        for (const sentence of sentencesOf(statement.content)) {
            const base = stripNegation(sentence);
            if (base.length < 5)
                continue;
            entries.push({ postId: statement.postId, sentence, base, negated: negationsOf(sentence) });
            if (entries.length >= 60)
                break;
        }
        if (entries.length >= 60)
            break;
    }
    for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
            const first = entries[i];
            const second = entries[j];
            if (first.postId === second.postId && first.sentence === second.sentence)
                continue;
            const onlyOneNegated = (first.negated.size === 0 && second.negated.size > 0) ||
                (second.negated.size === 0 && first.negated.size > 0);
            if (!onlyOneNegated)
                continue;
            const run = sharedRun(first.base, second.base);
            /**
             * ## What counts as "the same claim"
             *
             * The first version required the shared run to be most of the shorter sentence, and
             * that rejected the case it was written for: 「这个方案的成本会翻倍」 against
             * 「其实这个方案的成本不会翻倍」 share seven characters, which is 60% of the shorter
             * one and nowhere near 70%.
             *
             * The rule now asks two things instead of one ratio:
             *
             * - the shared run is at least six characters (long enough to be a claim, not a word);
             * - **and** it contains a content bigram, so 「这个方案」 alone cannot carry it.
             *
             * Extra qualifiers around the shared core are expected — people do not repeat
             * themselves verbatim — and requiring a ratio punished exactly that.
             */
            const shortest = Math.min(first.base.length, second.base.length);
            if (shortest === 0)
                continue;
            if (run < 6)
                continue;
            const sharedAt = longestCommonSubstring(first.base, second.base);
            if (sharedAt === '')
                continue;
            const contentTokens = subjectTokens(sharedAt);
            if (contentTokens.size === 0)
                continue;
            out.push({
                firstPostId: first.postId,
                firstQuote: first.sentence.slice(0, 120),
                secondPostId: second.postId,
                secondQuote: second.sentence.slice(0, 120),
                subject: first.base.slice(0, run),
            });
            if (out.length >= 3)
                return out;
        }
    }
    return out;
}
/**
 * 条件语境：两句话如果各带不同的前提，它们就不是「同一断言的一正一反」。
 *
 * ## 这一条挡的是什么
 *
 * 「如果涨价我就退出」与「降价了我也不退出」在字面上是同一个内核（退出）加不同极性，
 * 但**前提不同**，两句都对。把它们当成「前后矛盾」是最容易被对方一句话打回来的
 * 错误 —— 而且说错一次，整条回复的可信度就没了。
 *
 * 识别方式是标记词而非语义：出现条件/时间词，就把置信度降下来，让渲染层写成
 * 「待核实」，由人来决定要不要碰。这是**保守的降级**，不是判定「没有矛盾」。
 */
const CONDITION_MARKERS = /(如果|要是|假设|假如|除非|一旦|在.{0,6}情况下|只要|万一|倘若)/;
const TIME_MARKERS = /(现在|目前|当前|当时|以前|之前|去年|今年|上个月|这个月|未来|将来|以后|之后|过去|最近|刚|刚刚)/;
/** 这句话带着哪种前提/时间限定。 */
function qualifierOf(sentence) {
    const condition = CONDITION_MARKERS.exec(sentence)?.[1];
    const time = TIME_MARKERS.exec(sentence)?.[1];
    return {
        ...(condition === undefined ? {} : { condition }),
        ...(time === undefined ? {} : { time }),
    };
}
/**
 * 两句话的限定语境是否可能不同。
 *
 * 判定规则刻意宽松：只要一方带条件、或两方带**不同**的时间词，就算「可能不同」。
 * 宽松在这里是安全的 —— 它只影响置信度，不影响「这条要不要出现在简报里」。
 */
function contextMayDiffer(first, second) {
    const a = qualifierOf(first);
    const b = qualifierOf(second);
    if (a.condition !== undefined && b.condition === undefined) {
        return { differs: true, why: `一句带条件「${a.condition}」、另一句没有，可能说的是不同前提` };
    }
    if (b.condition !== undefined && a.condition === undefined) {
        return { differs: true, why: `一句带条件「${b.condition}」、另一句没有，可能说的是不同前提` };
    }
    if (a.condition !== undefined && b.condition !== undefined && a.condition !== b.condition) {
        return { differs: true, why: `两句话的前提不同（「${a.condition}」/「${b.condition}」）` };
    }
    if (a.time !== undefined && b.time !== undefined && a.time !== b.time) {
        return { differs: true, why: `两句话的时间不同（「${a.time}」/「${b.time}」），可能是观点改变而不是自相矛盾` };
    }
    return { differs: false, why: '' };
}
/** Quoted third parties inside the opponent's posts. */
function findThirdPartyCitations(opponent, participantTexts) {
    const out = [];
    for (const statement of opponent) {
        for (const span of quotedSpans(statement.content)) {
            /**
             * A quote of a participant's own words is a quotation of that participant, not a
             * third party — **but the citing post must be excluded from that test**.
             *
             * The first version compared the span against every participant post including the
             * one it appears in, so every quotation matched itself and the list was always empty.
             * The question is "did somebody *else* say this", which is only answerable by
             * excluding the post doing the quoting.
             */
            const matchesParticipant = participantTexts.some((text) => text.postId !== statement.postId && text.content.includes(span));
            const attribution = ATTRIBUTION_MARKERS.find((marker) => statement.content.includes(marker));
            if (matchesParticipant)
                continue;
            if (attribution === undefined && !/「|“/.test(statement.content))
                continue;
            out.push({
                postId: statement.postId,
                quote: span,
                ...(attribution === undefined ? {} : { attribution }),
                note: attribution === undefined
                    ? '这条发言引用了不在争论里的一段话，但没有说明来源；不能当成对手自己的主张。'
                    : `这条发言引用了「${attribution}」的说法，那是第三方的观点，不是对手本人的立场。`,
            });
            if (out.length >= 3)
                return out;
        }
    }
    return out;
}
/** Context this read is missing, phrased for the reviewer. */
function findMissingContext(input) {
    const out = [];
    const { collected, dispute } = input;
    if (!collected.complete) {
        out.push(`读取不完整（${collected.stopReason ?? '原因未知'}）：可能有楼层或楼中楼没有被读到。`);
    }
    if (dispute.opponent !== undefined && dispute.opponent.matchKind === 'name') {
        out.push('对手是按昵称匹配的：同名的人会被当成同一个人。');
    }
    /**
     * ## 只有「没读到」才算缺上下文
     *
     * 这里一度把「对方问了、主人没答的问题数」也列进来，那是错的：没答不等于没读到，
     * 把两者混在一起会让简报多出一段「这次没有拿到的上下文」，而它其实是一条待办。
     * 未答的问题在 `challenges` 与 `openQuestions` 里各自成段，不需要在这里重复。
     */
    return out;
}
/**
 * Compute the structure.
 *
 * Bounded work: the contradiction scan is quadratic in the opponent's sentences and capped
 * at 60 of them, so a long thread costs a few milliseconds rather than a few seconds. The
 * scale baseline in the test suite measures this path.
 */
export function analyzeArguments(input) {
    const { dispute } = input;
    const ownerKey = dispute.owner.key;
    const opponentKey = dispute.opponent?.key;
    const opponent = byAuthor(dispute.exchange, opponentKey);
    const owner = byAuthor([...dispute.exchange, ...dispute.ownerStatements], ownerKey);
    const subject = disputeSubject(owner, opponent);
    const ownerQuestions = questionLedger(dispute.exchange, ownerKey, opponentKey);
    const opponentQuestions = questionLedger(dispute.exchange, opponentKey, ownerKey);
    const unansweredByOpponent = ownerQuestions
        .filter((entry) => entry.answerPostId === undefined)
        .map(({ quote, postId, evasionPostId, evasionQuote }) => ({
        quote,
        postId,
        ...(evasionPostId === undefined ? {} : { evasionPostId }),
        ...(evasionQuote === undefined ? {} : { evasionQuote }),
    }));
    const answeredByOwner = opponentQuestions.filter((entry) => entry.answerPostId !== undefined);
    const contradictions = findContradictions(opponent);
    const topicShifts = findTopicShifts(opponent, subject);
    const participantTexts = [...owner, ...opponent].map((statement) => ({
        postId: statement.postId,
        content: statement.content,
    }));
    const thirdPartyCitations = findThirdPartyCitations(opponent, participantTexts);
    // Fallacy findings are assembled from the observations above plus three sentence-level
    // tests, so a finding never exists without a detector that produced it.
    const fallacies = [];
    for (const contradiction of contradictions) {
        fallacies.push({
            code: 'self_contradiction',
            label: '前后矛盾',
            postId: contradiction.secondPostId,
            quote: contradiction.secondQuote,
            otherPostId: contradiction.firstPostId,
            otherQuote: contradiction.firstQuote,
            why: '同一个说法在前面被肯定、在后面被否定，两句话不能同时成立。',
            confidence: 'high',
        });
    }
    for (const shift of topicShifts) {
        fallacies.push({
            code: 'topic_shift',
            label: '转移话题',
            postId: shift.postId,
            quote: shift.quote,
            otherPostId: shift.previousPostId,
            otherQuote: shift.previousQuote,
            why: shift.marker === undefined
                ? '这一条与正在争论的对象没有任何共同话题，像是在换一个更好回答的问题。'
                : `这一条明确用「${shift.marker}」换了话题。`,
            confidence: shift.marker === undefined ? 'medium' : 'high',
        });
    }
    for (const statement of opponent) {
        for (const sentence of sentencesOf(statement.content)) {
            if (isHastyGeneralization(sentence)) {
                fallacies.push({
                    code: 'hasty_generalization',
                    label: '以偏概全',
                    postId: statement.postId,
                    quote: sentence.slice(0, 120),
                    why: '用个别例子推出「都/所有」这种全称结论，样本支撑不了结论。',
                    confidence: 'high',
                });
            }
            if (isFalseCause(sentence)) {
                fallacies.push({
                    code: 'false_cause',
                    label: '错误因果',
                    postId: statement.postId,
                    quote: sentence.slice(0, 120),
                    why: '只凭先后顺序就断言因果，没有说明机制。',
                    confidence: 'medium',
                });
            }
            if (isUnsupportedClaim(sentence)) {
                fallacies.push({
                    code: 'missing_evidence',
                    label: '缺少关键证据',
                    postId: statement.postId,
                    quote: sentence.slice(0, 120),
                    why: '这一句给出了具体数量结论，但同一条发言里没有来源、数据或链接。',
                    confidence: 'low',
                });
            }
            if (fallacies.length >= 8)
                break;
        }
        if (fallacies.length >= 8)
            break;
    }
    // Quoting the owner out of context: the quoted span exists in an owner post, but the
    // sentence it came from says something the span alone does not.
    for (const statement of opponent) {
        for (const span of quotedSpans(statement.content)) {
            const source = owner.find((candidate) => candidate.content.includes(span));
            if (source === undefined)
                continue;
            const sentence = sentencesOf(source.content).find((line) => line.includes(span));
            if (sentence === undefined || sentence.length <= span.length + 4)
                continue;
            const outside = sentence.split(span).join('');
            if (!negationsOf(outside).size && !/(如果|要是|假设|除非|本来|原本)/.test(outside))
                continue;
            fallacies.push({
                code: 'quote_mining',
                label: '断章取义',
                postId: statement.postId,
                quote: span.slice(0, 120),
                otherPostId: source.postId,
                otherQuote: sentence.slice(0, 160),
                why: '引用的这句话在原帖里带着限定或否定，单独截出来意思变了。',
                confidence: 'high',
            });
            if (fallacies.length >= 10)
                break;
        }
    }
    // Replying without addressing the question that was asked.
    for (const entry of opponentQuestions) {
        if (entry.answerPostId === undefined)
            continue;
        const answer = opponent.find((candidate) => candidate.postId === entry.answerPostId);
        if (answer === undefined)
            continue;
        const questionTokens = subjectTokens(entry.quote);
        if (overlap(questionTokens, subjectTokens(answer.content)) > 0)
            continue;
        fallacies.push({
            code: 'evasion',
            label: '回避核心问题',
            postId: answer.postId,
            quote: answer.content.slice(0, 120),
            otherPostId: entry.postId,
            otherQuote: entry.quote,
            why: '被问到的问题与这条回应没有任何共同话题，等于没有回答。',
            confidence: 'medium',
        });
        if (fallacies.length >= 10)
            break;
    }
    const decisivePoints = rankDecisivePoints({
        contradictions,
        unansweredByOpponent,
        thirdPartyCitations,
        fallacies,
    });
    return {
        unansweredByOpponent,
        answeredByOwner,
        topicShifts,
        contradictions,
        thirdPartyCitations,
        missingContext: findMissingContext(input),
        fallacies: fallacies.slice(0, 10),
        decisivePoints,
    };
}
/**
 * 按「改变了结论没有」排序，取前三。
 *
 * 权重是显式的常量，不是 `sort` 里的一段隐式比较：审阅的人要能指着一行说
 * 「为什么这条比那条重要」。权重相同则按出现顺序 —— 早说的通常是被回避的那条。
 */
function rankDecisivePoints(input) {
    const points = [];
    for (const item of input.contradictions) {
        /**
         * 矛盾是唯一「可以给 high」的类型 —— 但它必须先过条件检查（v0.2.37 §5.1）。
         *
         * 两句话字面相反，但一句带条件/时间限定、另一句没有时，它们**可能都对**。
         * 这种情形保留在列表里（它确实值得一问），但 confidence 降到 medium、
         * 渲染时写成「待核实」，而不是「你前后矛盾」。
         */
        const differs = contextMayDiffer(item.firstQuote, item.secondQuote);
        points.push({
            kind: 'contradiction',
            postId: item.secondPostId,
            quote: item.secondQuote,
            otherPostId: item.firstPostId,
            otherQuote: item.firstQuote,
            why: differs.differs
                ? `${differs.why}。先确认两句说的是不是同一件事，再谈矛盾。`
                : '这两句话不能同时成立；对方必须先说清哪一句算数，后面的推论才有基础。',
            weight: 100,
            confidence: differs.differs ? 'medium' : 'high',
            evidenceKind: 'quoted',
        });
    }
    for (const item of input.unansweredByOpponent) {
        // 只有「被明确回避」的才算决定性；单纯没回答可能只是还没看到。
        const avoided = item.evasionPostId !== undefined;
        points.push({
            kind: 'evasion',
            postId: item.postId,
            quote: item.quote,
            ...(item.evasionPostId === undefined ? {} : { otherPostId: item.evasionPostId }),
            ...(item.evasionQuote === undefined ? {} : { otherQuote: item.evasionQuote }),
            why: avoided
                ? '主人问过这一点，对方用另一句话绕开了；把问题原样放回去比新增论点更有力。'
                : '主人问过这一点，对方还没有回答；可以要求先回答再继续。',
            weight: avoided ? 90 : 60,
            /**
             * 「被回避」有**两段原文**可对（提问 + 绕开的那句），所以可以是 high；
             * 「没回答」只有一段原文，剩下的靠「后面没有实质回复」这个推断 ——
             * 那是 inferred，压低置信度。
             */
            confidence: avoided ? 'high' : 'medium',
            evidenceKind: avoided ? 'quoted' : 'inferred',
        });
    }
    for (const item of input.thirdPartyCitations) {
        points.push({
            kind: 'third_party',
            postId: item.postId,
            quote: item.quote,
            why: item.note,
            weight: 70,
            /**
             * 引文本身是原文（quoted），但「这是一段第三方引用」是规则根据引号与归属词
             * 推出来的判断 —— 它可能是对方在复述自己的另一段话。所以只给 medium。
             */
            confidence: 'medium',
            evidenceKind: 'quoted',
        });
    }
    for (const item of input.fallacies) {
        if (item.code !== 'missing_evidence')
            continue;
        points.push({
            kind: 'missing_evidence',
            postId: item.postId,
            quote: item.quote,
            why: item.why,
            weight: 50,
            confidence: 'low',
            evidenceKind: 'inferred',
        });
    }
    const shifts = input.fallacies.filter((item) => item.code === 'topic_shift');
    for (const item of shifts) {
        points.push({
            kind: 'topic_shift',
            postId: item.postId,
            quote: item.quote,
            ...(item.otherPostId === undefined ? {} : { otherPostId: item.otherPostId }),
            ...(item.otherQuote === undefined ? {} : { otherQuote: item.otherQuote }),
            why: item.why,
            weight: 40,
            /**
             * 「转移话题」是最容易被误用的一条：对方只是补充一个相关角度，也会被
             * 判成跑题。所以除非有明确的话题标记词，否则只给 low。
             */
            confidence: item.otherQuote === undefined ? 'low' : 'medium',
            evidenceKind: item.otherQuote === undefined ? 'inferred' : 'quoted',
        });
    }
    // 稳定排序：同权重保持原有先后（早出现的通常是被回避的那条）。
    return points
        .map((point, index) => ({ point, index }))
        .sort((a, b) => b.point.weight - a.point.weight || a.index - b.index)
        .slice(0, 3)
        .map((entry) => entry.point);
}
/** Every fallacy code, for the UI legend and the tests. */
export const FALLACY_CODES = [
    'equivocation',
    'self_contradiction',
    'hasty_generalization',
    'false_cause',
    'topic_shift',
    'quote_mining',
    'evasion',
    'missing_evidence',
];
/** Human labels, in one place so the renderer and the report cannot drift. */
export const FALLACY_LABELS = {
    equivocation: '偷换概念',
    self_contradiction: '前后矛盾',
    hasty_generalization: '以偏概全',
    false_cause: '错误因果',
    topic_shift: '转移话题',
    quote_mining: '断章取义',
    evasion: '回避核心问题',
    missing_evidence: '缺少关键证据',
};
/**
 * True when `quote` really occurs in `content`.
 *
 * Whitespace is normalised on both sides: the quote is taken from a sentence that was
 * trimmed, and a post's line breaks must not turn a real citation into a fabricated one.
 */
export function quoteOccursIn(quote, content) {
    const flatQuote = quote.replace(/\s+/g, '');
    if (flatQuote === '')
        return false;
    return content.replace(/\s+/g, '').includes(flatQuote);
}
//# sourceMappingURL=argument-structure.js.map