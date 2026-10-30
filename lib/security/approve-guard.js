/**
 * The rules for *creating* an approval, kept out of the route and out of `index.ts`.
 *
 * ## Why a separate module
 *
 * The route is a transport concern (parse JSON, answer with a status) and `index.ts`
 * is wiring. Both are bad places for the question "may this candidate be approved at
 * all", because that question is a security decision with several refusal modes and it
 * needs to be testable without an HTTP server or a Cordis context.
 *
 * ## The one rule that matters most
 *
 * An approval may not exist for a candidate the security gate blocked, and it may not
 * exist for one that was never assessed. Both would create a record that later gets
 * refused for a *different* reason than the real one, and a stored-but-unusable
 * approval is how an owner comes to believe they approved something the plugin then
 * silently ignored.
 *
 * ## Why it re-checks the assessment freshness
 *
 * `assessmentFingerprint` is baked into the binding, so an approval for assessment A
 * cannot authorise a send under assessment B. That covers the case where the candidate
 * is re-assessed *after* approval. It does not cover a caller asking to approve against
 * a fingerprint that is already stale, which would mint a record that can never match
 * anything — so that is refused here rather than at publish time, where the message
 * would be about "no approval" and hide the real cause.
 */
/**
 * Whether this candidate may receive an approval at all.
 *
 * `allow` and `review` are both approvable — the difference between them is what
 * happens *without* an approval (`review` is never allowed to spend an automatic
 * slot), not whether an owner may say yes. `block` is not, and neither is a candidate
 * with no assessment: there is nothing to approve.
 */
export function isApprovable(candidate) {
    if (candidate.security === undefined) {
        return {
            ok: false,
            code: 'unassessed',
            reason: '这个候选没有安全评估记录（可能是旧版本生成的），无法确认它通过了输出检查。' +
                '请重新生成一次再批准。',
        };
    }
    if (candidate.security.decision === 'block') {
        return {
            ok: false,
            code: 'blocked',
            reason: `这个候选已被安全闸门阻止，不能批准：${candidate.security.reasons.join('；') || '未记录原因'}。` +
                '人工批准不能覆盖这道判定。',
        };
    }
    return { ok: true, fingerprint: candidate.security.fingerprint };
}
/**
 * Whether the fingerprint a caller wants to approve against is still current.
 *
 * A caller that does not send one is asking to approve *now*, against whatever the
 * stored assessment is. Since v0.2.7 the approve route never takes that path — it
 * requires a snapshot — but this function keeps accepting `undefined` because it
 * answers a narrower question ("is this fingerprint current?") and other callers
 * legitimately have nothing to compare.
 *
 * A caller that does send one is asserting which assessment they are looking at. If
 * that is not the stored one, their page is stale and the approval they are about to
 * create describes a candidate that no longer exists.
 */
export function checkReassessment(candidate, requested) {
    if (requested === undefined)
        return { ok: true };
    const current = candidate.security?.fingerprint;
    if (current === undefined) {
        return {
            ok: false,
            code: 'fingerprint_stale',
            reason: '这个候选还没有安全评估，无法按指定评估批准。',
        };
    }
    if (requested !== current) {
        return {
            ok: false,
            code: 'fingerprint_stale',
            reason: '你看到的候选评估已经过期：安全评估可能在页面加载后被重新计算。' +
                '请刷新设置页，确认最新内容后再批准。',
        };
    }
    return { ok: true };
}
/** The fields a caller must supply; kept separate from values so the error names them. */
const EXPECTATION_KEYS = [
    'sessionId',
    'candidateId',
    'candidateVersion',
    'platform',
    'targetPostId',
    'publishingAccount',
    'textHash',
    'assessmentFingerprint',
];
/**
 * Validate the raw `expected` block from a request body.
 *
 * Split from the comparison so the two failure kinds stay distinguishable: a request
 * that never had a snapshot is a *client bug* (400), while a snapshot that no longer
 * matches is a *race the owner must see* (409). Collapsing them would let a broken
 * page look like a stale one, and the instruction to the user is different.
 *
 * @param raw the `expected` field, unvalidated, from the request body
 * @param sessionId the id the request also named at top level
 * @param candidateId the id the request also named at top level
 */
