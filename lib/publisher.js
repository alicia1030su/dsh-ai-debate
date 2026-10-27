/**
 * Publishing: the only path that can write to the platform on the owner's
 * behalf, and therefore the most conservative file in the project.
 *
 * The design decisions worth stating:
 *
 * - **The dedupe record is written before the request.** If the process dies
 *   between "wrote a record" and "learned the outcome", the next run sees a
 *   `pending` publish and refuses to retry automatically. Losing that ordering
 *   is how bots double-post.
 * - **An unprovable result is `uncertain`, never `success`.** A 200 with an
 *   unexpected body, a timeout after send, a response with no post id — all
 *   produce `uncertain`, which requires a human read-back.
 * - **Verification is a separate read.** After a confirmed publish the returned
 *   post id is looked up again; a reply that the platform claimed but that
 *   cannot be read back is reported as unverified rather than assumed.
 */
import { PlatformError } from './types.js';
import { dedupeKey, upsertDedupe } from './store.js';
import { describeTargetProblem, contentHash, hasStableAuthor, resolveTarget, snapshotStillValid, } from './target.js';
import { assertPublishableText, checkPublishPolicy, mustPauseOn, transition, } from './safety.js';
/**
 * In-flight publishes, keyed by dedupe key.
 *
 * This is the atomic half of the double-post guard. Checking the dedupe record
 * and then writing `pending` is two awaits, and two concurrent calls for the
 * same trigger both read "no record yet" before either writes — so both send.
 * Measured: `Promise.all` of ten identical publishes called the platform ten
 * times. The Map below makes the check-and-claim one synchronous step, so the
 * second caller sees a claim and refuses.
 *
 * Scope is deliberately the process. Two DSH processes sharing one store file
 * are not protected by this and are documented as unsupported.
 */
const inFlight = new Map();
/** Test seam: how many keys are currently claimed. */
export function inFlightCount() {
    return inFlight.size;
}
/** Test seam: clear claims left behind by a failed test. */
export function resetInFlight() {
    inFlight.clear();
}
/**
 * Publish one approved candidate.
 *
 * Every check runs in the order that fails cheapest first, and each refusal is
 * specific: "the text you approved differs from the stored candidate" is far
 * more useful than a generic "refused".
 *
 * Concurrency: the whole check-and-send sequence runs under a per-dedupe-key
 * claim (see {@link inFlight}). A second call for the same trigger while the
 * first is still working is refused outright rather than queued, because the
 * honest answer to "is this already being sent?" is yes.
 */
