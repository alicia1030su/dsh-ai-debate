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

import type { PlatformId } from './types.js'

/**
 * What a node is in the conversation.
 *
 * Deliberately about *role in the discussion*, not about which site it came from:
 * `comment` covers a Tieba floor, a Weibo comment and a Zhihu answer's comment,
 * because in each case it is the first level of response to the root.
 */
export type ConversationNodeKind =
  /** The thing being discussed: a thread, a status, a question. */
  | 'root'
  /** A first-level response: a floor, a comment, an answer. */
  | 'comment'
  /** A response to a response, at any depth below `comment`. */
  | 'reply'
  /** A repost/forward: its own content *and* a pointer at the original. */
  | 'repost'

/** How strongly an account id identifies a person on this platform. */
export type AccountIdStrength = 'stable' | 'slug' | 'opaque' | 'name_only'

/**
 * An account reference.
 *
 * `displayName` is for humans and logs only. Matching on it is what produced the
 * merged-identity bugs this project has had, so it is never a key here.
 */
export interface ConversationAuthor {
  readonly platform: PlatformId
  /** Platform-native stable id, when the platform exposes one. */
  readonly accountId?: string
  /** Display name as rendered. Not an identity. */
  readonly displayName?: string
  /** How much `accountId` can be trusted. */
  readonly idStrength?: AccountIdStrength
}

/** One node in the conversation. */
export interface ConversationNode {
  readonly platform: PlatformId
  /** Platform post/comment id. Unique within the thread. */
  readonly id: string
  /** The thread this node belongs to. Part of the identity namespace. */
  readonly threadId: string
  readonly kind: ConversationNodeKind
  readonly author: ConversationAuthor
  readonly content: string
  readonly createdAt?: string
  readonly images: readonly string[]
  /**
   * The number the platform *displays* for this position, if any.
   *
   * Display only. Grouping and addressing use ids, because a microblog has no
   * floor numbers and inventing them is what v0.2.1 had to do.
   */
  readonly displayIndex?: number
  /** How many replies the platform claims this node has. */
  readonly declaredReplyCount?: number
  /**
   * True when this node came from a degraded source (an inlined subset, a
   * rate-limited fallback), so `declaredReplyCount` cannot be checked against it.
   */
  readonly degraded?: boolean
}

/** How one node relates to another. */
export type ConversationEdgeKind =
  /** Structural containment: thread → comment → reply. */
  | 'contains'
  /** "This post answers that post." The relationship an argument follows. */
  | 'replies_to'
  /** Repost/forward of another post. */
  | 'reposts'
  /** Quoted another post inside its own content. */
  | 'quotes'

/** One directed relationship between two nodes. */
export interface ConversationEdge {
  readonly platform: PlatformId
  readonly kind: ConversationEdgeKind
  readonly from: string
  readonly to: string
  /**
   * Whether the platform stated this relationship or the code inferred it.
   *
   * `inferred` edges are honest guesses (typically from a display name) and must
   * never be presented as fact. This field exists because the Tieba adapter had
   * to guess, and the guess was indistinguishable from a stated edge downstream.
   */
  readonly certainty: 'stated' | 'inferred'
  /** What the inference was based on, for audit and UI explanation. */
  readonly basis?: string
}

/** How much of the graph is actually here. */
export interface ConversationCoverage {
  /** The platform's own evidence proved the node list is complete. */
  readonly sourceComplete: boolean
  /** Nodes the platform declares but that could not be read. */
  readonly missingCount?: number
  /** Nodes dropped locally by a cap, so the model knows it has not seen them. */
  readonly droppedCount?: number
  /** Why the read stopped, reusing the collector's vocabulary. */
  readonly stopReason: string
  /** Human-readable coverage notes, including signal contradictions. */
  readonly issues: readonly string[]
}

/** A whole conversation, as nodes plus edges. */
export interface ConversationGraph {
  readonly platform: PlatformId
  readonly threadId: string
  /** Every node, in platform display order. */
  readonly nodes: readonly ConversationNode[]
  readonly edges: readonly ConversationEdge[]
  readonly coverage: ConversationCoverage
}

/**
 * What an adapter must provide to drive the core from a graph.
 *
 * Optional on `PlatformAdapter`: an adapter that already speaks `Floor` (Tieba)
 * keeps doing so and is bridged, while a new platform can implement this instead
 * of inventing floors. Nothing in the analyzer requires it yet — that migration
 * is deliberately incremental, because rewriting the analyzer in the same release
 * as the fixes above would make a regression impossible to attribute.
 */
