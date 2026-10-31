/**
 * The one-off publish verification flow.
 *
 * ## The problem this solves
 *
 * Tieba's `comment.publish` and `comment.reply` are `unverified`, and the publish
 * gate only accepts `supported`. That is correct — the gate exists so that "code
 * was written" never means "it can post to a stranger's thread". But it also means
 * the capability can never *become* supported: verification requires publishing,
 * and publishing is refused until it is verified.
 *
 * The wrong fix is to flip the state to `supported` so one test can prove itself.
 * That is precisely the lie the capability model was introduced to stop.
 *
 * ## The fix
 *
 * A separate, explicit flow that is **not reachable from the normal publish path**
 * and cannot be turned into a general bypass:
 *
 * - it takes an *authorization record* naming the account, the target thread, and
 *   the person who authorized it — all required, so there is no "verify against
 *   whatever is configured";
 * - it publishes **exactly once** per authorization, tracked durably, so it
 *   cannot be looped into a bulk poster;
 * - it is only usable while the capability is `unverified` — an
 *   already-`supported` capability has nothing to verify, and a `permission_required`
 *   or `unavailable` one must not be probed;
 * - it records the read-back outcome, and the capability only moves to
 *   `supported` when that evidence is complete.
 *
 * ## What it deliberately does not do
 *
 * - It does not touch the ordinary `assertCapability` gate. A thread the owner
 *   wants to argue in still needs a verified capability, and this flow does not
 *   change that for anyone.
 * - It does not retry. A failed verification (403, captcha, rate limit) leaves the
 *   capability `unverified`, because the honest reading of "the platform refused"
 *   is "we still do not know whether publishing works".
 * - It does not accept a capability it cannot verify. Asking to verify
 *   `thread.read` here is a caller error, not something to accommodate.
 */
/** Which capabilities this flow is allowed to verify. */
export const VERIFIABLE_CAPABILITIES = Object.freeze([
    'comment.publish',
    'comment.reply',
]);
/** The key for one authorization, so a second run is detectable. */
export function authorizationKey(auth) {
    // The parent is part of the key for a reply: authorizing "reply to floor 3" must not be
    // silently reusable for "reply to floor 4" in the same thread.
    return [
        auth.platform,
        auth.capability,
        auth.authorizedAccountId,
        auth.authorizedThreadId,
        auth.capability === 'comment.reply' ? (auth.authorizedFloorId ?? '') : '',
        auth.capability === 'comment.reply' ? (auth.replyToPostId ?? '') : '',
    ].join('\u0000');
}
/**
 * Decide whether a verification may start.
 *
 * All the checks run before the caller touches the network, so a refusal costs
 * nothing and cannot half-publish.
 *
 * @param input.authorization what the owner approved
 * @param input.capabilityState the platform's current declaration
 * @param input.liveAccountId the account the live session belongs to, if known
 * @param input.usedKeys keys of attempts already recorded
 */
