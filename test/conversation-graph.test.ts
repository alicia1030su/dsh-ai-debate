/**
 * The platform-neutral conversation graph, and the Tieba projection onto it.
 *
 * v0.2.2 requirement: "新增 FakePlatform 测试，验证一个完全没有 floorNumber，
 * 也没有贴吧 Floor 语义的平台，能够提供正常的争论关系输入。"
 *
 * The point of these tests is not that the graph type exists — it is that the
 * relationships an argument depends on can be expressed *without* a floor. Where a
 * relationship is not stated by the platform, the graph must say so rather than
 * guess, so several of these assert the absence of an edge.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ancestorsOf,
  edgesFrom,
  edgesTo,
  indexNodes,
  parentOf,
  repliedToOf,
  renderGraph,
  type ConversationEdge,
  type ConversationGraph,
  type ConversationNode,
} from '../lib/conversation.js'
import { toConversationGraph } from '../lib/conversation-bridge.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'

const PLATFORM = 'microblog'

/** A thread with no floor semantics whatsoever. */
function thread(): Thread {
  return {
    platform: PLATFORM,
    id: 'status-1',
    title: '一条微博',
    content: '今天加班到十一点。',
    authorId: 'host',
    authorName: '发帖人',
    forum: { id: 'home', name: '首页' },
    url: 'https://microblog.example/status/1',
    images: [],
    declaredReplyCount: 2,
  }
}

function floor(id: string, author: string, content: string, nested: NestedReply[] = []): Floor {
  return {
    platform: PLATFORM,
    // No floorNumber at all: a status has none, and nothing may require one.
    postId: id,
    authorId: author,
    authorName: author,
    content,
    images: [],
    nestedCount: nested.length,
  }
}

function nested(
  postId: string,
  author: string,
  content: string,
  extra: Partial<NestedReply> = {},
): NestedReply {
  return {
    platform: PLATFORM,
    postId,
    parentPostId: 'unused',
    authorId: author,
    authorName: author,
    content,
    ...extra,
  }
}

function collected(floors: { floor: Floor; nested: NestedReply[] }[]): CollectedThread {
  return {
    thread: thread(),
    floors: floors.map((entry) => ({ ...entry, nestedComplete: true })),
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    stopReason: 'confirmed_end',
    issues: [],
  }
}

test('没有楼层号的平台也能投影出完整的对话图', () => {
  const graph = toConversationGraph(collected([{ floor: floor('c1', 'alice', '第一条评论'), nested: [] }]))

  // root + one comment, and the containment edge that says so.
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.platform, PLATFORM)
  assert.equal(graph.threadId, 'status-1')

  const root = graph.nodes[0]!
  assert.equal(root.kind, 'root')
  assert.equal(root.id, 'root:status-1')

  const comment = graph.nodes[1]!
  assert.equal(comment.kind, 'comment')
  assert.equal(comment.id, 'c1')
  assert.equal(
    comment.displayIndex,
    undefined,
    '没有楼层号的节点不应凭空获得 displayIndex',
  )
  assert.equal(comment.threadId, 'status-1', '每个节点都要带上线程 id')

  assert.deepEqual(
    graph.edges.map((edge) => `${edge.kind}:${edge.from}->${edge.to}`),
    ['contains:root:status-1->c1'],
  )
  // Containment is known from the collected structure, so it is stated fact.
  assert.equal(graph.edges[0]!.certainty, 'stated')
})

test('三层评论（根 → 评论 → 回复）在图上表达得出来，不需要楼层', () => {
  const graph = toConversationGraph(
    collected([
      {
        floor: floor('c1', 'alice', '第一条评论', [
          nested('r1', 'bob', '回复 alice'),
          nested('r2', 'alice', '再回复 bob'),
        ]),
        nested: [
          nested('r1', 'bob', '回复 alice'),
          nested('r2', 'alice', '再回复 bob'),
        ],
      },
    ]),
  )

  // root + comment + 2 replies.
  assert.equal(graph.nodes.length, 4)
  assert.deepEqual(ancestorsOf(graph, 'r1').map((node) => node.id), ['root:status-1', 'c1'])
  assert.deepEqual(ancestorsOf(graph, 'r2').map((node) => node.id), ['root:status-1', 'c1'])
  assert.equal(parentOf(graph, 'c1')?.id, 'root:status-1')
  assert.equal(parentOf(graph, 'r1')?.id, 'c1')
  // The root has no parent, and a missing edge must not be read as "top level".
  assert.equal(parentOf(graph, 'root:status-1'), undefined)
})

test('平台没给出被回复者的 id 时，不按昵称猜一条回复边', () => {
  // Tieba's parser fills replyToName but not replyToPostId. Guessing an edge from
  // a display name is exactly how the wrong person gets answered, so the bridge
  // emits no edge and records the gap in coverage.issues instead.
  const graph = toConversationGraph(
    collected([
      {
        floor: floor('c1', 'alice', '第一条评论'),
        nested: [nested('r1', 'bob', '回复某人', { replyToName: 'alice' })],
      },
    ]),
  )

  assert.equal(
    edgesFrom(graph, 'r1', 'replies_to').length,
    0,
    '只有昵称时不能推断回复边',
  )
  assert.equal(repliedToOf(graph, 'r1'), undefined)
  assert.ok(
    graph.coverage.issues.some((issue) => issue.includes('没有给出被回复者的 id')),
    '缺口必须写进 issues，不能静默消失',
  )
})

