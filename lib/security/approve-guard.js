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
 * stored assessment is — the common case, and safe: the binding records that exact
 * fingerprint, so a later re-assessment invalidates the record normally.
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