/**
 * Durable state for sessions, deduplication and usage accounting.
 *
 * Requirements this file has to satisfy at once:
 *
 * - **Survives a restart without double-posting.** The dedupe record is
 *   written *before* a publish is attempted and updated after, so a crash in
 *   between leaves a record saying "this may have been sent", which blocks an
 *   automatic retry and asks a human to check.
 * - **Survives a torn write.** Every save goes through a temp file and a
 *   rename, so a crash mid-write leaves the previous file intact instead of a
 *   truncated one.
 * - **Never contains credentials.** Only ids, text, states and counters live
 *   here; cookies stay in memory and in the profile's own secret store.
 *
 * Storage is a plain JSON file because the data is small and per-profile. A
 * database would add an install dependency for no benefit at this size.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pruneApprovals } from './security/approvals.js';
/**
 * A store failure the caller is expected to act on.
 *
 * These used to be swallowed so the plugin would keep running. That is exactly
 * the wrong trade for this project: a persisted dedupe record is the only thing
 * standing between "the process died mid-publish" and "the bot posts the same
 * reply twice", so a write that did not happen must stop the pipeline rather
 * than be forgotten.
 */
export class StoreError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = 'StoreError';
        this.code = code;
    }
}
/** States from which no further automatic progress happens. */
export const TERMINAL_STATES = ['PUBLISHED', 'FAILED', 'CANCELLED'];
/** Empty store. */
export function emptyStore() {
    return { version: 1, sessions: [], dedupe: [], usage: [], security: [], approvals: [] };
}
/**
 * The persisted store.
 *
 * All mutations go through `mutate`, which serializes writes so two concurrent
 * tasks cannot interleave and lose one another's changes. Construction is
 * synchronous — only the first read touches the disk — so a plugin can build the
 * store during mount without blocking, and every async entry point awaits
 * {@link ready} before using the synchronous accessors.
 */