export async function publishCandidate(deps, request) {
    await deps.store.ready();
    const session = deps.store.getSession(request.sessionId);
    if (!session) {
        return { ok: false, status: 'refused', message: `找不到会话 ${request.sessionId}` };
    }
    const candidate = session.candidates.find((entry) => entry.replyId === request.candidateId);
    if (!candidate) {
        return {
            ok: false,
            status: 'refused',
            message: `会话 ${session.id} 里没有候选回复 ${request.candidateId}`,
        };
    }
    // The approved text must equal what is stored: prevents approving one thing
    // while sending another, whether through a stale UI or a bug.
    if (candidate.text.trim() !== request.approvedText.trim()) {
        return {
            ok: false,
            status: 'refused',
            message: '你确认的文本与已保存的候选不一致，已拒绝发送。请重新生成或重新审核。',
        };
    }
    const violations = candidate.violations;
    if (violations.length > 0) {
        return {
            ok: false,
            status: 'refused',
            message: `该候选存在未通过的检查，不能发表：${violations.join('；')}`,
        };
    }
    // The platform must be able to write at all, before anything else is decided.
    //
    // This runs first — ahead of the credential probe, the in-flight claim, the
    // dedupe record and every network call — because the answer cannot change and
    // because "this platform cannot publish" is a fact about the integration, not
    // about this attempt. Placing it later was how a platform with `unverified`
    // publishing reached the point of writing a `pending` ledger row.
    //
    // The capability depends on where the bytes land: answering a comment needs
    // `comment.reply`, starting a new one needs `comment.publish`. A platform may
    // legitimately support one and not the other.
    const capability = capabilityForSession(session, candidate);
    if (deps.assertCapability !== undefined) {
        try {
            deps.assertCapability(session.platform, capability);
        }
        catch (error) {
            return {
                ok: false,
                status: 'refused',
                message: `平台「${session.platform}」当前不能${capability === 'comment.reply' ? '回复评论' : '发表评论'}：` +
                    (error instanceof Error ? error.message : String(error)),
                errorCode: 'capability_not_proven',
            };
        }
    }
    // The credential state must be proven before anything irreversible happens.
    //
    // Publishing logs in with the configured cookie and verifies the account. If
    // the plugin cannot tell "no cookie saved" from "the store has not finished
    // loading", it would either send as the wrong identity or claim the cookie is
    // missing when it is not. So an unproven state is refused here — before the
    // in-flight claim, before the dedupe record, before any network call — and the
    // message names the actual phase so the owner can act on it.
    const credentials = deps.credentialState?.();
    if (credentials !== undefined && !credentials.canPublish) {
        return {
            ok: false,
            status: 'refused',
            message: describeCredentialBlocker(credentials),
            errorCode: 'credentials_unproven',
        };
    }
    const key = dedupeKey({
        platform: session.platform,
        threadId: session.threadId,
        ownerKey: session.ownerKey,
        triggerPostId: session.triggerPostId,
    });
    // Claim the key synchronously, before any await. Anything after this point is
    // the single owner of this trigger for the rest of the process's life.
    const claim = inFlight.get(key);
    if (claim) {
        return {
            ok: false,
            status: 'refused',
            message: '这个召唤事件已经有一个发表请求正在处理中（' +
                `候选 ${claim.candidateId}，${new Date(claim.startedAt).toISOString()} 开始）。` +
                '为避免重复回帖，本次请求被拒绝；请等待当前请求返回结果。',
        };
    }
    inFlight.set(key, { startedAt: (deps.now ?? Date.now)(), candidateId: candidate.replyId });
    try {
        return await sendOnce(deps, request, session, candidate, key);
    }
    finally {
        // Released only once the dedupe record has been written by `sendOnce`, so a
        // later call is stopped by the record rather than by this in-memory claim.
        inFlight.delete(key);
    }
}
/** The publish sequence proper, run while holding the trigger's claim. */
async function sendOnce(deps, request, session, candidate, key) {
    const now = deps.now ?? (() => Date.now());
    // The dedupe record is the restart-proof guard. It is checked *before* the
    // session state, because the state a previous attempt leaves behind (a pause,
    // a needs-confirmation) is a consequence of that attempt: reporting "wrong
    // state" instead would hide the real and more urgent "do not send twice".
    const existing = deps.store.findDedupe(key);
    if (existing?.publishState === 'pending') {
        return {
            ok: false,
            status: 'refused',
            message: '这个召唤事件已经尝试过发表，但上次没有拿到确定结果。为避免重复回帖，请先打开帖子确认是否已经发出，再决定是否重试。',
        };
    }
    if (existing?.publishState === 'confirmed' || session.publishedPostIds.length > 0) {
        return {
            ok: false,
            status: 'refused',
            message: `本次召唤已经在帖子中发表过（post id ${existing?.publishedPostId ?? session.publishedPostIds[0]}），不会重复发表`,
        };
    }
    if (session.state !== 'READY') {
        return {
            ok: false,
            status: 'refused',
            message: `会话当前状态是 ${session.state}，只有 READY 才能发表`,
        };
    }
    // Counted from the permanent ledger, not from sessions.
    //
    // Sessions are pruned on a TTL, so counting publishes there made the per-thread
    // cap reset itself: after the earlier sessions aged out, the plugin would see
    // "0 published in this thread" and keep replying past `maxPublishesPerThread`.
    //
    // An unresolved attempt occupies a slot. It is not proof a reply went out, but
    // treating it as free space is exactly how the cap gets exceeded during a run of
    // timeouts; refusing early is recoverable, a duplicate post is not.
    const activity = deps.store.threadPublishActivity(session.platform, session.threadId);
    const threadPublishes = activity.confirmed + activity.unresolved;
    const lastPublishAt = activity.lastConfirmedAt;
    const decision = checkPublishPolicy(deps.policy, {
        sessionId: session.id,
        threadId: session.threadId,
        sessionPublishes: session.publishedPostIds.length,
        threadPublishes,
        lastPublishAt,
        humanApproved: request.humanApproved,
        now: now(),
    });
    if (!decision.allowed) {
        return { ok: false, status: 'refused', message: decision.reason, errorCode: decision.code };
    }
    try {
        assertPublishableText(request.approvedText, 2000);
    }
    catch (error) {
        return { ok: false, status: 'refused', message: error.message };
    }
    // A dirty store means the previous write never reached the disk. Sending now
    // would create a reply whose dedupe record exists only in memory, so a restart
    // could send it again.
    if (deps.store.hasUnsavedChanges) {
        return {
            ok: false,
            status: 'refused',
            message: `状态无法写入磁盘（${deps.store.unsavedReason ?? '未知原因'}），已拒绝发表：` +
                '此时发帖的记录只存在内存里，重启后可能重复发送。请先修复状态目录的写入权限。',
            errorCode: 'store_write_failed',
        };
    }
    // Whose account will speak matters as much as whether one is logged in.
    //
    // A cookie that can read a thread says nothing about which account it belongs
    // to: posting as the wrong account is public, attributed and irreversible.
    //
    // The previous shape wrapped this whole block in `if (configuredAiId ||
    // configuredAiName)`, so leaving both fields empty skipped identity checking
    // entirely and published as whoever the cookie happened to belong to. Reading and
    // drafting work fine without a binding; publishing does not.
    const configuredAiId = (deps.config?.().aiAccountUserId ?? '').trim();
    const configuredAiName = (deps.config?.().aiAccountName ?? '').trim();
    if (!configuredAiId && !configuredAiName) {
        return {
            ok: false,
            status: 'refused',
            message: '还没有绑定 AI 发帖账号（aiAccountUserId / aiAccountName 都为空），无法确认会用哪个账号发言。' +
                '请在插件设置里填写 aiAccountUserId（推荐）或 aiAccountName 后再发表。' +
                '读取帖子和生成候选不受影响。',
            errorCode: 'identity_unbound',
        };
    }
    {
        let auth;
        try {
            // Read the login banner from the thread being published into, not from a
            // hard-coded sample thread. A deleted or rate-limited sample post used to make a
            // perfectly good login look broken — and the banner is rendered on any post page
            // the cookie can see.
            auth = await deps.adapter.checkAuthentication(request.signal, session.threadId);
        }
        catch (error) {
            return {
                ok: false,
                status: 'refused',
                message: `无法确认当前登录账号（${error.message}），已拒绝发表`,
                errorCode: 'identity_unverified',
            };
        }
        if (!auth.authenticated) {
            // A login wall is not a one-off failure: retrying cannot fix it, and each try
            // re-reads the thread. Pause the session so the owner gets one instruction.
            const message = `未登录：${auth.reason ?? '无法确认登录状态'}。已拒绝发表，会话已暂停。`;
            await recordPausedFailure(deps, session, message, now);
            return {
                ok: false,
                status: 'failed',
                message,
                errorCode: auth.blocked ? 'captcha' : 'auth_required',
                paused: true,
            };
        }
        // Identity is fail-closed.
        //
        // The old shape was `configuredAiName && auth.userName && mismatch`, so a
        // platform reply that omitted `userName` silently skipped the name check and
        // the publish went through. "I could not read the name" must never mean "the
        // name is fine": posting as the wrong account is public and irreversible.
        const actualId = auth.userId?.trim() ?? '';
        const actualName = auth.userName?.trim() ?? '';
        if (configuredAiId && !actualId) {
            return {
                ok: false,
                status: 'refused',
                message: `配置了 AI 账号 ID ${configuredAiId}，但当前 Cookie 没有暴露登录用户 ID，无法确认是谁在发帖。` +
                    '为避免用错账号发言，已拒绝发表。',
                errorCode: 'identity_unverified',
            };
        }
        if (configuredAiId && actualId !== configuredAiId) {
            return {
                ok: false,
                status: 'refused',
                message: `当前登录的是 ${actualId}，但配置的 AI 账号是 ${configuredAiId}。` +
                    '已拒绝发表：帖子会署上错误的账号名。请更换 Cookie 或修改 aiAccountUserId。',
                errorCode: 'identity_mismatch',
            };
        }
        // The name is checked when configured. A conflict is fatal even when the id
        // matched: an id match does not license posting as a differently-named account.
        if (configuredAiName) {
            if (!actualName) {
                if (!configuredAiId) {
                    // A name was configured, there is no id to fall back on, and the platform
                    // reported no name — nothing was verified at all.
                    return {
                        ok: false,
                        status: 'refused',
                        message: `配置了 AI 账号名称 ${configuredAiName}，但当前登录态没有返回账号名称，无法确认是谁在发帖。` +
                            '请改为配置 aiAccountUserId（数字 ID 更可靠），或确认 Cookie 有效。',
                        errorCode: 'identity_unverified',
                    };
                }
                // An id was configured and matched; a missing name adds nothing.
            }
            else if (actualName !== configuredAiName) {
                return {
                    ok: false,
                    status: 'refused',
                    message: `当前登录账号名是 ${actualName}，与配置的 ${configuredAiName} 不一致。` +
                        (configuredAiId ? `（账号 ID ${actualId} 与配置一致，但名称不符）` : '') +
                        '已拒绝发表。',
                    errorCode: 'identity_mismatch',
                };
            }
        }
    }
    // Everything up to here is local validation that can refuse without touching the
    // session state. Only once the target is confirmed does the session move to
    // PUBLISHING — a refusal that happened first would otherwise leave the session
    // stuck in a state that means "a request is in flight".
    //
    // The candidate must be the newest one for this session.
    //
    // Regenerating bumps `candidateVersion`; a candidate that is no longer current was
    // written against a situation the owner has since moved past, and the fresh
    // candidate may say something different. `humanApproved` cannot override this —
    // approving an old draft by mistake is exactly the case this blocks.
    const newestVersion = session.candidates.reduce((max, row) => Math.max(max, row.candidateVersion ?? 0), 0);
    const thisVersion = candidate.candidateVersion ?? 0;
    if (newestVersion > 0 && thisVersion < newestVersion) {
        const message = `这个候选是第 ${thisVersion} 版，而会话里已经有第 ${newestVersion} 版。` +
            '旧版候选不再可发表：它可能针对的是之前的争论对象或目标，请改用最新一版，或重新生成并审核。';
        // A stale candidate is still only *this* candidate's problem; the newest one
        // remains publishable.
        await recordTargetFailure(deps, session, key, existing, message, now);
        return { ok: false, status: 'refused', message, errorCode: 'candidate_stale' };
    }
    // A candidate with no snapshot cannot be published.
    //
    // This check comes *before* re-reading the target on purpose: the fresh read is
    // what a snapshot is compared against, so without a snapshot there is nothing to
    // compare and the guard degenerates into "trust whatever is there now". An old
    // candidate, or one generated when the target could not be confirmed, therefore
    // has to be regenerated and re-reviewed.
    if (!candidate.targetSnapshot) {
        const message = '这个候选回复没有目标快照（可能是旧版本生成的，或生成时无法确认回复目标），' +
            '无法验证它是否仍针对同一条发言。已拒绝发表，请重新生成并重新审核。';
        // Only this candidate is unusable: a session may still hold a newer one whose
        // snapshot is fine, so the session state is left alone.
        await recordTargetFailure(deps, session, key, existing, message, now);
        return { ok: false, status: 'refused', message, errorCode: 'target_no_snapshot' };
    }
    // A snapshot that identifies the target only by its display name cannot prove
    // *who* is being answered.
    //
    // Tieba exposes a numeric user id on some rows and only a name on others, and a
    // name is something any account can change at will. `snapshotStillValid` compares
    // the names and reports a mismatch, but a match is not identity: if the real author
    // renamed and a different account took the name, the comparison passes and the
    // reply lands on a stranger's post. So automatic publishing fails closed here and
    // asks the owner to look, instead of shipping a reply aimed by a label.
    //
    // This is not a read restriction — analysis and drafting work fine with a name —
    // only the irreversible step is withheld.
    if (!hasStableAuthor(candidate.targetSnapshot)) {
        const who = candidate.targetSnapshot.targetAuthorName ?? '未知用户';
        const message = `要回复的这条发言只有显示昵称「${who}」，平台没有给出稳定的用户 ID，` +
            '无法证明现在还是同一个人（昵称可以被改掉，也可能被别人占用）。' +
            '为避免回复到错误的人，本次发表已拒绝。请打开帖子确认后再决定，' +
            '或改用能读到作者 ID 的帖子/楼层。';
        await recordTargetFailure(deps, session, key, existing, message, now);
        return { ok: false, status: 'refused', message, errorCode: 'author_unverifiable' };
    }
    // The approval must match the candidate the human actually read.
    if (candidate.textHash && candidate.textHash !== contentHash(candidate.text)) {
        const message = '存储的候选正文与它自己的哈希不一致（文件可能被改动过），无法确认主人审核的是哪一版。已拒绝发表。';
        await recordTargetFailure(deps, session, key, existing, message, now);
        return { ok: false, status: 'refused', message, errorCode: 'candidate_tampered' };
    }
    // Where the reply lands is decided by re-reading the platform — not by the ids
    // the model produced, and not by trusting the stored snapshot.
    const expectation = {
        threadId: session.threadId,
        floorPostId: candidate.targetSnapshot.floorPostId,
        targetPostId: candidate.targetSnapshot.targetPostId,
        targetKind: candidate.targetSnapshot.targetKind,
        ...(candidate.targetSnapshot.targetAuthorId
            ? { targetAuthorId: candidate.targetSnapshot.targetAuthorId }
            : session.opponentUserId
                ? { targetAuthorId: session.opponentUserId }
                : {}),
    };
    const resolved = await resolveTarget(deps.adapter, expectation, { signal: request.signal, now });
    if (!resolved.ok) {
        // The *target itself* is gone or moved, so every candidate for this session is
        // now suspect. This is the case that does block the session.
        await recordTargetFailure(deps, session, key, existing, resolved.message, now, {
            blockSession: true,
        });
        return {
            ok: false,
            status: 'refused',
            message: resolved.message,
            errorCode: `target_${resolved.problem}`,
        };
    }
    // Compare the fresh read against the snapshot this text was written against.
    // Author *and* body are both checked; either changing means the reviewed reply no
    // longer answers the same thing.
    const drift = snapshotStillValid(candidate.targetSnapshot, resolved.snapshot);
    if (drift) {
        const message = `回复目标在审核期间发生了变化（${describeTargetProblem(drift)}），` +
            '已评审的正文可能不再针对当前对象，已拒绝发表。请重新生成或重新审核。';
        // The target moved under this candidate. Other candidates were written against
        // the same target, so the whole session needs a fresh review.
        await recordTargetFailure(deps, session, key, existing, message, now, { blockSession: true });
        return { ok: false, status: 'refused', message, errorCode: `target_${drift}` };
    }
    // Cancellation is checked after all local validation and immediately before the
    // network call: earlier checks are cheap and their messages are more specific.
    if (deps.isCancelled?.(session.id) || request.signal?.aborted) {
        return {
            ok: false,
            status: 'refused',
            message: '这个会话已被主人停止，未发出请求。',
            errorCode: 'cancelled',
        };
    }
    // The target is confirmed and nothing local refuses. From here on the platform is
    // involved, so the session moves to PUBLISHING and the dedupe row goes to
    // `pending` *before* the request: an unpersisted `pending` is not a guard at all.
    const publishing = transition(session.state, 'PUBLISHING');
    if (!publishing.ok) {
        return { ok: false, status: 'refused', message: publishing.reason ?? '状态不允许发表' };
    }
    try {
        await deps.store.mutate((data) => ({
            ...data,
            dedupe: upsertDedupe(data.dedupe, {
                key,
                platform: session.platform,
                threadId: session.threadId,
                ownerKey: session.ownerKey,
                triggerPostId: session.triggerPostId,
                sessionId: session.id,
                firstSeenAt: existing?.firstSeenAt ?? nowIso(now()),
                publishState: 'pending',
                decidedAt: nowIso(now()),
            }),
            sessions: data.sessions.map((entry) => entry.id === session.id
                ? { ...entry, state: publishing.state, statusText: '正在发表…', updatedAt: nowIso(now()) }
                : entry),
        }));
    }
    catch (error) {
        return {
            ok: false,
            status: 'refused',
            message: `无法把去重记录写入磁盘（${error.message}），已拒绝发表。` +
                '没有落盘的去重记录无法防止重启后重复回帖，因此这一步不能跳过。',
            errorCode: 'store_write_failed',
        };
    }
    const ref = {
        platform: session.platform,
        threadId: session.threadId,
        url: session.threadUrl,
    };
    let outcome;
    try {
        outcome = await deps.adapter.publishReply(ref, resolved.target, request.approvedText, request.signal);
    }
    catch (error) {
        const failure = error;
        const pause = mustPauseOn(error);
        const code = error instanceof PlatformError ? error.code : 'unknown';
        // A throw from `publishReply` is ambiguous: the request may have reached the
        // platform before the failure. Timeouts, dropped connections and aborts after
        // send all mean "unknown outcome", and an unknown outcome must not become
        // `failed` — that would reopen automatic retrying and double-post.
        //
        // Only a failure that provably happened *before* anything was sent is
        // `failed`; the adapter reports those as a status, not as a throw.
        const ambiguous = code === 'timeout' || code === 'network' || code === 'malformed_response' || code === 'unknown';
        await deps.store.mutate((data) => ({
            ...data,
            dedupe: upsertDedupe(data.dedupe, {
                key,
                platform: session.platform,
                threadId: session.threadId,
                ownerKey: session.ownerKey,
                triggerPostId: session.triggerPostId,
                sessionId: session.id,
                firstSeenAt: existing?.firstSeenAt ?? nowIso(now()),
                // `pending` keeps "this may have been sent" on disk, which is what stops an
                // automatic retry after a restart.
                publishState: ambiguous ? 'pending' : 'failed',
                decidedAt: nowIso(now()),
            }),
            sessions: data.sessions.map((entry) => entry.id === session.id
                ? {
                    ...entry,
                    state: transition(entry.state, ambiguous ? 'NEEDS_CONFIRMATION' : pause.pause ? 'PAUSED' : 'FAILED').state,
                    statusText: ambiguous
                        ? `发表结果不确定：${failure.message}（请求可能已经发出，请人工核实，不会自动重试）`
                        : (pause.reason ?? `发表失败：${failure.message}`),
                    error: failure.message,
                    updatedAt: nowIso(now()),
                }
                : entry),
        }));
        if (ambiguous) {
            return {
                ok: false,
                status: 'uncertain',
                message: `发表结果不确定：${failure.message}。请求可能已经发出，为避免重复回帖不会自动重试；` +
                    '请打开帖子确认后再决定。',
                paused: pause.pause,
                errorCode: code,
            };
        }
        return {
            ok: false,
            status: 'failed',
            message: pause.reason ?? `发表失败：${failure.message}`,
            paused: pause.pause,
            errorCode: code,
        };
    }
    if (outcome.status === 'failed') {
        await deps.store.mutate((data) => ({
            ...data,
            dedupe: upsertDedupe(data.dedupe, {
                key,
                platform: session.platform,
                threadId: session.threadId,
                ownerKey: session.ownerKey,
                triggerPostId: session.triggerPostId,
                sessionId: session.id,
                firstSeenAt: existing?.firstSeenAt ?? nowIso(now()),
                publishState: 'failed',
                decidedAt: nowIso(now()),
            }),
            sessions: data.sessions.map((entry) => entry.id === session.id
                ? {
                    ...entry,
                    state: outcome.errorCode === 'captcha' || outcome.errorCode === 'auth_required' ? 'PAUSED' : 'FAILED',
                    statusText: `发表被平台拒绝：${outcome.error ?? '未知原因'}`,
                    error: outcome.error,
                    updatedAt: nowIso(now()),
                }
                : entry),
        }));
        return {
            ok: false,
            status: 'failed',
            message: `发表被平台拒绝：${outcome.error ?? '未知原因'}`,
            paused: outcome.errorCode === 'captcha' || outcome.errorCode === 'auth_required',
            errorCode: outcome.errorCode,
        };
    }
    if (outcome.status === 'uncertain') {
        // Deliberately keep `pending` so no automatic retry can happen.
        await deps.store.mutate((data) => ({
            ...data,
            sessions: data.sessions.map((entry) => entry.id === session.id
                ? {
                    ...entry,
                    state: transition(entry.state, 'NEEDS_CONFIRMATION').state,
                    statusText: `发表结果不确定：${outcome.error ?? '需要人工核实'}`,
                    error: outcome.error,
                    updatedAt: nowIso(now()),
                }
                : entry),
        }));
        return {
            ok: false,
            status: 'uncertain',
            message: `发表结果不确定：${outcome.error ?? '平台没有给出可确认的结果'}。` +
                '为防重复回帖，系统不会自动重试，请打开帖子确认后再决定。',
            errorCode: outcome.errorCode,
        };
    }
    // A "confirmed" with no post id is not confirmed.
    //
    // The adapter is supposed to normalise this already, but the publisher must not
    // depend on that: if the platform reports success while exposing nothing to point
    // at, the only honest reading is "it may have been sent". Recording `confirmed`
    // would both claim a reply exists that cannot be located and, worse, license the
    // automatic retry path — so it is treated exactly like an ambiguous throw.
    if (outcome.status === 'confirmed' && !outcome.postId) {
        await deps.store.mutate((data) => ({
            ...data,
            dedupe: upsertDedupe(data.dedupe, {
                key,
                platform: session.platform,
                threadId: session.threadId,
                ownerKey: session.ownerKey,
                triggerPostId: session.triggerPostId,
                sessionId: session.id,
                firstSeenAt: existing?.firstSeenAt ?? nowIso(now()),
                publishState: 'pending',
                decidedAt: nowIso(now()),
            }),
            sessions: data.sessions.map((entry) => entry.id === session.id
                ? {
                    ...entry,
                    state: transition(entry.state, 'NEEDS_CONFIRMATION').state,
                    statusText: '平台报告发表成功，但没有返回回复 ID，结果无法确认',
                    error: 'malformed_response',
                    updatedAt: nowIso(now()),
                }
                : entry),
        }));
        return {
            ok: false,
            status: 'uncertain',
            message: '平台报告发表成功，但没有返回回复 ID，无法确认这条回复真的存在。' +
                '为防重复回帖，系统不会自动重试，请打开帖子确认后再决定。',
            errorCode: 'malformed_response',
        };
    }
    // The platform says it published. Prove it by reading the reply back and comparing
    // it against what the owner approved — the post id alone only proves *something*
    // exists at that id.
    const verifyExpectation = {
        text: request.approvedText,
        targetKind: candidate.targetSnapshot?.targetKind ?? session.targetKind ?? 'nested',
        floorPostId: candidate.targetSnapshot?.floorPostId ?? session.disputeFloorPostId,
        ...(configuredAiId ? { aiAccountUserId: configuredAiId } : {}),
        ...(configuredAiName ? { aiAccountName: configuredAiName } : {}),
        ...(candidate.targetSnapshot?.targetPostId
            ? { replyToPostId: candidate.targetSnapshot.targetPostId }
            : {}),
    };
    const verification = await verifyPublished(deps.adapter, ref, outcome.postId, verifyExpectation, request.signal);
    // A contradiction means the reply that exists is not the reply that was approved.
    //
    // It is *not* a clean failure either: something was posted, so the ledger must stay
    // `pending` — recording `failed` would invite the automatic retry that posts a
    // second, possibly also-wrong reply. The honest state is "a human must look".
    if (verification.mismatches.length > 0) {
        const detail = verification.mismatches.join('；');
        await deps.store.mutate((data) => ({
            ...data,
            dedupe: upsertDedupe(data.dedupe, {
                key,
                platform: session.platform,
                threadId: session.threadId,
                ownerKey: session.ownerKey,
                triggerPostId: session.triggerPostId,
                sessionId: session.id,
                firstSeenAt: existing?.firstSeenAt ?? nowIso(now()),
                publishState: 'pending',
                decidedAt: nowIso(now()),
                ...(outcome.postId ? { publishedPostId: outcome.postId } : {}),
            }),
            sessions: data.sessions.map((entry) => entry.id === session.id
                ? {
                    ...entry,
                    state: transition(entry.state, 'NEEDS_CONFIRMATION').state,
                    statusText: `发表后回读与审核内容不一致：${detail}`,
                    error: 'verification_mismatch',
                    updatedAt: nowIso(now()),
                }
                : entry),
        }));
        return {
            ok: false,
            status: 'uncertain',
            message: `平台报告发表成功（post id ${outcome.postId}），但回读核对发现不一致：${detail}。` +
                '系统不会自动重试（可能造成第二条错误回复），请打开帖子人工确认。',
            errorCode: 'verification_mismatch',
            postId: outcome.postId,
        };
    }
    const verified = verification.verified && verification.unconfirmed.length === 0;
    await deps.store.mutate((data) => ({
        ...data,
        dedupe: upsertDedupe(data.dedupe, {
            key,
            platform: session.platform,
            threadId: session.threadId,
            ownerKey: session.ownerKey,
            triggerPostId: session.triggerPostId,
            sessionId: session.id,
            firstSeenAt: existing?.firstSeenAt ?? nowIso(now()),
            publishState: 'confirmed',
            decidedAt: nowIso(now()),
            publishedPostId: outcome.postId,
        }),
        sessions: data.sessions.map((entry) => entry.id === session.id
            ? {
                ...entry,
                state: transition(entry.state, 'PUBLISHED').state,
                statusText: verified
                    ? `已发表并在帖子中核实（post id ${outcome.postId}）`
                    : verification.unconfirmed.length > 0
                        ? `平台报告发表成功（post id ${outcome.postId}），已回读但部分项目无法核对：${verification.unconfirmed.join('；')}`
                        : `平台报告发表成功（post id ${outcome.postId} ?? '未返回'}），但未能回读确认`,
                publishedPostIds: outcome.postId
                    ? [...entry.publishedPostIds, outcome.postId]
                    : entry.publishedPostIds,
                sentTexts: [...entry.sentTexts, request.approvedText],
                candidates: entry.candidates.map((row) => row.replyId === candidate.replyId
                    ? { ...row, approved: true, publishedPostId: outcome.postId }
                    : row),
                updatedAt: nowIso(now()),
            }
            : entry),
    }));
    return {
        ok: true,
        status: 'published',
        message: verified
            ? `已发表，并在帖子中核对了正文、位置与作者（post id ${outcome.postId}）`
            : verification.unconfirmed.length > 0
                ? `平台报告发表成功（post id ${outcome.postId}），已回读但以下项目无法核对：` +
                    `${verification.unconfirmed.join('；')}。建议打开帖子看一眼`
                : `平台报告发表成功${outcome.postId ? `（post id ${outcome.postId}）` : ''}，但未能回读确认；建议打开帖子看一眼`,
        postId: outcome.postId,
        verified,
    };
}
/**
 * Re-read the published reply and check it against what was approved.
 *
 * The previous version returned `true` as soon as `getReplyContext` resolved — that
 * only proves *a* post with that id is readable, not that the approved text was sent
 * by the bound account into the intended place. This version checks what the platform
 * exposes, and — crucially — reports what it could not check instead of assuming the
 * best.
 *
 * Checks, in order of how much they protect:
 *
 * 1. **Thread** — the post resolves inside the thread we published to.
 * 2. **Body** — normalised text matches the approved text. Catches "the reply that
 *    came back is somebody else's".
 * 3. **Kind and parent** — a nested target really is nested under the expected floor;
 *    a floor target really is a floor.
 * 4. **Author** — the reply's author is the bound AI account, when the platform
 *    exposes ids.
 *
 * A failed check is a mismatch. A check the platform gave no data for is recorded as
 * unconfirmed and does **not** by itself turn a success into a failure — but it does
 * mean the caller cannot claim full verification.
 *
 * @param adapter the platform
 * @param ref the thread that was published to
 * @param postId the id the platform returned
 * @param expectation what was approved: text, author, kind and parent
 * @param signal cancellation
 * @returns what was proven, what was not, and what contradicted the publish
 */
