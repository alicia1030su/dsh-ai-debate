/**
 * The Weibo read-plan cache.
 *
 * ## The bug this replaces (v0.2.13 §二)
 *
 * v0.2.12 cached the *promise* of the first probe forever:
 *
 *     if (planPromise === undefined) planPromise = resolveReadPlan()
 *     return planPromise
 *
 * Reproduced with the shipped build: probe once with the CLI absent → `cli_missing`; install
 * the CLI; the **same adapter** still answers `cli_missing` until the whole DSH process is
 * restarted. The user has no way to recover short of a restart, and the diagnostic panel keeps
 * reporting a state that stopped being true minutes ago.
 *
 * ## What the cache is now
 *
 * A small state machine with three distinct states:
 *
 * - **`ready`** — reads can run. Cached for a bounded time (`READY_TTL_MS`) so a long analysis
 *   does not re-probe for every comment page, but a revoked permission is noticed within
 *   minutes.
 * - **`failed`** — the last probe could not read. Carries a `retryAfter` instant: a *recoverable*
 *   failure (`cli_missing`, `not_authenticated`, `service_inactive`, `command_unavailable`,
 *   `quota_exhausted`) may be retried after a short cooldown. A failure is never cached
 *   permanently.
 * - **`probing`** — a probe is in flight. Concurrent callers share it, which is what keeps one
 *   analysis from spawning a dozen `weibo-cli` processes.
 *
 * ## Stale results must not win
 *
 * Every probe bumps `generation` before it starts. When it finishes it compares its own
 * generation with the current one; a probe that was superseded (by a forced refresh, or by a
 * failure that invalidated the cache) **discards its result** rather than overwriting newer
 * knowledge. Without this, a slow probe started before a manual refresh could land afterwards
 * and resurrect an outdated verdict.
 *
 * ## What is deliberately NOT here
 *
 * No login, no purchase, no OAuth flow. A failure is reported with its remedy; performing the
 * remedy is the owner's decision. Retrying is bounded and passive — it re-runs a probe, which
 * only reads local state.
 */
/**
 * How long a *successful* plan stays fresh.
 *
 * Chosen to be long enough to cover a full analysis (one thread read plus several comment
 * pages) and short enough that a permission revoked in the console is noticed while the owner
 * is still looking at the page.
 */
export const READY_TTL_MS = 60_000;
/**
 * How long a *recoverable* failure suppresses an automatic re-probe.
 *
 * This is not a cache of the failure as a fact — it is a rate limit on spawning processes. The
 * next read attempt after this window re-probes; until then it fails fast with the known
 * reason.
 */
export const FAILED_BACKOFF_MS = 15_000;
/**
 * Mutable durations, so a test can observe expiry without sleeping for real time.
 *
 * Same convention as `__setCliInvocation`: the defaults are the production values, and the only
 * way to change them is to import this module and call the setter. No setting, no environment
 * variable, no config field reaches it.
 */
let readyTtlMs = READY_TTL_MS;
let failedBackoffMs = FAILED_BACKOFF_MS;
/** Override the lifetimes. **Tests only**; call with `undefined` to restore the defaults. */
export function __setPlanCacheTimings(next) {
    readyTtlMs = next?.readyMs ?? READY_TTL_MS;
    failedBackoffMs = next?.backoffMs ?? FAILED_BACKOFF_MS;
}
/**
 * Statuses that a retry could plausibly fix without the plugin doing anything privileged.
 *
 * Every one of these is a local precondition: install a binary, log in, activate a service,
 * wait for credit, list a command. None of them can be repaired by retrying *alone*, which is
 * exactly why the retry is cheap and why the message must carry the remedy.
 */
const RECOVERABLE = new Set([
    'cli_missing',
    'not_authenticated',
    'service_inactive',
    'quota_exhausted',
    'command_unavailable',
    'failed',
]);
/** Whether a status may be retried automatically after the backoff window. */
export function isRecoverable(status) {
    return RECOVERABLE.has(status);
}
/** Build a cache around a probe function. */
export function createPlanCache(probe) {
    let entry;
    let inFlight;
    /**
     * Bumped on every *state-changing* event: a probe start, a forced refresh, an invalidation.
     *
     * A probe captures the value at start and refuses to publish if it has moved. This is the
     * defence against "slow probe started before a manual refresh lands afterwards and resurrects
     * an outdated verdict".
     */
    let generation = 0;
    const computeExpiry = (status, now) => status === 'ok' ? now + readyTtlMs : now + failedBackoffMs;
    const runProbe = async (now) => {
        const startedAt = ++generation;
        try {
            const result = await probe();
            const expiresAt = computeExpiry(result.status, Date.now());
            const candidate = {
                value: result.plan,
                status: result.status,
                expiresAt,
                generation: startedAt,
            };
            // ## The stale-result guard
            //
            // If a forced refresh or an invalidation bumped the generation while this probe was
            // running, its answer describes a world that has already been superseded. It is still
            // returned to *its own* caller (so that caller gets a definite answer rather than
            // hanging), but it does not become the cached truth.
            if (generation === startedAt)
                entry = candidate;
            return { plan: candidate.value, status: candidate.status, source: 'probed' };
        }
        catch (error) {
            // A thrown probe is a `failed` status, not a crash: the caller needs to render a
            // diagnostic, not a stack trace.
            const status = 'failed';
            void error;
            const expiresAt = computeExpiry(status, Date.now());
            const candidate = {
                // The probe is expected to return a plan even on failure; if it threw, there is none.
                value: undefined,
                status,
                expiresAt,
                generation: startedAt,
            };
            if (generation === startedAt)
                entry = candidate;
            return { plan: candidate.value, status, source: 'probed' };
        }
        finally {
            void now;
        }
    };
    const get = async (request = {}) => {
        const now = request.now ?? Date.now();
        if (request.force !== true && entry !== undefined) {
            // A concurrent caller joins the probe already running rather than starting another.
            if (inFlight !== undefined) {
                const joined = await inFlight;
                return { ...joined, source: 'joined' };
            }
            if (now < entry.expiresAt) {
                return { plan: entry.value, status: entry.status, source: 'cached' };
            }
            // Expired. A recoverable failure must be re-probed; an expired success too (its TTL ran
            // out, so we no longer know it still holds).
            if (entry.status !== 'ok' && !isRecoverable(entry.status)) {
                // An unrecoverable failure (e.g. a malformed response) is not retried automatically —
                // retrying would just repeat the same unparseable answer.
                return {
                    plan: entry.value,
                    status: entry.status,
                    source: 'backoff',
                    retryAt: entry.expiresAt,
                };
            }
        }
        if (inFlight !== undefined) {
            const joined = await inFlight;
            return { ...joined, source: 'joined' };
        }
        // A forced refresh invalidates first, so the guard can tell that a probe which started
        // before the force must not win.
        if (request.force === true)
            generation += 1;
        inFlight = runProbe(now);
        try {
            return await inFlight;
        }
        finally {
            inFlight = undefined;
        }
    };
    return {
        get,
        invalidate: () => {
            generation += 1;
            entry = undefined;
        },
        peek: () => entry,
    };
}
//# sourceMappingURL=plan-cache.js.map