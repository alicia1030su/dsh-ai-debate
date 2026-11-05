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
import { MAX_STORED_COMMENT_CHARS, MAX_STORED_COMMENTS } from './store.js';
function truncate(text) {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= MAX_STORED_COMMENT_CHARS)
        return { text: collapsed, truncated: false };
    return { text: `${collapsed.slice(0, MAX_STORED_COMMENT_CHARS)}…`, truncated: true };
}
function identityOf(options) {
    if (options.conflicted)
        return 'conflicted';
    // ## A source label is not an identity
    //
    // v0.2.25 returned `verified` whenever `authorSource` was set, and `comment_page`
    // always sets one — even for a row that carries no `username` and no numeric id. The
    // workbench then labelled 「路过的匿名 · 身份已核验」, which claims to know who spoke
    // when the only thing known is where the row came from.
    //
    // Verified now requires an actual identifier: a login name or a numeric account id.
    // Provenance alone says the *source* is trustworthy, not that the author is known.
    const hasIdentifier = (options.authorId !== undefined && options.authorId !== '') ||
        (options.numericUid !== undefined && options.numericUid !== '');
    if (!hasIdentifier)
        return 'unverified';
    if (options.authorSource === undefined || options.authorSource === '')
        return 'unverified';
    return 'verified';
}
/**
 * Build the workbench comment list.
 *
 * Floors come first in floor order, each immediately followed by its nested replies,
 * so the list reads like the thread rather than like two concatenated arrays.
 */
export function buildCommentList(collected) {
    const conflictedPostIds = (collected.identityConflicts ?? []).map((entry) => entry.postId);
    const conflicted = new Set(conflictedPostIds);
    const rows = [];
    /**
     * The opening post, when the platform models it as a post of its own (v0.2.28).
     *
     * Listed first and selectable, because on a microblog it is the thing every comment
     * hangs under — "reply to the post" and "reply to a comment" are different actions,
     * and the workbench could only express the second one. It carries no floor number:
     * a microblog does not number its posts, and supplying one would print 「第 0 楼」.
     */
    if (collected.thread.bodyNode === 'standalone') {
        const thread = collected.thread;
        const body = truncate(thread.content ?? '');
        rows.push({
            postId: thread.id,
            kind: 'floor',
            ...(thread.authorName === undefined ? {} : { authorName: thread.authorName }),
            ...(thread.authorId === undefined ? {} : { authorHandle: thread.authorId }),
            ...(thread.authorNumericUid === undefined ? {} : { authorNumericUid: thread.authorNumericUid }),
            ...(thread.authorNumericUidKind === undefined
                ? {}
                : { authorNumericUidKind: thread.authorNumericUidKind }),
            identity: identityOf({
                authorSource: thread.authorSource,
                conflicted: conflicted.has(thread.id),
                authorId: thread.authorId,
                numericUid: thread.authorNumericUid,
            }),
            text: body.text,
            ...(body.truncated ? { truncated: true } : {}),
            ...(thread.createdAt === undefined ? {} : { createdAt: thread.createdAt }),
        });
    }
    for (const entry of collected.floors) {
        const floor = entry.floor;
        const body = truncate(floor.content ?? '');
        rows.push({
            postId: floor.postId,
            floorNumber: floor.floorNumber,
            kind: 'floor',
            ...(floor.authorName === undefined ? {} : { authorName: floor.authorName }),
            ...(floor.authorId === undefined ? {} : { authorHandle: floor.authorId }),
            ...(floor.authorNumericUid === undefined ? {} : { authorNumericUid: floor.authorNumericUid }),
            ...(floor.authorNumericUidKind === undefined
                ? {}
                : { authorNumericUidKind: floor.authorNumericUidKind }),
            identity: identityOf({
                authorSource: floor.authorSource,
                conflicted: conflicted.has(floor.postId),
                authorId: floor.authorId,
                numericUid: floor.authorNumericUid,
            }),
            text: body.text,
            ...(body.truncated ? { truncated: true } : {}),
            ...(floor.createdAt === undefined ? {} : { createdAt: floor.createdAt }),
        });
        for (const reply of entry.nested) {
            const nestedBody = truncate(reply.content ?? '');
            rows.push({
                postId: reply.postId,
                parentPostId: reply.parentPostId,
                kind: 'nested',
                ...(reply.authorName === undefined ? {} : { authorName: reply.authorName }),
                ...(reply.authorId === undefined ? {} : { authorHandle: reply.authorId }),
                ...(reply.authorNumericUid === undefined ? {} : { authorNumericUid: reply.authorNumericUid }),
                ...(reply.authorNumericUidKind === undefined
                    ? {}
                    : { authorNumericUidKind: reply.authorNumericUidKind }),
                identity: identityOf({
                    authorSource: reply.authorSource,
                    conflicted: conflicted.has(reply.postId),
                    authorId: reply.authorId,
                    numericUid: reply.authorNumericUid,
                }),
                text: nestedBody.text,
                ...(nestedBody.truncated ? { truncated: true } : {}),
                ...(reply.createdAt === undefined ? {} : { createdAt: reply.createdAt }),
            });
        }
    }
    const total = rows.length;
    const capped = total > MAX_STORED_COMMENTS;
    return {
        comments: capped ? rows.slice(0, MAX_STORED_COMMENTS) : rows,
        total,
        capped,
        conflictedPostIds,
    };
}
//# sourceMappingURL=comment-list.js.map