export class DebateStore {
    options;
    file;
    data = emptyStore();
    loading;
    /**
     * Serializes writes as a chain, but each link resolves with *its own* outcome.
     *
     * The previous implementation did `.catch(() => undefined)`, which made a
     * failed write indistinguishable from a successful one to every caller. Here
     * the chain only orders the writes; the error still reaches whoever awaited
     * that particular `mutate`.
     */
    writeChain = Promise.resolve();
    /**
     * True while the in-memory document is known to differ from the file.
     *
     * Set when a write fails and cleared by the next successful one. It is what
     * lets the publisher refuse to send after a lost dedupe record: memory saying
     * "not sent yet" is worthless if the disk never learned it.
     */
    dirty = false;
    /** The last write failure, reported until a write succeeds. */
    lastWriteError;
    constructor(options) {
        this.options = options;
        this.file = join(options.dir, 'state.json');
    }
    /** Path of the backing file, for diagnostics. */
    get path() {
        return this.file;
    }
    /** True when memory and disk are known to disagree. */
    get hasUnsavedChanges() {
        return this.dirty;
    }
    /** The most recent write failure, when the store is dirty. */
    get unsavedReason() {
        return this.lastWriteError?.message;
    }
    /** Load once; safe to call from every entry point. */
    ready() {
        this.loading ??= this.load();
        return this.loading;
    }
    /**
     * Load from disk.
     *
     * A missing file is a normal first run. A file that exists but fails validation
     * is **not**: silently starting empty would drop every dedupe record and let the
     * plugin re-post replies it had already sent. Every invalid case therefore
     * backs up the original bytes and throws — there is no "repair and continue"
     * path, because that is exactly the path that loses publish history.
     */
    async load() {
        let raw;
        try {
            raw = await readFile(this.file, 'utf8');
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT') {
                this.data = emptyStore();
                return;
            }
            throw new StoreError('read_failed', `无法读取状态文件 ${this.file}：${error.message}`, {
                cause: error,
            });
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (error) {
            // Preserve the damaged bytes first: the user needs them to recover, and
            // the next successful save will overwrite this path.
            await this.backupCorrupt(raw);
            throw new StoreError('corrupt', `状态文件 ${this.file} 不是合法 JSON：${error.message}。` +
                '为避免重复回帖，插件不会自动重置它；请先备份并检查该文件，或确认安全后手动删除。', { cause: error });
        }
        // Full structural validation. Anything wrong is fatal, and the original bytes
        // are kept so a human can fix or migrate them.
        const validated = validateStore(parsed);
        if (!validated.ok) {
            await this.backupCorrupt(raw);
            throw new StoreError('corrupt', `状态文件 ${this.file} ${validated.reason}`, { cause: undefined });
        }
        this.data = validated.data;
    }
    /** Keep a copy of an unreadable document next to the live one. */
    async backupCorrupt(raw) {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
            await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
            await writeFile(backup, raw, { encoding: 'utf8', mode: 0o600 });
        }
        catch {
            // A backup failure must not mask the real problem; the caller reports it.
        }
    }
    /** Current snapshot. */
    snapshot() {
        return this.data;
    }
    /**
     * Apply a change atomically and persist it.
     *
     * The change is applied in memory, written, and only then returned. If the
     * write fails the in-memory document stays changed (so the caller can inspect
     * what it meant to do) but the store is marked dirty and the error is thrown —
     * the caller must not treat a rejected promise as a saved record.
     */
    async mutate(change) {
        await this.ready();
        const next = prune(change(this.data), this.options);
        this.data = next;
        // Queue the write behind whatever is already in flight. `then` with both
        // handlers keeps the chain alive after a failure instead of poisoning it,
        // while the returned promise still rejects for this caller.
        const write = this.writeChain.then(() => this.persist(next), () => this.persist(next));
        this.writeChain = write.catch(() => undefined);
        try {
            await write;
        }
        catch (error) {
            this.dirty = true;
            const wrapped = error instanceof StoreError
                ? error
                : new StoreError('write_failed', `状态写入失败：${error.message}`, { cause: error });
            this.lastWriteError = wrapped;
            throw wrapped;
        }
        this.dirty = false;
        this.lastWriteError = undefined;
        return next;
    }
    /**
     * Write to disk via a temp file plus rename.
     *
     * The rename is retried, because on Windows it transiently fails with `EPERM`
     * while another process (an antivirus scanner, the search indexer, a backup agent)
     * holds the destination open for a few milliseconds. That is a lock, not a real
     * permission problem, and surfacing it as "cannot write state" is misleading: a
     * publish is refused on a dirty store, so a transient lock would look like a
     * permanent misconfiguration and the user would go hunting for a permissions bug
     * that does not exist.
     *
     * Only `EPERM`/`EACCES`/`EBUSY` are retried, only a handful of times, and the
     * final error still propagates — a genuinely unwritable directory keeps failing.
     */
    async persist(data) {
        const body = `${JSON.stringify(data, undefined, 2)}\n`;
        let lastError;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            // A fresh temp name per attempt: if a failed rename left the previous temp
            // file locked, reusing the name would fail again for the original reason.
            const temp = `${this.file}.${process.pid}.${Date.now()}.${attempt}.tmp`;
            try {
                // 0700 on the directory and 0600 on the file: the store holds who said
                // what to whom, which is nobody else's business on a shared machine.
                await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
                await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
                await rename(temp, this.file);
                return;
            }
            catch (error) {
                lastError = error;
                const code = error.code;
                if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
                    break;
                // Back off briefly: the lock is short-lived or it is not a lock at all.
                await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
            }
        }
        throw new StoreError('write_failed', `状态写入失败（${this.file}）：${lastError.message}`, {
            cause: lastError,
        });
    }
    /** Find a session by id. */
    getSession(id) {
        return this.data.sessions.find((session) => session.id === id);
    }
    /**
     * Recent security events, oldest first.
     *
     * Returns an empty array when the store predates the field, so a caller never
     * has to distinguish "no events" from "old file" — both mean nothing to report.
     */
    getSecurityEvents() {
        return this.data.security ?? [];
    }
    /**
     * Every stored approval, oldest first.
     *
     * Returns an empty array when the store predates the field. A caller must not
     * read "empty" as "no approval needed" — the publish path treats a missing record
     * as a refusal, and this accessor only answers "what is on file".
     */
    getApprovals() {
        return this.data.approvals ?? [];
    }
    /**
     * Append one security event, keeping the newest `limit`.
     *
     * The cap is enforced here rather than by the caller so a store written by any
     * path stays bounded: an attacker who can post a thousand times must not be able
     * to grow this file without limit.
     */
    async appendSecurityEvent(event, limit) {
        await this.mutate((data) => {
            const existing = data.security ?? [];
            // An event with a duplicate id would mean two writers raced on the same
            // counter; dropping the new one keeps the log append-only and honest about
            // what it actually observed.
            if (existing.some((row) => row.id === event.id))
                return data;
            const next = [...existing, event];
            const bounded = limit > 0 && next.length > limit ? next.slice(next.length - limit) : limit === 0 ? [] : next;
            return { ...data, security: bounded };
        });
    }
    /** Sessions for one thread, newest first. */
    sessionsForThread(threadId) {
        return this.data.sessions
            .filter((session) => session.threadId === threadId)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    /** The dedupe record for a trigger, if any. */
    findDedupe(key) {
        return this.data.dedupe.find((record) => record.key === key);
    }
    /**
     * How much live work is open, against the cap.
     *
     * Exposed as a method rather than by publishing `options`, so a caller cannot read
     * the config object and then compute capacity differently from `prune`.
     */
    capacity() {
        return activeSessionCapacity(this.data, this.options);
    }
    /**
     * Publish activity for one thread, counted from the permanent ledger.
     *
     * Deliberately not computed from sessions: a session is pruned after the TTL, and
     * counting there let the per-thread cap reset itself — the plugin would happily
     * exceed `maxPublishesPerThread` simply because the earlier sessions had aged out.
     *
     * `unresolved` is reported separately because a `pending` publish is not evidence
     * of a sent reply, but it is not evidence of a free slot either; the caller decides
     * how conservative to be with it.
     */
    /**
     * Publish activity for one thread **on one platform**.
     *
     * The platform is part of the scope because thread ids are not globally unique:
     * `tieba/12345` and `weibo/12345` are different conversations, and counting
     * them together would let activity on one platform exhaust the other's quota —
     * or, worse, let one platform's cooldown silently suppress a publish on another.
     *
     * The old signature took only `threadId` and matched every row with that id. It
     * was correct while there was one platform and became a cross-platform bug the
     * moment a second one existed.
     *
     * @param platform the platform id; must be passed explicitly
     * @param threadId the thread id, unique only within the platform
     */
    threadPublishActivity(platform, threadId) {
        let confirmed = 0;
        let unresolved = 0;
        let lastConfirmedAt;
        for (const record of this.data.dedupe) {
            // Both columns must match. A record written before the platform column
            // existed would have platform `'tieba'` (every pre-0.2.0 row), so old rows
            // keep counting for tieba and never for another platform.
            if (record.platform !== platform)
                continue;
            if (record.threadId !== threadId)
                continue;
            if (record.publishState === 'confirmed') {
                confirmed += 1;
                const stamp = Date.parse(record.decidedAt ?? record.firstSeenAt);
                if (Number.isFinite(stamp) && (lastConfirmedAt === undefined || stamp > lastConfirmedAt)) {
                    lastConfirmedAt = stamp;
                }
            }
            else if (record.publishState === 'pending') {
                unresolved += 1;
            }
        }
        return { confirmed, unresolved, lastConfirmedAt };
    }
    /** Usage totals. */
    usageSummary() {
        let inputTokens = 0;
        let outputTokens = 0;
        let failures = 0;
        for (const row of this.data.usage) {
            inputTokens += row.inputTokens;
            outputTokens += row.outputTokens;
            if (row.error)
                failures += 1;
        }
        return { calls: this.data.usage.length, inputTokens, outputTokens, failures };
    }
}
/**
 * Validate a parsed store document.
 *
 * Deliberately total: it either returns the document unchanged or explains why it
 * cannot be trusted. There is no "fill in the missing array" branch, because a
 * null `dedupe` array is indistinguishable from "every publish record was lost" —
 * and losing those records is how the plugin re-posts replies it already sent.
 *
 * @param value the parsed JSON
 * @returns the validated document, or the reason it was rejected
 */
