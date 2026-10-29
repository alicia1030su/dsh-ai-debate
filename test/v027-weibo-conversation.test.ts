/**
 * v0.2.7 §六：微博结构投影到统一对话图。
 *
 * 这一层不联网。它证明的是：微博的「正文 → 评论 → 评论回复 / 转发 / 引用」
 * 能被表达成 ConversationGraph，**不用伪造楼层号**，并且把「平台明说」与「按昵称猜」
 * 分开标注——后者一旦和前者混在一起，下游就再也分不清哪句是事实。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  projectWeiboThread,
  weiboParticipants,
  type WeiboComment,
  type WeiboPost,
  type WeiboThreadPayload,
} from '../lib/platforms/weibo/conversation.js'

function post(overrides: Partial<WeiboPost> = {}): WeiboPost {
  return {
    mid: '5012345678901234',
    user: { uid: '111', screenName: '楼主' },
    text: '这个方案我认为不可行。',
    createdAt: '2026-10-01T10:00:00Z',
    ...overrides,
  }
}

function comment(overrides: Partial<WeiboComment> = {}): WeiboComment {
  return {
    id: 'c1',
    user: { uid: '222', screenName: '对手' },
    text: '你凭什么这么说？',
    createdAt: '2026-10-01T10:05:00Z',
    ...overrides,
  }
}

function payload(overrides: Partial<WeiboThreadPayload> = {}): WeiboThreadPayload {
  return {
    post: post(),
    comments: [comment()],
    sourceComplete: true,
    stopReason: 'confirmed_end',
    ...overrides,
  }
}

test('正文成为 root 节点，评论成为 comment，平台没给楼层号就不造', () => {
  const graph = projectWeiboThread(payload())
  const root = graph.nodes.find((node) => node.kind === 'root')
  assert.ok(root !== undefined, '必须有 root')
  assert.equal(root!.content, '这个方案我认为不可行。')
  assert.equal(root!.platform, 'weibo')
  assert.equal(root!.threadId, '5012345678901234')

  const commentNode = graph.nodes.find((node) => node.kind === 'comment')
  assert.ok(commentNode !== undefined)
  // The whole point: no invented floor number anywhere.
  for (const node of graph.nodes) {
    assert.equal(node.displayIndex, undefined, `${node.id} 不应有 displayIndex`)
  }
})

test('containment 是平台明说的事实：每条评论都 contains 到正文', () => {
  const graph = projectWeiboThread(
    payload({ comments: [comment({ id: 'c1' }), comment({ id: 'c2', text: '第二楼' })] }),
  )
  const contains = graph.edges.filter((edge) => edge.kind === 'contains')
  assert.equal(contains.length, 2)
  for (const edge of contains) {
    assert.equal(edge.certainty, 'stated')
    assert.equal(edge.from, 'post:5012345678901234')
  }
})

test('平台给了 replyToCommentId：replies_to 是 stated', () => {
  const graph = projectWeiboThread(
    payload({
      comments: [comment({ id: 'c1' }), comment({ id: 'c2', replyToCommentId: 'c1', text: '回应' })],
    }),
  )
  const replyEdge = graph.edges.find((edge) => edge.kind === 'replies_to')
  assert.ok(replyEdge !== undefined)
  assert.equal(replyEdge!.certainty, 'stated')
  assert.equal(replyEdge!.from, 'comment:c2')
  assert.equal(replyEdge!.to, 'comment:c1')
})

test('只给昵称没有 id：边标 inferred，并写明推断依据', () => {
  const graph = projectWeiboThread(
    payload({
      comments: [
        comment({ id: 'c1', user: { uid: '222', screenName: '对手' } }),
        // The replier is a *different* person; otherwise the name matches itself and
        // the uniqueness check correctly refuses to guess.
        comment({ id: 'c2', user: { uid: '333', screenName: '楼主' }, replyToScreenName: '对手', text: '回应你' }),
      ],
    }),
  )
  const replyEdge = graph.edges.find((edge) => edge.kind === 'replies_to')
  assert.ok(replyEdge !== undefined, '同名唯一时应生成推断边')
  assert.equal(replyEdge!.certainty, 'inferred', '按昵称猜出来的必须标成 inferred')
  assert.match(String(replyEdge!.basis), /显示名/)
  assert.equal(replyEdge!.to, 'comment:c1')
})

test('昵称重名时不猜：不生成边，但 issue 说清为什么', () => {
  const graph = projectWeiboThread(
    payload({
      comments: [
        comment({ id: 'c1', user: { uid: '222', screenName: '小明' } }),
        comment({ id: 'c2', user: { uid: '333', screenName: '小明' } }),
        comment({ id: 'c3', replyToScreenName: '小明', text: '回谁呢' }),
      ],
    }),
  )
  assert.equal(
    graph.edges.some((edge) => edge.kind === 'replies_to'),
    false,
    '重名时猜出来的边比没有边更糟，因为它看起来同样确定',
  )
  assert.match(graph.coverage.issues.join('\n'), /重名|无法确定/)
})

test('replyToCommentId 指向未读到的评论：不静默丢弃，写进 issues', () => {
  const graph = projectWeiboThread(
    payload({ comments: [comment({ id: 'c2', replyToCommentId: 'c-missing' })] }),
  )
  assert.equal(graph.edges.some((edge) => edge.kind === 'replies_to'), false)
  assert.match(graph.coverage.issues.join('\n'), /不在读取范围内/)
})

test('转发：独立节点 + reposts 边，不是父子回复', () => {
  const original: WeiboPost = {
    mid: '4099999999999999',
    user: { uid: '999', screenName: '原始作者' },
    text: '原始观点。',
  }
  const graph = projectWeiboThread(payload({ post: post({ retweeted: original }) }))

  const repostNode = graph.nodes.find((node) => node.kind === 'repost')
  assert.ok(repostNode !== undefined, '转发应成为自己的节点')
  assert.equal(repostNode!.id, 'post:4099999999999999')

  const repostEdge = graph.edges.find((edge) => edge.kind === 'reposts')
  assert.ok(repostEdge !== undefined)
  assert.equal(repostEdge!.certainty, 'stated')
  assert.equal(repostEdge!.from, 'post:5012345678901234')
  assert.equal(repostEdge!.to, 'post:4099999999999999')

  // A repost is not a `contains` child of the root: it is a broadcast, not an answer.
  assert.equal(
    graph.edges.some((edge) => edge.kind === 'contains' && edge.to === repostNode!.id),
    false,
    '转发不能当作正文的子节点',
  )
})

test('引用：quotes 边，独立于 replies_to', () => {
  const graph = projectWeiboThread(payload({ post: post({ quotedMid: 'c1' }) }))
  const quoteEdge = graph.edges.find((edge) => edge.kind === 'quotes')
  assert.ok(quoteEdge !== undefined)
  assert.equal(quoteEdge!.certainty, 'stated')
  assert.equal(
    graph.edges.some((edge) => edge.kind === 'replies_to'),
    false,
    '引用不是回复',
  )
})

test('作者身份：有 uid 是 stable，没有就是 name_only，绝不升级昵称', () => {
  const graph = projectWeiboThread(
    payload({
      comments: [
        comment({ id: 'c1', user: { uid: '222', screenName: '有id' } }),
        comment({ id: 'c2', user: { screenName: '没id' } }),
      ],
    }),
  )
  const withId = graph.nodes.find((node) => node.id === 'comment:c1')!
  const withoutId = graph.nodes.find((node) => node.id === 'comment:c2')!
  assert.equal(withId.author.idStrength, 'stable')
  assert.equal(withId.author.accountId, '222')
  assert.equal(withoutId.author.idStrength, 'name_only')
  assert.equal(withoutId.author.accountId, undefined)
})

test('覆盖率来自读取方，不由节点数量反推', () => {
  const incomplete = projectWeiboThread(
    payload({ sourceComplete: false, stopReason: 'rate_limited', missingComments: 12 }),
  )
  assert.equal(incomplete.coverage.sourceComplete, false)
  assert.equal(incomplete.coverage.stopReason, 'rate_limited')
  assert.equal(incomplete.coverage.missingCount, 12)

  // A complete read with zero comments is still complete — and an incomplete one with
  // zero comments is still incomplete. Count must not decide this.
  const emptyButComplete = projectWeiboThread(
    payload({ comments: [], sourceComplete: true, stopReason: 'confirmed_end' }),
  )
  assert.equal(emptyButComplete.coverage.sourceComplete, true)
})

test('参与者：stable 与 name_only 分开返回，调用方才有机会拒绝按昵称匹配', () => {
  const graph = projectWeiboThread(
    payload({
      comments: [
        comment({ id: 'c1', user: { uid: '222', screenName: '有id' } }),
        comment({ id: 'c2', user: { screenName: '只有昵称' } }),
      ],
    }),
  )
  const participants = weiboParticipants(graph)
  assert.ok(participants.stable.includes('111'), '正文作者带 uid')
  assert.ok(participants.stable.includes('222'))
  assert.ok(participants.nameOnly.includes('只有昵称'))
  assert.equal(participants.nameOnly.includes('有id'), false)
})

test('节点 id 与 threadId 组合唯一：不同帖子里的同一条评论 id 不会互相覆盖', () => {
  const a = projectWeiboThread(payload({ post: post({ mid: '1111' }), comments: [comment({ id: 'x' })] }))
  const b = projectWeiboThread(payload({ post: post({ mid: '2222' }), comments: [comment({ id: 'x' })] }))
  const nodeA = a.nodes.find((node) => node.id === 'comment:x')!
  const nodeB = b.nodes.find((node) => node.id === 'comment:x')!
  assert.equal(nodeA.threadId, '1111')
  assert.equal(nodeB.threadId, '2222')
  // Same node id, different thread: identity is the pair, which is what the graph says.
  assert.notEqual(nodeA.threadId, nodeB.threadId)
})