export function readExpectation(raw, sessionId, candidateId) {
    if (raw === undefined || raw === null || typeof raw !== 'object') {
        return {
            ok: false,
            status: 400,
            code: 'snapshot_required',
            reason: '批准请求必须携带预期快照（expected）。这是为了确保你批准的是页面上看到的那一条候选；' +
                '请刷新设置页后重新批准。',
        };
    }
    const source = raw;
    const missing = EXPECTATION_KEYS.filter((key) => {
        const value = source[key];
        if (key === 'candidateVersion')
            return typeof value !== 'number' || !Number.isFinite(value);
        return typeof value !== 'string' || value.trim() === '';
    });
    if (missing.length > 0) {
        return {
            ok: false,
            status: 400,
            code: 'snapshot_incomplete',
            reason: `预期快照缺少字段：${missing.join('、')}。请刷新设置页后重新批准。`,
        };
    }
    const expectation = {
        sessionId: String(source['sessionId']).trim(),
        candidateId: String(source['candidateId']).trim(),
        candidateVersion: source['candidateVersion'],
        platform: String(source['platform']).trim(),
        targetPostId: String(source['targetPostId']).trim(),
        publishingAccount: String(source['publishingAccount']).trim(),
        textHash: String(source['textHash']).trim(),
        assessmentFingerprint: String(source['assessmentFingerprint']).trim(),
    };
    // The snapshot has to describe the candidate the request names. A body that says
    // "approve c1" with c2's snapshot is either a buggy page or a probe; either way
    // there is nothing to compare it against honestly.
    if (expectation.sessionId !== sessionId || expectation.candidateId !== candidateId) {
        return {
            ok: false,
            status: 409,
            code: 'stale_candidate',
            reason: '预期快照与请求的候选不一致，可能是页面数据串了。请刷新设置页后重新批准。',
        };
    }
    return { ok: true, expectation };
}
/**
 * Compare the page's snapshot with what the store holds.
 *
 * Every field the binding uses is compared, so a change to any of them — a
 * regenerated body, a re-targeted reply, a switched account, a re-assessed
 * candidate — invalidates the approval instead of authorising something the owner
 * did not read. Reported as one code because the remedy is the same: re-read, look
 * again, approve again.
 */
export function checkExpectation(expectation, actual) {
    const drifted = [];
    if (expectation.platform !== actual.platform)
        drifted.push('平台');
    if (expectation.targetPostId !== actual.targetPostId)
        drifted.push('回复目标');
    if (expectation.publishingAccount !== actual.publishingAccount)
        drifted.push('发帖账号');
    if (expectation.candidateVersion !== actual.candidateVersion)
        drifted.push('候选版本');
    if (expectation.textHash !== actual.textHash)
        drifted.push('正文内容');
    if (expectation.assessmentFingerprint !== actual.assessmentFingerprint)
        drifted.push('安全评估');
    if (drifted.length === 0)
        return { ok: true };
    return {
        ok: false,
        code: 'stale_candidate',
        reason: `你看到的候选已经变了（${drifted.join('、')}）。` +
            '为了避免批准一条你没看过的回复，这次批准被拒绝。请刷新设置页，确认最新内容后再批准。',
    };
}
/** Narrow a stored candidate to the fields {@link isApprovable} reads. */
export function approvableOf(candidate) {
    return {
        replyId: candidate.replyId,
        text: candidate.text,
        targetPostId: candidate.targetPostId,
        ...(candidate.candidateVersion === undefined
            ? {}
            : { candidateVersion: candidate.candidateVersion }),
        ...(candidate.security === undefined
            ? {}
            : {
                security: {
                    decision: candidate.security.decision,
                    fingerprint: candidate.security.fingerprint,
                    reasons: candidate.security.reasons,
                },
            }),
    };
}
//# sourceMappingURL=approve-guard.js.map