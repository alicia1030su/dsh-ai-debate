/**
 * The view layer for the verification panel (v0.2.21 §三/§四).
 *
 * Kept out of `settings-routes.ts` so the route file stays about transport, and out of
 * `verification-service.ts` so that module stays about *doing* one attempt. This file only
 * arranges what already exists into something a page and a script can both read.
 *
 * ## Two properties it must keep
 *
 * - **Blockers are sentences, not booleans.** "cannot verify" is useless without the reason: the
 *   owner has to know whether to log in, configure an account, or wait for a cookie to settle.
 * - **Nothing unknown is reported as fine.** An absent live account is `undefined` and a matching
 *   blocker, never `'ok'`; a capability with no evidence is `unverified`, never `supported`.
 */
/** Capabilities this page can verify. Both of them publish, so both need the full ceremony. */
const VERIFIABLE = ['comment.publish', 'comment.reply'];
/**
 * Build the panel view.
 *
 * `platform` may be empty — the page renders before the owner picks one — in which case the
 * capability list is empty and the blockers say what to do, rather than showing a green
 * "nothing declared".
 *
 * ## `live` is passed in, never inferred (v0.2.21 P0-2)
 *
 * The configured posting account and the account the session is actually logged in as are two
 * different facts, and only the second one may be called "the live account". Before P0-2 this
 * function put the configured id in the `liveAccountId` field, so the panel stated an identity it
 * had never read — and an unknown session looked identical to a matching one.
 */
export function verificationViewOf(service, platform, live) {
    const records = service.history().map((record) => ({
        key: record.key,
        platform: record.platform,
        capability: record.capability,
        authorizedAccountId: record.authorizedAccountId,
        authorizedThreadId: record.authorizedThreadId,
        startedAt: record.startedAt,
        outcome: record.outcome,
        ...(record.publishedPostId !== undefined ? { publishedPostId: record.publishedPostId } : {}),
        ...(record.readBack !== undefined ? { readBack: record.readBack } : {}),
        ...(record.failure !== undefined ? { failure: record.failure } : {}),
    }));
    if (platform.trim() === '') {
        return {
            ok: false,
            capabilities: [],
            records,
            blockers: ['还没有选择平台。先在上面选一个平台，再看它的发表验收状态。'],
            report: { platform: '', generatedAt: new Date().toISOString(), capabilities: [] },
        };
    }
    const described = service.describe(platform);
    const blockers = [];
    if (described.accountId === undefined || described.accountId.trim() === '') {
        blockers.push(`还没有配置 ${platform} 的发帖账号 id。验收要证明「这个账号能发」，所以不知道是哪个账号就没法验。`);
    }
    // The session is a separate question from configuration, and it is the one that decides
    // whether a publish would go out as the authorised identity. Unknown is a blocker, not a
    // silent pass: the runner refuses it too, and the button should not invite the attempt.
    const liveId = live?.accountId !== undefined && live.accountId.trim() !== '' ? live.accountId.trim() : undefined;
    if (liveId === undefined) {
        blockers.push(live?.error !== undefined
            ? `读不到当前登录的账号（${live.error}），所以无法确认这次发表会用谁的身份。`
            : '读不到当前登录的账号，所以无法确认这次发表会用谁的身份。请先在「贴吧账号」里确认登录状态。');
    }
    else if (described.accountId !== undefined && liveId !== described.accountId) {
        blockers.push(`当前登录的是账号 ${liveId}，而配置里要用的发帖账号是 ${described.accountId}。` +
            '两者必须一致，否则发出去的回复不是以你授权的身份发的。');
    }
    if (described.adapterVersion === undefined) {
        blockers.push(`${platform} 的适配器当前不可用（未注册，或凭据还没加载完成）。`);
    }
    const capabilities = VERIFIABLE.map((capability) => {
        const entry = described.capability[capability];
        return {
            capability,
            declared: entry.declared,
            effective: entry.effective,
            reason: entry.reason,
        };
    });
    const report = {
        platform,
        generatedAt: new Date().toISOString(),
        capabilities: VERIFIABLE.map((capability) => {
            const entry = described.capability[capability];
            const evidence = described.accountId === undefined || described.adapterVersion === undefined
                ? []
                : service
                    .evidenceFor(platform, capability, described.accountId, described.adapterVersion)
                    .map((row) => ({
                    at: row.verifiedAt,
                    accountId: row.accountId,
                    adapterVersion: row.adapterVersion,
                }));
            return {
                name: capability,
                declared: entry.declared,
                effective: entry.effective,
                evidence,
            };
        }),
    };
    return {
        ok: blockers.length === 0,
        // Only the *read* value goes here. `configuredAccountId` carries the other fact so the panel
        // can show both and a reader can see whether they agree.
        ...(liveId !== undefined ? { liveAccountId: liveId } : {}),
        ...(described.accountId !== undefined ? { configuredAccountId: described.accountId } : {}),
        ...(described.adapterVersion !== undefined ? { adapterVersion: described.adapterVersion } : {}),
        capabilities,
        records,
        blockers,
        report,
    };
}
//# sourceMappingURL=verification-view.js.map