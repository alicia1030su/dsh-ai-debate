/**
 * Shared, platform-neutral data model.
 *
 * Nothing in this module may know about Tieba: HTML selectors, WAP URLs and
 * forum-specific quirks belong to `src/platforms/tieba/`. Everything here is
 * the vocabulary the agent core (analysis, generation, sessions, publishing)
 * speaks, so a second platform can be added without touching it.
 */
/** An error carrying a normalized platform code. */
export class PlatformError extends Error {
    code;
    status;
    retryAfterMs;
    constructor(message, code, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'PlatformError';
        this.code = code;
        this.status = options.status;
        this.retryAfterMs = options.retryAfterMs;
    }
    /** True when retrying the same request could plausibly succeed. */
    get retryable() {
        return this.code === 'network' || this.code === 'timeout' || this.code === 'rate_limited';
    }
}
//# sourceMappingURL=types.js.map