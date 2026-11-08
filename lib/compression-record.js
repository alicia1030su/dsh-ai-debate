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
/** 取一段可用于判定的原文：优先用完整片段，太短则不可靠。 */
function probeOf(text, limit = 18) {
    if (text === undefined)
        return undefined;
    const trimmed = text.trim();
    if (trimmed.length < 4)
        return undefined;
    return trimmed.slice(0, limit);
}
/** 文本里是否出现这个片段（忽略空白差异）。 */
function contains(haystack, needle) {
    const compact = (text) => text.replace(/\s+/g, '');
    return compact(haystack).includes(compact(needle));
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
export function recordCompression(brief, targetContent, context, briefText = '') {
    const after = `${context.text}\n${briefText}`;
    const items = [];
    // 1. 目标评论：既要留原文，也要留它的 id（模型要用 id 回答）。
    const targetProbe = probeOf(targetContent);
    items.push({
        key: 'target',
        label: '目标评论',
        before: targetProbe !== undefined,
        after: targetProbe !== undefined &&
            contains(after, targetProbe) &&
            contains(after, brief.targetPostId),
        probe: targetProbe ?? '（这一层没有可引用的目标正文）',
        basis: targetProbe === undefined ? 'absent' : 'exact',
    });
    // 2. 主人立场：用简报里那句 summary 的片段。
    const ownerProbe = probeOf(brief.owner.summary, 20);
    items.push({
        key: 'ownerPosition',
        label: '主人立场',
        before: ownerProbe !== undefined && brief.owner.evidence.length > 0,
        after: ownerProbe !== undefined && contains(after, ownerProbe),
        probe: ownerProbe ?? brief.owner.summary,
        basis: ownerProbe === undefined ? 'absent' : 'exact',
    });
    // 3. 对手论据：取第一条的 claim 片段。没有论据时这一项不适用 —— 记 absent。
    const argProbe = probeOf(brief.opponentArguments?.[0]?.claim, 16);
    items.push({
        key: 'opponentArgument',
        label: '对手论据',
        before: argProbe !== undefined,
        after: argProbe !== undefined && contains(after, argProbe),
        probe: argProbe ?? '（简报没有抽出对方论据）',
        basis: argProbe === undefined ? 'absent' : 'exact',
    });
    // 4. 来源 id：论据/立场的证据 id 是否还出现在压缩后的文本里。
    const evidenceIds = [
        ...brief.owner.evidence,
        ...(brief.opponentArguments ?? []).flatMap((item) => item.evidence),
    ];
    const uniqueIds = [...new Set(evidenceIds)];
    items.push({
        key: 'sourceId',
        label: '来源 id',
        before: uniqueIds.length > 0,
        after: uniqueIds.length > 0 ? uniqueIds.some((id) => contains(after, id)) : false,
        probe: uniqueIds.length > 0 ? uniqueIds.join('、') : '（简报没有引用任何 post id）',
        basis: uniqueIds.length > 0 ? 'exact' : 'absent',
    });
    // 5. 核心争议：没有逐字原文，只能看双方立场句是否都在 —— 标 proxy。
    const disputeProbe = probeOf(brief.disagreements?.[0], 20);
    items.push({
        key: 'dispute',
        label: '核心争议',
        before: disputeProbe !== undefined,
        after: disputeProbe !== undefined && contains(after, disputeProbe),
        probe: disputeProbe ?? '（这次没有识别出可陈述的分歧）',
        basis: disputeProbe === undefined ? 'absent' : 'proxy',
    });
    // 6. 不确定信息：不在上下文里，而在简报里。这一项的判据是「简报有没有说」，
    //    压缩无法删掉它（它随简报作为独立段落下发），所以 before/after 同值。
    const uncertainties = brief.missingContext ?? [];
    items.push({
        key: 'uncertainty',
        label: '不确定信息',
        before: uncertainties.length > 0,
        after: uncertainties.length > 0,
        probe: uncertainties.length > 0 ? uncertainties[0]?.slice(0, 30) ?? '' : '（这次读取没有可报告的缺口）',
        basis: 'exact',
    });
    const lost = items.filter((item) => item.before && !item.after).map((item) => item.key);
    return {
        items,
        lost,
        omissions: context.omissions,
        tokens: context.tokens,
        budget: context.budget,
    };
}
/**
 * 把记录渲染成一段可读的说明，供报告与界面使用。
 *
 * 一行一项，丢了的打「丢」。不写「通过 / 失败」：丢了某一项不一定是 bug
 * （预算小的时候核心争议本来就装不下），但必须让人看见。
 */
export function renderCompressionRecord(record, dispute) {
    const lines = [];
    lines.push(`压缩占用 ${record.tokens} / ${record.budget} tokens`);
    for (const item of record.items) {
        const status = item.before ? (item.after ? '保留' : '丢失') : '不适用';
        const note = item.basis === 'proxy' ? '（代理判定）' : '';
        lines.push(`- ${item.label}：${status}${note} —— ${item.probe}`);
    }
    if (record.lost.length > 0) {
        lines.push(`丢掉 ${record.lost.length} 项：${record.lost.join('、')}`);
    }
    if (record.omissions.length > 0) {
        lines.push('压缩器报告的裁剪：');
        for (const omission of record.omissions)
            lines.push(`  - ${omission}`);
    }
    if (dispute !== undefined && dispute.notes.length > 0) {
        lines.push('分析备注：');
        for (const note of dispute.notes)
            lines.push(`  - ${note}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=compression-record.js.map