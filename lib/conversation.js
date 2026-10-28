/**
 * A platform-neutral conversation graph.
 *
 * ## Why this exists
 *
 * v0.2.2 removed the requirement that every platform number its posts, but the
 * data model is still shaped like a forum: a thread holds `Floor`s, each `Floor`
 * holds `NestedReply`s, and a reply's parent is by definition a floor. Two levels
 * is not a universal shape:
 *
 * - **Weibo** is text → comment → reply, and a repost is *both* new content and an
 *   edge back to the original. A repost that quoted someone is a graph, not a
 *   tree; forcing it into a parent-child slot loses either the content or the
 *   relationship. `manifests.ts` already records this constraint.
 * - **Zhihu** is question → answer/article → comment → reply. Four levels, and
 *   the question itself is not a speaker — the author is the answer's author.
 * - **Tieba** is thread → floor → nested reply: the two-level case that the old
 *   model generalised from.
 *
 * ## Design
 *
 * Nodes carry identity and content; **edges carry relationships**. Keeping them
 * apart is what makes "a repost is a node *and* an edge" expressible, and it stops
 * the model from having to guess a relationship out of a display name — which is
 * what the Tieba ancestor walk had to do (`adapter.ts` matched `replyToName`
 * against author names, silently truncating the chain when two people shared a
 * name).
 *
 * Every edge states whether the platform *said* it or the code *inferred* it.
 * That distinction is the difference between evidence and a guess, and downstream
 * code treats them differently: an inferred edge may be shown, but never used to
 * assert what the opponent said.
 *
 * ## Relationship to the old types
 *
 * `Floor` / `NestedReply` / `CollectedThread` are **not** replaced here. They are
 * what the Tieba adapter produces and what the analyzer, publisher and store
 * already consume, and rewriting all of it in one version is how working
 * behaviour gets lost. The bridge is `toConversationGraph()` in
 * `conversation.ts`, which projects a collected thread onto this model losslessly
 * for the two-level case. New platforms may implement `ConversationSource`
 * directly and skip the Floor shape entirely.
 */
/** Nodes addressed by id, for O(1) lookups while walking edges. */
export function indexNodes(graph) {
    return new Map(graph.nodes.map((node) => [node.id, node]));
}
/** Outgoing edges of one node, filtered by kind when given. */
export function edgesFrom(graph, from, kind) {
    return graph.edges.filter((edge) => edge.from === from && (kind === undefined || edge.kind === kind));
}
/** Incoming edges of one node, filtered by kind when given. */
export function edgesTo(graph, to, kind) {
    return graph.edges.filter((edge) => edge.to === to && (kind === undefined || edge.kind === kind));
}
/**
 * The parent of a node, by `contains`.
 *
 * `undefined` for the root, and also when containment is not recorded — the
 * caller must not assume a missing edge means "top level".
 */
export function parentOf(graph, nodeId) {
    const [edge] = edgesTo(graph, nodeId, 'contains');
    if (edge === undefined)
        return undefined;
    return graph.nodes.find((node) => node.id === edge.from);
}
/**
 * Ancestor chain from the root down to (but excluding) the node.
 *
 * Depth-capped rather than trusting the data: a malformed or cyclic edge set
 * would otherwise hang the caller. A cycle is a data error, and truncating is
 * safer than looping.
 */
export function ancestorsOf(graph, nodeId, maxDepth = 64) {
    const out = [];
    const seen = new Set([nodeId]);
    let current = parentOf(graph, nodeId);
    while (current !== undefined && out.length < maxDepth) {
        if (seen.has(current.id))
            break;
        seen.add(current.id);
        out.unshift(current);
        current = parentOf(graph, current.id);
    }
    return out;
}
/**
 * The node this one answered, when the platform stated it.
 *
 * Returns `undefined` for an inferred-only edge: answering "who did you reply to"
 * with a guess is how the plugin would end up arguing with the wrong person.
 */
export function repliedToOf(graph, nodeId) {
    const edge = edgesFrom(graph, nodeId, 'replies_to').find((entry) => entry.certainty === 'stated');
    if (edge === undefined)
        return undefined;
    return graph.nodes.find((node) => node.id === edge.to);
}
/**
 * The conversation as a readable transcript, one line per node.
 *
 * Used by tests and by human-facing summaries. The model path keeps using the
 * compressor, which has a token budget; this is for explanations.
 */
export function renderGraph(graph) {
    const depth = new Map();
    const depthOf = (id) => {
        const cached = depth.get(id);
        if (cached !== undefined)
            return cached;
        const chain = ancestorsOf(graph, id);
        depth.set(id, chain.length);
        return chain.length;
    };
    return graph.nodes
        .map((node) => {
        const indent = '  '.repeat(depthOf(node.id));
        const who = node.author.displayName ?? node.author.accountId ?? '未知';
        const answered = repliedToOf(graph, node.id);
        const arrow = answered === undefined ? '' : ` → ${answered.id}`;
        const label = node.displayIndex === undefined ? node.id : `${node.displayIndex}:${node.id}`;
        return `${indent}[${label}] ${who}${arrow}: ${node.content}`;
    })
        .join('\n');
}
//# sourceMappingURL=conversation.js.map