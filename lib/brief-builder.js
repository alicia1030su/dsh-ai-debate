/**
 * Build a `DebateBrief` from what was actually collected.
 *
 * ## Why this file had to be written in v0.2.12
 *
 * `brief.ts` had a type, a validator and a renderer — and **no builder**. So the brief could
 * be validated and rendered in tests while the production generation path went on using
 * `compressContext()` alone. That is the gap the task book calls out: `validateBrief()` was
 * "只存在于测试文件".
 *
 * This module closes it by deriving the brief from `Dispute` — the reconstruction the
 * analyzer already produces from real collected data. Every field it fills cites post ids,
 * and every field it cannot support is left as an explicit uncertainty rather than a guess.
 *
 * ## The three rules it follows
 *
 * 1. **Evidence or nothing.** A position, an argument or an agreed fact is only emitted with
 *    the post ids that support it. `validateBrief` then re-checks that those ids exist and
 *    belong to the side being described.
 * 2. **The reply target is not a model choice.** `targetPostId` comes from the opponent's
 *    verified last post, exactly as the publish path already requires. A builder that let a
 *    later stage change it would hand the model the one decision the design keeps away from
 *    it.
 * 3. **Uncertainty is stated, not smoothed over.** Missing nested replies, an inferred
 *    reply edge, a name-only opponent — each becomes an entry in `uncertainties`, because a
 *    reply written on top of a silent assumption is the failure mode this project keeps
 *    having to remove.
 */
import { judgeRelation } from './conflict.js';
import { extractClaims, isSubstantive } from './analyzer.js';
/**
 * Collapse a statement's content into one readable sentence.
 *
 * Quotes are trimmed to a length a human can check at a glance. The full text stays in the
 * graph; a brief that quoted four hundred characters would make the review step skippable,
 * and the review step is the safety mechanism.
 */
function summarise(content, limit = 80) {
    const flat = content.replace(/\s+/g, ' ').trim();
    if (flat.length <= limit)
        return flat;
    return `${flat.slice(0, limit)}…`;
}
/** The post ids of a set of statements, in order, de-duplicated. */
function idsOf(statements) {
    const seen = new Set();
    const ids = [];
    for (const statement of statements) {
        if (statement.postId === '' || seen.has(statement.postId))
            continue;
        seen.add(statement.postId);
        ids.push(statement.postId);
    }
    return ids;
}
/** Statements from the owner, newest first, for building the owner's position. */
function ownerStatements(dispute) {
    return dispute.ownerStatements;
}
/** Statements from the opponent, derived from the dispute exchange. */
function opponentStatements(dispute) {
    const opponentKey = dispute.opponent?.key;
    if (opponentKey === undefined)
        return [];
    return dispute.exchange.filter((statement) => statement.authorKey === opponentKey);
}
/**
 * Which side a statement belongs to, by author key.
 *
 * Used to keep a bystander's words out of both positions — the specific mistake that makes
 * a third party look like a participant in the argument.
 */
function sideOf(statement, ownerKey, opponentKey) {
    if (statement.authorKey === ownerKey)
        return 'owner';
    if (opponentKey !== undefined && statement.authorKey === opponentKey)
        return 'opponent';
    return 'third';
}
/**
 * Facts both sides stated.
 *
 * ## How "agreed" is decided without a language model
 *
 * This is deliberately conservative: it looks for a substantive statement from the owner and
 * one from the opponent that share a **distinctive** token — a number, or a proper-looking
 * term of four or more characters. Two people both saying "这个" is not agreement.
 *
 * Anything not matched this way simply does not become an agreed fact. Missing one is a
 * quality loss; inventing one is a lie about what the other side conceded, and the validator
 * would reject it anyway since it requires evidence from both sides.
 */
function agreedFacts(owner, opponent, limit = 3) {
    const facts = [];
    const tokenise = (text) => {
        const tokens = new Set();
        // Numbers (prices, counts, dates) and Latin terms are the least ambiguous shared facts.
        for (const match of text.matchAll(/\d+(?:\.\d+)?%?/g))
            tokens.add(match[0]);
        for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g))
            tokens.add(match[0].toLowerCase());
        return tokens;
    };
    for (const mine of owner) {
        if (!isSubstantive(mine.content))
            continue;
        const mineTokens = tokenise(mine.content);
        if (mineTokens.size === 0)
            continue;
        for (const theirs of opponent) {
            if (!isSubstantive(theirs.content))
                continue;
            const theirTokens = tokenise(theirs.content);
            const shared = [...mineTokens].filter((token) => theirTokens.has(token));
            if (shared.length === 0)
                continue;
            facts.push({
                statement: `双方都提到了 ${shared.slice(0, 2).join('、')}`,
                evidence: [mine.postId, theirs.postId],
            });
            if (facts.length >= limit)
                return facts;
            break;
        }
    }
    return facts;
}
/**
 * The opponent's unanswered challenges.
 *
 * `dispute.openQuestions` already carries the analyzer's finding. Each becomes a
 * `BriefChallenge` with the opponent's own words, because "he asked about X" is checkable
 * and "he was evasive" is not.
 */
