/**
 * The credential mirror: the plugin's belief about the credential store.
 *
 * ## Why this is its own module
 *
 * Before v0.1.12 this logic lived inside `apply()` as three `let` bindings and
 * two nested closures, so it could only be tested through a local re-creation of
 * its own rule — and a test helper that re-implements a rule agrees with it even
 * when the rule is wrong. That is how v0.1.9's frozen empty mirror survived a
 * green suite. Two concrete defects came out of it:
 *
 * - A boolean `overlayStale` could not express the difference between "the store
 *   is empty" and "the store has not finished parsing", so an all-empty read
 *   cleared the flag and the empty mirror was cached for the process lifetime.
 * - Concurrent refreshes had no ordering, so a read that started before a save
 *   could land after it and install the pre-save value.
 *
 * A boolean cannot be tested for the property that matters. This module replaces
 * it with a `phase` — a closed set of facts that each mean something different to
 * every consumer — and gives every read a ticket so results can be ordered.
 *
 * ## What the store actually offers
 *
 * Verified against the shipped `@deepseek-ai/dsh-credentials-local` (Harness
 * 0.2.1-rc.2): the provider is constructed and registered by Cordis immediately,
 * and its `[Service.init]` generator then runs `await this.loadInitial()` — one
 * file read — before assigning `this.values`. There is:
 *
 * - **no** documented ready flag (`values` starts as `new Map()` and `text` as
 *   `undefined`, but neither is an initialization signal, and reading a private
 *   field would couple this plugin to another package's internals),
 * - **no** initialization-complete event (`credentials/reference-updated` fires
 *   only after a *write* commits),
 * - **no** way to ask "have you finished loading".
 *
 * So the honest design is the one point 5 of the brief asks for: **bounded
 * retries with an explicit timeout state**. See `timeout` below.
 */
import { type CredentialSeam, type SecretOverlay, type SecretRefName } from './secrets.js';
/**
 * What the mirror currently believes.
 *
 * The set is closed on purpose: every member gives a different answer to "may I
 * publish", and adding one forces the call sites to decide.
 *
 * Note what is **not** here: a plain "empty" concluded from a read. A read that
 * returns nothing cannot distinguish an empty store from an unparsed one — that
 * is the whole bug — so it may not claim `empty`. Only a write the store
 * confirmed (`commitClear`) proves emptiness, and only then is `empty` set.
 */
export type CredentialPhase = 
/** No read has completed yet; nothing is known. */
'unknown'
/** A read is in progress, or the warm-up window has not closed. */
 | 'loading'
/** The store answered with values: they are in force and publishable. */
 | 'ready'
/** The store answered consistently that it holds nothing. Proven, not assumed. */
 | 'empty'
/** The store claims a value it will not hand over. Never treated as ready. */
 | 'partial'
/** The read threw. The last confirmed overlay is kept. */
 | 'failed'
/**
 * The warm-up window closed without a conclusive answer.
 *
 * This is the explicit timeout state the design needs: the store returned
 * nothing on every attempt within the window, and "nothing" is ambiguous. It is
 * reported as its own phase so the settings page can say "尚未确认" instead of
 * the two lies available otherwise — "未配置" (claims a fact we do not have) or
 * "已配置 · 长度 0" (v0.1.10's original defect).
 */
 | 'timeout'
/** This deployment has no credential service at all; config is authoritative. */
 | 'unavailable';
/** The complete state a consumer reads. */
export interface CredentialMirrorState {
    readonly phase: CredentialPhase;
    /** Values in force. Preserved across failures; never guessed. */
    readonly overlay: SecretOverlay;
    /** References the store claimed but did not hand over. */
    readonly unresolved: readonly SecretRefName[];
    /** A human-readable reason, when `phase` describes a problem. */
    readonly error?: string;
    /**
     * Whether a terminal read has happened.
     *
     * `false` means "still warming up"; consumers that cannot wait must treat it
     * exactly like `loading`.
     */
    readonly settled: boolean;
    /** How many store reads have produced this state, for diagnostics. */
    readonly reads: number;
}
/**
 * The warm-up schedule, in milliseconds.
 *
 * Cumulative 900 ms. Sized from the two costs on the real path: parsing a few
 * kilobytes of YAML is sub-millisecond, but the process may also be waiting on
 * the file to appear while the user's own tooling rewrites it. Long enough to
 * cover a slow disk, short enough that opening the settings page never feels
 * stuck, and bounded so the cost is predictable.
 */
