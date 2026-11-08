/**
 * The structured brief a reply is generated from.
 *
 * ## Why a separate structure
 *
 * The generator currently receives a compressed pile of statements and a persona,
 * and is asked for a reply. That works, but it leaves the *reasoning* implicit:
 * nothing records which of the opponent's claims the reply is answering, which
 * facts both sides agree on, or which questions are still open. The result is a
 * reply that reads plausibly and occasionally answers something nobody said.
 *
 * A brief makes those things explicit and, crucially, **citable**: every claim
 * points at the post id it came from. That turns "the model said the opponent
 * claimed X" into "the opponent's post 12345 says X", which a human reviewer can
 * check in one click — and which the generator can be held to.
 *
 * ## The three rules that keep it honest
 *
 * 1. **Every cited id must exist in the collected conversation.** A brief whose
 *    evidence points at a post that was never read is a fabrication, and
 *    `validateBrief` rejects it rather than letting it reach the model.
 * 2. **The opponent's positions are quotations, not summaries.** `quote` is the
 *    opponent's own text, so a reviewer can see whether it was characterised
 *    fairly. `paraphrase` is clearly labelled as an inference.
 * 3. **The brief cannot name a publish target.** The target is decided by the
 *    trigger and the capability gate, never by the model's own reading of the
 *    argument; a brief that could choose where to post would bypass both.
 *
 * ## Persona boundary
 *
 * `PersonaConfig` changes tone and length. It must not change `facts`,
 * `disagreements` or `evidence` — those are what the argument is *about*, and
 * letting a "幽默" persona alter them would be the model rewriting reality to fit
 * a voice. `validateBrief` therefore has no persona parameter at all.
 */
/**
 * Check that a brief only asserts what it can cite.
 *
 * Returns every problem rather than the first, because a brief with three
 * fabricated citations should be reported as such in one pass.
 *
 * The checks, and what each prevents:
 *
 * - **citation exists** — a cited post must be in the conversation. Prevents the
 *   model inventing a source.
 * - **side attribution** — the owner's position may only cite the owner's posts,
 *   and the opponent's only the opponent's. Prevents putting words in the wrong
 *   mouth, which is the failure this project treats as worst.
 * - **no empty citation list** — a position or argument with no evidence is an
 *   unsupported claim.
 * - **at least one disagreement** — a brief about a dispute that names no
 *   disagreement is describing something else.
 * - **target is in the conversation** — the reply must answer a real post.
 * - **uncertainties are stated, not empty when they exist** — enforced by the
 *   builder rather than here, since only the builder knows what was not read.
 */
