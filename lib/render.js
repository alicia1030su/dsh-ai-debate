/**
 * Tool result rendering and JSON safety.
 *
 * Tool results must be *lossless JSON*: no `undefined` values, no functions, no
 * cycles. An object that carries an optional field left `undefined` looks fine
 * in TypeScript and fails at the Host boundary, so every result passes through
 * {@link jsonSafe} instead of being trusted.
 */
/**
 * Convert a value into lossless JSON.
 *
 * `undefined` object properties are dropped (they carry no information), while
 * `undefined` array entries become `null` so indices stay stable. `Date`
 * becomes an ISO string, and a cycle is replaced by a marker rather than
 * throwing — a result with a cycle is a bug, but a visible marker in the output
 * is more useful than a failed tool call.
 *
 * @param value any tool result
 * @returns the same data as plain JSON-safe values
 */
export function jsonSafe(value) {
    const seen = new WeakSet();
    /** Recursive walk with cycle tracking. */
    const walk = (current) => {
        if (current === null)
            return null;
        if (current === undefined)
            return null;
        const type = typeof current;
        if (type === 'string' || type === 'boolean')
            return current;
        if (type === 'number')
            return Number.isFinite(current) ? current : null;
        if (type === 'bigint')
            return String(current);
        if (type === 'function' || type === 'symbol')
            return null;
        if (current instanceof Date)
            return current.toISOString();
        if (Array.isArray(current)) {
            if (seen.has(current))
                return '[circular]';
            seen.add(current);
            const out = current.map((item) => walk(item));
            seen.delete(current);
            return out;
        }
        if (type === 'object') {
            const source = current;
            if (seen.has(source))
                return '[circular]';
            seen.add(source);
            const out = {};
            for (const [key, item] of Object.entries(source)) {
                // Dropping undefined properties keeps the object shape meaningful; a
                // `lastPostId: undefined` conveys nothing but breaks JSON typing.
                if (item === undefined)
                    continue;
                out[key] = walk(item);
            }
            seen.delete(source);
            return out;
        }
        return null;
    };
    return walk(value);
}
/** Render a short title plus bullet lines as chat text. */
export function renderSummary(title, lines) {
    const body = lines.filter(Boolean).join('\n');
    return [{ type: 'text', text: `${title}\n${body}` }];
}
/** Render a block of free text. */
export function renderText(text) {
    return [{ type: 'text', text }];
}
/** Format a progress bar from a fraction. */
export function progressBar(current, total, width = 10) {
    if (total <= 0)
        return '';
    const filled = Math.min(width, Math.max(0, Math.round((current / total) * width)));
    return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${current}/${total}`;
}
/** Truncate a string for a card title. */
export function ellipsis(text, limit) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
/** Render an error result body. */
export function renderError(message, hint) {
    return [{ type: 'text', text: hint ? `❌ ${message}\n提示：${hint}` : `❌ ${message}` }];
}
//# sourceMappingURL=render.js.map