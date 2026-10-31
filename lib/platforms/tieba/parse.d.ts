/**
 * HTML/JSON parsing for the Tieba reading surface.
 *
 * Pure functions only: a string in, structures out. No network, no state, no
 * clock. Every selector here was observed against the live site and is pinned
 * by a fixture in `test/fixtures/`, because a scraper that is only validated
 * against markup someone typed from memory is worse than no scraper at all.
 *
 * ## What Tieba actually exposes
 *
 * - The WAP thread page (`/mo/q/m?kz=<tid>&pn=<offset>`) is UTF-8 and carries
 *   the floor list: post id, floor number, author *username*, display name,
 *   body, date and image URLs.
 * - It does **not** carry a numeric user id for floors. The only stable handle
 *   the markup gives is the `un` (username) plus `portrait` token. Numeric ids
 *   appear only in the `totalComment` JSON, so identity binding has to accept
 *   either form.
 * - The thread title lives in `.post_title_embed`, and is empty for threads
 *   whose first post has no title. It is never fabricated.
 * - Nested replies are **not** inline on the WAP page. The floor only reports
 *   `data-list-count`; the actual replies come from `/p/comment`.
 */
import type { Floor, NestedReply } from '../../types.js';
/** Decode the entities Tieba emits inside attributes and text nodes. */
export declare function decodeEntities(input: string): string;
/** Strip tags and collapse whitespace, producing the plain text a reader sees. */
export declare function toPlainText(html: string): string;
/** The `page: {...}` metadata the WAP page embeds in a script. */
export interface WapPageMeta {
    readonly currentPage?: number;
    readonly totalPages?: number;
    readonly totalCount?: number;
    readonly pageSize?: number;
    readonly offset?: number;
}
/** Read the WAP paging metadata. */
export declare function parseWapPageMeta(html: string): WapPageMeta;
/** Thread-level metadata embedded in the WAP page. */
export interface WapThreadMeta {
    readonly forumId?: string;
    readonly forumName?: string;
    readonly title?: string;
    readonly tbs?: string;
}
/**
 * Read forum id/name, thread title and the CSRF token from a WAP page.
 *
 * The title comes from `.post_title_embed`; an empty one means the thread has
 * no title, which is a real state on Tieba (many threads are body-only).
 */
export declare function parseWapThreadMeta(html: string): WapThreadMeta;
/** One floor block located in the raw page, with its own byte range. */
interface FloorAnchor {
    readonly start: number;
    readonly end: number;
}
/**
 * Locate every first-level floor block.
 *
 * Nested `<li>` elements exist inside floors, so the split anchors on the
 * floor's own opening tag — the only one carrying `tid=` *and* `fn=`.
 */
export declare function findFloorAnchors(html: string): readonly FloorAnchor[];
/** One parsed floor. */
export interface ParsedFloor {
    readonly floor: Floor;
    /** Portrait token, used as a secondary identity handle. */
    readonly portrait?: string;
}
/**
 * Parse every floor in a WAP page, in platform display order.
 *
 * @param html the WAP thread page body
 * @returns parsed floors; floors whose opening tag cannot be read are skipped
 *   rather than guessed at
 */
export declare function parseWapFloors(html: string): readonly ParsedFloor[];
/** One nested reply parsed from `/p/comment` or read inline from a floor page. */
export interface ParsedNested {
    readonly reply: NestedReply;
    readonly portrait?: string;
}
/**
 * Read the nested replies that the WAP floor page inlines.
 *
 * The page is not a reliable full copy: measured on a live 219-floor thread it
 * inlined 21 of the 36 replies the platform declared, and its
 * `data-list-count` attribute often reported 0 for floors that do have replies.
 * So this is a *degraded* source that is used only when the paginated channel is
 * unreachable, and the caller must compare against {@link readNestedCount} to
 * learn whether anything is missing.
 *
 * The relation is read the same way as the HTML channel: from the "回复 X :"
 * prefix inside `.floor_content`. The `user_name` anchor that precedes it is the
 * author of *this* reply, never the person being answered.
 *
 * @param block one floor's raw markup
 * @param floorPostId the floor these replies hang under
 * @returns the replies in display order; empty when the floor inlines none
 */
export declare function parseInlineNested(block: string, floorPostId: string): readonly ParsedNested[];
/** Result of one `/p/comment` page. */
export interface ParsedCommentPage {
    readonly replies: readonly ParsedNested[];
    readonly total: number;
    readonly totalPages: number;
}
/**
 * Parse a `/p/comment` page.
 *
 * ## Reading reply relations honestly
 *
 * The markup gives two different names, and they mean opposite things:
 *
 * - The leading `<a class="at j_user_card">DISPLAY</a>:` before the body names
 *   the **author of this reply** (its `username` is that author's account).
 *   Treating it as the reply target would make every conversation look like
 *   people answering themselves — a real bug this parser had and now pins
 *   with a fixture-based test.
 * - The body prefix `回复 <a class="at">NAME</a> :` names the user actually
 *   answered. Only that is a reply target.
 *
 * So a reply with no such prefix is a direct reply to the floor: a certain
 * relation, not an unknown one. A reply that carries the prefix but whose name
 * cannot be read keeps `relationUncertain`, and downstream code must ask
 * rather than guess.
 */
export declare function parseCommentPage(html: string, floorPostId: string): ParsedCommentPage;
/** One entry of the `totalComment` JSON response. */
export interface TotalCommentEntry {
    readonly floorPostId: string;
    readonly declaredCount: number;
    readonly inline: readonly InlineComment[];
}
/** One inline comment from `totalComment`, which does carry numeric ids. */
export interface InlineComment {
    readonly commentId: string;
    readonly postId: string;
    readonly authorId?: string;
    readonly authorName?: string;
    readonly content: string;
    readonly createdAt?: string;
}
/** Parse a `totalComment` JSON body. */
export declare function parseTotalComment(raw: string): {
    readonly entries: readonly TotalCommentEntry[];
    readonly userNames: ReadonlyMap<string, string>;
};
/** Extract the CSRF token from any page that carries one. */
export declare function parseTbs(html: string): string | undefined;
export {};
//# sourceMappingURL=parse.d.ts.map