export function validateStore(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, reason: '不是对象' };
    }
    const record = value;
    if (!('version' in record))
        return { ok: false, reason: '缺少 version 字段' };
    if (record.version !== 1) {
        // A future version may carry fields this build would silently drop, so it is a
        // refusal, not a downgrade. An older version would need an explicit migration
        // function; none exists yet, so it is also a refusal.
        return {
            ok: false,
            reason: `的 version 是 ${JSON.stringify(record.version)}，本版本只认识 1。` +
                '为避免丢失未知字段或误解旧格式，插件不会自动降级；请备份后手动处理或删除该文件。',
        };
    }
    for (const field of ['sessions', 'dedupe']) {
        if (!(field in record))
            return { ok: false, reason: `缺少 ${field} 字段` };
        if (!Array.isArray(record[field])) {
            return {
                ok: false,
                reason: `的 ${field} 不是数组（${JSON.stringify(record[field])}）`,
            };
        }
    }
    // `usage` is bookkeeping only: losing it costs a cost report, never a duplicate
    // post. It is allowed to be absent and is repaired to an empty list.
    if ('usage' in record && !Array.isArray(record.usage)) {
        return { ok: false, reason: `的 usage 不是数组（${JSON.stringify(record.usage)}）` };
    }
    const sessions = record.sessions;
    for (const [index, session] of sessions.entries()) {
        const problem = validateSession(session);
        if (problem)
            return { ok: false, reason: `的第 ${index} 个会话${problem}` };
    }
    const dedupe = record.dedupe;
    for (const [index, entry] of dedupe.entries()) {
        const problem = validateDedupe(entry);
        if (problem)
            return { ok: false, reason: `的第 ${index} 条去重记录${problem}` };
    }
    // A malformed approval is *dropped*, not repaired and not refused.
    //
    // Repairing it would invent authorisation from a damaged record, which is the one
    // direction that ends in a wrongly-published reply. Dropping is fail-closed: the
    // publish path treats "no record" as "not approved" and asks the owner again, which
    // costs one click. Refusing the whole document would be worse than either — a single
    // bad row would make the store unreadable and take the publish ledger with it.
    const approvals = (Array.isArray(record.approvals) ? record.approvals : []).filter((entry) => validateApproval(entry) === undefined);
    return {
        ok: true,
        data: {
            version: 1,
            sessions: sessions,
            dedupe: dedupe,
            usage: Array.isArray(record.usage) ? record.usage : [],
            // Same failure as `prune()`: this rebuilds the document field by field, so
            // anything omitted here is lost on read. `approvals` was omitted, which meant an
            // approval written by the settings page disappeared the moment the plugin
            // restarted — and the publish path then reported "no approval on file" for a
            // record the owner had demonstrably created minutes earlier.
            //
            // Both are optional-by-design (a v0.2.2 store has neither), so absent is
            // repaired to an empty list rather than refused. Validated below when present.
            security: Array.isArray(record.security) ? record.security : [],
            approvals,
        },
    };
}
/** A session must at least carry the fields publishing depends on. */
function validateSession(value) {
    if (typeof value !== 'object' || value === null)
        return '不是对象';
    const session = value;
    for (const field of ['id', 'platform', 'threadId', 'triggerPostId', 'state']) {
        if (typeof session[field] !== 'string')
            return `缺少字符串字段 ${field}`;
    }
    if (!Array.isArray(session.candidates))
        return '的 candidates 不是数组';
    if (!Array.isArray(session.publishedPostIds))
        return '的 publishedPostIds 不是数组';
    return undefined;
}
/**
 * A dedupe record is the publish guard, so it is validated hardest.
 *
 * A row without `key` cannot match any trigger and would silently allow a re-post;
 * one with an unknown `publishState` cannot be interpreted as "already sent".
 */