export function validateBrief(brief, sources) {
    const problems = [];
    const checkCitation = (field, postId) => {
        if (!sources.allPostIds.has(postId)) {
            problems.push({
                field,
                reason: `引用了未读取的帖子 ${postId}：不能把没看到的内容当作证据`,
            });
        }
    };
    const checkSide = (field, side, postIds) => {
        if (postIds.length === 0) {
            problems.push({ field, reason: '没有任何证据引用' });
            return;
        }
        const allowed = side === 'owner' ? sources.ownerPostIds : sources.opponentPostIds;
        for (const postId of postIds) {
            checkCitation(field, postId);
            if (sources.allPostIds.has(postId) && !allowed.has(postId)) {
                problems.push({
                    field,
                    reason: side === 'owner'
                        ? `把 ${postId} 当作主人的发言，但那不是主人发的`
                        : `把 ${postId} 当作对方的发言，但那不是对方发的`,
                });
            }
        }
    };
    /**
     * A quote must actually occur in the post it names (v0.2.35 §3.1 第 10 项).
     *
     * ## Why this is stricter than "the id exists"
     *
     * Every v0.2.35 finding is a `quote` plus a `postId`, and the whole point of the pair is
     * that a reviewer can check one against the other. A finding whose quote is not in that
     * post is a fabricated citation that looks exactly like a real one — the id resolves, the
     * page highlights nothing, and the reviewer assumes the tool is right. This is the check
     * that makes "可追溯到原始评论" a property rather than a promise.
     *
     * It also catches the subtler failure: a quote taken from the *owner's* post but filed
     * under the opponent's id. The id belongs to the opponent, so only the text can tell.
     */
    const checkQuote = (field, postId, quote) => {
        if (quote.trim() === '') {
            problems.push({ field, reason: '引文为空：没有原文就不能声称为证据' });
            return;
        }
        const content = sources.contentOf?.get(postId);
        if (content === undefined)
            return;
        const flatQuote = quote.replace(/\s+/g, '');
        const flatContent = content.replace(/\s+/g, '');
        if (flatContent.includes(flatQuote))
            return;
        /**
         * ## Truncated quotes are checked by prefix, not waved through
         *
         * Findings clip long sentences to keep the page readable, so the stored quote is often
         * a *prefix* of the real sentence rather than the whole of it. Comparing the full
         * string would then reject every long finding — and the tempting fix, skipping those,
         * would also skip the fabricated ones.
         *
         * Checking a 40-character prefix instead keeps both honest: a quote clipped from real
         * text still matches its source, while an invented quote would have to reproduce forty
         * consecutive characters of that post by accident.
         */
        const prefix = [...flatQuote].slice(0, 40).join('');
        if (prefix !== '' && flatContent.includes(prefix))
            return;
        problems.push({
            field,
            reason: `引文「${quote.slice(0, 24)}」不在它标注的帖子 ${postId} 里`,
        });
    };
    checkSide('owner', 'owner', brief.owner.evidence);
    checkSide('opponent', 'opponent', brief.opponent.evidence);
    /**
     * 每一条论据的出处也要校验（v0.2.34 §4.2）。
     *
     * 新字段必须立刻进校验，否则它就是一条**没有守卫的引用通道**：一旦构造逻辑
     * 把主人的帖子当成对方的论据（或反过来），模型会拿着「对方说过这句话」去反驳
     * 一句主人自己说的话。这类错误在生成结果上看起来完全正常 —— 只有在这里能拦住。
     */
    for (const argument of brief.arguments) {
        checkSide(`arguments[${argument.claim.slice(0, 12)}]`, 'owner', argument.evidence);
    }
    for (const argument of brief.opponentArguments ?? []) {
        checkSide(`opponentArguments[${argument.claim.slice(0, 12)}]`, 'opponent', argument.evidence);
    }
    /**
     * ## v0.2.35：四类新引用通道，四条方向检查
     *
     * 这一版新增的字段全都带「谁说的」这个属性，而它们恰好是最容易搞反的：
     *
     * - `unansweredByOpponent` 是**主人问、对方没答**。若把提问帖归给对方，模型会去
     *   追问一个自己刚提过的问题。
     * - `answeredByOwner` 是**对方问、主人答了**。方向反了，就等于告诉模型「对方已经
     *   答过你」，而实际是主人答的。
     * - `topicShifts` 与 `contradictions` 只对**对方**成立：把主人的话题转换标成对方
     *   转移话题，是这一版最严重的一类误伤。
     * - `thirdPartyCitations` 记录的是**对方帖子里**引用的第三方。若把引用挂在主人
     *   名下，回复会去反驳主人从未引用过的话。
     *
     * 每一条都同时校验 id 归属与引文内容 —— 只有 id 对得上不算数，引文必须真的在
     * 那一条帖子里。
     */
    for (const [index, question] of (brief.unansweredByOpponent ?? []).entries()) {
        const field = `unansweredByOpponent[${index}]`;
        checkSide(field, 'owner', [question.postId]);
        checkQuote(field, question.postId, question.quote);
        if (question.answerPostId !== undefined) {
            problems.push({
                field,
                reason: '标注为「对方没有回答」，却给出了对方的回答帖：这两件事不能同时成立',
            });
        }
        if (question.evasionPostId !== undefined) {
            // 「回了一句但没回答」 is a claim about the opponent's post, so that post must be theirs.
            checkSide(`${field}.evasion`, 'opponent', [question.evasionPostId]);
            if (question.evasionQuote !== undefined) {
                checkQuote(`${field}.evasion`, question.evasionPostId, question.evasionQuote);
            }
        }
    }
    for (const [index, question] of (brief.answeredByOwner ?? []).entries()) {
        const field = `answeredByOwner[${index}]`;
        checkSide(field, 'opponent', [question.postId]);
        checkQuote(field, question.postId, question.quote);
        if (question.answerPostId === undefined) {
            problems.push({
                field,
                reason: '标注为「主人已经回答」，却没有给出主人回答的那条帖子',
            });
            continue;
        }
        checkSide(`${field}.answer`, 'owner', [question.answerPostId]);
        if (question.answerQuote !== undefined) {
            checkQuote(`${field}.answer`, question.answerPostId, question.answerQuote);
        }
    }
    for (const [index, shift] of (brief.topicShifts ?? []).entries()) {
        const field = `topicShifts[${index}]`;
        checkSide(field, 'opponent', [shift.postId, shift.previousPostId]);
        checkQuote(field, shift.postId, shift.quote);
        checkQuote(`${field}.previous`, shift.previousPostId, shift.previousQuote);
    }
    for (const [index, contradiction] of (brief.contradictions ?? []).entries()) {
        const field = `contradictions[${index}]`;
        checkSide(field, 'opponent', [contradiction.firstPostId, contradiction.secondPostId]);
        checkQuote(field, contradiction.firstPostId, contradiction.firstQuote);
        checkQuote(field, contradiction.secondPostId, contradiction.secondQuote);
        if (contradiction.firstPostId === contradiction.secondPostId &&
            contradiction.firstQuote === contradiction.secondQuote) {
            problems.push({ field, reason: '两条引文完全相同，不构成前后矛盾' });
        }
    }
    for (const [index, citation] of (brief.thirdPartyCitations ?? []).entries()) {
        const field = `thirdPartyCitations[${index}]`;
        // 引用发生在对方的帖子里，所以这条帖子必须属于对方。
        checkSide(field, 'opponent', [citation.postId]);
        checkQuote(field, citation.postId, citation.quote);
        // 把对方自己的话标成「第三方引用」，会让模型去反驳一个对方没说过的主张。
        const own = sources.allPostIds.has(citation.postId)
            ? sources.contentOf?.get(citation.postId)
            : undefined;
        if (own !== undefined && own.replace(/\s+/g, '') === citation.quote.replace(/\s+/g, '')) {
            problems.push({
                field,
                reason: '整条帖子只有一个引文，且与帖子内容完全相同：这不是引用第三方，就是对方自己的话',
            });
        }
    }
    for (const [index, fallacy] of (brief.fallacies ?? []).entries()) {
        const field = `fallacies[${index}:${fallacy.code}]`;
        checkSide(field, 'opponent', [fallacy.postId]);
        checkQuote(field, fallacy.postId, fallacy.quote);
        if (fallacy.why.trim() === '') {
            problems.push({ field, reason: '没有说明为什么这构成论证问题' });
        }
        if (fallacy.otherPostId === undefined)
            continue;
        // 断章取义的「另一半」是被截取的原帖，属于主人；其余证据都来自对方自己。
        checkSide(`${field}.other`, fallacy.code === 'quote_mining' ? 'owner' : 'opponent', [fallacy.otherPostId]);
        if (fallacy.otherQuote !== undefined) {
            checkQuote(`${field}.other`, fallacy.otherPostId, fallacy.otherQuote);
        }
    }
    /**
     * 重点判断的校验（v0.2.36 §5.2）。
     *
     * 与 fallacies 同一套规则：引文必须在那条帖子里，方向必须归对了人。
     * 唯一多出来的一条是「权重必须是有限数」—— 一个 NaN 会让排序失效，而排序
     * 失效的表现是「它挑了一条最不重要的打」，从结果上看不出是排序坏了。
     */
    for (const [index, point] of (brief.decisivePoints ?? []).entries()) {
        const field = `decisivePoints[${index}:${point.kind}]`;
        /**
         * 方向的判定必须按 kind 分开（v0.2.36）。
         *
         * `evasion` 的 `postId` 是**主人**那条提问（「你做过测算吗」），`otherPostId`
         * 才是对方的回避。一刀切要求 postId 属于对方，会把一条完全正确的判断判成
         * 「把主人的话当成了对方说的」—— 而那正是校验器最该抓、也最容易误报的一类。
         */
        const primarySide = point.kind === 'evasion' ? 'owner' : 'opponent';
        checkSide(field, primarySide, [point.postId]);
        checkQuote(field, point.postId, point.quote);
        if (point.why.trim() === '') {
            problems.push({ field, reason: '没有说明为什么这一点重要' });
        }
        if (!Number.isFinite(point.weight)) {
            problems.push({ field, reason: '权重不是有限数，排序会失效' });
        }
        /**
         * 置信度与依据必须自洽（v0.2.37 §5.1）。
         *
         * 两条硬规则：
         * 1. `high` 必须有第二段原文 —— 一个只靠规则的判断没有资格被写成断言；
         * 2. `inferred` 不许自报 `high` —— 没有原文可对的推断，最高只能到 medium。
         *
         * 这两条不是风格要求：渲染层按 `confidence === 'high' && evidenceKind === 'quoted'`
         * 决定「写成断言还是写成待核实」，所以一个自相矛盾的标注会直接变成一个
         * 说错话的回复。
         */
        if (point.confidence === 'high') {
            if (point.evidenceKind !== 'quoted') {
                problems.push({ field, reason: '标为高置信但依据是推断：没有原文可对的判断不能当成事实' });
            }
            if (point.otherPostId === undefined || point.otherQuote === undefined) {
                problems.push({ field, reason: '标为高置信却没有对照原文：高置信要求两段可核对的原文' });
            }
        }
        if (point.otherPostId === undefined)
            continue;
        // 对照帖一律属于对方：矛盾的前一句、被回避的回应、更早的话题，都是对方说的。
        checkSide(`${field}.other`, 'opponent', [point.otherPostId]);
        if (point.otherQuote !== undefined)
            checkQuote(`${field}.other`, point.otherPostId, point.otherQuote);
    }
    // ## A brief with no disagreement is allowed *if* it says why (v0.2.13)
    //
    // v0.2.12 required at least one disagreement, on the reasoning that "a brief about a dispute
    // that names no disagreement is describing something else". That was written when the builder
    // fabricated a disagreement unconditionally, so the rule never fired in practice.
    //
    // Now the conflict judge may legitimately conclude "I cannot prove these positions
    // contradict" — the apple/oolong case, or two people talking past each other. Demanding a
    // disagreement in that situation would force the builder to invent one, which is exactly the
    // failure this version removes.
    //
    // The rule is therefore: no disagreement is acceptable **only when the brief explicitly says
    // why**, so a reviewer sees the gap instead of a silent empty list.
    //
    // ## Why the explanation may live in `risks` as well as `uncertainties`
    //
    // The first fix only looked at `uncertainties`, and that broke the strongest case: when the
    // judge is *confident* the positions do not conflict (both are first-person preferences), it
    // correctly does not flag them as uncertain — it explains the situation in `risks` instead.
    // Requiring the uncertainty entry forced either a false "we are unsure" or a rejection of a
    // correct brief. Both sources count; what matters is that the reviewer is told.
    if (brief.disagreements.length === 0) {
        const explained = brief.uncertainties.some((item) => /分歧|冲突|对立/.test(item.point + item.reason)) ||
            brief.risks.some((risk) => /分歧|冲突|对立|喜好|不是同一件事/.test(risk));
        if (!explained) {
            problems.push({
                field: 'disagreements',
                reason: '没有指出任何具体分歧，也没有说明为什么没有分歧——' +
                    '不解释的空列表会让审阅者以为漏看了什么',
            });
        }
    }
    if (!sources.allPostIds.has(brief.targetPostId)) {
        problems.push({
            field: 'targetPostId',
            reason: `回复目标 ${brief.targetPostId} 不在本次读取的对话里`,
        });
    }
    for (const [index, fact] of brief.agreedFacts.entries()) {
        if (fact.evidence.length === 0) {
            problems.push({ field: `agreedFacts[${index}]`, reason: '没有证据引用' });
            continue;
        }
        for (const postId of fact.evidence)
            checkCitation(`agreedFacts[${index}]`, postId);
        // A "fact both sides agreed on" citing only one side is just one side's claim.
        const fromOwner = fact.evidence.some((postId) => sources.ownerPostIds.has(postId));
        const fromOpponent = fact.evidence.some((postId) => sources.opponentPostIds.has(postId));
        if (!fromOwner || !fromOpponent) {
            problems.push({
                field: `agreedFacts[${index}]`,
                reason: '被称为「双方确认的事实」，但证据只来自一方',
            });
        }
    }
    for (const [index, argument] of brief.arguments.entries()) {
        if (argument.evidence.length === 0) {
            problems.push({ field: `arguments[${index}]`, reason: '没有证据引用' });
            continue;
        }
        for (const postId of argument.evidence) {
            checkCitation(`arguments[${index}]`, postId);
            if (sources.allPostIds.has(postId) && !sources.ownerPostIds.has(postId)) {
                problems.push({
                    field: `arguments[${index}]`,
                    reason: `把 ${postId} 当作主人的论据，但那不是主人发的`,
                });
            }
        }
    }
    for (const [index, challenge] of brief.challenges.entries()) {
        checkCitation(`challenges[${index}].evidence`, challenge.evidence);
        if (sources.allPostIds.has(challenge.evidence) &&
            !sources.opponentPostIds.has(challenge.evidence)) {
            problems.push({
                field: `challenges[${index}].evidence`,
                reason: '把这条质疑归给对方，但那条发言不是对方发的',
            });
        }
        if (challenge.quote.trim() === '') {
            problems.push({
                field: `challenges[${index}].quote`,
                reason: '质疑必须引用对方原话，不能只写概括',
            });
        }
    }
    // Bystanders (v0.2.11).
    //
    // Two rules, both about not promoting a third party into a side:
    //
    // 1. A `leaning` must be backed by a post that was actually read — same citation rule
    //    as every other claim here.
    // 2. That post must belong to **neither** the owner nor the chosen opponent. A
    //    bystander whose "evidence" is one of the opponent's own posts is not a third party
    //    agreeing with them; it is the opponent, double-counted. Catching this keeps the
    //    supporter count from being inflated by the participant the reply is aimed at.
    for (const [index, bystander] of (brief.bystanders ?? []).entries()) {
        if (bystander.leaning === undefined) {
            if (bystander.evidence !== undefined && bystander.evidence.length > 0) {
                problems.push({
                    field: `bystanders[${index}]`,
                    reason: '没有说明站队却给了证据：要么说明站哪边，要么不要把证据挂在不站队的人身上',
                });
            }
            continue;
        }
        const evidence = bystander.evidence ?? [];
        if (evidence.length === 0) {
            problems.push({
                field: `bystanders[${index}]`,
                reason: '声称某个路人有明确立场，却没有引用任何一条发言',
            });
            continue;
        }
        for (const postId of evidence) {
            checkCitation(`bystanders[${index}]`, postId);
            if (sources.ownerPostIds.has(postId) ||
                sources.opponentPostIds.has(postId)) {
                problems.push({
                    field: `bystanders[${index}]`,
                    reason: `把 ${postId} 当作路人的话，但那一条属于争论的一方（主人或对手）`,
                });
            }
        }
    }
    if (brief.directions.length === 0) {
        problems.push({ field: 'directions', reason: '没有给出任何推荐回应方向' });
    }
    return problems;
}
/**
 * Human-readable brief, for the review step.
 *
 * Deliberately includes every citation: the reviewer's job is to check that the
 * characterisation matches the posts, so hiding the ids would make the review
 * performative.
 */
