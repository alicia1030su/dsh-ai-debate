/**
 * Context collection: turn a thread reference into a complete, structured
 * conversation graph.
 *
 * Design rule this module exists to enforce: **the model never reads raw HTML
 * and never sees a page it was not given**. Collection happens first, in code,
 * and everything afterwards works on typed records. That is what lets a small
 * model succeed — it receives a compact, already-correct structure instead of
 * being asked to reconstruct who replied to whom from a wall of text.
 *
 * Pagination lives here, on the *generic* adapter interface, not inside the
 * Tieba adapter. A second platform then gets correct paging, deduplication and
 * partial-result reporting for free, and cannot quietly implement "read page 1
 * and call it done".
 */
import { type Floor, type NestedReply, type PlatformAdapter, type ReplyContext, type Thread, type ThreadRef } from './types.js';
/** How much of a thread to collect. */
export interface CollectOptions {
    /** Hard cap on floor pages walked. */
    readonly maxPages?: number;
    /** Safety cap on floors kept. */
    readonly maxFloors?: number;
    /** How many floors get their nested replies fetched. */
    readonly nestedFloorLimit?: number;
    /** Fetch nested replies only for floors this predicate accepts. */
    readonly wantNested?: (floor: Floor) => boolean;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: CollectProgress) => void;
}
/** Progress of a collection run. */
export interface CollectProgress {
    readonly stage: 'thread' | 'floors' | 'nested' | 'done';
    readonly message: string;
    readonly current?: number;
    readonly total?: number;
}
/** Everything collected for one thread. */
export interface CollectedThread {
    readonly thread: Thread;
    readonly floors: readonly FloorWithNested[];
    /** True when every declared floor was read. */
    readonly complete: boolean;
    /** Floors the platform declares but that were not readable (usually deleted). */
    readonly missingCount?: number;
    /** Why the floor walk stopped, so callers can distinguish causes. */
    readonly stopReason?: StopReason;
    /** True when more pages were known to remain. */
    readonly truncated?: boolean;
    /** True when any floor's nested replies were read incompletely. */
    readonly nestedIncomplete?: boolean;
    /** Non-fatal problems, phrased for a human. */
    readonly issues: readonly string[];
}
/** A floor plus whatever nested replies were collected under it. */
export interface FloorWithNested {
    readonly floor: Floor;
    readonly nested: readonly NestedReply[];
    /** True when the platform's own count was reached. */
    readonly nestedComplete: boolean;
}
/**
 * Why a walk stopped.
 *
 * These are deliberately distinct: "the platform says that was the last page" and
 * "I hit my own page cap" produce the same short floor list but mean opposite
 * things about trustworthiness, and the UI has to be able to say which happened.
 */
export type StopReason = 
/** Every declared page was read. */
'last_page'
/** The walk's own `maxPages` was reached while more pages existed. */
 | 'page_cap'
/** A request failed. */
 | 'error'
/** A page was empty or contained only already-seen rows. */
 | 'exhausted'
/** A degraded source returned fewer rows than it claimed. */
 | 'degraded';
/** The outcome of walking every floor page. */
export interface FloorWalk {
    readonly floors: readonly Floor[];
    readonly declaredTotal?: number;
    readonly totalPages?: number;
    readonly pagesRead: number;
    readonly complete: boolean;
    readonly missingCount?: number;
    readonly error?: string;
    /** Why the walk ended; `page_cap` means the read is incomplete by definition. */
    readonly stopReason: StopReason;
    /** True when more pages were known to remain when the walk stopped. */
    readonly truncated: boolean;
}
/**
 * Walk every floor page of a thread through the generic adapter interface.
 *
 * Stops on any of: an error, an empty page, a page of only already-seen floors,
 * the declared last page, or the page cap. Deduplication is by post id, so a
 * platform that repeats the last floor on every page cannot inflate the count.
 */
export declare function walkFloors(adapter: PlatformAdapter, ref: ThreadRef, options?: {
    maxPages?: number;
    signal?: AbortSignal;
    onPage?: (page: number, collected: number) => void;
}): Promise<FloorWalk>;
/** Walk every page of nested replies under one floor. */
export declare function walkNested(adapter: PlatformAdapter, ref: ThreadRef, floor: Floor, options?: {
    maxPages?: number;
    signal?: AbortSignal;
}): Promise<{
    replies: readonly NestedReply[];
    complete: boolean;
    error?: string;
    degraded?: boolean;
}>;
/**
 * Collect a thread: metadata, every floor page, then nested replies for the
 * floors that matter.
 *
 * Partial success is a first-class outcome. A thread whose page 5 times out
 * returns everything from pages 1–4 plus an `issue` saying so, because a model
 * asked to help with an argument is better served by "here is most of it, and
 * here is exactly what is missing" than by a hard failure.
 */
export declare function collectThread(adapter: PlatformAdapter, ref: ThreadRef, options?: CollectOptions): Promise<CollectedThread>;
/**
 * Locate the exact post the owner pointed at, and return its neighbourhood.
 *
 * This is the entry point the trigger path uses: a URL with `?pid=` or an
 * explicit reply id resolves here, and an id that cannot be found is an
 * explicit error rather than a fallback to "the last floor".
 */
export declare function locateReply(adapter: PlatformAdapter, ref: ThreadRef, postId: string, signal?: AbortSignal): Promise<ReplyContext>;
/** Flatten a collected thread into one ordered timeline of posts. */
export interface TimelineEntry {
    readonly kind: 'floor' | 'nested';
    readonly postId: string;
    readonly floorNumber: number;
    readonly authorId?: string;
    readonly authorName?: string;
    /** Display order within the floor; floors use 0. */
    readonly order: number;
    readonly content: string;
    readonly createdAt?: string;
    readonly replyToName?: string;
    readonly relationUncertain?: boolean;
}
/** Build the ordered timeline the analyzer reads. */
export declare function buildTimeline(collected: CollectedThread): readonly TimelineEntry[];
/** Find an entry in a timeline by post id. */
export declare function findInTimeline(timeline: readonly TimelineEntry[], postId: string): TimelineEntry | undefined;
/** The floor that contains a timeline entry. */
export declare function floorOf(collected: CollectedThread, postId: string): FloorWithNested | undefined;
/** Throw a normalized error when a thread could not be read at all. */
export declare function assertCollected(collected: CollectedThread): void;
//# sourceMappingURL=collector.d.ts.map