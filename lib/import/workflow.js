/**
 * 离线工作流的完整链路（v0.2.30 §二）。
 *
 * ## 十一步，每一步都要能被页面单独说清
 *
 * ```
 * 导入 → 预览 → 确认 → 分析 → 选中 → 人格 → 生成 → 编辑 → 安全评估 → 人工确认 → 复制
 * ```
 *
 * 任务书要求这条链路「可独立解释」。落到实处是：每一步失败都有一个不属于
 * 「未知错误」的原因，且原因说的是**下一步能做什么**，而不是「操作失败」。
 *
 * ## 这里没有第二个辩论引擎
 *
 * 分析用 `analyzeDispute`，生成用 `generateReply`，评估用 `guardOutput`，
 * 压缩用 `compressContext`，简报用 `buildBrief` + `validateBrief`——与真实平台
 * 走的是**同一批函数**。本文件做的是把它按离线场景的顺序串起来，并在每一个
 * 需要写库的地方落库。任何一行「自己判断谁在跟谁吵」的代码都意味着出现了
 * 第二个引擎，那是任务书明确禁止的。
 *
 * ## 终点是剪贴板
 *
 * `copyReply` 返回纯文本，不调用任何发布路径。这不是「暂时不支持发表」的委婉说法：
 * `runPublish` 对导入会话有显式拒绝，`platform: 'manual'` 在注册表里不存在，
 * 两道门都在。
 */
import { buildTimeline, containerOf } from '../collector.js';
import { buildBrief } from '../brief-builder.js';
import { renderBrief, validateBrief } from '../brief.js';
import { compressContext, resolveBudget, splitBudget } from '../compressor.js';
import { generateReply } from '../generator.js';
import { PERSONAS, resolvePersona } from '../persona.js';
import { selectStrategy } from '../strategy.js';
import { recordCompression } from '../compression-record.js';
import { classifyOutcome, reasonNamesGap } from '../outcome.js';
import { guardOutput, toStorageRecord } from '../security/output-guard.js';
import { contentHash, resolveTarget } from '../target.js';
import { detectInjection, transition } from '../safety.js';
import { newCandidateId } from '../store.js';
import { buildCommentList } from '../comment-list.js';
import { analyzeImported, collectedFromStored, correctedDiscussion, excerptOf, localTargetResolver } from './session.js';
import { MANUAL_PLATFORM } from './manual.js';
import { hasCorrections, sanitizeCorrections } from './corrections.js';
import { describeImport } from './preview.js';
import { MANUAL_CAPABILITIES, MANUAL_IMPORT } from './source.js';
/** 每一步的中文名，供页面与错误消息共用一份。 */
export const STEP_TITLES = {
    import: '导入讨论',
    preview: '预览解析结果',
    confirm: '确认导入',
    analyze: '分析争论结构',
    select: '选中要回复的那一条',
    persona: '选择人格',
    generate: '生成候选回复',
    edit: '编辑正文',
    assess: '安全评估',
    approve: '人工确认',
    copy: '复制回复',
};
function failed(step, reason, next = [], outcome) {
    return { ok: false, step, reason, next, ...(outcome === undefined ? {} : { outcome }) };
}
function succeeded(step, value) {
    return { ok: true, step, value };
}
export function personaOptions() {
    return Object.keys(PERSONAS).map((id) => {
        const persona = PERSONAS[id];
        return { id, name: persona.name, summary: persona.summary, approach: persona.approach };
    });
}
/** 从配置取人格基础值。与 `runtime.ts` 的 `personaFromConfig` 同一份字段。 */
function personaFromConfig(config) {
    return resolvePersona({
        style: config.personaStyle,
        intensity: config.intensity,
        maxLength: config.maxLength,
        emojiLevel: config.emojiLevel,
        sarcasmLevel: config.sarcasmLevel,
        directness: config.directness,
    });
}
/** 校验一个人格 id，返回可写进会话的配置。 */
export function personaOf(style, config, overrides) {
    const base = personaFromConfig(config);
    const withOverrides = resolvePersona({
        ...base,
        ...(overrides?.intensity === undefined ? {} : { intensity: overrides.intensity }),
        ...(overrides?.maxLength === undefined ? {} : { maxLength: overrides.maxLength }),
    });
    if (style === undefined || style.trim() === '')
        return withOverrides;
    const known = Object.keys(PERSONAS).includes(style);
    if (!known) {
        throw new Error(`未知的人格「${style}」。可选：${personaOptions()
            .map((option) => `${option.id}（${option.name}）`)
            .join('、')}。`);
    }
    return { ...withOverrides, style: style };
}
/**
 * 分析一份导入的讨论，并落库成会话。
 *
 * ## 为什么会话要写两次
 *
 * 第一次写入是「会话已创建」，第二次补上分析结果（`ownerKey`、`disputeFloorPostId`、
 * 参与者）。分开是因为分析可能抛错：抛错时用户应该看到一个「导入了但没分析成功」
 * 的会话，而不是「什么都没有」——前者可以重试，后者得从头再来一遍。
 *
 * 但它们必须在同一个会话 id 上。所以第一次写入就定下 id，第二次按 id 更新。
 */