export declare const DEFAULT_WARMUP_DELAYS_MS: readonly number[];
/** What the mirror needs from the credential service. */
export type MirrorSeam = Pick<CredentialSeam, 'describe' | 'resolve'>;
/** Construction options. */
export interface CredentialMirrorOptions {
    /**
     * The credential seam, or `undefined` when this deployment has none.
     *
     * A function is accepted as well, because the service can appear after mount:
     * `credentials` is optional in this plugin's dependencies, so the seam is
     * looked up lazily on each read rather than captured once.
     */
    readonly seam: MirrorSeam | undefined | (() => MirrorSeam | undefined);
    /** Sleep, injected so tests can advance a fake clock. */
    readonly sleep: (ms: number) => Promise<void>;
    /** Warm-up schedule; defaults to {@link DEFAULT_WARMUP_DELAYS_MS}. */
    readonly delays?: readonly number[];
    /** An overlay to start with, so a failure before the first read keeps it. */
    readonly initialOverlay?: SecretOverlay;
    /** Called after every accepted state change (used to re-key the runtime). */
    readonly onSettled?: (state: CredentialMirrorState) => void;
}
/**
 * The mirror.
 *
 * One instance per plugin mount. Every read records the ticket it started under,
 * and only a newer ticket may install — so a read that began before a confirmed
 * write cannot resurrect the pre-write value, and a credential-change event can
 * discard in-flight work in one call.
 *
 * Reads are **not** serialized: they run concurrently and the newest wins. That
 * is the "refresh version number" approach in the brief, and it keeps a slow
 * warm-up from blocking a user-initiated save behind it.
 */
export declare class CredentialMirror {
    #private;
    constructor(options: CredentialMirrorOptions);
    /** The current state. Reading it never blocks and never mutates. */
    get state(): CredentialMirrorState;
    /** The overlay in force, for `resolveConfig` to fold in synchronously. */
    get overlay(): SecretOverlay;
    /** Whether a write is possible in this deployment. */
    get writable(): boolean;
    /**
     * Whether the credential state is proven well enough to publish under.
     *
     * Two rules, and which one applies depends on where the cookie came from:
     *
     * - **A cookie from the credential store** needs a conclusive read. The store
     *   is the thing that can be mid-initialization or have been rotated away, so
     *   only `ready` counts. A `timeout`, `partial` or `failed` phase means the
     *   plugin cannot tell an absent cookie from an unread one, and posting as a
     *   guessed identity is precisely the irreversible failure worth refusing.
     * - **A cookie from the config layer** does not. It is a static string the
     *   owner wrote in the patch; no read can make it more or less true, and a
     *   v0.1.5 setup with nothing in the store must keep working. This is why
     *   `unavailable` — a deployment with no credential service at all — can still
     *   publish.
     *
     * Either way a cookie has to actually exist: an empty overlay is not a
     * publishable state, because publishing needs an identity to verify against.
     */
    canPublish(): boolean;
    /**
     * Re-read the store, warming up while the answer stays ambiguous.
     *
     * Never rejects: every failure is classified into a phase, because a rejection
     * here would either be swallowed by the caller (hiding the problem) or escape
     * into a route handler that has already started writing a response.
     */
    refresh(): Promise<void>;
    /**
     * Install a value a confirmed write produced.
     *
     * Called by the save route *after* the store accepted the write, so this is a
     * fact rather than a belief — and bumping the ticket is what makes every read
     * started before the write obsolete, since such a read describes the old store.
     *
     * @param ref which reference was written
     * @param value the value the store confirmed
     */
    commit(ref: SecretRefName, value: string): void;
    /**
     * Install an empty value a confirmed clear produced.
     *
     * The only path that may claim `empty`, because a deletion the store confirmed
     * is proof, whereas a read that returns nothing is not.
     */
    commitClear(ref: SecretRefName): void;
    /**
     * Discard the result of every in-flight read.
     *
     * A credential-change event means the store already moved; any read still
     * running raced that change, so its answer is about the past.
     */
    invalidate(): void;
    /**
     * Stop permanently.
     *
     * In-flight reads install nothing afterwards and `onSettled` is never called
     * again, so a dispose during plugin unmount cannot re-key a runtime that the
     * caller has already dropped.
     */
    dispose(): void;
    /**
     * Adopt an overlay the caller computed from the config layer.
     *
     * Used when there is no credential service: the legacy config fields are the
     * whole story, and the mirror must not claim they came from the store. It is
     * also what keeps a v0.1.5 patch working unchanged.
     */
    adoptConfigFallback(overlay: SecretOverlay): void;
}
//# sourceMappingURL=credential-mirror.d.ts.map