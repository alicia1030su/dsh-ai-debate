/**
 * Target resolution: decide *where* a reply lands, from data re-read from the
 * platform, and refuse to send when that cannot be established.
 *
 * Why this is its own module rather than a few lines in the publisher: the bug
 * this prevents is subtle. The publisher used to build a target containing only
 * `floorPostId` and `replyToUserId`, while the adapter only enters its
 * floor-reply branch when `nestedReplyId` is present. For a reply aimed at a
 * nested post, the floor id was therefore the *floor's* id and the nested id was
 * missing — a well-formed request that lands in the wrong place, with no error
 * anywhere to notice it.
 *
 * The rule here is: the target is derived from a fresh `getReplyContext` read,
 * never assembled from ids that came out of the model.
 */
import { createHash } from 'node:crypto';
import { PlatformError } from './types.js';
/** Hash of a post body, to notice an edit between review and send. */
export function contentHash(text) {
    return createHash('sha256').update(text.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex').slice(0, 32);
}
/**
 * Re-read one post and describe where a reply to it must go.
 *
 * Every check below fails closed. A rejected target is always cheaper than a
 * reply attached to the wrong person, which the owner cannot take back.
 *
 * @param resolver the platform adapter
 * @param expected what the analysis said the target is
 * @param options.signal cancellation
 * @param options.forceFresh bypass the adapter's structure cache (publishing does)
 * @returns either a verified snapshot plus the wire-level target, or the reason
 */
export async function resolveTarget(resolver, expected, options = {}) {
    const now = options.now ?? (() => Date.now());
    // The platform comes from the caller, then from the expectation, then from the
    // adapter's own id. Never defaulted to a concrete platform name.
    const adapterId = resolver.id;
    const platform = options.platform ??
        expected.platform ??
        (typeof adapterId === 'string' ? adapterId : undefined) ??
        'unknown';
    let context;
    try {
        context = await resolver.getReplyContext({ platform, threadId: expected.threadId }, expected.targetPostId, options.signal, 
        // Default true: this function exists to answer "what is there *now*", so a
        // cached body would be the wrong answer by construction.
        { forceFresh: options.forceFresh ?? true });
    }
    catch (error) {
        if (error instanceof PlatformError && (error.code === 'not_found' || error.code === 'permission_denied')) {
            return {
                ok: false,
                problem: 'not_found',
                message: `目标回复 ${expected.targetPostId} 已经读不到了（可能已被删除或设为不可见）。` +
                    '为避免把回复发到错误的位置，本次发表已停止。',
            };
        }
        return {
            ok: false,
            problem: 'not_found',
            message: `无法重新读取目标回复 ${expected.targetPostId}：${error.message}`,
        };
    }
    // The post must still belong to the thread we think it does.
    if (context.thread.id !== expected.threadId) {
        return {
            ok: false,
            problem: 'wrong_thread',
            message: `目标回复属于帖子 ${context.thread.id}，与当前会话的帖子 ${expected.threadId} 不一致`,
        };
    }
    // ...and to the floor the dispute is under.
    if (context.floor.postId !== expected.floorPostId) {
        return {
            ok: false,
            problem: 'wrong_floor',
            message: `目标回复现在挂在第 ${context.floor.floorNumber} 楼（${context.floor.postId}）下，` +
                `与分析的楼层 ${expected.floorPostId} 不一致，回复位置可能已变化`,
        };
    }
    const isNested = context.nested !== undefined;
    const actualKind = isNested ? 'nested' : 'floor';
    if (actualKind !== expected.targetKind) {
        return {
            ok: false,
            problem: 'kind_mismatch',
            message: `目标是${expected.targetKind === 'nested' ? '楼中楼回复' : '楼层'}，` +
                `但重新读取时它是${isNested ? '楼中楼回复' : '楼层'}，回复位置可能已变化`,
        };
    }
    if (isNested && context.nested.postId !== expected.targetPostId) {
        return {
            ok: false,
            problem: 'nested_mismatch',
            message: `楼中楼 id 不一致：期望 ${expected.targetPostId}，读到 ${context.nested.postId}`,
        };
    }
    // The author must be the person the analysis decided to answer.
    //
    // Stricter than before in the direction that matters: when an author id was
    // recorded and the fresh read no longer exposes one, that is *unknown*, not
    // *unchanged*. Treating a vanished id as a match is how a reply gets aimed at
    // whoever occupies the post now.
    const actualAuthorId = isNested ? context.nested.authorId : context.floor.authorId;
    const actualAuthorName = isNested ? context.nested.authorName : context.floor.authorName;
    if (expected.targetAuthorId) {
        if (!actualAuthorId) {
            return {
                ok: false,
                problem: 'author_unverifiable',
                message: `分析时记录了目标作者 ${expected.targetAuthorId}，但重新读取时这条回复没有暴露作者 ID，` +
                    '无法确认它仍是写给同一个人。为避免发错对象，本次发表已停止。',
            };
        }
        if (expected.targetAuthorId !== actualAuthorId) {
            return {
                ok: false,
                problem: 'author_mismatch',
                message: `目标回复的作者是 ${actualAuthorId}，与分析时的争论对象 ${expected.targetAuthorId} 不一致。` +
                    '争论对象可能已经变化，需要重新分析后再发表。',
            };
        }
    }
    const content = isNested ? context.nested.content : context.floor.content;
    const snapshot = {
        platform,
        threadId: expected.threadId,
        floorPostId: context.floor.postId,
        floorNumber: context.floor.floorNumber,
        ...(isNested ? { nestedReplyId: context.nested.postId } : {}),
        targetPostId: expected.targetPostId,
        targetKind: actualKind,
        ...(actualAuthorId ? { targetAuthorId: actualAuthorId } : {}),
        ...(actualAuthorName ? { targetAuthorName: actualAuthorName } : {}),
        contentHash: contentHash(content),
        capturedAt: new Date(now()).toISOString(),
    };
    return { ok: true, snapshot, target: targetFromSnapshot(snapshot) };
}
/**
 * Turn a verified snapshot into the request the adapter sends.
 *
 * For a nested target both ids are required: `reply_id` is the floor and
 * `comment_id` is the nested post. Sending the floor id alone is what silently
 * turned an in-floor reply into a new floor.
 */
export function targetFromSnapshot(snapshot) {
    const base = {
        platform: snapshot.platform,
        threadId: snapshot.threadId,
        floorPostId: snapshot.floorPostId,
        targetPostId: snapshot.targetPostId,
        targetKind: snapshot.targetKind,
        ...(snapshot.targetAuthorId ? { targetAuthorId: snapshot.targetAuthorId } : {}),
        ...(snapshot.targetAuthorId ? { replyToUserId: snapshot.targetAuthorId } : {}),
    };
    if (snapshot.targetKind === 'nested') {
        if (!snapshot.nestedReplyId) {
            // Unreachable for a snapshot this module produced, but a target with
            // kind=nested and no nested id would post to the floor instead.
            throw new Error('内部错误：目标是楼中楼，但快照里没有 nestedReplyId');
        }
        return { ...base, nestedReplyId: snapshot.nestedReplyId };
    }
    return base;
}
/**
 * Decide whether a snapshot taken before review still describes reality.
 *
 * Called immediately before sending. A snapshot that no longer matches means the
 * reviewed text and the current target describe different situations, so the
 * reply must go back for review rather than be sent at whatever is there now.
 */
export function snapshotStillValid(before, after) {
    if (before.threadId !== after.threadId)
        return 'wrong_thread';
    if (before.floorPostId !== after.floorPostId)
        return 'wrong_floor';
    if (before.targetPostId !== after.targetPostId)
        return 'nested_mismatch';
    if (before.targetKind !== after.targetKind)
        return 'kind_mismatch';
    if (before.nestedReplyId !== after.nestedReplyId)
        return 'nested_mismatch';
    // Author identity, in strict preference order.
    //
    // A recorded id that the fresh read cannot confirm is *unknown*, not equal. And
    // when no id was ever available, the name is the only signal left — it is weaker
    // (a display name can be changed at will), so it is compared and, when it is the
    // only thing available, a match is still not treated as proof of identity.
    if (before.targetAuthorId) {
        if (!after.targetAuthorId)
            return 'author_unverifiable';
        if (before.targetAuthorId !== after.targetAuthorId)
            return 'author_mismatch';
    }
    else if (before.targetAuthorName || after.targetAuthorName) {
        if (!after.targetAuthorName)
            return 'author_unverifiable';
        if (before.targetAuthorName !== after.targetAuthorName)
            return 'author_mismatch';
    }
    if (before.contentHash !== after.contentHash)
        return 'context_changed';
    return undefined;
}
/**
 * Whether the snapshot identifies the author by a stable id.
 *
 * A snapshot carrying only a display name cannot prove *who* wrote the post, and the
 * publish path requires proof, so this is what the publisher consults to decide
 * whether automatic publishing is allowed at all.
 */
export function hasStableAuthor(snapshot) {
    return typeof snapshot.targetAuthorId === 'string' && snapshot.targetAuthorId.length > 0;
}
/** Human-readable explanation for each problem. */
export function describeTargetProblem(problem) {
    switch (problem) {
        case 'not_found':
            return '目标回复已经读不到了';
        case 'wrong_thread':
            return '目标不在原来的帖子里';
        case 'wrong_floor':
            return '目标所在楼层变了';
        case 'author_mismatch':
            return '目标作者与分析结果不一致';
        case 'author_unverifiable':
            return '目标作者无法确认（重新读取时没有暴露作者 ID）';
        case 'kind_mismatch':
            return '目标是楼层还是楼中楼发生了变化';
        case 'nested_mismatch':
            return '楼中楼 id 对不上';
        case 'context_changed':
            return '目标内容在审核期间被修改过';
        case 'no_snapshot':
            return '这个候选没有目标快照，需要重新生成并审核';
        case 'version_mismatch':
            return '候选版本已过期，审核授权不再适用于当前候选';
    }
}
//# sourceMappingURL=target.js.map