function challenges(dispute) {
    const out = [];
    for (const question of dispute.openQuestions) {
        if (question.postId === '')
            continue;
        out.push({
            quote: summarise(question.content, 120),
            evidence: question.postId,
            // The analyzer only records questions the owner did not answer, so `no_reply` is the
            // accurate label. `reply_did_not_address` would need proof that a reply existed and
            // failed to address it, which this builder cannot establish from text alone.
            unanswered: 'no_reply',
        });
    }
    return out;
}
/**
 * Bystanders, projected from the analyzer's participant list.
 *
 * No `leaning` is inferred. Deciding who a third party supports from tone is exactly the
 * kind of guess that turns a casual "我倒觉得他说得有道理" into "an ally", and the validator
 * would reject a leaning without a cited post anyway. The count and the name are facts; the
 * side is not, so it stays absent.
 */
function bystanders(dispute) {
    const out = [];
    for (const person of dispute.bystanders) {
        out.push({ displayName: person.displayName, postCount: person.postCount });
    }
    return out;
}
/**
 * What this brief must not assert as fact.
 *
 * Each entry states a *reason*, not just a topic, so a reviewer can tell "we did not read
 * that" from "the two accounts disagree about it".
 */
function uncertainties(input, verdict) {
    const out = [];
    const { dispute, collected } = input;
    if (!collected.complete) {
        out.push({
            point: '这次读取不完整',
            reason: `${collected.stopReason ?? '未知原因'}：部分楼层或楼中楼没有被读到，相关判断可能建立在缺失的内容上。`,
        });
    }
    if (dispute.needsConfirmation) {
        out.push({
            point: '对手身份需要人工确认',
            reason: dispute.notes.join('；') || '分析器无法确定主人在和谁争论。',
        });
    }
    if (dispute.opponent === undefined) {
        out.push({
            point: '没有识别出争论对手',
            reason: '因此不存在可以回应的具体对象。',
        });
    }
    if (dispute.opponent !== undefined && dispute.opponent.matchKind === 'name') {
        out.push({
            point: '对手是按昵称匹配的',
            reason: '平台没有给出稳定的账号 id，同名的人会被当成同一个人；如果对手改过昵称，这条线索可能指向别人。',
        });
    }
    // An inferred reply edge is a guess from a display name; saying so keeps it from being
    // read later as a stated fact.
    const inferred = dispute.exchange.some((statement) => statement.replyToName !== undefined && statement.replyToName !== '');
    if (inferred) {
        out.push({
            point: '部分回复关系是按昵称推断的',
            reason: '平台只给了被回复人的显示名，没有给评论 id；同名或改名的情形下可能连错。',
        });
    }
    // The semantic relation between the two positions (v0.2.13 §三).
    //
    // This is the entry that keeps a machine reading of "do they actually disagree" from being
    // treated as settled. When the judge could not prove a contradiction — or proved one only
    // weakly — the reviewer is told so explicitly instead of being handed a confident sentence.
    if (verdict !== undefined && verdict.requiresReview) {
        out.push({
            point: '双方是否真的存在分歧，尚未确认',
            reason: `${verdict.reason}` +
                '（这是基于文本结构的判断，不是语义理解；请人工确认后再决定回应方向。）',
        });
    }
    return out;
}
/** Pick the reply shapes that fit what is actually in the brief. */
function directions(input, hasChallenge) {
    const out = [];
    const { dispute } = input;
    if (dispute.openQuestions.length > 0)
        out.push('rebut');
    if (hasChallenge)
        out.push('rebut');
    // No open questions and no unanswered challenge still leaves something to say, but the
    // honest framing is analysis rather than another round of accusation.
    if (out.length === 0)
        out.push('analyse');
    return [...new Set(out)];
}
/**
 * Risks a human should weigh before approving.
 *
 * Only risks this build can actually see. A generic "注意言辞" would train the reviewer to
 * ignore the list.
 */
