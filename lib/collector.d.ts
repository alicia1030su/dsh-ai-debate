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
/**
 * The four independent things "complete" used to mean, separated.
 *
 * v0.2.1 had one boolean `complete`, and it answered every question at once. The
 * problem is that they genuinely differ: a thread can be read perfectly from the
 * platform and then trimmed to the first floor by `maxFloors`, and the old flag
 * stayed `true` — the data handed to the model was *not* the thread, while the
 * plugin said the read was complete.
 *
 * Reproduced before this change: a platform returns 3 floors, `maxFloors: 1`, and
 * `complete` was still `true`.
 *
 * Keeping them apart is what lets each one be honest:
 *
 * | field | question it answers |
 * | --- | --- |
 * | `sourceComplete` | did the platform's own evidence prove we saw all of it? |
 * | `retainedComplete` | did we *keep* everything we read? |
 * | `analysisComplete` | is the dispute chain we need actually present? |
 * | `nestedComplete` | were the sub-comments under each floor fully read? |
 *
 * `sourceComplete` can be true while `retainedComplete` is false (read 3, kept 1
 * by cap) — that combination is exactly what v0.2.1 could not express, and it is
 * the one that matters most: the model must be told that replies exist which it
 * has not seen, so it cannot invent them.
 */
export interface CompletenessReport {
    /** The platform's evidence proves the floor list was read in full. */
    readonly sourceComplete: boolean;
    /** Everything read was kept; no cap, trim or sampling dropped anything. */
    readonly retainedComplete: boolean;
    /** The argument chain needed to answer is present, so publishing is safe. */
    readonly analysisComplete: boolean;
    /** Every floor's nested replies were read to the platform's declared count. */
    readonly nestedComplete: boolean;
    /** Floors the platform declares that could not be read (usually deleted). */
    readonly missingCount?: number;
    /** Floors dropped locally by `maxFloors`, stated so nothing is silently lost. */
    readonly droppedByCap?: number;
    /** Fraction of declared floors retained, when a total was declared. */
    readonly retainedRatio?: number;
    /** Why any of the above is false, phrased for a human. */
    readonly reasons: readonly string[];
}
/** Everything collected for one thread. */
export interface CollectedThread {
    readonly thread: Thread;
    readonly floors: readonly FloorWithNested[];
    /**
     * True when every declared floor was read *and* kept.
     *
     * Kept as a single flag for v0.2.x callers. v0.2.2 made it strictly stronger
     * than before: it is now the conjunction of `sourceComplete` and
     * `retainedComplete`, so a capped read no longer reports `true`. New code
     * should read {@link completeness} instead, which says which part failed.
     */
    readonly complete: boolean;
    /** The separated verdicts. Always present on a v0.2.2 or later read. */
    readonly completeness: CompletenessReport;
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
 *
 * **Only `confirmed_end` is positive evidence that the read is complete.** Every
 * other value means the walk ended without proving there was nothing more —
 * including `empty_page` and `repeated_page`, which v0.2.0 treated as a normal
 * end. That was the bug: a platform that returned nothing on page 1, or repeated
 * the same rows until the walk gave up, produced `complete: true` on the strength
 * of having read no data at all.
 */
export type StopReason = 
/** The platform stated this was the last page, or the declared total was reached. */
'confirmed_end'
/** A page came back empty, with no declared total to corroborate it. */
 | 'empty_page'
/** A page contained only rows already seen, with no declared total to corroborate it. */
 | 'repeated_page'
/** The walk's own `maxPages` was reached while more pages existed. */
 | 'page_cap'
/** A request failed outright. */
 | 'request_error'
/** The platform rate-limited the channel. */
 | 'rate_limited'
/** A degraded source returned fewer rows than it claimed. */
 | 'degraded'
/** The platform reports the content as deleted or unavailable. */
 | 'deleted_or_unavailable'
/**
 * The platform's own pagination signals contradict each other.
 *
 * v0.2.2: a platform that declares `declaredTotalPages: 8` and then answers
 * page 1 with `hasMore: false` used to be taken at its word — the walk stopped
 * with `pagesRead: 1, complete: true, stopReason: 'confirmed_end'`. Two
 * mutually exclusive claims ("there are 8 pages" / "page 1 was the last") were
 * resolved in favour of whichever field the code happened to read first.
 *
 * Neither claim can be trusted alone once they conflict, so the read is neither
 * complete nor failed: it is *inconsistent*, and saying so is the only honest
 * answer. The data read so far is kept.
 */
 | 'inconsistent_pagination'
/** The walk ended for a reason this module cannot classify. */
 | 'unknown';
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
    /**
     * Human-readable notes about coverage, including signal contradictions.
     *
     * v0.2.2: the walk can end while platform signals disagree, and that fact is
     * worth keeping even though `stopReason` already names it, because the caller
     * has to be able to tell the user *which* numbers disagreed.
     */
    readonly issues: readonly string[];
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
    /**
     * The floor this entry belongs to, by the floor post's stable id.
     *
     * v0.2.1: this is the grouping key. It used to be `floorNumber`, which forced
     * any non-forum platform to invent a number so that a microblog post and its
     * comments could be told apart from the next one. The post id already
     * identifies the floor uniquely on every platform and needs no invention, so
     * the core groups on it and `floorNumber` is left for display only.
     */
    readonly floorPostId: string;
    /** The number the platform displays for the floor, when it displays one. */
    readonly floorNumber?: number;
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
/**
 * How to name a floor in human-facing text.
 *
 * v0.2.1: `floorNumber` is optional — a microblog has no 楼层 — so every message
 * that used to interpolate `${floorNumber} 楼` could print "第 undefined 楼".
 * One helper keeps that from coming back: the label is a number when the
 * platform gives one, and the post id when it does not.
 */
export declare function floorLabel(floorNumber: number | undefined, postId: string): string;
/** Find an entry in a timeline by post id. */
export declare function findInTimeline(timeline: readonly TimelineEntry[], postId: string): TimelineEntry | undefined;
/** The floor that contains a timeline entry. */
export declare function floorOf(collected: CollectedThread, postId: string): FloorWithNested | undefined;
/** Throw a normalized error when a thread could not be read at all. */
export declare function assertCollected(collected: CollectedThread): void;
//# sourceMappingURL=collector.d.ts.map