function validateDedupe(value) {
    if (typeof value !== 'object' || value === null)
        return '不是对象';
    const entry = value;
    for (const field of ['key', 'platform', 'threadId', 'ownerKey', 'triggerPostId', 'sessionId']) {
        if (typeof entry[field] !== 'string' || entry[field].length === 0) {
            return `缺少非空字符串字段 ${field}`;
        }
    }
    if ('publishState' in entry && entry.publishState !== undefined) {
        const state = entry.publishState;
        if (state !== 'pending' && state !== 'confirmed' && state !== 'failed') {
            return `的 publishState 是未知值 ${JSON.stringify(state)}`;
        }
    }
    return undefined;
}
/**
 * A stored approval must carry every field the binding comparison reads.
 *
 * Missing one would make the comparison silently pass on that dimension: an
 * `undefined === undefined` on `assessmentFingerprint` would let an approval for one
 * assessment authorise a different one. So a row that cannot answer every question is
 * dropped rather than loaded with holes.
 */
function validateApproval(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return '不是对象';
    const entry = value;
    for (const field of [
        'id',
        'sessionId',
        'candidateId',
        'platform',
        'targetPostId',
        'publishingAccount',
        'textHash',
        'assessmentFingerprint',
        'grantedBy',
        'grantedAt',
    ]) {
        if (typeof entry[field] !== 'string')
            return `缺少字符串字段 ${field}`;
    }
    // An empty id cannot be consumed by id, and an unparseable timestamp cannot be
    // expiry-checked — both would be permanently-valid free passes.
    if (entry.id.length === 0)
        return 'id 为空';
    if (!Number.isFinite(Date.parse(entry.grantedAt)))
        return '的 grantedAt 不是时间戳';
    if (typeof entry.candidateVersion !== 'number' || !Number.isFinite(entry.candidateVersion)) {
        return '缺少数字字段 candidateVersion';
    }
    if ('consumedAt' in entry && entry.consumedAt !== undefined && typeof entry.consumedAt !== 'string') {
        return '的 consumedAt 不是字符串';
    }
    if ('revokedAt' in entry && entry.revokedAt !== undefined && typeof entry.revokedAt !== 'string') {
        return '的 revokedAt 不是字符串';
    }
    return undefined;
}
/**
 * Drop expired sessions and trim unbounded lists.
 *
 * Two rules, and both exist because breaking them has already caused real bugs:
 *
 * **1. Publish records are never dropped silently.**
 *
 * A session is a working scratchpad and may expire. A dedupe row is the permanent
 * fact "this trigger was already answered", and deleting it is precisely how the same
 * summon gets answered twice — the guard would be gone while the platform still shows
 * the first reply.
 *
 * The previous version capped the array with `.slice(-maxDedupe)`, which discards the
 * *oldest* rows — precisely the most established publish records. A 2001-row store
 * silently forgot its first publish. Now:
 *
 * - `confirmed` and `pending` rows are never removed by pruning, whatever the count;
 * - only `failed` rows (nothing was sent) age out with the session TTL;
 * - exceeding the soft cap is *reported* (see {@link publishLedgerOverCapacity}) and
 *   never enforced by deletion, because a duplicate post costs far more than a few
 *   kilobytes of ledger.
 *
 * **2. `maxSessions` caps *terminal* sessions only.**
 *
 * The previous version filtered out expired terminal sessions and then applied
 * `.slice(-maxSessions)` to whatever remained — which still contained live work. With
 * `maxSessions: 1`, creating a second `READY` session silently deleted the first one:
 * a draft the user was part-way through reviewing simply vanished, and because the
 * ledger row survived it, the trigger looked "never analysed" while its candidate was
 * unrecoverable.
 *
 * Now the cap applies to finished sessions only. Live sessions — anything the user or
 * the plugin may still act on — are always kept, even past the cap. Over-capacity is
 * reported by {@link activeSessionCapacity} so the caller can refuse to start new work
 * instead of sacrificing data, which is the trade this plugin must never make
 * automatically.
 */
