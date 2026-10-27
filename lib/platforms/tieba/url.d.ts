/**
 * URL parsing for Tieba.
 *
 * Tieba links arrive in many shapes — `/p/<tid>`, `/mo/q/m?kz=<tid>`,
 * `/f?kw=<forum>` with a `pid` anchor, share links with query junk. Parsing
 * lives here so the adapter never sniffs strings, and so a bad URL produces a
 * clear error instead of a confusing 404 much later.
 */
import { type ThreadRef } from '../../types.js';
/** A successfully parsed Tieba thread reference. */
export interface TiebaThreadRef extends ThreadRef {
    readonly platform: 'tieba';
    /** Forum id, when the URL carried one (`fid=`). */
    readonly forumId?: string;
}
/** Pull a numeric thread id out of a Tieba URL. */
export declare function parseTiebaUrl(input: string): TiebaThreadRef;
/** Build the canonical shareable URL for a thread. */
export declare function threadUrl(threadId: string): string;
/** Build a link that opens one specific post. */
export declare function postUrl(threadId: string, postId: string): string;
//# sourceMappingURL=url.d.ts.map