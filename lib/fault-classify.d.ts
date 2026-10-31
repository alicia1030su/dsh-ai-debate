/**
 * Why a platform request failed, in terms the owner can act on (v0.2.22 §六).
 *
 * ## Why a classifier instead of another error message
 *
 * "Read failed: 403" is true and useless. The same status code covers at least five situations
 * with five different remedies — a session that expired, an endpoint this account may not read,
 * a rate limit, an anti-bot page, and a platform decision — and telling the owner the wrong one
 * sends them to fix the wrong thing. This module turns the observable facts (status, error code,
 * body markers, whether the platform's *own* host answered) into exactly one category plus the
 * next step that is safe to take.
 *
 * ## What it refuses to conclude
 *
 * - **Reachability of `www.baidu.com` says nothing about `tieba.baidu.com`.** They are different
 *   hosts with different protections; the observed block on this deployment hits the forum host
 *   while the portal answers 200. `reachability` is therefore derived from the platform host
 *   only, and an unreachable host is reported as such rather than "the internet is down".
 * - **It never suggests a workaround that evades a platform control.** No captcha bypass, no
 *   proxy rotation, no header spoofing. The advice for an anti-bot block is "stop, and read
 *   later from a normal session" — the same thing a person would do.
 * - **It does not claim a cause it cannot see.** Ambiguous evidence lands on `unknown` with the
 *   facts attached, because a confident wrong answer here costs more than "I do not know".
 */
import type { PlatformErrorCode } from './types.js';
/**
 * One failure category.
 *
 * The values are deliberately few and mutually exclusive: a UI that has to render eight
 * overlapping states ends up collapsing them, and the collapse is where "uncertain" becomes
 * "failed" or, worse, "fine".
 */
export type FaultKind = 
/** The platform host itself did not answer (DNS, TCP, TLS, timeout). */
'unreachable'
/** The request reached the platform and it refused the credentials. */
 | 'session_invalid'
/** No credentials configured at all — nothing was sent. */
 | 'not_logged_in'
/** Authenticated, but this account may not read/do this. */
 | 'permission_denied'
/** Too many requests; back off. */
 | 'rate_limited'
/** An anti-bot page (captcha / verification), not a normal response. */
 | 'challenge'
/** The platform answered and said no, for a reason outside the categories above. */
 | 'platform_refused'
/** The response was structurally wrong: the platform changed shape. */
 | 'malformed'
/** Not enough information to decide. */
 | 'unknown';
/** What the caller observed. Every field is optional: a classifier that demands fields gets fed lies. */
export interface FaultEvidence {
    /** HTTP status, when the request got a response. */
    readonly status?: number;
    /** The normalized error code from `PlatformError`, when one was raised. */
    readonly code?: PlatformErrorCode;
    /** Raw error text, searched for well-known platform markers. */
    readonly message?: string;
    /** Whether *the platform's own host* answered at TCP/HTTP level. */
    readonly hostReachable?: boolean;
    /** Whether any credential was configured for this platform. */
    readonly hasCredential?: boolean;
    /** Whether the adapter believed its session was valid before the request. */
    readonly sessionKnownGood?: boolean;
}
/** A classification plus the safe next step. */
export interface FaultReport {
    readonly kind: FaultKind;
    /** Short label for a badge. */
    readonly label: string;
    /** Why, in terms of the evidence actually observed. */
    readonly reason: string;
    /** What the owner can safely do next. Never a way around a platform control. */
    readonly nextStep: string;
    /** Whether retrying the same request later could plausibly help. */
    readonly retryable: boolean;
}
/**
 * Classify one failure.
 *
 * Order matters and is documented because it encodes precedence:
 *
 * 1. **No host answer** wins over everything: if the platform was never reached, no other fact
 *    about the response exists, and reporting "session invalid" for a DNS failure is a guess.
 * 2. **No credential** beats status codes: a 403 with no cookie is not a permission problem.
 * 3. **Challenge** beats 403: an anti-bot page is also a 403, and it is the one case where
 *    "try harder" is the wrong advice.
 * 4. **429 / rate_limited**, then **401/403**, then structural problems.
 */
export declare function classifyFault(evidence: FaultEvidence): FaultReport;
/**
 * Whether the fault means "this deployment cannot publish at all right now".
 *
 * Used by the workbench to decide whether the publish button may be offered. It is a separate
 * question from `retryable`: a malformed response is not retryable but also does not forbid
 * publishing forever, while a challenge page does forbid a publish today.
 */
export declare function blocksPublishing(report: FaultReport): boolean;
//# sourceMappingURL=fault-classify.d.ts.map