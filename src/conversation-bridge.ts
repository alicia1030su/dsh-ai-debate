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

import type { CollectedThread } from './collector.js'
import type { Floor, NestedReply, PlatformId, Thread } from './types.js'
import {
  ancestorsOf,
  indexNodes,
  repliedToOf,
  type ConversationAuthor,
  type ConversationCoverage,
  type ConversationEdge,
  type ConversationGraph,
  type ConversationNode,
} from './conversation.js'

/** Author projection: a name-only handle is marked as such, never upgraded. */
function authorOf(
  platform: PlatformId,
  accountId: string | undefined,
  displayName: string | undefined,
): ConversationAuthor {
  return {
    platform,
    ...(accountId !== undefined && accountId !== '' ? { accountId } : {}),
    ...(displayName !== undefined && displayName !== '' ? { displayName } : {}),
    // Tieba exposes a numeric user id on some surfaces and a nickname on others,
    // so the strength has to be read from the value rather than assumed.
    idStrength: accountId === undefined || accountId === '' ? 'name_only' : 'stable',
  }
}

function rootNode(thread: Thread): ConversationNode {
  return {
    platform: thread.platform,
    id: `root:${thread.id}`,
    threadId: thread.id,
    kind: 'root',
    author: authorOf(thread.platform, thread.authorId, thread.authorName),
    content: thread.content,
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    images: thread.images,
    ...(thread.declaredReplyCount !== undefined
      ? { declaredReplyCount: thread.declaredReplyCount }
      : {}),
  }
}

function floorNode(floor: Floor): ConversationNode {
  return {
    platform: floor.platform,
    id: floor.postId,
    threadId: '',
    kind: 'comment',
    author: authorOf(floor.platform, floor.authorId, floor.authorName),
    content: floor.content,
    ...(floor.createdAt !== undefined ? { createdAt: floor.createdAt } : {}),
    images: floor.images,
    ...(floor.floorNumber !== undefined ? { displayIndex: floor.floorNumber } : {}),
    ...(floor.nestedCount !== undefined ? { declaredReplyCount: floor.nestedCount } : {}),
    ...(floor.inlineNested !== undefined ? { degraded: true } : {}),
  }
}

function nestedNode(reply: NestedReply, threadId: string): ConversationNode {
  return {
    platform: reply.platform,
    id: reply.postId,
    threadId,
    // Everything below a floor is a reply: Tieba's nesting is only two levels, so
    // a nested reply is always one step under a comment, never a `comment` itself.
    kind: 'reply',
    author: authorOf(reply.platform, reply.authorId, reply.authorName),
    content: reply.content,
    ...(reply.createdAt !== undefined ? { createdAt: reply.createdAt } : {}),
    images: [],
    ...(reply.relationUncertain === true ? { degraded: true } : {}),
  }
}

/**
 * Convert a collected thread into a graph.
 *
 * The `threadId` is filled in on every node here rather than in the node builders,
 * because the floor builders do not carry it and threading a parameter through
 * three helpers for one field obscures more than it explains.
 */
export function toConversationGraph(collected: CollectedThread): ConversationGraph {
  const { thread, floors } = collected
  const platform = thread.platform
  const threadId = thread.id

  const root = rootNode(thread)
  const nodes: ConversationNode[] = [root]
  const edges: ConversationEdge[] = []
  const issues: string[] = [...collected.issues]

  for (const entry of floors) {
    const floor = floorNode(entry.floor)
    nodes.push({ ...floor, threadId })
    edges.push({
      platform,
      kind: 'contains',
      from: root.id,
      to: floor.id,
      certainty: 'stated',
    })

    for (const reply of entry.nested) {
      nodes.push(nestedNode(reply, threadId))
      edges.push({
        platform,
        kind: 'contains',
        from: floor.id,
        to: reply.postId,
        certainty: 'stated',
      })
      // A stated target is recorded as a real edge; a missing one is *not*
      // guessed from `replyToName`, because a name is not an identity and a wrong
      // edge here would make the analyzer attribute a claim to the wrong person.
      if (reply.replyToPostId !== undefined && reply.replyToPostId !== '') {
        edges.push({
          platform,
          kind: 'replies_to',
          from: reply.postId,
          to: reply.replyToPostId,
          certainty: 'stated',
          basis: '平台返回了被回复的 post id',
        })
      } else if (reply.replyToName !== undefined && reply.replyToName !== '') {
        issues.push(
          `回复 ${reply.postId} 声称在回复「${reply.replyToName}」，但平台没有给出被回复者的 id；` +
            '这条回复关系不会被当作事实，避免按昵称猜错人。',
        )
      }
    }
  }

  const coverage: ConversationCoverage = {
    sourceComplete: collected.completeness.sourceComplete,
    ...(collected.missingCount !== undefined ? { missingCount: collected.missingCount } : {}),
    ...(collected.completeness.droppedByCap !== undefined
      ? { droppedCount: collected.completeness.droppedByCap }
      : {}),
    stopReason: collected.stopReason ?? 'unknown',
    issues,
  }

  return { platform, threadId, nodes, edges, coverage }
}

/**
 * The neighbourhood of one node in a graph.
 *
 * Re-exported from the graph helpers so a caller that only has a graph does not
 * need to import `conversation.js` as well.
 */
export { ancestorsOf, indexNodes, repliedToOf }