function prune(data, options) {
    const now = Date.now();
    const ttl = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    const maxSessions = options.maxSessions ?? 200;
    const maxUsage = options.maxUsageRows ?? 500;
    // Live sessions pass through untouched; finished ones may expire.
    const live = [];
    const terminal = [];
    for (const session of data.sessions) {
        if (!TERMINAL_STATES.includes(session.state)) {
            live.push(session);
            continue;
        }
        const updated = Date.parse(session.updatedAt);
        // An expired finished session is dropped outright and never enters the cap pool.
        if (Number.isFinite(updated) && now - updated >= ttl)
            continue;
        terminal.push(session);
    }
    // Only the finished-and-kept pool is subject to the cap. `slice(-maxSessions)` keeps
    // the most recent, which is the right end to keep for history — nothing live is in
    // this list, so nothing can be lost that the user was still working on.
    const keptTerminal = terminal.slice(Math.max(0, terminal.length - maxSessions));
    // Rebuild in the original order so ids, ordering and any external reasoning about
    // "the newest session" stay meaningful.
    const surviving = new Set([...live, ...keptTerminal]);
    const sessions = data.sessions.filter((session) => surviving.has(session));
    // Publish records are kept whole, in original order.
    const dedupe = data.dedupe.filter((record) => {
        // Unknown-outcome and already-sent publishes are permanent.
        if (record.publishState === 'pending')
            return true;
        if (record.publishState === 'confirmed')
            return true;
        // `failed` sent nothing, so it only needs to outlive a would-be retry.
        const seen = Date.parse(record.firstSeenAt);
        return !Number.isFinite(seen) || now - seen < ttl;
    });
    const usage = data.usage.slice(-maxUsage);
    // `security` and `approvals` must survive this function.
    //
    // It returns a *fresh* document rather than mutating the old one, so any field it
    // forgets to carry is silently erased by the very next write. `approvals` was added
    // in v0.2.5 and not carried here, which meant every approval record vanished on the
    // next mutation — and since the publish path *writes a ledger row* before sending,
    // the record was gone before it could ever be checked. The failure mode was a
    // refusal that looked like "the owner never approved", with a record sitting in
    // memory that had demonstrably been created.
    //
    // `security` had the same latent bug from v0.2.3; the panel simply reads through a
    // different accessor that re-reads from disk, so it showed an empty log instead of
    // crashing. Both are fixed here, and `PRESERVED_FIELDS` below is asserted against
    // `StoreData` in the tests so a future field cannot repeat this.
    return {
        version: 1,
        sessions,
        dedupe,
        usage,
        security: data.security ?? [],
        approvals: pruneApprovals(data.approvals ?? [], () => now),
    };
}
/**
 * Every field of {@link StoreData}.
 *
 * `prune()` builds a new document by hand, so a field it omits is destroyed on the
 * next write. Listing them here lets a test assert that this list covers the
 * interface: adding a field to `StoreData` without deciding what happens to it in
 * `prune()` now fails loudly instead of losing data quietly.
 */
