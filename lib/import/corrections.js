/**
 * 交互式关系纠错：用户的修正作为**一层独立数据**，不覆盖解析结果（v0.2.31 §四）。
 *
 * ## 为什么修正是独立的一层，而不是「解析器多几个开关」
 *
 * 一份导入的讨论有三层事实，三层的可信度完全不同：
 *
 * | 层 | 内容 | 谁说的 |
 * | --- | --- | --- |
 * | 原始事实 | 用户粘进来的原文，逐行保留 | 用户（他看到了什么） |
 * | 解析结果 | 谁是作者、谁在回谁、第几楼 | 插件（猜的） |
 * | 用户修正 | 「这一条其实是他说的」「这条不是回他」 | 用户（他知道实际情况） |
 *
 * 如果修正直接改写解析结果，三层就塌成一层：用户再也无法回答「插件到底看懂了多少」
 * 和「我改过哪些」，而这两个问题在出错时是唯一有用的线索。
 *
 * 所以本模块只做一件事：**给定解析结果 + 修正清单，算出修正后的视图**。
 * 原始解析结果始终留在 `StoredImport` 里，随时可以重新算出「没改之前是什么样」。
 *
 * ## 一条硬规则：修正可以改「关系是什么」，不能改「谁说的」
 *
 * 用户指定「这条在回 local:2」，这个**指向**是明确的（不是从昵称猜的），所以它在
 * 界面上是 `stated` / 「确定」。但这不等于「平台证明过」——平台从未参与，这份
 * 内容来自剪贴板，修正清单还是一段可编辑的本地 JSON。
 *
 * 所以真正的分界线不在 `certainty`，在**依据**：
 *
 * - `certainty` 回答「这条关系是怎么定下来的」：明确的 id，还是按昵称推的。
 * - `basis` 回答「**谁**说它是这样」：平台返回的、你手工指定的、还是解析器认的。
 *
 * 两者混为一谈会出具体事故：`replies_to` 边带着「平台返回了被回复的 post id」
 * 进入图、转录和模型上下文，而它其实来自用户的一次点击。v0.2.31 之前正是如此
 * （硬编码在 `conversation-bridge.ts` 里），现在依据随边一起传下去。
 *
 * 反向的升级永远不做：昵称猜出来的关系不能变成 `stated`，`unconfirmed` 压过一切。
 * 那一条看 `manual.ts` 的 `resolutionOf` 与 `toCollectedThread`。
 */
import { MANUAL_ROOT_BASIS } from './manual.js';
const EMPTY = [];
/**
 * 应用修正。
 *
 * ## 确定性
 *
 * 同样的 `(discussion, corrections)` 必须得到同样的结果，且不能依赖对象顺序。
 * 这一点有实际后果：会话落盘时只存原始解析结果 + 修正清单，每次读取重新应用。
 * 如果应用过程不确定，刷新前后的图会不一样，而目标校验会因此全部失败
 * （它比对的是正文哈希与作者）。
 */
