/**
 * The Weibo provider: link routing, capability declaration, adapter construction.
 *
 * ## What this integration deliberately does NOT claim
 *
 * The Weibo Open Platform needs a registered application, developer qualification
 * and an explicit scope grant. This build has none of them, and no request against
 * the live API has ever been made from here. So:
 *
 * - every network-touching capability is `permission_required` or `unavailable`,
 *   never `supported` and never `unverified`;
 * - there is **no OAuth client here**, because inventing endpoint paths and scope
 *   strings would look like working code and be wrong in a way nobody could see
 *   until a user granted a permission that does not exist;
 * - the adapter throws a named, actionable error on every read method rather than
 *   returning empty data, because "no comments" and "not implemented" must not look
 *   the same to the analysis pipeline.
 *
 * ## What it DOES provide, and why that is worth shipping
 *
 * Link routing and id normalisation are the parts that can be verified offline and
 * are the most expensive to get wrong: a base62 display id compared against a
 * numeric mid points the whole pipeline at a different post, silently. Registering
 * Weibo *read-only* means a pasted Weibo link resolves to the right platform and the
 * settings page shows the honest status instead of treating it as an unknown link
 * that "fell back to Tieba" — the v0.2.0 bug.
 *
 * `projectWeiboThread` (see `./conversation.ts`) is also complete and tested, so the
 * day an authorised reader exists, the data model needs no new design.
 */
import type { PlatformProvider } from '../contracts.js';
/** The error every unimplemented read throws. Named so callers can branch on it. */
export declare class WeiboNotAuthorisedError extends Error {
    readonly code = "weibo_not_authorised";
    constructor(what: string);
}
/** The provider the registry holds. */
export declare const weiboProvider: PlatformProvider;
//# sourceMappingURL=provider.d.ts.map