export interface ConversationSource {
  /** Read the conversation for one thread. */
  readConversation(
    threadId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ConversationGraph>

  /** Locate one node and return the neighbourhood needed to answer it. */
  locateNode(
    threadId: string,
    nodeId: string,
    options?: { signal?: AbortSignal },
  ): Promise<NodeContext | undefined>
}

/**
 * One node plus its neighbourhood — the platform-neutral replacement for
 * `ReplyContext`, which required a `floor`.
 */
export interface NodeContext {
  readonly threadId: string
  /** The node in question. */
  readonly node: ConversationNode
  /** Ancestors from the root down to (but excluding) `node`. */
  readonly ancestors: readonly ConversationNode[]
  /** Siblings under the same parent, in platform display order. */
  readonly siblings: readonly ConversationNode[]
  /** The node this one explicitly answered, when the platform stated it. */
  readonly repliesTo?: ConversationNode
}

/** Nodes addressed by id, for O(1) lookups while walking edges. */
export function indexNodes(graph: ConversationGraph): ReadonlyMap<string, ConversationNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]))
}

/** Outgoing edges of one node, filtered by kind when given. */
export function edgesFrom(
  graph: ConversationGraph,
  from: string,
  kind?: ConversationEdgeKind,
): readonly ConversationEdge[] {
  return graph.edges.filter((edge) => edge.from === from && (kind === undefined || edge.kind === kind))
}

/** Incoming edges of one node, filtered by kind when given. */
export function edgesTo(
  graph: ConversationGraph,
  to: string,
  kind?: ConversationEdgeKind,
): readonly ConversationEdge[] {
  return graph.edges.filter((edge) => edge.to === to && (kind === undefined || edge.kind === kind))
}

/**
 * The parent of a node, by `contains`.
 *
 * `undefined` for the root, and also when containment is not recorded — the
 * caller must not assume a missing edge means "top level".
 */
export function parentOf(
  graph: ConversationGraph,
  nodeId: string,
): ConversationNode | undefined {
  const [edge] = edgesTo(graph, nodeId, 'contains')
  if (edge === undefined) return undefined
  return graph.nodes.find((node) => node.id === edge.from)
}

/**
 * Ancestor chain from the root down to (but excluding) the node.
 *
 * Depth-capped rather than trusting the data: a malformed or cyclic edge set
 * would otherwise hang the caller. A cycle is a data error, and truncating is
 * safer than looping.
 */
export function ancestorsOf(
  graph: ConversationGraph,
  nodeId: string,
  maxDepth = 64,
): readonly ConversationNode[] {
  const out: ConversationNode[] = []
  const seen = new Set<string>([nodeId])
  let current = parentOf(graph, nodeId)
  while (current !== undefined && out.length < maxDepth) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    out.unshift(current)
    current = parentOf(graph, current.id)
  }
  return out
}

/**
 * The node this one answered, when the platform stated it.
 *
 * Returns `undefined` for an inferred-only edge: answering "who did you reply to"
 * with a guess is how the plugin would end up arguing with the wrong person.
 */
export function repliedToOf(
  graph: ConversationGraph,
  nodeId: string,
): ConversationNode | undefined {
  const edge = edgesFrom(graph, nodeId, 'replies_to').find((entry) => entry.certainty === 'stated')
  if (edge === undefined) return undefined
  return graph.nodes.find((node) => node.id === edge.to)
}

/**
 * The conversation as a readable transcript, one line per node.
 *
 * Used by tests and by human-facing summaries. The model path keeps using the
 * compressor, which has a token budget; this is for explanations.
 */
export function renderGraph(graph: ConversationGraph): string {
  const depth = new Map<string, number>()
  const depthOf = (id: string): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    const chain = ancestorsOf(graph, id)
    depth.set(id, chain.length)
    return chain.length
  }
  return graph.nodes
    .map((node) => {
      const indent = '  '.repeat(depthOf(node.id))
      const who = node.author.displayName ?? node.author.accountId ?? '未知'
      const answered = repliedToOf(graph, node.id)
      const arrow = answered === undefined ? '' : ` → ${answered.id}`
      const label =
        node.displayIndex === undefined ? node.id : `${node.displayIndex}:${node.id}`
      return `${indent}[${label}] ${who}${arrow}: ${node.content}`
    })
    .join('\n')
}