async function verifyPublished(adapter, ref, postId, expectation, signal) {
    const unconfirmed = [];
    const mismatches = [];
    let context;
    try {
        // `forceFresh` on purpose: a cached copy would let the verification confirm the
        // publish with data captured before it happened.
        context = await adapter.getReplyContext(ref, postId, signal, { forceFresh: true });
    }
    catch (error) {
        // Cannot read it back. That is not proof of failure — the platform may lag, or
        // rate-limit reads — so it is recorded as unverified rather than contradicted.
        const reason = error instanceof Error ? error.message : String(error);
        return {
            verified: false,
            unconfirmed: [`无法回读这条回复（${reason}）`],
            mismatches: [],
        };
    }
    // 1. The post must live in the thread we published to.
    if (context.thread.id !== ref.threadId) {
        mismatches.push(`回复挂在帖子 ${context.thread.id}，而不是 ${ref.threadId}`);
    }
    const actualKind = context.nested ? 'nested' : 'floor';
    const body = context.nested ? context.nested.content : context.floor.content;
    // 2. The body must be what the owner approved.
    if (normalizeForCompare(body) !== normalizeForCompare(expectation.text)) {
        mismatches.push('回读到的正文与审核通过的正文不一致');
    }
    // 3. Floor vs nested, and the parent it hangs under.
    if (actualKind !== expectation.targetKind) {
        mismatches.push(`回复落在了${actualKind === 'floor' ? '楼层' : '楼中楼'}，` +
            `而审核的目标是${expectation.targetKind === 'floor' ? '楼层' : '楼中楼'}`);
    }
    else if (actualKind === 'nested') {
        const nested = context.nested;
        if (nested.parentPostId !== expectation.floorPostId) {
            mismatches.push(`楼中楼挂在楼层 ${nested.parentPostId}，而期望的是 ${expectation.floorPostId}`);
        }
        // Only checked when both sides know the answered post: the platform frequently
        // omits it, and an absent field is not a contradiction.
        if (expectation.replyToPostId && nested.replyToPostId && nested.replyToPostId !== expectation.replyToPostId) {
            mismatches.push(`回复指向 ${nested.replyToPostId}，而期望的是 ${expectation.replyToPostId}`);
        }
        else if (expectation.replyToPostId && !nested.replyToPostId) {
            unconfirmed.push('平台没有暴露这条楼中楼回复的是哪一条');
        }
    }
    // 4. Author must be the bound account.
    const authorId = actualKind === 'nested' ? context.nested.authorId : context.floor.authorId;
    const authorName = actualKind === 'nested' ? context.nested.authorName : context.floor.authorName;
    if (expectation.aiAccountUserId) {
        if (!authorId) {
            unconfirmed.push('平台没有暴露回复的作者 ID，无法确认是否由绑定账号发出');
        }
        else if (authorId !== expectation.aiAccountUserId) {
            mismatches.push(`回复的作者是 ${authorId}，而绑定账号是 ${expectation.aiAccountUserId}`);
        }
    }
    else if (expectation.aiAccountName) {
        if (!authorName)
            unconfirmed.push('平台没有暴露回复的作者昵称');
        else if (authorName !== expectation.aiAccountName) {
            mismatches.push(`回复的作者是 ${authorName}，而配置的是 ${expectation.aiAccountName}`);
        }
    }
    else {
        unconfirmed.push('没有绑定 AI 账号信息，无法核对作者');
    }
    return { verified: mismatches.length === 0, unconfirmed, mismatches };
}
/**
 * Which write capability a send needs, from the candidate that will be sent.
 *
 * v0.2.1 takes this from the *candidate's own snapshot* rather than from
 * `session.targetKind`. The session field is written at analysis time and is
 * optional (an old session migrated from before it existed has none), while the
 * snapshot is what the publish path actually acts on
 * (`publisher.ts` reads `candidate.targetSnapshot.targetKind` when building the
 * request). Reading two different fields here meant the gate could approve
 * `comment.publish` while the send went out as a reply — checked capability and
 * performed action describing different things.
 *
 * The fallback order matches the send path exactly, so the two cannot drift.
 */
