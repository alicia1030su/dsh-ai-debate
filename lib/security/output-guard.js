/**
 * The output gate: judge a generated reply before it may be published.
 *
 * This is the piece that makes the whole system's guarantee real. The task book's
 * acceptance condition is precise: **even if an injection succeeds in making the
 * generation model produce a reply that attacks the owner, the independent output
 * check and the pre-publish gate must still stop it.** So this module must not ask
 * the generation model anything, must not rely on the prompt having said "don't do
 * that", and must not depend on the input detector having fired.
 *
 * ## Two layers, deliberately unequal
 *
 * - **Deterministic** checks (target identity, credential shapes, stance rules,
 *   evidence citations) are cheap, reproducible, and cannot be argued with. They
 *   produce `block` on their own.
 * - **Semantic** review may *only* make the verdict stricter. It runs on attacker-
 *   controlled text, so treating its `ok` as permission would be trusting the
 *   target of the attack. A reviewer that fails, times out, or returns junk raises
 *   the verdict to `review` — never leaves it at `allow`.
 *
 * ## Where the check runs
 *
 * Twice: once at generation (so the reviewer sees the verdict alongside the text)
 * and again immediately before the network call. The second run is the one that
 * matters, because between the two the owner may have edited the text, the
 * opponent may have posted again, and the stored assessment may describe prose
 * that is no longer what would be sent.
 */
import { assessmentFingerprint } from './security-policy.js';
import { assessBatch } from './injection-detector.js';
import { checkStance } from './owner-integrity.js';
import { decideSecurity, } from './security-policy.js';
/** Credential-shaped strings that must never appear in a reply. */
const SECRET_SHAPES = [
    { re: /BDUSS=|STOKEN=|BAIDUID=/i, label: '贴吧 Cookie 字段' },
    { re: /\bsk-[A-Za-z0-9]{16,}/, label: 'OpenAI 风格的 API key' },
    { re: /\bBearer\s+[A-Za-z0-9._-]{16,}/i, label: 'Bearer 令牌' },
    { re: /DSH_AI_DEBATE_[A-Z_]+/, label: '本插件的凭据引用名' },
    { re: /m0sk_[A-Za-z0-9]{10,}/, label: 'mem0 API key' },
];
/**
 * True when the reply text itself contains anything credential-shaped.
 *
 * Separate from the stance guard because it is a pure text property: a reply
 * leaking a key is dangerous regardless of who it was aimed at.
 */
export function textLooksLikeSecretLeak(reply) {
    const labels = SECRET_SHAPES.filter((shape) => shape.re.test(reply)).map((shape) => shape.label);
    return { leak: labels.length > 0, labels };
}
/**
 * Check that a reply's factual claims trace back to posts that were read.
 *
 * Only checks the *shape* of a citation claim, not truth — deciding whether a
 * sentence is true is not something this layer can do. What it can do is notice a
 * reply asserting that someone said something when no collected post contains it.
 *
 * Deliberately conservative: a quote must match a real post's text (normalised) to
 * within a short window. Requiring exact equality would make every paraphrase a
 * violation, which would block legitimate replies.
 */
export function checkEvidenceIntegrity(input) {
    const posts = input.posts;
    if (posts.length === 0)
        return { valid: true };
    // Quoted fragments: 「…」, “…” or "..."
    const quotePatterns = [/「([^」]{4,60})」/g, /“([^”]{4,60})”/g, /"([^"]{4,60})"/g];
    const normalise = (text) => text.replace(/[\s，。,.!！?？~～、:：;；]/g, '');
    const haystack = posts.map((post) => normalise(post.text)).join('\u0000');
    for (const pattern of quotePatterns) {
        for (const match of input.reply.matchAll(pattern)) {
            const fragment = normalise(match[1] ?? '');
            if (fragment.length < 4)
                continue;
            // Allow a partial quote: the reply may trim the middle of a long sentence.
            const head = fragment.slice(0, Math.min(fragment.length, 12));
            if (!haystack.includes(head)) {
                return {
                    valid: false,
                    problem: `回复引用了「${match[1]?.slice(0, 30) ?? ''}」，但已读取的帖子里找不到这句话`,
                };
            }
        }
    }
    return { valid: true };
}
/**
 * Run every check and produce the assessment.
 *
 * @returns the assessment, plus a fingerprint that binds it to this exact text
 */
export function guardOutput(input) {
    const targetIdentityValid = input.expectedTargetPostId === undefined
        ? false
        : input.targetPostId === input.expectedTargetPostId;
    const inputAssessment = input.conversationText !== undefined && input.conversationText.length > 0
        ? assessBatch(input.conversationText)
        : undefined;
    const stance = checkStance({
        reply: input.reply,
        owner: input.owner,
        ...(input.opponentName !== undefined ? { opponentName: input.opponentName } : {}),
        ...(inputAssessment !== undefined ? { inputAssessment } : {}),
    });
    const secret = textLooksLikeSecretLeak(input.reply);
    const evidence = input.posts === undefined
        ? { valid: true }
        : checkEvidenceIntegrity({ reply: input.reply, posts: input.posts });
    const assessment = decideSecurity({
        ...(inputAssessment !== undefined ? { input: inputAssessment } : {}),
        stance,
        ownerIdentityValid: input.owner.accountId !== undefined || input.owner.displayName !== undefined,
        targetIdentityValid,
        evidenceIntegrityValid: evidence.valid,
        secretLeakRisk: secret.leak,
    }, input.strictness ?? 'standard');
    return {
        assessment,
        fingerprint: assessmentFingerprint({
            reply: input.reply,
            targetPostId: input.targetPostId,
            decision: assessment.decision,
        }),
    };
}
/**
 * Re-verify a stored candidate immediately before publishing.
 *
 * This is the gate the acceptance criterion talks about, and it is intentionally
 * **stricter than the generation-time check**:
 *
 * - A candidate with no stored assessment is refused. It was produced by an older
 *   version, which means it never faced this check at all.
 * - The stored decision must not be `block`.
 * - The stored fingerprint must still match the text about to be sent. Editing the
 *   text after approval invalidates the approval.
 *
 * @returns `undefined` when the send may proceed, otherwise the refusal reason
 */
export function recheckBeforePublish(input) {
    const security = input.candidate.security;
    if (security === undefined) {
        return {
            ok: false,
            reason: '这个候选没有安全评估记录（可能是旧版本生成的）。安全闸门无法确认它是否通过了输出检查，' +
                '因此拒绝发表。请重新生成一次。',
        };
    }
    if (security.decision === 'block') {
        return {
            ok: false,
            reason: `这个候选已被安全闸门阻止：${security.reasons.join('；') || '未记录原因'}`,
        };
    }
    const expected = assessmentFingerprint({
        reply: input.textToSend,
        targetPostId: input.candidate.targetPostId,
        decision: security.decision,
    });
    if (expected !== security.fingerprint) {
        return {
            ok: false,
            reason: '候选正文或目标在安全评估之后被改动过，原来的评估不适用于现在要发的内容。' +
                '请重新执行安全检查后再发表。',
        };
    }
    return { ok: true };
}
/** The assessment as it is persisted on the candidate. */
export function toStorageRecord(assessment, fingerprint) {
    return { ...assessment, fingerprint };
}
//# sourceMappingURL=output-guard.js.map