export async function analyzeImport(store, input) {
    let collected;
    try {
        collected = collectedFromStored(input.imported);
    }
    catch (error) {
        return failed('analyze', `无法从导入内容重建讨论：${error.message}`, [
            '检查导入的正文是否完整（每条发言要有「作者：内容」）',
            '重新导入一次',
        ]);
    }
    const ownerName = input.ownerName?.trim() || input.imported.root.author;
    let analyzed;
    try {
        analyzed = analyzeImported({
            collected,
            ownerName,
            ...(input.targetPostId === undefined ? {} : { targetPostId: input.targetPostId }),
            ...(input.config.aiAccountName === '' ? {} : { aiAccountName: input.config.aiAccountName }),
            ...(input.now === undefined ? {} : { now: input.now }),
        });
    }
    catch (error) {
        // 分析器的错误本来就是具体的（「没有找到主人」「触发回复不在对话里」），
        // 原样透出而不是包一层「分析失败」——包一层会把可行动的原因变成噪音。
        return failed('analyze', error.message, [
            '检查「主人是谁」是否填了导入内容里的某个作者名',
            '确认至少有一条别人的发言（只有原帖时没有可回复的对象）',
        ]);
    }
    const { dispute, targetPostId } = analyzed;
    const now = new Date(input.now?.() ?? Date.now()).toISOString();
    /**
     * 会话 id。
     *
     * ## 为什么不能只用「时间戳 + 线程哈希」
     *
     * 第一版就是这么算的，而它有一个只在真实使用中才出现的缺陷：同一秒内对同一份
     * 内容分析两次（`reselectImport` 正是这样——它先建一个新会话再把内容搬到旧 id 上），
     * 两次得到同一个 id。于是「删掉刚才多插的那一条」把原会话一起删掉了，
     * 用户看到的是「会话消失了」。
     *
     * 时间戳精确到秒、线程哈希确定，只有第三个分量能保证唯一。用进程内单调计数：
     * 它不依赖随机数（可测），也不依赖更多的时间精度（同一毫秒仍会撞）。
     */
    const sessionId = `m${now.replace(/[-:.TZ]/g, '').slice(0, 14)}${nextManualSessionSerial().toString(36)}`;
    const participants = [
        dispute.owner,
        ...(dispute.opponent === undefined ? [] : [dispute.opponent]),
        ...dispute.bystanders,
    ].map((person) => ({
        name: person.displayName,
        postCount: person.postCount,
        isOwner: person.key === dispute.owner.key,
        isOpponent: person.key === dispute.opponent?.key,
    }));
    // 注入检测：报告，不执行。与 `runAnalysis` 的措辞一致，因为用户可能在两处
    // 看到同一条内容，两处说不同的话会让人怀疑哪一处是真的。
    const securityNotes = [];
    for (const entry of buildTimeline(collected)) {
        const hits = detectInjectionText(entry.content);
        if (hits.length > 0) {
            securityNotes.push(`${entry.authorName ?? entry.postId} 的发言里出现可疑指令性文本（${hits.join('、')}），` +
                '已按普通用户发言处理，不会作为系统指令执行');
        }
    }
    const comments = buildStoredComments(collected);
    const reasons = [...collected.completeness.reasons];
    if (input.imported.droppedComments > 0) {
        reasons.push(`导入时只保存了 ${input.imported.comments.length} 条，另有 ${input.imported.droppedComments} 条没有保存。`);
    }
    if (input.imported.truncatedComments > 0) {
        reasons.push(`有 ${input.imported.truncatedComments} 条正文被截断保存。`);
    }
    const session = {
        id: sessionId,
        platform: MANUAL_PLATFORM,
        threadId: collected.thread.id,
        threadUrl: input.imported.url ?? '',
        threadTitle: input.imported.title,
        forumName: '',
        ownerKey: dispute.owner.key,
        ownerName: dispute.owner.displayName,
        ...(dispute.opponent === undefined
            ? {}
            : { opponentKey: dispute.opponent.key, opponentName: dispute.opponent.displayName }),
        ...(dispute.opponent?.lastPostId === undefined
            ? {}
            : { targetKind: postKindOf(collected, targetPostId) }),
        ownerIdentityAssurance: dispute.ownerIdentityAssurance,
        ownerIdentityEvidence: dispute.ownerIdentityEvidence,
        disputeFloorPostId: dispute.floorPostId,
        disputeFloorNumber: dispute.floorNumber ?? 0,
        triggerPostId: targetPostId,
        state: 'ANALYZING',
        statusText: '人工导入：内容来自剪贴板，未经平台核验',
        persona: {
            style: input.persona.style,
            intensity: input.persona.intensity,
            maxLength: input.persona.maxLength,
        },
        candidates: [],
        comments,
        readQuality: {
            floorsRead: collected.floors.length,
            nestedRead: collected.floors.reduce((sum, entry) => sum + entry.nested.length, 0),
            // 导入的永远不是「完整读取」：内容来自剪贴板，没有平台来证明它没被裁剪。
            truncated: true,
            reasons,
            observationOverflow: [],
        },
        sentTexts: [],
        publishedPostIds: [],
        imported: input.imported,
        participants,
        createdAt: now,
        updatedAt: now,
    };
    await store.mutate((data) => ({ ...data, sessions: [...data.sessions, session] }));
    return succeeded('analyze', {
        collected,
        dispute,
        targetPostId,
        session,
        participants,
        securityNotes,
    });
}
/** 与 `runAnalysis` 同一套检测，避免两处措辞分叉。 */
function detectInjectionText(text) {
    // 直接复用安全模块的实现；这个薄包装存在的唯一理由是让上面的调用点读起来
    // 像「检测这段文本」，而不是「导入一个以 detect 开头的函数」。
    return detectInjection(text);
}
/**
 * 进程内单调计数，只用于让会话 id 唯一。
 *
 * 从模块加载时刻的毫秒值起算而不是从 0 起算：两个进程同时分析同一份内容时，
 * 起始值的差异让它们几乎不可能落在同一个数上。这不是严格的唯一性保证
 * （那需要一个真正的外部分配器），但对同一个 store 里的两个会话已经足够——
 * 而 store 本身在写入时会加跨进程锁。
 */
