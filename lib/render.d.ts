/**
 * Tool result rendering and JSON safety.
 *
 * Tool results must be *lossless JSON*: no `undefined` values, no functions, no
 * cycles. An object that carries an optional field left `undefined` looks fine
 * in TypeScript and fails at the Host boundary, so every result passes through
 * {@link jsonSafe} instead of being trusted.
 */
import type { ContentBlock } from './host.js';
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
export declare function jsonSafe(value: unknown): unknown;
/** Render a short title plus bullet lines as chat text. */
export declare function renderSummary(title: string, lines: readonly string[]): ContentBlock[];
/** Render a block of free text. */
export declare function renderText(text: string): ContentBlock[];
/** Format a progress bar from a fraction. */
export declare function progressBar(current: number, total: number, width?: number): string;
/** Truncate a string for a card title. */
export declare function ellipsis(text: string, limit: number): string;
/** Render an error result body. */
export declare function renderError(message: string, hint?: string): ContentBlock[];
//# sourceMappingURL=render.d.ts.map