export const PRESERVED_FIELDS = ['version', 'sessions', 'dedupe', 'usage', 'security', 'approvals'];
/**
 * How many sessions are still actionable, and whether that exceeds the cap.
 *
 * The cap bounds *finished* history, not live work (see {@link prune}). Live sessions
 * are counted separately so a caller can refuse to start another task instead of
 * dropping one the user has not finished with.
 *
 * @param data the store document
 * @param options the store options
 * @returns live count, the cap, and whether starting more work would exceed it
 */
export function activeSessionCapacity(data, options) {
    const cap = options.maxSessions ?? 200;
    const live = data.sessions.filter((session) => !TERMINAL_STATES.includes(session.state));
    return {
        active: live.length,
        cap,
        full: live.length >= cap,
        activeIds: live.map((session) => session.id),
    };
}
/**
 * Whether the publish ledger has outgrown its soft capacity.
 *
 * Reported rather than enforced: deleting a publish record to save space trades a
 * duplicate post for a few kilobytes, which is not a trade worth making
 * automatically. The caller surfaces this so a human can archive consciously.
 */
export function publishLedgerOverCapacity(data, options) {
    const cap = options.maxDedupeRows ?? 2000;
    return { over: data.dedupe.length > cap, rows: data.dedupe.length, cap };
}
/**
 * Render the canonical id for one summoning event.
 *
 * Stable across nickname changes, avatar changes, restarts, concurrent runs and
 * version upgrades — which is the whole point. See {@link TriggerIdentity}.
 *
 * @param identity the platform-scoped event coordinates
 * @returns the canonical id, safe to use as a ledger key
 */