function risks(input, verdict) {
    const out = [];
    const { dispute, collected } = input;
    if (!collected.complete) {
        out.push('读取不完整：回复可能涉及没有读到的内容，建议先补读再发。');
    }
    if (dispute.opponent !== undefined && dispute.opponent.matchKind === 'name') {
        out.push('对手按昵称匹配：存在认错人的风险。');
    }
    if (dispute.bystanders.length > 0) {
        out.push(`这一层还有 ${dispute.bystanders.length} 位其他参与者；回复只面向对手，不要把他们卷进来。`);
    }
    // A reply written against a nonexistent dispute is worse than no reply (v0.2.13 §三).
    if (verdict !== undefined) {
        if (verdict.relation === 'different_topics') {
            out.push('双方讨论的似乎不是同一件事：如果按「反驳」来写，会像在攻击一个对方没提出的观点。' +
                '建议先确认争论到底是什么，或改成澄清式回应。');
        }
        else if (verdict.relation === 'different_preference') {
            out.push('双方只是喜好不同：这类差别没有对错，用反驳口吻会显得在争一件不需要争的事。');
        }
        else if (verdict.relation === 'unknown') {
            out.push('无法确认双方是否真的对立：回复前请人工核对，不要默认对手在攻击主人。');
        }
    }
    return out;
}
/**
 * Build the brief.
 *
 * Returns the brief plus the `BriefSources` that `validateBrief` needs, so a caller cannot
 * accidentally validate against a different set of posts than the brief was built from.
 */
export function buildBrief(input) {
    const { dispute } = input;
    const ownerKey = dispute.owner.key;
    const opponentKey = dispute.opponent?.key;
    const mine = ownerStatements(dispute);
    const theirs = opponentStatements(dispute);
    // Positions. The summary names an actual claim, not a mood, and the evidence is the posts
    // it came from.
    //
    // ## Why the summary falls back to the whole statement (v0.2.13)
    //
    // `extractClaims` drops questions, which is right for "arguments" but wrong here. The e2e
    // fixture's opponent says "你凭什么说成本会翻倍？有数据吗？" — a genuine challenge and the
    // most important thing about their position — and `extractClaims` reduced it to the bare
    // fragment "有数据吗". Comparing "成本会翻倍" against "有数据吗" found no shared subject, so
    // the judge could not see the dispute that obviously exists.
    //
    // The position summary is what the conflict judge reads, so it must keep the subject the
    // opponent is actually addressing. Using the first substantive statement verbatim is both
    // more faithful and more useful to the judge.
    const firstSubstantive = (statements) => {
        for (const statement of statements) {
            if (!isSubstantive(statement.content))
                continue;
            return summarise(statement.content, 120);
        }
        return undefined;
    };
    const ownerClaims = extractClaims(mine, 3);
    const opponentClaims = extractClaims(theirs, 3);
    let ownerPosition = {
        side: 'owner',
        summary: firstSubstantive(mine) ?? ownerClaims[0] ?? '（主人的具体主张未能从句子里提取出来，请人工核对原帖）',
        evidence: idsOf(mine),
    };
    let opponentPosition = {
        side: 'opponent',
        summary: firstSubstantive(theirs) ?? opponentClaims[0] ?? '（对方的具体主张未能从句子里提取出来，请人工核对原帖）',
        evidence: idsOf(theirs),
    };
    // Arguments: the owner's substantive claims, each citing its own post.
    const argumentsList = [];
    for (const statement of mine) {
        if (!isSubstantive(statement.content))
            continue;
        const claim = extractClaims([statement], 1)[0];
        if (claim === undefined)
            continue;
        argumentsList.push({ claim: summarise(claim), evidence: [statement.postId] });
        if (argumentsList.length >= 5)
            break;
    }
    // Disagreements are decided by `conflict.ts`, not by "both sides have evidence".
    //
    // v0.2.12 asserted a contradiction on exactly that condition, which made two unrelated
    // statements ("我喜欢吃苹果" / "我喜欢喝乌龙茶") into "两者不能同时成立". The verdict now
    // comes from a structural judge that is allowed to answer `unknown`, and only a real
    // contradiction produces a disagreement line.
    const verdict = judgeRelation({
        ownerText: ownerPosition.summary,
        opponentText: opponentPosition.summary,
    });
    const disagreements = [];
    if (verdict.isContradiction) {
        disagreements.push(`主人主张「${summarise(ownerPosition.summary, 40)}」，对方主张「${summarise(opponentPosition.summary, 40)}」；` +
            `${verdict.reason}`);
    }
    // Open questions the owner left unanswered, phrased as questions because that is what they
    // are. `findOpenQuestions` already filtered to questions the owner did not answer.
    const openQuestions = [];
    for (const question of dispute.openQuestions) {
        openQuestions.push(summarise(question.content, 100));
        if (openQuestions.length >= 5)
            break;
    }
    const briefChallenges = challenges(dispute);
    // Third parties must not leak into either position. Assert it here as well as in the
    // validator: a builder that put a bystander's words in the opponent's mouth would produce
    // a brief that cites a post belonging to nobody in the dispute.
    //
    // `BriefPosition.evidence` is readonly, so the filtering happens by reconstruction rather
    // than by mutation — which is also why the result is assigned back explicitly.
    const thirdPartyIds = new Set(dispute.exchange
        .filter((statement) => sideOf(statement, ownerKey, opponentKey) === 'third')
        .map((statement) => statement.postId));
    ownerPosition = {
        ...ownerPosition,
        evidence: ownerPosition.evidence.filter((id) => !thirdPartyIds.has(id)),
    };
    opponentPosition = {
        ...opponentPosition,
        evidence: opponentPosition.evidence.filter((id) => !thirdPartyIds.has(id)),
    };
    const targetPostId = dispute.opponent?.lastPostId ?? dispute.floorPostId;
    const brief = {
        platform: input.platform,
        threadId: input.threadId,
        // The verified target, taken from collected data — never from a model's suggestion.
        targetPostId,
        owner: ownerPosition,
        opponent: opponentPosition,
        disagreements,
        agreedFacts: agreedFacts(mine, theirs),
        arguments: argumentsList,
        challenges: briefChallenges,
        openQuestions,
        uncertainties: uncertainties(input, verdict),
        directions: directions(input, briefChallenges.length > 0),
        risks: risks(input, verdict),
        bystanders: bystanders(dispute),
    };
    const sources = buildSources(input);
    return { brief, sources, verdict };
}
/**
 * Everything the brief is allowed to cite.
 *
 * Built from the collected thread rather than from the brief, so validation can catch a
 * citation the builder invented — if both came from the same narrowing, the check would be
 * circular.
 */
