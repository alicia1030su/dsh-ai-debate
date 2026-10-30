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
import type { WeiboCliStatus } from './cli.js';
/**
 * How long a *successful* plan stays fresh.
 *
 * Chosen to be long enough to cover a full analysis (one thread read plus several comment
 * pages) and short enough that a permission revoked in the console is noticed while the owner
 * is still looking at the page.
 */
export declare const READY_TTL_MS = 60000;
/**
 * How long a *recoverable* failure suppresses an automatic re-probe.
 *
 * This is not a cache of the failure as a fact — it is a rate limit on spawning processes. The
 * next read attempt after this window re-probes; until then it fails fast with the known
 * reason.
 */
export declare const FAILED_BACKOFF_MS = 15000;
/** Override the lifetimes. **Tests only**; call with `undefined` to restore the defaults. */
export declare function __setPlanCacheTimings(next: {
    readonly readyMs?: number;
    readonly backoffMs?: number;
} | undefined): void;
/** Whether a status may be retried automatically after the backoff window. */
export declare function isRecoverable(status: WeiboCliStatus): boolean;
/** One resolved probe, as the cache stores it. */
export interface CachedPlan<T> {
    readonly value: T;
    readonly status: WeiboCliStatus;
    /** Epoch millis when this entry stops being served without a re-probe. */
    readonly expiresAt: number;
    /** Monotonic counter, so a superseded probe can detect that it lost. */
    readonly generation: number;
}
/** Why a caller got the plan it got. Useful for the diagnostic panel and for tests. */
export type PlanSource = 
/** Freshly probed by this call. */
'probed'
/** Served from cache, still within its lifetime. */
 | 'cached'
/** A concurrent caller's probe was joined. */
 | 'joined'
/** The previous failure is still within its backoff window; no probe was run. */
 | 'backoff';
/** The outcome of asking for a plan. */
export interface PlanResult<T> {
    readonly plan: T;
    readonly status: WeiboCliStatus;
    readonly source: PlanSource;
    /** When the next automatic probe may happen. */
    readonly retryAt?: number;
}
/** Options for one `get()`. */
export interface PlanRequest {
    /**
     * Ignore any cached result and probe now.
     *
     * This is what the diagnostic panel's refresh button uses. It is *controlled*: it runs one
     * probe and does not loop, and it still refuses to do anything but read local state.
     */
    readonly force?: boolean;
    /** Override the clock, for tests. */
    readonly now?: number;
}
/**
 * The cache.
 *
 * Deliberately not a class hierarchy — one small object with a `get()` and an `invalidate()`.
 */
export interface PlanCache<T> {
    readonly get: (request?: PlanRequest) => Promise<PlanResult<T>>;
    /**
     * Drop whatever is cached.
     *
     * Called when something outside this module proves the plan is stale: the account binding
     * changed, or the diagnostic panel asked for a refresh. The next `get()` probes.
     */
    readonly invalidate: () => void;
    /** Read the current entry without probing. */
    readonly peek: () => CachedPlan<T> | undefined;
}
/** Build a cache around a probe function. */
export declare function createPlanCache<T>(probe: () => Promise<{
    readonly plan: T;
    readonly status: WeiboCliStatus;
}>): PlanCache<T>;
//# sourceMappingURL=plan-cache.d.ts.map