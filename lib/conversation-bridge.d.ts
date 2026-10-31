/**
 * Project a collected thread onto the platform-neutral conversation graph.
 *
 * The Tieba data model is two levels — a thread holds floors, each floor holds
 * nested replies — which maps onto the graph almost losslessly, so this bridge is
 * the cheapest way to prove the graph is expressive enough before any platform
 * implements it natively.
 *
 * Three things are deliberately *stated* rather than smoothed over:
 *
 * 1. **The display index is carried, not used.** `displayIndex` records the floor
 *    number for humans; nothing here groups by it.
 * 2. **Containment is always stated** — the collected structure already says which
 *    floor a nested reply belongs to, so `contains` edges are facts.
 * 3. **"Replied to" is only recorded when the platform said so.** Tieba's parser
 *    fills `replyToName` (a display name) but not `replyToPostId` (an id), so a
 *    reply's target is currently unknown. Emitting an `inferred` edge would be a
 *    guess the graph could not distinguish from fact later, so no `replies_to`
 *    edge is emitted at all. That is the honest projection: the relationship is
 *    missing, and `coverage.issues` says why.
 */
import type { CollectedThread } from './collector.js';
import { ancestorsOf, indexNodes, repliedToOf, type ConversationGraph } from './conversation.js';
/**
 * Convert a collected thread into a graph.
 *
 * The `threadId` is filled in on every node here rather than in the node builders,
 * because the floor builders do not carry it and threading a parameter through
 * three helpers for one field obscures more than it explains.
 */
export declare function toConversationGraph(collected: CollectedThread): ConversationGraph;
/**
 * The neighbourhood of one node in a graph.
 *
 * Re-exported from the graph helpers so a caller that only has a graph does not
 * need to import `conversation.js` as well.
 */
export { ancestorsOf, indexNodes, repliedToOf };
//# sourceMappingURL=conversation-bridge.d.ts.map