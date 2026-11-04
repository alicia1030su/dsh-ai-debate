/**
 * Turn a collected thread into the list the workbench shows.
 *
 * ## Why this is a separate projection
 *
 * The collector keeps two things apart on purpose: the canonical reply list (one row
 * per comment, used for counts and publishing) and `identityObservations` (every
 * sighting, used only for identity verdicts). The workbench needs a third view: one
 * row per comment, carrying enough identity detail to *explain* itself, and nothing
 * else. Reusing either structure would drag its guarantees into a UI list, and the
 * two would drift.
 *
 * ## What this must never do
 *
 * - It must not merge the canonical list with raw observations. Two sightings of one
 *   comment are one comment; showing them as two rows would look like two people
 *   wrote it.
 * - It must not promote a nickname to an identity. `identity` is `verified` only when
 *   the record declared a usable source, and `conflicted` only when the collector saw
 *   two sources disagree.
 * - It must not pretend a truncated list is complete. `capped` is returned so the page
 *   can say so.
 */
import type { CollectedThread } from './collector.js';
import type { StoredComment } from './store.js';
export interface CommentList {
    readonly comments: readonly StoredComment[];
    /** Total rows the thread would have produced, before the cap. */
    readonly total: number;
    /** True when {@link comments} is shorter than {@link total}. */
    readonly capped: boolean;
    /** Post ids that the collector recorded an authorship conflict for. */
    readonly conflictedPostIds: readonly string[];
}
/**
 * Build the workbench comment list.
 *
 * Floors come first in floor order, each immediately followed by its nested replies,
 * so the list reads like the thread rather than like two concatenated arrays.
 */
export declare function buildCommentList(collected: CollectedThread): CommentList;
//# sourceMappingURL=comment-list.d.ts.map