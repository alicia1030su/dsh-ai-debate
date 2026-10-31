/**
 * The view layer for the verification panel (v0.2.21 §三/§四).
 *
 * Kept out of `settings-routes.ts` so the route file stays about transport, and out of
 * `verification-service.ts` so that module stays about *doing* one attempt. This file only
 * arranges what already exists into something a page and a script can both read.
 *
 * ## Two properties it must keep
 *
 * - **Blockers are sentences, not booleans.** "cannot verify" is useless without the reason: the
 *   owner has to know whether to log in, configure an account, or wait for a cookie to settle.
 * - **Nothing unknown is reported as fine.** An absent live account is `undefined` and a matching
 *   blocker, never `'ok'`; a capability with no evidence is `unverified`, never `supported`.
 */
import type { VerificationView } from './settings-routes.js';
import type { VerificationService } from './verification-service.js';
/**
 * Build the panel view.
 *
 * `platform` may be empty — the page renders before the owner picks one — in which case the
 * capability list is empty and the blockers say what to do, rather than showing a green
 * "nothing declared".
 */
export declare function verificationViewOf(service: VerificationService, platform: string): VerificationView;
//# sourceMappingURL=verification-view.d.ts.map