export function applyCorrections(discussion, corrections) {
    if (corrections === undefined || corrections.entries.length === 0) {
        if (corrections?.rootFromCommentId === undefined && corrections?.demoteRoot !== true) {
            return { discussion, audit: EMPTY, issues: [], changed: false };
        }
    }
    const issues = [];
    const audit = [];
    const entries = corrections?.entries ?? [];
    // 修正按 id 索引。同一个 id 出现两次时后者覆盖前者，但要说出来——
    // 静默取最后一条会让「我改了两处，只生效一处」变得无法解释。
    const byId = new Map();
    for (const entry of entries) {
        if (byId.has(entry.id)) {
            issues.push({
                severity: 'warning',
                code: 'correction_duplicate',
                message: `对「${entry.id}」有不止一条修正，只采用最后一条。`,
            });
        }
        byId.set(entry.id, entry);
    }
    // ── 1. 原帖的升降 ────────────────────────────────────────────────────────
    let root = discussion.root;
    let comments = [...discussion.comments];
    let rootRaw = discussion.rootRaw;
    let rootFloor = discussion.rootFloor;
    const promoteId = corrections?.rootFromCommentId;
    if (promoteId !== undefined) {
        const index = comments.findIndex((comment) => comment.id === promoteId);
        if (index === -1) {
            issues.push({
                severity: 'error',
                code: 'correction_root_missing',
                message: `你指定「${promoteId}」作为原帖，但这次导入里没有这条发言。` +
                    '请刷新预览后重新选择。',
            });
        }
        else {
            const promoted = comments[index];
            const oldRootAsComment = {
                id: 'local:root',
                author: root.author,
                ...(root.authorId === undefined ? {} : { authorId: root.authorId }),
                text: root.text,
                ...(root.createdAt === undefined ? {} : { createdAt: root.createdAt }),
                ...(rootRaw === undefined ? {} : { raw: rootRaw }),
                ...(rootFloor === undefined ? {} : { floor: rootFloor }),
            };
            audit.push({
                id: promoteId,
                field: 'root',
                before: root.author,
                after: promoted.author,
                note: `把「${promoted.author}」那条提升为原帖，原来的原帖「${root.author}」改为一条评论。`,
            });
            comments = comments.filter((comment) => comment.id !== promoteId);
            if (promoteId !== 'local:root')
                comments = [oldRootAsComment, ...comments];
            root = {
                author: promoted.author,
                text: promoted.text,
                ...(promoted.createdAt === undefined ? {} : { createdAt: promoted.createdAt }),
            };
            rootRaw = promoted.raw;
            rootFloor = promoted.floor;
        }
    }
    else if (corrections?.demoteRoot === true) {
        // 只降不升：原帖变成评论，新的原帖只能由用户再指定，否则没有原帖可用。
        issues.push({
            severity: 'info',
            code: 'correction_root_demoted_only',
            message: '你把原帖标记成了普通评论，但没有指定新的原帖。' +
                '导入仍会把原来那条当原帖——一份讨论必须有一个原帖，否则分析器没有可回复的对象。',
        });
    }
    // ── 2. 逐条修正 ──────────────────────────────────────────────────────────
    const ids = new Set(comments.map((comment) => comment.id));
    if (promoteId !== undefined && !ids.has(promoteId) && promoteId !== 'local:root') {
        // 已被提升为原帖，不在 comments 里了。它的修正按 id 找不到，必须说明。
        if (byId.has(promoteId)) {
            issues.push({
                severity: 'warning',
                code: 'correction_on_root',
                message: `「${promoteId}」已经是被提升的原帖，对它那几条修正没有应用——` +
                    '原帖只保留作者与正文，没有回复目标可以改。',
            });
        }
    }
    for (const entry of byId.values()) {
        if (!ids.has(entry.id) && entry.id !== 'local:root') {
            issues.push({
                severity: 'error',
                code: 'correction_unknown_id',
                message: `修正指向「${entry.id}」，但这次导入里没有这条发言（共 ${comments.length} 条）。` +
                    '可能是内容改了之后又用上了旧修正——请刷新预览。',
            });
        }
    }
    const corrected = comments.map((comment) => {
        const entry = byId.get(comment.id);
        if (entry === undefined)
            return comment;
        let next = comment;
        // 作者名 / 本地身份
        const authorBefore = comment.author;
        if (entry.localIdentity !== undefined && entry.localIdentity.trim() !== '') {
            const label = entry.localIdentity.trim();
            const renamed = `${authorBefore}（${label}）`;
            next = { ...next, author: renamed };
            audit.push({
                id: comment.id,
                field: 'identity',
                before: authorBefore,
                after: renamed,
                note: `你把这条标为「${label}」，与另一个同名的人分开。分析会按两个参与者处理。`,
            });
        }
        else if (entry.author !== undefined && entry.author.trim() !== '') {
            const renamed = entry.author.trim();
            if (renamed !== authorBefore) {
                next = { ...next, author: renamed };
                audit.push({
                    id: comment.id,
                    field: 'author',
                    before: authorBefore,
                    after: renamed,
                    note: `作者名从「${authorBefore}」改成「${renamed}」。原文另存，没有被改写。`,
                });
            }
        }
        // 回复目标
        if (entry.replyTo !== undefined) {
            const wanted = entry.replyTo;
            const before = comment.replyTo ?? '（没有回复对象）';
            if (wanted === 'none') {
                if (comment.replyTo !== undefined) {
                    next = stripReply(next);
                    audit.push({
                        id: comment.id,
                        field: 'replyTo',
                        before,
                        after: '（已解除）',
                        note: '解除了这条的回复关系，它会单独成层。',
                    });
                }
            }
            else if (wanted === 'root') {
                next = {
                    ...stripReply(next),
                    replyTo: rootAuthorMarker(root),
                    replyToKind: 'name',
                    replyBasis: MANUAL_ROOT_BASIS,
                };
                audit.push({
                    id: comment.id,
                    field: 'replyTo',
                    before,
                    after: `原帖（${root.author}）`,
                    note: '你指定这条在回复原帖。',
                });
            }
            else if (wanted === comment.id) {
                issues.push({
                    severity: 'error',
                    code: 'correction_self_reply',
                    message: `「${comment.id}」不能回复它自己。这条修正没有应用。`,
                });
            }
            else if (!ids.has(wanted)) {
                issues.push({
                    severity: 'error',
                    code: 'correction_reply_missing',
                    message: `你把「${comment.id}」的回复目标改成「${wanted}」，但这次导入里没有这条发言。` +
                        '这条修正没有应用，原来的关系保持不变。',
                });
            }
            else {
                next = {
                    ...next,
                    replyTo: wanted,
                    replyToKind: 'id',
                    replyBasis: '你手工指定了被回复的那一条',
                };
                audit.push({
                    id: comment.id,
                    field: 'replyTo',
                    before,
                    after: wanted,
                    note: '你手工指定了回复目标。按 id 指定比按昵称可靠，但它仍然是你说的，不是平台证明的。',
                });
            }
        }
        // 「确认不了」
        if (entry.unconfirmed === true) {
            next = { ...next, replyUnconfirmed: true };
            audit.push({
                id: comment.id,
                field: 'unconfirmed',
                after: '无法确认',
                note: '你标记这条关系无法确认，它会带着这个标记进入分析（不当成事实使用）。',
            });
        }
        return next;
    });
    const changed = audit.length > 0 ||
        corrected.some((comment, index) => comment !== comments[index]);
    const nextDiscussion = {
        ...discussion,
        root,
        ...(rootRaw === undefined ? {} : { rootRaw }),
        ...(rootFloor === undefined ? {} : { rootFloor }),
        comments: corrected,
        ...(corrections === undefined ? {} : { corrections }),
    };
    return { discussion: nextDiscussion, audit, issues, changed };
}
/** 去掉回复相关字段。 */
function stripReply(comment) {
    const { replyTo: _replyTo, replyToKind: _kind, replyBasis: _basis, ...rest } = comment;
    return rest;
}
/**
 * 「在回原帖」用什么表示。
 *
 * 复用 `replyToKind: 'name'` + 原帖作者名的组合，而不是发明一个新字段：
 * 解析层已经能处理「按昵称找原帖作者」这条路径（`rootAuthorMatches`），
 * 再造一个 `kind: 'root'` 会让那条路径出现第二个分支，而两个分支迟早会不一致。
 */
