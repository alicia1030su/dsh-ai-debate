/**
 * The one-off verification runner: the part of `verification.ts` that touches the world.
 *
 * ## Why this file is separate from `verification.ts`
 *
 * `verification.ts` holds the **rules** (may this run start? did the read-back prove it?) and is
 * pure. This file holds the **order of operations**: read the live identity, write a `pending`
 * record, call the platform, read the reply back, write the outcome. Keeping them apart is what
 * lets the rules be tested against combinations that are expensive or impossible to produce for
 * real, while the order stays in exactly one place.
 *
 * ## The order is the safety property
 *
 * Every step below exists because of a specific way this could go wrong:
 *
 * 1. **Refuse before the network.** All authorization checks run first, so a refusal costs
 *    nothing and cannot half-publish.
 * 2. **Re-read the live identity.** The authorization names an account; a session logged in as
 *    somebody else must not publish as them. Checked *here*, not at authorization time, because
 *    the session can change between the two.
 * 3. **Write `pending` before the call.** If the process dies mid-publish the reply may already
 *    be on the platform. A record saying "attempted, outcome unknown" is the only honest state,
 *    and it is what stops an automatic retry from double-posting.
 * 4. **Never retry.** 403, 429, a captcha, a timeout — all leave the capability `unverified`,
 *    because "the platform refused" does not mean "publishing does not work".
 * 5. **Read back and demand all four facts.** A returned post id proves something was written
 *    somewhere; the author, the text and the parent are what prove it was *this* reply.
 * 6. **Decide the upgrade from the persisted record.** Not from the in-memory result, so a crash
 *    between the two loses the upgrade rather than inventing one.
 *
 * ## What it deliberately does not do
 *
 * - It does not publish without an authorization. There is no "verify against whatever is
 *   configured" path.
 * - It does not write capability declarations. Evidence is recorded, and
 *   `capability-evidence.ts` joins it with the static ceiling; nothing here flips a declaration.
 * - It does not loop. One authorization, one publish, ever.
 */
import { authorizationKey, checkVerification, decideCapabilityUpgrade, } from './verification.js';
/**
 * Turn the authorization into the platform's own vocabulary.
 *
 * Kept separate so the runner has no opinion about URL shapes: the caller passes the ids the
 * owner authorized. `PublishTarget` is built here from **the authorization**, never from a
 * model-supplied id — that is the rule `types.ts` documents for the normal publish path, and it
 * matters just as much for a verification publish.
 */
export function targetFor(authorization) {
    const ref = {
        platform: authorization.platform,
        threadId: authorization.authorizedThreadId,
        url: `https://tieba.baidu.com/p/${authorization.authorizedThreadId}`,
        ...(authorization.capability === 'comment.reply' && authorization.replyToPostId
            ? { postId: authorization.replyToPostId }
            : {}),
    };
    if (authorization.capability === 'comment.reply') {
        return {
            ref,
            target: {
                platform: ref.platform,
                threadId: ref.threadId,
                floorPostId: authorization.authorizedFloorId,
                nestedReplyId: authorization.replyToPostId,
                targetPostId: authorization.replyToPostId,
                targetKind: 'nested',
            },
        };
    }
    return {
        ref,
        target: {
            platform: ref.platform,
            threadId: ref.threadId,
            targetKind: 'floor',
        },
    };
}
/**
 * Run one verification attempt.
 *
 * Returns rather than throws for every expected refusal: a caller that has to distinguish
 * "refused" from "crashed" ends up treating both as failure, and the owner loses the reason.
 */
