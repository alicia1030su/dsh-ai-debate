/**
 * The security event log.
 *
 * ## What gets recorded, and what must not
 *
 * An event exists so the owner can see *that* something was blocked and *why*,
 * days later, without having read the review at the time. That purpose limits what
 * may be stored:
 *
 * - **Never the whole post.** A security log that keeps full attacker text becomes
 *   a copy of the attack, and if the log is ever shown, exported or pasted into an
 *   issue, the attack travels with it. Events store a short excerpt plus a reason.
 * - **Never a credential.** If the reason for a block was a leaked key, the event
 *   records "疑似凭据泄露" and the *shape* that matched — not the value. The value
 *   may not even be known to us (it came from the model's output), but a naive
 *   implementation would happily copy it into a log.
 * - **Never unbounded.** A fixed-size ring: an attacker who can post a thousand
 *   times must not be able to grow the state file without limit.
 *
 * ## Why events are separate from the assessment
 *
 * The assessment lives on the candidate and answers "may this be published". The
 * event log answers "what has been happening" — a different question, at a
 * different granularity. Merging them would mean either an assessment that grows
 * without bound or a log too coarse to explain a specific block.
 */
/** Maximum characters of original text an event may keep. */
export const EXCERPT_LIMIT = 60;
/** How many events are retained. Older ones are dropped. */
export const EVENT_LIMIT = 50;
let counter = 0;
/** A stable id for an event, unique within this process. */
function nextEventId(now) {
    counter += 1;
    return `${now.toString(36)}-${counter.toString(36)}`;
}
/**
 * Redact a fragment for storage.
 *
 * Two jobs: cap the length, and remove anything that could carry a secret. A
 * pattern that looks like a credential is replaced wholesale rather than partially
 * masked, because a partially masked key is still a key.
 */
export function redactExcerpt(text) {
    const cleaned = text
        // Control and invisible characters would let an excerpt smuggle something
        // past a reader's eye, and they render as garbage anyway.
        .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // Anything credential-shaped is dropped entirely.
    const withoutSecrets = cleaned
        .replace(/(?:sk-|m0sk_|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '[已隐去]')
        .replace(/(?:BDUSS|STOKEN|BAIDUID)=[^;\s]{4,}/gi, '[已隐去]')
        .replace(/\b1[3-9]\d{9}\b/g, '[已隐去]')
        .replace(/\d{17}[\dXx]/g, '[已隐去]');
    return withoutSecrets.length > EXCERPT_LIMIT
        ? `${withoutSecrets.slice(0, EXCERPT_LIMIT)}…`
        : withoutSecrets;
}
/** Build one event, applying the redaction rules. */
export function makeEvent(input) {
    const now = (input.now ?? Date.now)();
    return {
        id: nextEventId(now),
        at: new Date(now).toISOString(),
        kind: input.kind,
        severity: input.severity ?? 'none',
        summary: input.summary,
        ...(input.decision !== undefined ? { decision: input.decision } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.postId !== undefined ? { postId: input.postId } : {}),
        ...(input.excerpt !== undefined && input.excerpt.trim() !== ''
            ? { excerpt: redactExcerpt(input.excerpt) }
            : {}),
    };
}
/**
 * Add an event to a list, keeping the newest `limit`.
 *
 * A pure function so the store can call it inside its own mutate callback without
 * this module knowing anything about persistence.
 */
export function appendEvent(events, event, limit = EVENT_LIMIT) {
    if (limit <= 0)
        return [];
    const next = [...events, event];
    return next.length > limit ? next.slice(next.length - limit) : next;
}
/** Summarize a list for the settings page. */
export function countersOf(events, now = Date.now) {
    const cutoff = now() - 24 * 60 * 60 * 1000;
    let last24h = 0;
    let blocked = 0;
    let reviewerUnavailable = 0;
    for (const event of events) {
        if (Date.parse(event.at) >= cutoff)
            last24h += 1;
        if (event.decision === 'block')
            blocked += 1;
        if (event.kind === 'reviewer_unavailable')
            reviewerUnavailable += 1;
    }
    return { last24h, blocked, reviewerUnavailable };
}
/**
 * Render the recent events for a human.
 *
 * Every line is built from the stored *label* and the redacted excerpt, so this
 * output is safe to show in the settings page and safe to screenshot.
 */
export function renderEvents(events, limit = 10) {
    const recent = [...events].reverse().slice(0, limit);
    if (recent.length === 0)
        return ['最近没有安全事件。'];
    return recent.map((event) => {
        const when = event.at.replace('T', ' ').slice(0, 16);
        const where = event.postId !== undefined ? ` [${event.postId}]` : '';
        const excerpt = event.excerpt !== undefined ? `「${event.excerpt}」` : '';
        return `${when} ${event.summary}${where}${excerpt}`;
    });
}
//# sourceMappingURL=security-events.js.map