export function checkVerification(input) {
    const { authorization, capabilityState, liveAccountId, usedKeys } = input;
    if (!VERIFIABLE_CAPABILITIES.includes(authorization.capability)) {
        return {
            ok: false,
            refusal: 'not_verifiable',
            message: `${authorization.capability} 不能通过一次性验收流程验证；这个流程只用于「发表」与「回复」`,
        };
    }
    // Only `unverified` is worth testing. `supported` has evidence already,
    // `permission_required` would test the wrong thing, and `unavailable` is a
    // statement about the platform, not about this account.
    if (capabilityState !== 'unverified') {
        return {
            ok: false,
            refusal: 'wrong_state',
            message: capabilityState === 'supported'
                ? '该能力已经是 supported，无需再验收'
                : `该能力当前是 ${capabilityState}，不是 unverified；这次验收证明不了任何东西`,
        };
    }
    const missing = [];
    if (authorization.authorizedAccountId.trim() === '')
        missing.push('授权账号');
    if (authorization.authorizedThreadId.trim() === '')
        missing.push('授权帖子');
    if (authorization.authorizedBy.trim() === '')
        missing.push('授权人');
    if (authorization.approvedText.trim() === '')
        missing.push('已批准的正文');
    // A reply needs a specific parent. Without one the read-back can only confirm "a reply
    // exists", which is exactly the weaker claim this flow must not accept.
    if (authorization.capability === 'comment.reply') {
        if ((authorization.authorizedFloorId ?? '').trim() === '')
            missing.push('要回复的楼层 id');
        if ((authorization.replyToPostId ?? '').trim() === '')
            missing.push('要回复的那条评论 id');
    }
    if (missing.length > 0) {
        return {
            ok: false,
            refusal: 'incomplete_authorization',
            message: `验收缺少授权信息：${missing.join('、')}。这些信息必须由主人明确提供，插件不会自行填写`,
        };
    }
    if (usedKeys.has(authorizationKey(authorization))) {
        return {
            ok: false,
            refusal: 'already_used',
            message: '这份授权已经用过一次。一次性验收的设计就是只发一条——' +
                '如果需要再验，请由主人重新指定并授权，而不是重复使用同一份授权',
        };
    }
    // The live identity must be the authorized one. Publishing from a different
    // logged-in account would post as someone who never consented.
    //
    // ## `undefined` is a refusal, not a skip (v0.2.21 P0-2)
    //
    // The previous form was `if (liveAccountId !== undefined && liveAccountId !== authorized)`.
    // That reads as defensive but means "we could not find out who is logged in, so we will send
    // it anyway" — and the record it then writes claims the authorised account made the post,
    // which is exactly the claim this whole flow exists to be able to make truthfully.
    //
    // A read failure and a logged-out session both land here. Refusing is the only answer that
    // keeps the record honest; the message tells the owner which of the two it looks like.
    if (liveAccountId === undefined || liveAccountId.trim() === '') {
        return {
            ok: false,
            refusal: 'account_unknown',
            message: '无法确认当前真实登录的是哪个账号，因此不会发表。' +
                '验收要证明的是「这个账号能发」，读不到登录态就证明不了——' +
                '请先在设置页确认登录状态，再回来验收',
        };
    }
    if (liveAccountId !== authorization.authorizedAccountId) {
        return {
            ok: false,
            refusal: 'account_mismatch',
            message: `当前登录的账号是 ${liveAccountId}，而授权使用的账号是 ` +
                `${authorization.authorizedAccountId}。验收必须用主人授权的那个账号`,
        };
    }
    return { ok: true, message: '授权检查通过，只会发表一条' };
}
/**
 * Decide whether the capability may be upgraded to `supported`.
 *
 * Requires *all four* read-back facts. A publish that returned a post id but whose
 * text could not be confirmed is not evidence that publishing works correctly —
 * it is evidence that something was written somewhere.
 */
export function decideCapabilityUpgrade(record) {
    if (record.outcome !== 'succeeded') {
        return {
            upgrade: false,
            reason: `验收结果是 ${record.outcome}，只有在成功的情况下才有证据`,
        };
    }
    const readBack = record.readBack;
    if (readBack === undefined) {
        return { upgrade: false, reason: '没有回读证据，无法确认这条回复真的出现在平台上' };
    }
    const missing = [];
    if (!readBack.postFound)
        missing.push('帖子没有在回读中出现');
    if (!readBack.authorMatched)
        missing.push('作者不符');
    if (!readBack.textMatched)
        missing.push('正文不符');
    if (!readBack.parentMatched)
        missing.push('父级位置不符');
    if (missing.length > 0) {
        return { upgrade: false, reason: `回读证据不完整：${missing.join('、')}` };
    }
    return { upgrade: true, reason: '回读确认了平台、作者、正文与父级位置，可以标记为 supported' };
}
/**
 * The authorization template shown to the owner.
 *
 * Written out so the required fields are visible before anything is attempted,
 * rather than being discovered one refusal at a time.
 */
export function describeAuthorizationRequirements(platform) {
    return [
        `为验证「${platform}」的真实发表能力，需要主人明确提供以下四项：`,
        '1. 一个你自己有权使用的测试账号（发表会以这个账号的身份进行）',
        '2. 一个你自己控制或已获许可的测试帖子链接',
        '3. 由谁授权（写清你的身份，用于留痕）',
        '4. 要发表的那一条回复正文（预先批准，不会由模型现场生成）',
        '插件只会发表一条，并在发表后回读确认平台、作者、正文与父级位置。',
        '如果平台返回 403、429、验证码或权限不足，验收会直接停止，能力保持 unverified。',
    ].join('\n');
}
//# sourceMappingURL=verification.js.map