function rootAuthorMarker(root) {
    return root.author;
}
/** 空修正清单。界面首次渲染时用它，避免到处判 `undefined`。 */
export function emptyCorrections(now) {
    return { version: 1, revisedAt: now, entries: [] };
}
/**
 * 修正清单里是否有内容。
 *
 * 落盘前用它决定要不要写这个字段：空清单写进去只是噪音，而且会让
 * 「这份导入被人改过」这句话在界面上无端出现。
 */
export function hasCorrections(corrections) {
    if (corrections === undefined)
        return false;
    return (corrections.entries.length > 0 ||
        corrections.rootFromCommentId !== undefined ||
        corrections.demoteRoot === true);
}
/**
 * 校验一份来路不明的修正清单（HTTP 入参会带一份）。
 *
 * ## 为什么在边界上校验，而不是相信调用方
 *
 * 修正清单会被写进会话文件，也会从页面的 POST 体里读回来。两者都可能被手改
 * ——本项目的惯例是：只要一个字段能影响分析结论，就在读入时校验它。
 * 这里不追求「修复」非法输入，只保证它不会变成一堆奇怪的字段进到下游。
 */
export function sanitizeCorrections(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    if (record.version !== 1)
        return undefined;
    const entriesRaw = Array.isArray(record.entries) ? record.entries : [];
    const entries = [];
    for (const item of entriesRaw.slice(0, 2000)) {
        if (typeof item !== 'object' || item === null)
            continue;
        const entry = item;
        if (typeof entry.id !== 'string' || entry.id === '')
            continue;
        const correction = {
            id: entry.id.slice(0, 200),
            ...(typeof entry.author === 'string' && entry.author.trim() !== ''
                ? { author: entry.author.slice(0, 80) }
                : {}),
            ...(typeof entry.localIdentity === 'string' && entry.localIdentity.trim() !== ''
                ? { localIdentity: entry.localIdentity.slice(0, 40) }
                : {}),
            ...(typeof entry.replyTo === 'string' && entry.replyTo !== ''
                ? { replyTo: entry.replyTo.slice(0, 200) }
                : {}),
            ...(entry.unconfirmed === true ? { unconfirmed: true } : {}),
        };
        // 一条什么都没改的修正不写进去：它会让审计里出现一行「没变化」，
        // 而那一行除了让人怀疑自己点错了以外没有别的用途。
        if (correction.author === undefined &&
            correction.localIdentity === undefined &&
            correction.replyTo === undefined &&
            correction.unconfirmed !== true) {
            continue;
        }
        entries.push(correction);
    }
    return {
        version: 1,
        revisedAt: typeof record.revisedAt === 'string' ? record.revisedAt : new Date(0).toISOString(),
        entries,
        ...(typeof record.rootFromCommentId === 'string' && record.rootFromCommentId !== ''
            ? { rootFromCommentId: record.rootFromCommentId.slice(0, 200) }
            : {}),
        ...(record.demoteRoot === true ? { demoteRoot: true } : {}),
    };
}
//# sourceMappingURL=corrections.js.map