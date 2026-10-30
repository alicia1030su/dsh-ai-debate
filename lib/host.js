/**
 * Minimal structural types for the Host services this plugin uses.
 *
 * They are declared here rather than imported from `@deepseek-ai/dsh-*` so the
 * package compiles and packs without depending on a specific Harness build,
 * while still being exact about what is called. Anything not declared here is
 * not used.
 */
/** Read a logger from a context, tolerating contexts without one. */
export function loggerOf(ctx, name) {
    if (typeof ctx.logger === 'function')
        return ctx.logger(name);
    return {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    };
}
//# sourceMappingURL=host.js.map