export function canonicalTriggerId(identity) {
    const event = identity.eventId && identity.eventId.length > 0 ? identity.eventId : 'na';
    return `${identity.platform}:${identity.threadId}:${identity.triggerPostId}:${event}`;
}
/**
 * Build the ledger key for one trigger event.
 *
 * `ownerKey` is accepted and ignored. It stays in the signature because every caller
 * still has one to hand and because the field remains meaningful *on the record* — it
 * says who the owner was — but it must not reach the key: `ownerKey` is a display name
 * whenever the platform exposed no numeric id, and a name that can be edited cannot
 * anchor idempotency.
 *
 * @param input event coordinates; `ownerKey` is deliberately unused
 * @returns the canonical trigger id
 */
export function dedupeKey(input) {
    return canonicalTriggerId({
        platform: input.platform,
        threadId: input.threadId,
        triggerPostId: input.triggerPostId,
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    });
}
/**
 * Find every ledger row that belongs to one canonical trigger, old scheme or new.
 *
 * This is the compatibility bridge. A user upgrading from 0.1.4 may hold rows keyed
 * by `platform:thread:昵称:trigger:na`; if the analysis only looked up the new
 * canonical key it would find nothing and re-offer a reply for a summon already
 * answered. So the match is made on the **explicit columns** — `platform`,
 * `threadId`, `triggerPostId` — which every version has written correctly, instead of
 * on the derived key string.
 *
 * Parsing the key was rejected on purpose: a nickname may itself contain a colon, so
 * "split and count fields" cannot tell a legacy key from a canonical one. The columns
 * are unambiguous.
 *
 * @param records the ledger
 * @param identity the canonical event
 * @returns every matching row, in ledger order
 */
export function findTriggerRecords(records, identity) {
    return records.filter((record) => {
        if (record.platform !== identity.platform)
            return false;
        if (record.threadId !== identity.threadId)
            return false;
        if (record.triggerPostId !== identity.triggerPostId)
            return false;
        // When the event carries an explicit id, rows recorded under a different one are
        // a different event. Absent on either side is not a mismatch: only one version
        // may know about it.
        if (identity.eventId !== undefined && record.eventId !== undefined && record.eventId !== identity.eventId) {
            return false;
        }
        return true;
    });
}
/**
 * Combine several historical rows for one trigger into one verdict.
 *
 * Upgrading can surface more than one row for a single summon: a nickname change
 * before the upgrade left two. They may disagree, and the merge must never invent a
 * safer-looking answer than the evidence supports:
 *
 * - **confirmed wins outright.** Once a reply is known to be in the thread, no other
 *   row's state can be allowed to re-open publishing. If confirmed rows name different
 *   posts, that is contradictory history and needs a human.
 * - **pending with no confirmed means "outcome unknown".** It blocks, because a retry
 *   could duplicate a reply that did go out.
 * - **failed means nothing was sent**, so it is the only state that leaves the summon
 *   free to proceed — and only when no stronger row exists.
 *
 * @param records the rows found for one trigger
 * @returns the merged state, plus whether the evidence is contradictory
 */