function capabilityForSession(session, candidate) {
    const kind = candidate.targetSnapshot?.targetKind ?? session.targetKind ?? 'nested';
    return kind === 'nested' ? 'comment.reply' : 'comment.publish';
}
/**
 * Normalise text for a body comparison.
 *
 * Whitespace, the platform's own quoting prefixes and zero-width characters all differ
 * between what was sent and what is rendered back; comparing raw strings would report
 * a mismatch on every publish. The comparison is deliberately conservative: it removes
 * only formatting noise, so a genuinely different body still fails.
 *
 * @param text the text to normalise
 * @returns a comparison key
 */
function normalizeForCompare(text) {
    return text
        // Zero-width and BOM characters the WAP page injects.
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        // Quoting prefixes such as "回复 某人 :" are added by the platform on render.
        .replace(/^\s*回复\s*[^:：]{1,40}[:：]\s*/u, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Re-exported so callers of the publisher keep working; the ledger rules
 * themselves live in `store.ts`, where both the analysis and publish paths read
 * them, so the two cannot disagree about what a record means.
 */
export { upsertDedupe } from './store.js';
/**
 * Record that one candidate was refused because its target could not be confirmed.
 *
 * Scope matters here, and getting it wrong is a real usability defect caught on a
 * live run: refusing a *single* stale candidate must not condemn the whole session.
 * A session can hold an old candidate with no snapshot next to a fresh one that has
 * a valid snapshot; marking the session `NEEDS_CONFIRMATION` because somebody tried
 * the stale one would block the good one too.
 *
 * So the state change happens only when the session genuinely cannot proceed —
 * otherwise the session keeps its state and this candidate is simply unusable. The
 * dedupe row goes to `failed` because no request was sent, and that is the truth
 * the record should carry.
 */
async function recordTargetFailure(deps, session, key, existing, message, now, options = {}) {
    await deps.store.mutate((data) => ({
        ...data,
        dedupe: upsertDedupe(data.dedupe, {
            key,
            platform: session.platform,
            threadId: session.threadId,
            ownerKey: session.ownerKey,
            triggerPostId: session.triggerPostId,
            sessionId: session.id,
            firstSeenAt: existing?.firstSeenAt ?? nowIso(now()),
            publishState: 'failed',
            decidedAt: nowIso(now()),
        }),
        sessions: data.sessions.map((entry) => {
            if (entry.id !== session.id)
                return entry;
            // A per-candidate refusal records the reason but leaves the state alone; the
            // session is still usable through any candidate that is properly snapshotted.
            if (!options.blockSession) {
                return { ...entry, statusText: message, error: message, updatedAt: nowIso(now()) };
            }
            return {
                ...entry,
                state: transition(entry.state, 'NEEDS_CONFIRMATION').state,
                statusText: message,
                error: message,
                updatedAt: nowIso(now()),
            };
        }),
    }));
}
/**
 * Record a refusal that also stops the session.
 *
 * Login loss and captcha walls do not clear up by themselves, and retrying makes
 * them worse: each attempt re-reads the thread and, on a captcha, looks like a bot.
 * The session therefore moves to PAUSED so the owner sees one clear "fix your login"
 * instruction instead of a stream of identical failures.
 */
async function recordPausedFailure(deps, session, message, now) {
    await deps.store.mutate((data) => ({
        ...data,
        sessions: data.sessions.map((entry) => {
            if (entry.id !== session.id)
                return entry;
            return {
                ...entry,
                state: transition(entry.state, 'PAUSED').state,
                statusText: message,
                error: message,
                updatedAt: nowIso(now()),
            };
        }),
    }));
}
/** ISO timestamp from an epoch, for stored rows. */
function nowIso(epochMs) {
    return new Date(epochMs).toISOString();
}
/**
 * Explain, in the owner's terms, why a publish was refused on credentials.
 *
 * Each phase gets its own sentence because each wants a different action: a
 * timeout means "open the settings page once", a failure means "look at the
 * error", a partial means the store is inconsistent. A single generic message
 * would leave the owner guessing which of those they are looking at.
 */
function describeCredentialBlocker(state) {
    const tail = state.error === undefined ? '' : `（${state.error}）`;
    switch (state.phase) {
        case 'loading':
            return ('凭据库还在初始化，尚未确认登录状态，本次发表已拒绝。' +
                '这不代表 Cookie 丢了——请等一两秒重试，或打开一次插件设置页让它读完。');
        case 'timeout':
            return ('凭据库没有在等待窗口内返回内容，无法确认 Cookie 是否已配置，本次发表已拒绝。' +
                `请打开一次插件设置页重试${tail}。`);
        case 'partial':
            return ('凭据库报告有值但没有返回内容，状态不可信，本次发表已拒绝。' +
                `请打开一次插件设置页重试${tail}。`);
        case 'failed':
            return ('读取凭据库失败，无法确认当前登录身份，本次发表已拒绝。' +
                `这不会删除已保存的 Cookie。请检查后重试${tail}。`);
        case 'unknown':
            return '还没有读取过凭据库，无法确认登录身份，本次发表已拒绝。请先调用一次 debate_bind_owner 或打开设置页。';
        case 'empty':
        case 'ready':
            // `canPublish` was false despite a conclusive phase, so the cookie itself
            // is missing rather than unreadable.
            return '没有可用的贴吧 Cookie，无法验证登录身份，本次发表已拒绝。请在插件设置页填写 Cookie。';
        case 'unavailable':
            return ('本部署没有凭据服务（ctx.credentials），也没有在配置里设置贴吧 Cookie，' +
                '无法验证登录身份，本次发表已拒绝。');
        default:
            return `凭据状态为「${state.phase}」，无法确认登录身份，本次发表已拒绝。`;
    }
}
//# sourceMappingURL=publisher.js.map