let manualSessionSerial = Date.now() % 1_000_000;
function nextManualSessionSerial() {
    manualSessionSerial += 1;
    return manualSessionSerial;
}
function buildStoredComments(collected) {
    return buildCommentList(collected).comments;
}
/**
 * 重新分析：换主人或换目标。
 *
 * ## 为什么要重新分析而不是改两个字段
 *
 * 主人变了，`ownerKey`、`ownerIdentityEvidence`、争论对象、`floorPostId` 全都变；
 * 目标变了，对手和争论链也变。只改字段会让会话内部自相矛盾——而发表路径
 * 正是靠这些字段判断「这段话是给谁写的」。
 *
 * 所以这里重跑分析器，然后把结果整体覆盖到同一个会话 id 上。候选**全部作废**：
 * 它们是对着旧的主人和旧的对手写的。
 */
export async function reselectImport(store, input) {
    const session = store.getSession(input.sessionId);
    if (session === undefined) {
        return failed('select', `找不到会话 ${input.sessionId}`, ['刷新页面后重试']);
    }
    if (session.imported === undefined) {
        return failed('select', '这条会话不是人工导入的，不能这样重新选择。', [
            '真实平台的会话请用工作台的「用这条」',
        ]);
    }
    const analyzed = await analyzeImport(store, {
        imported: session.imported,
        ownerName: input.ownerName ?? session.ownerName,
        targetPostId: input.targetPostId ?? session.triggerPostId,
        persona: input.persona,
        config: input.config,
        ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (!analyzed.ok || analyzed.value === undefined)
        return analyzed;
    // 分析生成了一个**新**会话（因为它总是插入）。把结果搬到原会话 id 上，
    // 并清掉候选——它们是对着旧目标写的。
    const fresh = analyzed.value;
    const merged = {
        ...fresh.session,
        id: session.id,
        candidates: [],
        createdAt: session.createdAt,
    };
    await store.mutate((data) => ({
        ...data,
        sessions: data.sessions
            // 先删掉刚才多插的那一条，再把内容覆盖到原 id 上。
            .filter((entry) => entry.id !== fresh.session.id)
            .map((entry) => (entry.id === session.id ? merged : entry)),
    }));
    return succeeded('select', { ...fresh, session: merged });
}
/**
 * 对已建好的会话应用一批修正。
 *
 * ## 与 `reselectImport` 的分工
 *
 * `reselectImport` 改的是「谁在说话、回给谁」（主人与目标），内容不变；
 * 这里是内容本身被纠正了（作者认错、回复目标错了、原帖标错了）。
 *
 * 两者都必须重跑分析，而且都必须**清空候选**——原因一样：已有候选是对着
 * 旧的那份讨论写的，而它的安全评估引用的是旧正文里的证据。留下它们，
 * 「这段文字通过了安全评估」这句话就会指向一份已经不存在的讨论。
 *
 * ## 为什么不能靠改 `imported` 就完事
 *
 * `imported` 只存原始解析结果 + 修正清单。会话上的 `comments`、`ownerKey`、
 * `disputeFloorPostId`、`triggerPostId` 全是分析产物，必须一起重算，
 * 否则「会话显示的作者」与「分析用的作者」会分叉。
 */
export async function reviseImport(store, input) {
    const session = store.getSession(input.sessionId);
    if (session === undefined) {
        return failed('analyze', `找不到会话 ${input.sessionId}`, ['刷新页面后重试']);
    }
    if (session.imported === undefined) {
        return failed('analyze', '这条会话不是人工导入的，不能这样修正。', [
            '真实平台的会话没有可修正的解析结果',
        ]);
    }
    const corrections = sanitizeCorrections(input.corrections);
    if (corrections === undefined) {
        return failed('analyze', '修正清单的格式不对（缺少 version 或不是对象）。', [
            '刷新页面后重新修改',
        ]);
    }
    // 空清单等于「撤销所有修正」：这是合法操作，且必须真的撤回。
    if (!hasCorrections(corrections)) {
        const { corrections: _drop, ...rest } = session.imported;
        return reviseWith(store, session, rest, input);
    }
    return reviseWith(store, session, { ...session.imported, corrections }, input);
}
async function reviseWith(store, session, imported, input) {
    /**
     * 先算结构，再分析。
     *
     * 顺序有实际意义：结构算得出来，说明投影这一层没炸（修正指向的 id 都在、
     * 原帖升降没把图搞坏）。先分析的话，投影炸掉的错误会被分析器的
     * 「没有找到主人」之类的消息盖住，而后者是完全无关的原因。
     */
    let structure;
    let audit;
    try {
        const mid = correctedDiscussion(imported);
        structure = describeImport(mid.discussion);
        audit = mid.audit;
    }
    catch (error) {
        return failed('analyze', `修正之后无法重建讨论：${error.message}`, [
            '撤销最近的修改再试一次',
            '如果反复失败，请把这段原文重新导入一次',
        ]);
    }
    const analyzed = await analyzeImport(store, {
        imported,
        ownerName: session.ownerName,
        ...(session.triggerPostId === '' ? {} : { targetPostId: session.triggerPostId }),
        persona: input.persona,
        config: input.config,
        ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (!analyzed.ok || analyzed.value === undefined) {
        // 分析失败时**不要**把修正写进去：那样会话会停在「内容改了但分析还是旧的」，
        // 而界面会显示修正已生效。宁可整批不生效，让用户看到原因。
        return failed('analyze', analyzed.reason ?? '修正之后分析失败。', analyzed.next ?? []);
    }
    const fresh = analyzed.value;
    const merged = {
        ...fresh.session,
        id: session.id,
        candidates: [],
        createdAt: session.createdAt,
        imported,
    };
    await store.mutate((data) => ({
        ...data,
        sessions: data.sessions
            .filter((entry) => entry.id !== fresh.session.id)
            .map((entry) => (entry.id === session.id ? merged : entry)),
    }));
    return succeeded('analyze', {
        session: merged,
        structure,
        audit,
        discardedCandidates: session.candidates.length,
    });
}
/** 与 `runtime.ts` 同一规则：只在压缩丢了材料时开口。 */
function compressionNotes(record) {
    if (record.lost.length === 0)
        return [];
    const labels = record.items
        .filter((item) => record.lost.includes(item.key))
        .map((item) => `${item.label}${item.basis === 'proxy' ? '（代理判定）' : ''}`);
    return [
        `这次压缩丢掉了 ${record.lost.length} 项材料：${labels.join('、')}。` +
            `占用 ${record.tokens}/${record.budget} tokens。`,
    ];
}
/**
 * 为导入的会话生成候选。
 *
 * ## v0.2.39：`input.forceAttempt` 把「材料够不够」的判断交回给模型
 *
 * `classifyOutcome` 用「简报里有没有可打的论据」判「该不该拒绝」。这个判据是**保守的**，
 * 它只看数量，不看内容 —— 于是「对方说了一句『方案我贴了』」也算一条论据，而模型完全
 * 可以合理地答「这句话支撑不了任何具体主张」。第一次真实采集里，q06 与 q19 就是这样被
 * 判成了缺陷（`unjustified_refusal`），而模型的理由其实站得住。
 *
 * 用户从页面点「生成候选回复」时，他**明确表达了意图**：先试着写一条。这时把「材料够不够」
 * 的最终判断交给模型，比由计数规则替他决定更合适 —— 模型拒绝时会给出具体缺口，而那个
 * 缺口会原样回到页面上。
 *
 * 这条开关不改变安全边界：拒绝仍然不落候选，违规仍然拦下，目标仍然校验。它只改变
 * 「模型说材料不够」这一条被判成什么。
 *
 * ## 与 `runGeneration` 的关系
 *
 * 它是**同一套步骤的不同入口**，因为 `runGeneration` 有三处真实平台专用的逻辑：
 * 读适配器（离线没有）、读配置里的主人绑定（离线不用）、发表目标校验用适配器
 * （离线用本地解析器）。除此之外的每一步——重投影、`analyzeDispute`、
 * `compressContext`、`buildBrief` + `validateBrief`、`generateReply`、
 * `guardOutput`、候选版本分配——都在这里原样重现。
 *
 * 之所以不把 `runGeneration` 参数化，是因为那会让真实发表路径上多出三个
 * 「如果这是离线会话」的分支，而那条路径的每一项检查都是防发错人的。
 * 复制一份步骤、共用全部函数，比让真实路径长出分支安全。
 */
export async function generateForImport(store, input) {
    const progress = input.progress ?? (() => undefined);
    const session = store.getSession(input.sessionId);
    if (session === undefined)
        return failed('generate', `找不到会话 ${input.sessionId}`, ['刷新页面后重试']);
    if (session.imported === undefined) {
        return failed('generate', '这条会话不是人工导入的。', ['真实平台的会话请用工作台的「生成候选」']);
    }
    if (session.state === 'CANCELLED') {
        return failed('generate', '这条会话已被停止，不能再生成。', ['重新导入一次']);
    }
    const collected = collectedFromStored(session.imported);
    const targetPostId = input.targetPostId ?? session.selectedTargetPostId ?? session.triggerPostId;
    // 目标必须在这份导入内容里。没有这一条，一个手写的 id 会让生成对着
    // 一段不存在的文字进行——而评估环节的所有引用校验都会因此失去意义。
    const known = buildTimeline(collected).some((entry) => entry.postId === targetPostId);
    if (!known) {
        return failed('generate', `目标 ${targetPostId} 不在这次导入的内容里，无法作为回复对象。`, [
            '在评论列表里重新点选一条',
        ]);
    }
    let dispute;
    try {
        dispute = analyzeImported({
            collected,
            ownerName: session.ownerName ?? session.imported.root.author,
            targetPostId,
            ...(input.config.aiAccountName === '' ? {} : { aiAccountName: input.config.aiAccountName }),
        }).dispute;
    }
    catch (error) {
        return failed('generate', error.message, ['检查「主人是谁」是否仍在这次导入的内容里']);
    }
    // 目标快照：走 `resolveTarget` 的完整校验，只是换成本地解析器。
    const expectation = {
        threadId: session.threadId,
        floorPostId: containerOf(collected, targetPostId)?.postId ?? dispute.floorPostId,
        targetPostId,
        targetKind: postKindOf(collected, targetPostId),
        ...(dispute.opponent?.userId === undefined ? {} : { targetAuthorId: dispute.opponent.userId }),
    };
    const resolved = await resolveTarget(localTargetResolver(collected), expectation, {
        platform: MANUAL_PLATFORM,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!resolved.ok) {
        return failed('generate', `回复目标无法确认：${resolved.message}`, [
            '重新选择要回复的那一条',
            '如果刚编辑过导入内容，重新导入一次',
        ]);
    }
    const persona = { ...resolvePersona(input.config), ...(input.persona ?? {}) };
    const total = resolveBudget({
        preset: input.config.contextPreset,
        tokens: input.config.contextTokens > 0 ? input.config.contextTokens : undefined,
    });
    const split = splitBudget(total.tokens);
    const context = compressContext({
        collected,
        dispute,
        trigger: { postId: session.triggerPostId },
        persona,
        budget: { tokens: split.contextTokens, quoteLimit: total.quoteLimit },
        totalTokens: total.tokens,
        ...(input.ownerInstruction === undefined ? {} : { ownerInstruction: input.ownerInstruction }),
    });
    const briefBuild = buildBrief({
        platform: MANUAL_PLATFORM,
        threadId: session.threadId,
        collected,
        dispute,
        targetPostId,
    });
    const briefProblems = validateBrief(briefBuild.brief, briefBuild.sources);
    if (briefProblems.length > 0) {
        const summary = briefProblems.map((problem) => `${problem.field}：${problem.reason}`).join('；');
        return failed('assess', `争论简报未通过证据校验，不能据此生成回复：${summary}`, ['这份导入内容可能不足以支撑一次回复，试试多导入几条对方的发言']);
    }
    /**
     * 人工导入这条链路也要选策略（v0.2.38）。
     *
     * 它是手动导入用户的**唯一**生成路径 —— 漏掉这一处，策略层只对真实平台生效，
     * 而这一版的质量对照实验恰好就是跑在这条路径上的。
     */
    const strategySelection = selectStrategy(briefBuild.brief, input.strategy);
    const strategy = strategySelection.choice;
    const briefText = renderBrief(briefBuild.brief);
    const compression = recordCompression(briefBuild.brief, collected.floors.flatMap((floor) => [floor.floor, ...floor.nested]).find((post) => post.postId === targetPostId)?.content, context, briefText);
    progress('正在生成回复…');
    const result = await generateReply(input.llm(), {
        dispute,
        context,
        persona,
        expectedTargetPostId: targetPostId,
        alreadyPublished: session.publishedPostIds,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.ownerInstruction === undefined ? {} : { ownerInstruction: input.ownerInstruction }),
        brief: briefText,
        ...(strategy === undefined ? {} : { strategy }),
        temperature: input.config.llmTemperature,
        ...(input.config.llmMaxOutputTokens > 0 ? { maxTokens: input.config.llmMaxOutputTokens } : {}),
    });
    if (result.draft === undefined) {
        const reasons = result.violations.map((violation) => violation.message).join('；');
        return failed('generate', `模型输出不符合约定，没有生成候选：${reasons}`, [
            '再点一次生成（模型偶尔不遵守格式）',
            '如果连续两次如此，换一个更强的模型',
        ]);
    }
    /**
     * 这次生成属于哪一类结果（v0.2.39 §3.1）。
     *
     * 与真实平台链路用**同一个函数**、同一套判据。两条链路各自判一次会让同一份材料在两处
     * 得到不同的分类 —— 而「这条该不该拒」不该取决于用户是从哪个入口点进来的。
     */
    const outcome = classifyOutcome({
        needsInput: result.needsInput,
        reply: result.draft.reply,
        violations: result.violations,
        evidence: {
            opponentArgumentCount: briefBuild.brief.opponentArguments?.length ?? 0,
            unansweredByOpponent: briefBuild.brief.unansweredByOpponent?.length ?? 0,
            targetConfirmed: dispute.opponent !== undefined && !dispute.needsConfirmation,
        },
        forceAttempt: input.forceAttempt === true,
        ...(result.needsInputReason === undefined ? {} : { needsInputReason: result.needsInputReason }),
    });
    /**
     * 模型自己说「材料不够，我不答」时，不能落一条空候选（v0.2.38）。
     *
     * ## 这是真实跑出来的坑
     *
     * v0.2.38 的质量采集里，长楼层那条案例（最早那条质疑被 6 条刷屏埋住）连续两轮
     * 都产出了一条 `text: ""` 的候选：模型按第 3 条铁律返回了 `needs_more_context`，
     * 而这条链路只判断「draft 存不存在」—— 存在就落库。于是页面上出现一条可以点
     * 「复制」的空候选，采集器也只能记下一条空正文，分不清是模型拒绝还是链路坏了。
     *
     * v0.2.39 起改成按 `outcome` 分流：`valid_draft` / `invalid_draft` 之外的三种结果
     * 都不落候选，但**都要把原因和下一步带回去**。合理拒绝不是故障，所以文案也不同。
     */
    if (outcome === 'needs_more_context' || outcome === 'unjustified_refusal') {
        const gap = result.needsInputReason ?? '模型没有说明缺什么';
        const concrete = reasonNamesGap(result.needsInputReason);
        return failed('generate', outcome === 'needs_more_context'
            ? `模型认为材料不够，没有给出回复：${gap}`
            : `材料里有可打的论据，模型仍然拒绝回应：${gap}`, outcome === 'needs_more_context'
            ? concrete
                ? ['补上它点出的那一部分后重新生成', '在「评论列表」里换一条更有依据的目标']
                : ['它只说「信息不足」，没说是哪里 —— 换一条评论更多的目标试试', '补读原帖后再导入']
            : ['再点一次生成（同一个模型偶尔会误判）', '换一个更强的模型', '把「论证打法」改成「追问关键依据」再试'], outcome);
    }
    if (outcome === 'technical_failure') {
        const detail = result.violations.map((violation) => violation.message).join('；');
        return failed('generate', `技术故障，没有生成结果：${detail || '模型没有返回正文'}`, [
            '再点一次生成',
            '如果连续两次如此，检查模型服务是否可用',
            '输出总是被截断时，把「最大输出 token」调高',
        ], outcome);
    }
    const replyText = result.draft.reply;
    const guarded = guardOutput({
        reply: replyText,
        targetPostId,
        expectedTargetPostId: targetPostId,
        owner: { platform: MANUAL_PLATFORM, displayName: session.ownerName ?? session.imported.root.author },
        ...(dispute.opponent?.displayName === undefined
            ? {}
            : { opponentName: dispute.opponent.displayName }),
        posts: collectedPostsOf(collected),
        ownerPostIds: new Set(dispute.ownerStatements.map((statement) => statement.postId)),
        opponentPostIds: new Set(dispute.exchange.map((statement) => statement.postId)),
        conversationText: conversationTextsOf(collected),
        strictness: input.config.securityStrictness === 'strict' || input.config.securityStrictness === 'relaxed'
            ? input.config.securityStrictness
            : 'standard',
        semanticSettled: briefBuild.verdict.requiresReview === false,
    });
    const violations = result.violations.map((violation) => violation.message);
    let stored;
    await store.mutate((data) => ({
        ...data,
        sessions: data.sessions.map((entry) => {
            if (entry.id !== session.id)
                return entry;
            const candidate = {
                replyId: newCandidateId(entry.id, nextIndex(entry)),
                text: replyText,
                strategy: result.draft?.strategy ?? 'direct_rebuttal',
                ...(strategy === undefined
                    ? {}
                    : {
                        argumentStrategy: {
                            id: strategy.id,
                            name: strategy.name,
                            source: strategy.source,
                            reason: strategy.reason,
                            confidence: strategy.confidence,
                            evidence: strategy.evidence.map((item) => ({
                                field: item.field,
                                postIds: [...item.postIds],
                                why: item.why,
                            })),
                        },
                    }),
                targetPostId,
                targetSnapshot: resolved.snapshot,
                candidateVersion: nextVersion(entry),
                textHash: hashOf(replyText),
                confidence: result.draft?.confidence ?? 0,
                violations,
                notes: [...result.notes, ...compressionNotes(compression)],
                security: toStorageRecord(guarded.assessment, guarded.fingerprint),
                createdAt: new Date().toISOString(),
                /**
                 * 人格 id 落库（v0.2.37 §7）。四种人格比较的前提是每条候选记得自己是
                 * 哪一种 —— 配置里的人格只说明「下一次用什么」。
                 */
                persona: persona.style,
                ...(result.usage?.elapsedMs === undefined ? {} : { elapsedMs: result.usage.elapsedMs }),
                ...(result.usage?.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
                ...(result.usage?.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
                approved: false,
            };
            stored = candidate;
            const entered = transition(entry.state, 'GENERATING');
            const desired = result.needsInput
                ? 'NEEDS_CONFIRMATION'
                : violations.length === 0 && replyText.length > 0
                    ? 'REVIEWING'
                    : 'REVIEWING';
            const moved = transition(entered.state, desired);
            return {
                ...entry,
                state: moved.ok ? moved.state : entered.state,
                statusText: result.needsInput
                    ? `模型要求补充信息：${result.needsInputReason ?? ''}`
                    : violations.length > 0
                        ? `候选回复未通过检查：${violations.join('；')}`
                        : '候选回复已生成，等待你确认',
                candidates: [...entry.candidates, candidate],
                selectedTargetPostId: targetPostId,
                updatedAt: new Date().toISOString(),
            };
        }),
    }));
    if (stored === undefined) {
        return failed('generate', '内部错误：候选没有写入会话。', ['刷新页面后重试']);
    }
    return succeeded('generate', {
        sessionId: session.id,
        outcome,
        candidateId: stored.replyId,
        text: stored.text,
        version: stored.candidateVersion,
        ...(stored.argumentStrategy === undefined
            ? {}
            : { argumentStrategy: stored.argumentStrategy }),
        violations,
        notes: result.notes,
        securityDecision: guarded.assessment.decision,
        securityReasons: guarded.assessment.reasons,
        needsInput: result.needsInput,
        ...(result.needsInputReason === undefined ? {} : { needsInputReason: result.needsInputReason }),
    });
}
/** 与 `runtime.ts` 的 `postKindOf` 同一规则：只有嵌套回复才是 `nested`。 */
function postKindOf(collected, postId) {
    for (const entry of collected.floors) {
        if (entry.nested.some((reply) => reply.postId === postId))
            return 'nested';
    }
    return 'floor';
}
/** 与 `runtime.ts` 的私有实现同一规则：取最大值 + 1。 */
function nextVersion(session) {
    return session.candidates.reduce((max, candidate) => Math.max(max, candidate.candidateVersion), 0) + 1;
}
/** 与 `runtime.ts` 同一规则：取已有 `-cN` 的最大 N + 1。 */
function nextIndex(session) {
    let max = 0;
    for (const candidate of session.candidates) {
        const match = candidate.replyId.match(/-c(\d+)$/);
        if (match === null)
            continue;
        max = Math.max(max, Number(match[1]));
    }
    return max + 1;
}
function hashOf(text) {
    // 与 `target.ts` 的 `contentHash` 同一算法：批准记录会跨两条路径比较同一个哈希，
    // 算法不同会让「编辑过的正文」在离线路径上看起来仍然是原样。
    return contentHash(text);
}
function collectedPostsOf(collected) {
    const out = [];
    for (const entry of collected.floors) {
        out.push({
            postId: entry.floor.postId,
            authorKey: entry.floor.authorId ?? entry.floor.authorName ?? '',
            text: entry.floor.content,
        });
        for (const reply of entry.nested) {
            out.push({
                postId: reply.postId,
                authorKey: reply.authorId ?? reply.authorName ?? '',
                text: reply.content,
            });
        }
    }
    return out;
}
function conversationTextsOf(collected) {
    const out = [collected.thread.title, collected.thread.content];
    for (const entry of collected.floors) {
        out.push(entry.floor.content);
        for (const reply of entry.nested)
            out.push(reply.content);
    }
    return out.filter((text) => text.trim() !== '');
}
/**
 * 复制之前的那一步。
 *
 * ## 为什么这也要走一次服务端
 *
 * 因为「复制」是这个流程的终点，而终点必须能回答三个问题：
 * 复制的是哪一份正文、它是回给谁的、它当时通过了什么评估。
 * 让页面自己从 state 里拼这三个答案，等于让页面去猜——而页面拿到的候选正文
 * 可能已经被编辑过（编辑会 bump 版本，但页面上的旧 state 不会自己刷新）。
 *
 * 所以复制前问一次服务端，由它给出**存下来的那一份**。正文与 `visibleText`
 * 不一致时拒绝：那不是同一段文字，复制出去会和用户看到的不同。
 */
export async function copyReply(store, input) {
    const session = store.getSession(input.sessionId);
    if (session === undefined)
        return failed('copy', `找不到会话 ${input.sessionId}`, ['刷新页面后重试']);
    if (session.imported === undefined) {
        return failed('copy', '这条会话不是人工导入的。', ['真实平台请用「发表」流程']);
    }
    const candidate = session.candidates.find((entry) => entry.replyId === input.candidateId);
    if (candidate === undefined) {
        return failed('copy', `这条会话里没有候选 ${input.candidateId}`, ['重新生成一次']);
    }
    if (candidate.text.trim() === '') {
        return failed('copy', '这段正文是空的，复制不出任何内容。', ['重新生成一次']);
    }
    if (input.visibleText !== undefined && input.visibleText !== candidate.text) {
        return failed('copy', '页面上的正文与保存下来的不一致（可能刚被编辑过）。' +
            '为避免复制出你没看过的内容，请刷新后再复制。', ['刷新页面', '重新检查正文，再复制']);
    }
    const collected = collectedFromStored(session.imported);
    const target = findTarget(collected, candidate.targetPostId);
    const assessment = candidate.security;
    const blockers = [];
    if (assessment === undefined) {
        blockers.push('这段正文没有安全评估记录（可能是旧版本写入的候选）。' +
            '可以重新生成一次，让评估重新跑一遍。');
    }
    else if (assessment.decision === 'block') {
        blockers.push(`安全评估判定为「阻止」：${assessment.reasons.join('；') || '未说明原因'}。` +
            '这段文字不应该贴到任何地方。');
    }
    if (candidate.violations.length > 0) {
        blockers.push(`候选检查未通过：${candidate.violations.join('；')}`);
    }
    return succeeded('copy', {
        sessionId: session.id,
        candidateId: candidate.replyId,
        text: candidate.text,
        target: {
            ...(target?.author === undefined ? {} : { author: target.author }),
            excerpt: excerptOf(target?.text ?? ''),
            postId: candidate.targetPostId,
        },
        persona: personaNameOf(session.persona.style),
        // `review` 不是「不安全」，它是「需要你看过再决定」。所以只有 `block` 与
        // 未评估会阻止一键复制；`review` 允许复制，但 blockers 里会说明它为什么被标记。
        safe: assessment !== undefined && assessment.decision !== 'block' && candidate.violations.length === 0,
        blockers: assessment?.decision === 'review'
            ? [...blockers, `安全评估标记为「需人工确认」：${assessment.reasons.join('；')}`]
            : blockers,
    });
}
function findTarget(collected, postId) {
    if (postId === collected.thread.id) {
        return {
            ...(collected.thread.authorName === undefined ? {} : { author: collected.thread.authorName }),
            text: collected.thread.content,
        };
    }
    for (const entry of collected.floors) {
        if (entry.floor.postId === postId) {
            return {
                ...(entry.floor.authorName === undefined ? {} : { author: entry.floor.authorName }),
                text: entry.floor.content,
            };
        }
        const nested = entry.nested.find((reply) => reply.postId === postId);
        if (nested !== undefined) {
            return {
                ...(nested.authorName === undefined ? {} : { author: nested.authorName }),
                text: nested.content,
            };
        }
    }
    return undefined;
}
function personaNameOf(style) {
    const known = Object.keys(PERSONAS).find((id) => id === style);
    return known === undefined ? style : PERSONAS[known].name;
}
/**
 * 编辑正文并重新评估。
 *
 * ## 为什么必须重新评估
 *
 * 评估记录绑定的是「这一版正文 + 这个目标」。改了正文却留着旧记录，
 * 就等于让复制环节声称「这段文字通过了评估」——通过的是另一段文字。
 *
 * `runtime.ts` 的 `editCandidate` 已经因为同样的理由在 v0.2.26 补上了重评估；
 * 这里做同一件事，理由相同。差别只有一处：主人身份只有昵称。
 */
export async function editImportedCandidate(store, input) {
    const trimmed = input.text.trim();
    if (trimmed === '') {
        return failed('edit', '正文不能是空的。', ['如果不想用这条，重新生成一次']);
    }
    const session = store.getSession(input.sessionId);
    if (session === undefined)
        return failed('edit', `找不到会话 ${input.sessionId}`, ['刷新页面后重试']);
    if (session.imported === undefined)
        return failed('edit', '这条会话不是人工导入的。', []);
    const candidate = session.candidates.find((entry) => entry.replyId === input.candidateId);
    if (candidate === undefined) {
        return failed('edit', `这条会话里没有候选 ${input.candidateId}`, ['重新生成一次']);
    }
    const collected = collectedFromStored(session.imported);
    const targetId = candidate.targetSnapshot?.targetPostId ?? candidate.targetPostId;
    const guarded = guardOutput({
        reply: trimmed,
        targetPostId: targetId,
        expectedTargetPostId: targetId,
        owner: { platform: MANUAL_PLATFORM, displayName: session.ownerName ?? session.imported.root.author },
        ...(session.opponentName === undefined ? {} : { opponentName: session.opponentName }),
        posts: collectedPostsOf(collected),
        conversationText: conversationTextsOf(collected),
        strictness: input.config.securityStrictness === 'strict' || input.config.securityStrictness === 'relaxed'
            ? input.config.securityStrictness
            : 'standard',
        semanticSettled: candidate.security?.semanticSettled,
    });
    const version = nextVersion(session);
    const hash = contentHash(trimmed);
    await store.mutate((data) => ({
        ...data,
        sessions: data.sessions.map((entry) => entry.id === session.id
            ? {
                ...entry,
                candidates: entry.candidates.map((row) => row.replyId === input.candidateId
                    ? {
                        ...row,
                        text: trimmed,
                        textHash: hash,
                        candidateVersion: version,
                        approved: false,
                        security: toStorageRecord(guarded.assessment, guarded.fingerprint),
                    }
                    : row),
                updatedAt: new Date().toISOString(),
            }
            : entry),
    }));
    return succeeded('edit', { candidateVersion: version, textHash: hash });
}
/**
 * 人工确认。
 *
 * ## 这里的「确认」确认的是什么
 *
 * 不是「可以发表」——离线流程不发表。它确认的是：**这段正文就是我读过的、
 * 我要复制的那一段**。绑定的是正文的哈希与候选版本，与真实流程的批准记录同一语义。
 *
 * 记录写在会话的候选上，不新建批准台账：批准台账的用途是「一次授权一次发表」，
 * 而离线流程没有发表，往那里写会让台账声称一次并不存在的授权。
 */
export async function approveImportedCandidate(store, input) {
    const session = store.getSession(input.sessionId);
    if (session === undefined)
        return failed('approve', `找不到会话 ${input.sessionId}`, ['刷新页面后重试']);
    if (session.imported === undefined)
        return failed('approve', '这条会话不是人工导入的。', []);
    const candidate = session.candidates.find((entry) => entry.replyId === input.candidateId);
    if (candidate === undefined) {
        return failed('approve', `这条会话里没有候选 ${input.candidateId}`, ['重新生成一次']);
    }
    if (candidate.text !== input.approvedText) {
        return failed('approve', '你确认的正文与保存的不一致（可能刚被编辑过）。请刷新页面，确认后再点一次。', ['刷新页面', '重新读一遍正文']);
    }
    if (candidate.security?.decision === 'block') {
        return failed('approve', `安全评估判定为「阻止」，这段正文不能确认：${candidate.security.reasons.join('；')}`, ['换一种说法重新生成']);
    }
    const approvedAt = new Date().toISOString();
    await store.mutate((data) => ({
        ...data,
        sessions: data.sessions.map((entry) => entry.id === session.id
            ? {
                ...entry,
                candidates: entry.candidates.map((row) => row.replyId === input.candidateId ? { ...row, approved: true } : row),
                updatedAt: approvedAt,
            }
            : entry),
    }));
    return succeeded('approve', { approvedAt });
}
/** 页面上要显示的能力表（人工导入固定那一份）。 */
export function manualCapabilityRows() {
    return MANUAL_CAPABILITIES;
}
/** 页面上要显示的来源标识（人工导入固定那一份）。 */
export function manualSource() {
    return MANUAL_IMPORT;
}
/**
 * 会话当前处在哪一步。
 *
 * 从存下来的事实推导，不存一个 `step` 字段：存字段意味着它可以和候选、批准、
 * 编辑记录三者不一致，而页面会把那个陈旧的 step 当成事实渲染。
 * 这与 `workbench.ts` 的 `deriveWorkbenchState` 是同一条理由。
 */
export function stepOf(session) {
    if (session === undefined)
        return 'import';
    if (session.imported === undefined)
        return 'import';
    if (session.candidates.length === 0)
        return 'generate';
    const latest = session.candidates[session.candidates.length - 1];
    if (latest.security === undefined)
        return 'assess';
    if (latest.security.decision === 'block')
        return 'edit';
    if (!latest.approved)
        return 'approve';
    return 'copy';
}
/** 十一步的固定顺序，页面按它画进度。 */
export const MANUAL_STEP_ORDER = [
    'import',
    'preview',
    'confirm',
    'analyze',
    'select',
    'persona',
    'generate',
    'edit',
    'assess',
    'approve',
    'copy',
];
/** 十一步里，前六步在会话存在之前就完成了；提供它们的完成标记。 */
export function completedSteps(session) {
    if (session === undefined)
        return [];
    const step = stepOf(session);
    const at = MANUAL_STEP_ORDER.indexOf(step);
    return MANUAL_STEP_ORDER.slice(0, at);
}
//# sourceMappingURL=workflow.js.map