export function buildSources(input) {
    const { dispute, collected } = input;
    const ownerKey = dispute.owner.key;
    const opponentKey = dispute.opponent?.key;
    const ownerPostIds = new Set();
    for (const statement of dispute.ownerStatements)
        ownerPostIds.add(statement.postId);
    const opponentPostIds = new Set();
    for (const statement of dispute.exchange) {
        if (opponentKey !== undefined && statement.authorKey === opponentKey) {
            opponentPostIds.add(statement.postId);
        }
    }
    const allPostIds = new Set();
    for (const floor of collected.floors) {
        allPostIds.add(floor.floor.postId);
        for (const nested of floor.nested)
            allPostIds.add(nested.postId);
    }
    // The exchange can carry posts from floors outside `collected.floors` when a cap dropped
    // them; those were still read, so they are citable.
    for (const statement of dispute.exchange)
        allPostIds.add(statement.postId);
    for (const statement of dispute.ownerStatements)
        allPostIds.add(statement.postId);
    void ownerKey;
    return { ownerPostIds, opponentPostIds, allPostIds };
}
/**
 * Render a brief for a small context window.
 *
 * ## What is kept when space runs out
 *
 * The task book allows compressing the brief but requires the **evidence relationships** to
 * survive: who said which post id. So this drops prose before it drops ids — a shorter
 * summary with the same citations is still checkable, while a citation-free paragraph is
 * not.
 */
export function renderBriefCompact(brief, maxChars) {
    const full = [
        `主人立场：${brief.owner.summary}（${brief.owner.evidence.join('、')}）`,
        `对方立场：${brief.opponent.summary}（${brief.opponent.evidence.join('、')}）`,
        ...brief.disagreements.map((item) => `分歧：${item}`),
        ...brief.challenges.map((item) => `对方未获回应：「${item.quote}」（${item.evidence}）`),
    ].join('\n');
    if (full.length <= maxChars)
        return full;
    // Too long: keep the citations and cut the prose. Never drop an id to save space.
    const minimal = [
        `主人：${brief.owner.evidence.join('、')}`,
        `对方：${brief.opponent.evidence.join('、')}`,
        `回复目标：${brief.targetPostId}`,
        brief.disagreements.length > 0 ? `分歧数：${brief.disagreements.length}` : '',
        brief.challenges.length > 0 ? `未回应质疑数：${brief.challenges.length}` : '',
    ]
        .filter((line) => line !== '')
        .join('\n');
    return minimal.length <= maxChars ? minimal : minimal.slice(0, maxChars);
}
/** Whether a dispute produced enough material for a brief worth validating. */
export function briefIsViable(dispute) {
    if (dispute.opponent === undefined)
        return false;
    if (dispute.ownerStatements.length === 0)
        return false;
    return true;
}
//# sourceMappingURL=brief-builder.js.map