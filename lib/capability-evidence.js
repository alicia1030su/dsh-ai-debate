/**
 * Capability evidence: what turns "the code exists" into "somebody proved it here".
 *
 * ## The problem
 *
 * v0.2.21 §三 requires that a one-off publish verification actually be reachable, and §三.9
 * requires that it never be possible to promote one account's success into "works for
 * everyone". Those two requirements pull in opposite directions:
 *
 * - The capability matrix must be able to say `supported` for **this deployment, this account**,
 *   otherwise the gate can never open and the verification flow is decoration.
 * - The matrix must **not** be edited by hand, because that is exactly the lie the capability
 *   model exists to prevent (`src/platforms/contracts.ts`).
 *
 * ## The resolution: evidence is data, declaration is code
 *
 * A provider's `describeCapabilities()` stays static and stays the **ceiling**: it says what
 * this integration could do. A verification record is **evidence**: it says what was observed,
 * where, by whom, and against which adapter version. This module is the pure function that
 * joins them.
 *
 * The rules are deliberately narrow — each one closes a way of over-reading a single success:
 *
 * 1. **Same platform.** A Tieba success says nothing about Weibo.
 * 2. **Same capability.** Publishing a new comment is not replying to one; the platform may
 *    allow one and refuse the other.
 * 3. **Same account.** "The owner's test account can reply" is not "any account can reply".
 *    A record without an account id is never evidence for a specific account.
 * 4. **Same adapter version.** A success recorded against `0.2.19+abcdef0` does not carry over
 *    to a rewritten adapter: the bytes that succeeded were different bytes.
 * 5. **Complete read-back.** The four facts in `verification.ts` (`decideCapabilityUpgrade`)
 *    must all be present. A publish that returned an id but whose text was not confirmed is
 *    evidence that something was written somewhere, not that publishing works.
 * 6. **Only upward.** Evidence may lift `unverified` to `supported`. It may never lift
 *    `permission_required` (a grant is missing) or `unavailable` (the platform does not offer
 *    it) — those are statements about the world, not about evidence we have collected.
 *
 * Nothing here touches the network, the store, or the clock: it takes records and returns a
 * decision, so the tests can feed it the combinations that are expensive to produce for real.
 */
/**
 * Which directions evidence may move a capability.
 *
 * `degraded` is included because it is still a working state that can be proven further;
 * `permission_required` and `unavailable` are not, and `supported` needs no promotion.
 */
const PROMOTABLE_FROM = Object.freeze(['unverified', 'degraded']);
function describeMismatch(record, query) {
    if (record.platform !== query.platform) {
        return `记录来自平台 ${record.platform}，不是 ${query.platform}`;
    }
    if (record.capability !== query.capability) {
        return `记录证明的是 ${record.capability}，不是 ${query.capability}`;
    }
    if (record.accountId !== query.accountId) {
        return `记录用的是账号 ${record.accountId || '（未知）'}，而当前账号是 ${query.accountId || '（未知）'}`;
    }
    if (record.adapterVersion !== query.adapterVersion) {
        return (`记录来自适配器 ${record.adapterVersion || '（未知）'}，当前是 ${query.adapterVersion || '（未知）'}：` +
            '换了实现就要重新取证，成功的那次跑的是另一份代码');
    }
    if (record.method !== 'live') {
        return `记录的执行方式是 ${record.method}，只有真实调用（live）能证明平台可用`;
    }
    if (!record.readBackComplete) {
        return '记录的回读证据不完整（作者、正文、目标或父级关系至少有一项没确认）';
    }
    return undefined;
}
/**
 * Compute the state the publish gate should use.
 *
 * @param declared the provider's static declaration — the ceiling, never edited by evidence
 * @param query what this publish is about
 * @param records every record the store holds, newest first
 */
export function effectiveCapability(declared, query, records) {
    if (declared === 'supported') {
        return { effective: declared, promotedByEvidence: false, reason: '平台声明本身就是 supported' };
    }
    if (!PROMOTABLE_FROM.includes(declared)) {
        return {
            effective: declared,
            promotedByEvidence: false,
            reason: declared === 'permission_required'
                ? '缺少平台授权，验收记录不能替代一项不存在的权限'
                : '平台本身不提供这项能力，验收记录不能改变这一点',
        };
    }
    const reasons = [];
    for (const record of records ?? []) {
        const mismatch = describeMismatch(record, query);
        if (mismatch === undefined) {
            return {
                effective: 'supported',
                promotedByEvidence: true,
                reason: `验收记录 ${record.verifiedAt} 证明「${record.accountId}」在适配器 ${record.adapterVersion} 上完成了 ${record.capability}`,
                usedRecord: record,
            };
        }
        reasons.push(mismatch);
    }
    return {
        effective: declared,
        promotedByEvidence: false,
        reason: reasons.length === 0
            ? '没有任何验收记录，因此维持 unverified：代码存在不等于平台可用'
            : `没有一条记录适用于这次发表（${reasons[0]}）`,
    };
}
/**
 * Whether a fresh record should be written for this authorization.
 *
 * A verification that failed must not erase the fact that it was attempted: §三.5 requires the
 * `pending` row **before** the network call, so a crash leaves evidence of the attempt rather
 * than silence. This helper only answers "is this run allowed to start", which is the
 * once-per-authorization rule from `verification.ts` expressed over persisted records.
 */
export function hasUsedAuthorization(records, key, usedKeys) {
    if (usedKeys.has([key.platform, key.capability, key.accountId, key.threadId].join('\u0000'))) {
        return true;
    }
    // A record carrying the same identity is also proof the authorization was spent, even when
    // the key set was lost (a fresh process, a store written by an older version).
    return (records ?? []).some((record) => record.platform === key.platform &&
        record.capability === key.capability &&
        record.accountId === key.accountId);
}
/**
 * A short, stable adapter version for evidence binding.
 *
 * Two properties matter and both are deliberate:
 *
 * - It must change when the adapter changes. A hard-coded `"1"` would let a rewritten publish
 *   method inherit the previous evidence.
 * - It must be reproducible. Hashing the source bytes is; `Date.now()` is not.
 *
 * The caller passes the bytes it considers the adapter (typically the compiled module file), so
 * this function stays pure and testable.
 */
export function adapterVersionOf(bytes) {
    // FNV-1a, 32 bit. Not a security hash — this is an identity tag for evidence, and using
    // SHA-256 here would suggest an integrity guarantee this value does not carry.
    let hash = 0x811c9dc5;
    const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    for (const byte of data) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
/**
 * The adapter identity, derived from the two methods that actually publish and read back.
 *
 * Hashing the function sources is deliberately narrow: a change anywhere else in the adapter
 * (a parser, a header) does not invalidate the evidence, because it did not change the bytes
 * that were sent or the way the reply is read back. A change to either of these two does.
 *
 * Function source is stable for a given compiled artefact, so the value is reproducible across
 * machines — which `node:vm`-independent, no-I/O and therefore testable.
 */
export function adapterVersionOfAdapter(adapter) {
    return adapterVersionOf(`${String(adapter.publishReply)}\u0000${String(adapter.getReplyContext)}`);
}
//# sourceMappingURL=capability-evidence.js.map