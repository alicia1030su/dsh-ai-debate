/**
 * Tieba as a registered platform.
 *
 * This file is the *only* place that connects Tieba to the registry. The adapter
 * itself (`../tieba/adapter.js`) is unchanged from v0.1.13 — it was already a
 * competent `PlatformAdapter`, so the migration wraps it instead of rewriting
 * it.
 *
 * Everything platform-specific about Tieba lives on this side of the boundary:
 * its URL syntax, its host names, its capability matrix and its adapter options.
 * Nothing here is imported by `runtime.ts`, `publisher.ts` or `target.ts`.
 */
import type { PlatformAdapter } from '../../types.js';
import type { LegacyCapabilityFlags, PlatformCapabilityMatrix, PlatformContext, PlatformProvider } from '../contracts.js';
/** The registry id. Must equal the adapter's `id` and the config namespace. */
export declare const TIEBA_PLATFORM_ID = "tieba";
/**
 * Can this URL be handled by Tieba?
 *
 * Never throws: junk, empty strings and non-URL input all answer `false`, because
 * the registry asks every provider in turn and one malformed link must not stop
 * the others from being tried.
 */
export declare function tiebaCanHandleUrl(url: string): boolean;
/**
 * Tieba's capability matrix.
 *
 * Hand-written rather than derived from the legacy booleans, because Tieba is the
 * one platform whose behaviour has actually been measured — and the measurements
 * are not flattering. In particular:
 *
 * - `comment.publish` is `unverified`: the request shape and the logged-out
 *   refusal were verified, but a real logged-in publish never was.
 * - `event.mentions` is `unavailable`: no verified endpoint exists.
 * - `media.read` is `unavailable`: images are linked, never fetched.
 *
 * Writing these as `supported` would be the exact failure this version is meant
 * to prevent.
 */
export declare function tiebaCapabilities(declaredAt?: string): PlatformCapabilityMatrix;
/** Tieba's legacy boolean flags, for any caller still reading the old shape. */
export declare function tiebaLegacyCapabilities(): LegacyCapabilityFlags;
/**
 * Build a Tieba adapter from a platform context.
 *
 * Kept here rather than in `runtime.ts` so the orchestration layer never imports
 * a concrete adapter class.
 */
export declare function createTiebaAdapter(context: PlatformContext): PlatformAdapter;
/** Tieba as the registry sees it. */
export declare const tiebaProvider: PlatformProvider;
//# sourceMappingURL=provider.d.ts.map