export function mergeTriggerRecords(records) {
    if (records.length === 0)
        return { found: false };
    const confirmed = records.filter((record) => record.publishState === 'confirmed');
    const pending = records.filter((record) => record.publishState === 'pending');
    const earliest = records
        .map((record) => record.firstSeenAt)
        .filter((stamp) => Number.isFinite(Date.parse(stamp)))
        .sort()[0];
    if (confirmed.length > 0) {
        const ids = new Set(confirmed.map((record) => record.publishedPostId ?? ''));
        // Different post ids across confirmed rows mean the ledger cannot say which reply
        // is the real one. Publishing again on that basis is exactly the duplicate this
        // whole mechanism exists to prevent, so it is reported, not resolved.
        const conflicting = ids.size > 1;
        const postId = [...ids].find((id) => id.length > 0);
        return {
            found: true,
            publishState: 'confirmed',
            ...(postId ? { publishedPostId: postId } : {}),
            firstSeenAt: earliest ?? records[0].firstSeenAt,
            conflicting,
            ...(conflicting
                ? {
                    reason: '历史记录里有不止一条“已确认发表”，但记录的回复 ID 不一致，' +
                        '无法确定哪一条才是真实发出过的。已停止自动发布，请打开帖子人工核对。',
                }
                : {}),
        };
    }
    if (pending.length > 0) {
        return {
            found: true,
            publishState: 'pending',
            firstSeenAt: earliest ?? records[0].firstSeenAt,
            conflicting: false,
        };
    }
    return {
        found: true,
        // No confirmed and no pending row: `failed` if anything was tried, otherwise the
        // row exists but the publish never started. Both leave the summon free to proceed.
        publishState: records.some((record) => record.publishState === 'failed') ? 'failed' : undefined,
        firstSeenAt: earliest ?? records[0].firstSeenAt,
        conflicting: false,
    };
}
/** Create a session id that sorts by time and stays unique. */
export function newSessionId(seed) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const hash = [...seed].reduce((acc, char) => (acc * 31 + char.codePointAt(0)) >>> 0, 7);
    return `s${stamp}${hash.toString(36)}`;
}
/** Create a candidate id. */
export function newCandidateId(sessionId, index) {
    return `${sessionId}-c${index}`;
}
/**
 * Insert or merge a publish record.
 *
 * Merging, not replacing: the publish facts on a record are the reason it exists,
 * and a caller that omits one — the analysis path re-registering a trigger, for
 * instance — must not erase it by writing a blank row under the same key.
 *
 * `confirmed` is absorbing. Once a reply is known to be in the thread, no later
 * write may demote it to `pending` or `failed`, because both invite a retry, and
 * a retry after a confirmed publish is a duplicate post.
 *
 * @param records the current ledger
 * @param next the row to store
 * @returns a new ledger with the row inserted or merged
 */
export function upsertDedupe(records, next) {
    const index = records.findIndex((record) => record.key === next.key);
    if (index < 0)
        return [...records, next];
    const previous = records[index];
    const merged = {
        ...previous,
        ...next,
        // The first sighting is a historical fact; a later write cannot move it.
        firstSeenAt: previous.firstSeenAt || next.firstSeenAt,
        // An omitted field means "not stated here", which is weaker than what is
        // already recorded, so the stored value wins.
        ...(next.publishState === undefined && previous.publishState !== undefined
            ? { publishState: previous.publishState }
            : {}),
        ...(next.publishedPostId === undefined && previous.publishedPostId !== undefined
            ? { publishedPostId: previous.publishedPostId }
            : {}),
    };
    const copy = [...records];
    copy[index] =
        previous.publishState === 'confirmed' && merged.publishState !== 'confirmed'
            ? { ...merged, publishState: 'confirmed', publishedPostId: previous.publishedPostId }
            : merged;
    return copy;
}
/** Where the store lives when the caller does not say. */
export function defaultStoreDir(homeDir) {
    return join(homeDir, '.dsh', 'ai-debate');
}
/** Ensure a directory exists, resolving its absolute form. */
export async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
    return dirname(join(dir, 'x')).replace(/[\\/]x$/, '') || dir;
}
//# sourceMappingURL=store.js.map