test('平台给出了被回复者的 id 时，记录一条 stated 的回复边', () => {
  const graph = toConversationGraph(
    collected([
      {
        floor: floor('c1', 'alice', '第一条评论'),
        nested: [
          nested('r1', 'bob', '回复 alice', { replyToPostId: 'c1' }),
        ],
      },
    ]),
  )

  const edge = edgesFrom(graph, 'r1', 'replies_to')[0]
  assert.ok(edge, '有 id 就必须记录回复边')
  assert.equal(edge.to, 'c1')
  assert.equal(edge.certainty, 'stated')
  assert.equal(repliedToOf(graph, 'r1')?.id, 'c1')
  // And the answered node knows it has an incoming edge.
  assert.equal(edgesTo(graph, 'c1', 'replies_to').length, 1)
})

test('图的覆盖率照抄采集结果，不自行升级', () => {
  const withGaps = collected([{ floor: floor('c1', 'alice', '评论'), nested: [] }])
  const graph = toConversationGraph({
    ...withGaps,
    completeness: {
      sourceComplete: false,
      retainedComplete: true,
      analysisComplete: false,
      nestedComplete: true,
      reasons: ['平台分页信号自相矛盾'],
    },
    stopReason: 'inconsistent_pagination',
  })

  assert.equal(graph.coverage.sourceComplete, false, '来源不完整时图不得声称完整')
  assert.equal(graph.coverage.stopReason, 'inconsistent_pagination')
})

test('渲染出的上下文里没有 undefined / NaN', () => {
  // The v0.2.1 bug this guards against: a missing floor number was interpolated
  // straight into model-facing text.
  const graph = toConversationGraph(
    collected([
      { floor: floor('c1', 'alice', '有时间'), nested: [nested('r1', 'bob', '回复')] },
    ]),
  )
  const text = renderGraph(graph)
  assert.doesNotMatch(text, /undefined/)
  assert.doesNotMatch(text, /NaN/)
  assert.match(text, /alice/)
  assert.match(text, /bob/)
})

test('一个完全手搭的图也支持查询，不需要来自贴吧', () => {
  // Proves the graph type is usable on its own terms: a hypothetical platform
  // that produces nodes and edges directly never touches Floor.
  const nodes: ConversationNode[] = [
    {
      platform: 'forum',
      id: 'q1',
      threadId: 't9',
      kind: 'root',
      author: { platform: 'forum', accountId: 'asker', displayName: '提问者' },
      content: '这样做对不对？',
      images: [],
    },
    {
      platform: 'forum',
      id: 'a1',
      threadId: 't9',
      kind: 'comment',
      author: { platform: 'forum', accountId: 'answerer', displayName: '回答者' },
      content: '不对。',
      images: [],
    },
    {
      platform: 'forum',
      id: 'c1',
      threadId: 't9',
      kind: 'reply',
      author: { platform: 'forum', accountId: 'asker', displayName: '提问者' },
      content: '哪里不对？',
      images: [],
    },
  ]
  const edges: ConversationEdge[] = [
    { platform: 'forum', kind: 'contains', from: 'q1', to: 'a1', certainty: 'stated' },
    { platform: 'forum', kind: 'contains', from: 'a1', to: 'c1', certainty: 'stated' },
    { platform: 'forum', kind: 'replies_to', from: 'c1', to: 'a1', certainty: 'stated' },
  ]
  const graph: ConversationGraph = {
    platform: 'forum',
    threadId: 't9',
    nodes,
    edges,
    coverage: { sourceComplete: true, stopReason: 'confirmed_end', issues: [] },
  }

  assert.deepEqual(ancestorsOf(graph, 'c1').map((node) => node.id), ['q1', 'a1'])
  assert.equal(repliedToOf(graph, 'c1')?.id, 'a1')
  assert.equal(indexNodes(graph).size, 3)
})

test('祖先链遇到环不会挂住', () => {
  // Malformed data from a broken adapter must not be able to hang the process.
  const nodes: ConversationNode[] = ['x', 'y'].map((id) => ({
    platform: 'p',
    id,
    threadId: 't',
    kind: 'reply' as const,
    author: { platform: 'p', accountId: id },
    content: '',
    images: [],
  }))
  const graph: ConversationGraph = {
    platform: 'p',
    threadId: 't',
    nodes,
    edges: [
      { platform: 'p', kind: 'contains', from: 'x', to: 'y', certainty: 'stated' },
      { platform: 'p', kind: 'contains', from: 'y', to: 'x', certainty: 'stated' },
    ],
    coverage: { sourceComplete: false, stopReason: 'unknown', issues: [] },
  }

  const chain = ancestorsOf(graph, 'x')
  assert.ok(chain.length <= 2, '遇到环必须截断，不能无限增长')
})