export async function runVerification(authorization, deps) {
    const existing = deps.records.all();
    const usedKeys = new Set(existing.map((record) => record.key));
    const liveAccountId = await deps.liveAccountId();
    const decision = checkVerification({
        authorization,
        capabilityState: deps.capabilityState(),
        liveAccountId,
        usedKeys,
    });
    if (!decision.ok) {
        return { ok: false, refusal: decision.refusal, message: decision.message, upgraded: false };
    }
    const key = authorizationKey(authorization);
    const startedAt = deps.now();
    // ---- 3. pending, before the network ------------------------------------
    //
    // This write is the difference between "we do not know" and "nothing happened". It is
    // deliberately before `publishReply`: a crash after this point leaves a `pending` row, and
    // the next run refuses on `already_used` rather than posting a second reply.
    const pending = {
        key,
        platform: authorization.platform,
        capability: authorization.capability,
        authorizedAccountId: authorization.authorizedAccountId,
        authorizedThreadId: authorization.authorizedThreadId,
        authorizedBy: authorization.authorizedBy,
        approvedText: authorization.approvedText,
        startedAt,
        ...(deps.adapterVersion !== undefined ? { adapterVersion: deps.adapterVersion } : {}),
        outcome: 'pending',
    };
    await deps.records.put(pending);
    const { ref, target } = targetFor(authorization);
    // ---- 4. exactly one call, no retry -------------------------------------
    let outcome;
    try {
        outcome = await deps.adapter.publishReply(ref, target, authorization.approvedText, deps.signal);
    }
    catch (error) {
        // Timeout, captcha, 403, 429, network drop. All of them mean "unknown", and none of them is
        // retried: the reply may already be on the platform.
        const reason = error instanceof Error ? error.message : String(error);
        const uncertain = {
            ...pending,
            outcome: 'uncertain',
            failure: `发表请求没有拿到确定结果（${reason}）。不重试：这条回复可能已经发出去了`,
        };
        await deps.records.put(uncertain);
        return { ok: false, message: uncertain.failure ?? reason, record: uncertain, upgraded: false };
    }
    if (outcome.status === 'failed') {
        const failed = {
            ...pending,
            outcome: 'failed',
            failure: `平台没有接受这次发表：${outcome.errorCode ?? '未知原因'}` +
                (outcome.error ? `（${outcome.error}）` : ''),
        };
        await deps.records.put(failed);
        return { ok: false, message: failed.failure ?? '发表失败', record: failed, upgraded: false };
    }
    if (outcome.postId === undefined || outcome.postId.trim() === '') {
        const uncertain = {
            ...pending,
            outcome: 'uncertain',
            failure: '平台没有返回 post id，无法回读确认；这条回复可能已经发出去了',
        };
        await deps.records.put(uncertain);
        return {
            ok: false,
            message: uncertain.failure ?? '平台没有返回 post id',
            record: uncertain,
            upgraded: false,
        };
    }
    // ---- 5. read back, and demand all four facts ---------------------------
    const readBack = await readBackVerification(deps.adapter, ref, outcome.postId, authorization, deps.signal);
    const succeeded = {
        ...pending,
        outcome: 'succeeded',
        publishedPostId: outcome.postId,
        readBack: readBack.facts,
        ...(readBack.facts.notes.length > 0 ? { failure: readBack.facts.notes.join('；') } : {}),
    };
    await deps.records.put(succeeded);
    // ---- 6. the upgrade reads the persisted record -------------------------
    const upgrade = decideCapabilityUpgrade(succeeded);
    return {
        ok: true,
        message: upgrade.upgrade
            ? `已发表并回读确认（post id ${outcome.postId}）`
            : `已发表，但回读证据不完整：${upgrade.reason}`,
        record: succeeded,
        upgraded: upgrade.upgrade,
    };
}
/**
 * Re-read the published reply and map it onto the four facts.
 *
 * Every "cannot check" is `false` plus a note, never an optimistic `true`: the upgrade decision
 * requires all four, so an unreadable field must not be able to look like agreement.
 *
 * Absent author and absent body are the two shapes that matter. Reading an absent body as a
 * *mismatch* claims the reply is wrong when nothing was read; reading it as a *match* claims it
 * is right when nothing was read. Both are lies about the same missing fact, so both become
 * `false` with a note.
 */
export async function readBackVerification(adapter, ref, postId, authorization, signal) {
    const notes = [];
    let context;
    try {
        // `forceFresh`: a cached body would "confirm" the publish with data captured before it.
        context = await adapter.getReplyContext(ref, postId, signal, { forceFresh: true });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            postId,
            facts: {
                postFound: false,
                authorMatched: false,
                textMatched: false,
                parentMatched: false,
                notes: [`无法回读这条回复，验收结论只能是未确认（${reason}）`],
            },
        };
    }
    const postFound = context.thread.id === ref.threadId;
    if (!postFound)
        notes.push(`回复挂在帖子 ${context.thread.id}，而不是 ${ref.threadId}`);
    const body = context.nested ? context.nested.content : context.floor.content;
    const textMatched = typeof body === 'string' ? normalize(body) === normalize(authorization.approvedText) : false;
    if (typeof body !== 'string')
        notes.push('回读到的回复没有正文，无法核对内容');
    const authorId = context.nested ? context.nested.authorId : context.floor.authorId;
    const authorMatched = typeof authorId === 'string' && authorId === authorization.authorizedAccountId;
    if (typeof authorId !== 'string') {
        notes.push('平台没有给出这条回复的作者，无法确认是谁发的');
    }
    else if (!authorMatched) {
        notes.push(`回读到的作者是 ${authorId}，而授权账号是 ${authorization.authorizedAccountId}`);
    }
    let parentMatched;
    if (authorization.capability === 'comment.reply') {
        const nested = context.nested;
        parentMatched =
            nested !== undefined &&
                (authorization.authorizedFloorId === undefined || nested.parentPostId === authorization.authorizedFloorId) &&
                (authorization.replyToPostId === undefined || nested.replyToPostId === authorization.replyToPostId);
        if (!parentMatched)
            notes.push('回读到的回复没有挂在授权的楼层/评论下');
    }
    else {
        parentMatched = context.nested === undefined;
        if (!parentMatched)
            notes.push('回读到的内容不是楼层（期望的是一条新的评论）');
    }
    return { postId, facts: { postFound, authorMatched, textMatched, parentMatched, notes } };
}
/** Normalise for comparison: whitespace and full-width spaces are what the platform rewrites. */
function normalize(text) {
    return text.replace(/[\s\u3000]+/g, ' ').trim();
}
//# sourceMappingURL=verification-runner.js.map