export function renderBrief(brief) {
    const lines = [];
    lines.push(`# 争论简述（${brief.platform} / ${brief.threadId}）`);
    lines.push('');
    lines.push(`回复目标：${brief.targetPostId}`);
    lines.push('');
    lines.push(`## 主人立场`);
    lines.push(brief.owner.summary);
    lines.push(`引用：${brief.owner.evidence.join('、')}`);
    lines.push('');
    lines.push(`## 对方立场`);
    lines.push(brief.opponent.summary);
    lines.push(`引用：${brief.opponent.evidence.join('、')}`);
    lines.push('');
    if (brief.disagreements.length > 0) {
        lines.push('## 核心分歧');
        for (const item of brief.disagreements)
            lines.push(`- ${item}`);
        lines.push('');
    }
    if (brief.agreedFacts.length > 0) {
        lines.push('## 双方确认的事实');
        for (const fact of brief.agreedFacts) {
            lines.push(`- ${fact.statement}（${fact.evidence.join('、')}）`);
        }
        lines.push('');
    }
    if (brief.arguments.length > 0) {
        lines.push('## 主人的主要论据');
        for (const argument of brief.arguments) {
            lines.push(`- ${argument.claim}（${argument.evidence.join('、')}）`);
        }
        lines.push('');
    }
    /**
     * 对方的论据紧跟主人之后、分歧之前（v0.2.34 §4.2）。
     *
     * 位置是有意的：模型读到这里时，手上同时有「我方论据」与「对方论据」，
     * 于是下一步（核心分歧）能被这两组具体句子支撑，而不是靠一句摘要去猜。
     *
     * 标题写「对方的核心论据」，不写「对方的观点」：后者会让人以为这是对整段
     * 发言的概括，而这些是逐条抽取的 claim。
     */
    if (brief.opponentArguments !== undefined && brief.opponentArguments.length > 0) {
        lines.push('## 对方的核心论据');
        for (const argument of brief.opponentArguments) {
            lines.push(`- ${argument.claim}（${argument.evidence.join('、')}）`);
        }
        lines.push('');
    }
    /**
     * ## v0.2.35：六个新段落，位置各自有理由
     *
     * 顺序按「读的时候先要什么」排：
     *
     * 1. 主人问过、对方没答的 —— 这是最好用的材料，放最前面，模型才知道该追什么。
     * 2. 对方引用的第三方 —— 紧跟其后，因为紧邻的下一段是「对方的论据」，必须先告诉
     *    模型哪些话**不是**对方自己的，否则第三方引用会被当成对方主张去反驳。
     * 3. 转移话题 / 前后矛盾 —— 放在分歧之后，作为「对方论证哪里不成立」的定位。
     * 4. 主人已经回答过的 —— 放在最后，作为「这些不要再答一遍」的清单。
     *
     * 每一段都只在有内容时出现：空标题会让模型以为「没有发现」也是一种结论。
     */
    if (brief.unansweredByOpponent !== undefined && brief.unansweredByOpponent.length > 0) {
        lines.push('## 主人问过、对方尚未回答的问题');
        for (const question of brief.unansweredByOpponent) {
            lines.push(`- 「${question.quote}」（${question.postId}）`);
        }
        lines.push('');
    }
    if (brief.thirdPartyCitations !== undefined && brief.thirdPartyCitations.length > 0) {
        lines.push('## 对方引用的第三方观点（不是对方自己的主张）');
        for (const citation of brief.thirdPartyCitations) {
            const who = citation.attribution === undefined ? '未说明来源' : citation.attribution;
            lines.push(`- 「${citation.quote}」——${who}（${citation.postId}）`);
        }
        lines.push('反驳这些引用时，针对的是被引用的人，不要说成「你自己说的」。');
        lines.push('');
    }
    if (brief.challenges.length > 0) {
        lines.push('## 对方尚未被回应的质疑');
        for (const challenge of brief.challenges) {
            const why = challenge.unanswered === 'no_reply' ? '主人没有回复' : '主人回复了但没有正面回应';
            lines.push(`- 对方原话：「${challenge.quote}」（${challenge.evidence}，${why}）`);
        }
        lines.push('');
    }
    /**
     * 转移话题与前后矛盾（v0.2.35 §3.1 第 6、7 项）。
     *
     * 两段都成对给出：只说「对方转移了话题」是判断，给出前后两条原话才是指控。
     * 前后矛盾的标题下额外写一句「这两句不能同时成立」，因为模型最容易犯的错是
     * 看到两条立场不同的发言就当成矛盾，而实际可能只是在说不同阶段的事。
     */
    if (brief.topicShifts !== undefined && brief.topicShifts.length > 0) {
        lines.push('## 对方转移话题的地方');
        for (const shift of brief.topicShifts) {
            const marker = shift.marker === undefined ? '' : `（用了「${shift.marker}」）`;
            lines.push(`- 原话题：「${shift.previousQuote}」（${shift.previousPostId}）`);
            lines.push(`  换成了：「${shift.quote}」（${shift.postId}）${marker}`);
        }
        lines.push('');
    }
    if (brief.contradictions !== undefined && brief.contradictions.length > 0) {
        lines.push('## 对方前后矛盾的地方');
        for (const contradiction of brief.contradictions) {
            lines.push(`- 先说：「${contradiction.firstQuote}」（${contradiction.firstPostId}）`);
            lines.push(`  后说：「${contradiction.secondQuote}」（${contradiction.secondPostId}）`);
            lines.push(`  两句话共同的说法是「${contradiction.subject}」，一句肯定一句否定，不能同时成立。`);
        }
        lines.push('');
    }
    if (brief.answeredByOwner !== undefined && brief.answeredByOwner.length > 0) {
        lines.push('## 对方问过、主人已经回答的问题（不要再答一遍）');
        for (const question of brief.answeredByOwner) {
            const answer = question.answerPostId === undefined ? '' : `（主人回答在 ${question.answerPostId}）`;
            lines.push(`- 「${question.quote}」（${question.postId}）${answer}`);
        }
        lines.push('');
    }
    /**
     * 论证形式问题（v0.2.35 §3.3）。
     *
     * 渲染时带「置信度」，并要求模型**不要**把标签当结论说出来。这条限制写在简报里
     * 而不是只写在系统提示里，是因为模型对离得近的指令更敏感：一个「以偏概全」
     * 就在它眼前时，不提醒它就会把这四个字写进回复，读起来像在做逻辑课作业。
     */
    /**
     * 先给「打哪一点」，再给「有哪些毛病」（v0.2.36 §5.2）。
     *
     * 顺序是有意的：模型对靠前的内容更敏感。把十条清单放在最前面时，它会挑最好
     * 反驳的那条；先说「这三条里第一条最影响结论」，它才会去打真正的那一点。
     */
    if (brief.decisivePoints !== undefined && brief.decisivePoints.length > 0) {
        lines.push('## 最值得先回应的（按影响结论的程度排序，第一条最重要）');
        for (const point of brief.decisivePoints) {
            /**
             * 措辞跟着 confidence 走（v0.2.37 §5.1）。
             *
             * 一个高优先级的「疑似矛盾」如果被写成断言，模型就会产出「你前后矛盾」——
             * 而它可能只是条件不同或时间不同。这类错误在论坛里是最伤的一类：说错了，
             * 对方一句话就能反驳，整条回复的可信度全没了。
             */
            if (point.confidence === 'high' && point.evidenceKind === 'quoted') {
                lines.push(`- 「${point.quote}」（${point.postId}）${point.otherPostId === undefined ? '' : ` vs 「${point.otherQuote ?? ''}」（${point.otherPostId}）`}`);
                lines.push(`  ${point.why}`);
                continue;
            }
            lines.push(`- 待核实：「${point.quote}」（${point.postId}，置信度${point.confidence === 'medium' ? '中' : '低'}）`);
            lines.push(`  ${point.why}`);
            lines.push('  这一条**不要**写成断言；要么先问清前提，要么不碰。');
        }
        lines.push('回复应当正面回应第一条；其余可以一句带过，不要平均用力。');
        lines.push('只有「置信度高」的那些才能当成对方确实说过的话来引用。');
        lines.push('');
    }
    if (brief.fallacies !== undefined && brief.fallacies.length > 0) {
        lines.push('## 可以引用的论证问题（仅供判断，不要在回复里照念术语）');
        for (const fallacy of brief.fallacies) {
            const confidence = fallacy.confidence === 'high' ? '较确定' : fallacy.confidence === 'medium' ? '可能' : '存疑';
            lines.push(`- ${fallacy.label}（${confidence}）：「${fallacy.quote}」（${fallacy.postId}）`);
            lines.push(`  ${fallacy.why}`);
        }
        lines.push('这些是辅助判断的线索，不是定论。除非直说这个问题最有力，否则用普通话说清哪里不成立即可。');
        lines.push('');
    }
    if (brief.openQuestions.length > 0) {
        // The heading must match the data source. These are questions the **opponent asked and
        // the owner has not answered** — printing "对方没有回答的问题" told the model the opposite
        // and would have produced a reply accusing the opponent of dodging. See the field's own
        // comment for the full account.
        lines.push('## 对方提出、主人尚未回应的问题');
        for (const question of brief.openQuestions)
            lines.push(`- ${question}`);
        lines.push('');
    }
    if (brief.uncertainties.length > 0) {
        lines.push('## 不能断言为事实的部分');
        for (const item of brief.uncertainties) {
            lines.push(`- ${item.point}：${item.reason}`);
        }
        lines.push('');
    }
    /**
     * 缺失的上下文（v0.2.35 §3.1 第 9 项）。
     *
     * 与 `uncertainties` 分开：那是「不能断言为事实的部分」，这是「我们根本没读到/
     * 读全的部分」。分开的理由是下一步不同 —— 前者要改措辞，后者要么补读，要么
     * 在回复里明确说「这部分我看不到」。
     */
    if (brief.missingContext !== undefined && brief.missingContext.length > 0) {
        lines.push('## 这次没有拿到的上下文');
        for (const item of brief.missingContext)
            lines.push(`- ${item}`);
        lines.push('缺失的部分不要补写，也不要据此推断对方的动机。');
        lines.push('');
    }
    lines.push(`推荐方向：${brief.directions.join(' / ')}`);
    // Third parties who spoke in the same floor (v0.2.11).
    //
    // This block exists so the model can tell "the opponent stands alone" from "several
    // people backed the opponent". Left out when empty rather than printed as "无", because
    // a heading followed by "none" reads like a finding.
    if (brief.bystanders !== undefined && brief.bystanders.length > 0) {
        lines.push('');
        lines.push('## 同一层里的其他参与者');
        lines.push('这些人不是争论的任何一方，只是也在这一层发过言。不要把他们的话当成交锋对象，也不要把他们当成对手。');
        for (const bystander of brief.bystanders) {
            const leaning = bystander.leaning === undefined
                ? '不站队'
                : bystander.leaning === 'owner'
                    ? '明确支持主人'
                    : '明确支持对方';
            const cite = bystander.evidence === undefined || bystander.evidence.length === 0
                ? ''
                : `（${bystander.evidence.join('、')}）`;
            lines.push(`- ${bystander.displayName}：发言 ${bystander.postCount} 次，${leaning}${cite}`);
        }
    }
    if (brief.risks.length > 0) {
        lines.push('');
        lines.push('## 发表前的风险提示');
        for (const risk of brief.risks)
            lines.push(`- ${risk}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=brief.js.map