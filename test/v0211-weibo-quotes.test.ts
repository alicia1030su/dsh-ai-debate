/**
 * v0.2.11 §四：微博引用关系的目标必须是**帖子节点**，不是评论节点。
 *
 * ## 缺陷
 *
 * v0.2.10 的写法是
 *
 *     to: quoted === threadId ? `post:${threadId}` : `comment:${quoted}`
 *
 * `quotedMid` 是微博**帖子**的 mid，不是评论 id。后果有两个，都不轻：
 *
 * 1. 这条边指向一个不存在的 `comment:` 节点——评论 id 和帖子 mid 是两套命名空间；
 * 2. `certainty` 仍然写着 `stated`，于是「目标错了」这件事带着满级置信度传下去。
 *
 * 第三个后果更隐蔽：任何沿 `quotes` 找帖子的下游代码都找不到东西，而它不会报错，
 * 只会表现为「这条转发没有引用内容」。
 *
 * ## 这条关系应该长什么样
 *
 * 引用目标通常**不在**本次读取范围内（我们读了一条帖子加它的评论），所以这条边
 * 合法地指向一个缺席的节点。那是「悬空引用」，图必须如实记着它，而不是：
 *
 * - 编一个节点出来（等于假装读过没人读过的正文）；
 * - 或者把这条边丢掉（等于假装没有引用关系）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { projectWeiboThread, type WeiboThreadPayload } from '../lib/platforms/weibo/conversation.js'

function payload(overrides: Partial<WeiboThreadPayload> = {}): WeiboThreadPayload {
  return {
    post: {
      mid: '4331051486294436',
      user: { uid: '111', screenName: '主人' },
      text: '这条说法站不住脚。',
    },
    comments: [],
    sourceComplete: true,
    stopReason: 'complete',
    ...overrides,
  }
}

test('引用边指向 post: 命名空间，不是 comment:（v0.2.11）', () => {
  const graph = projectWeiboThread(
    payload({
      post: {
        mid: '4331051486294436',
        user: { uid: '111', screenName: '主人' },
        text: '转发并引用另一条微博。',
        quotedMid: '4404101091169383',
      },
    }),
  )
  const quote = graph.edges.find((edge) => edge.kind === 'quotes')
  assert.ok(quote !== undefined, '必须有 quotes 边')
  assert.equal(quote!.to, 'post:4404101091169383', `引用目标应是帖子节点，实际 ${quote!.to}`)
  assert.match(quote!.to, /^post:/, '绝不能是 comment:')
})

test('引用目标不在本次读取范围时，明确记录为悬空引用（v0.2.11）', () => {
  // The whole point: the quoted post was not fetched, so no node exists for it. The
  // graph must say so rather than silently leaving an edge to nowhere.
  const quotedMid = '4404101091169383'
  const graph = projectWeiboThread(
    payload({
      post: {
        mid: '4331051486294436',
        user: { uid: '111', screenName: '主人' },
        text: '引用一条没有读取的微博。',
        quotedMid,
      },
    }),
  )
  assert.equal(
    graph.nodes.some((node) => node.id === `post:${quotedMid}`),
    false,
    '不得为没读过的微博编造节点',
  )
  const mentioned = graph.coverage.issues.some((issue) => issue.includes(quotedMid))
  assert.equal(mentioned, true, `必须在 coverage.issues 里说明 ${quotedMid} 未读取：${graph.coverage.issues.join(' | ')}`)
  assert.match(
    graph.coverage.issues.find((issue) => issue.includes(quotedMid))!,
    /未读取|外部|不存在/,
  )
})

test('引用自己（自引用）时目标落在图内，且不报悬空', () => {
  // A real payload shape. It resolves inside the graph, so there is nothing missing and
  // no issue should be invented for it — otherwise every self-quote would look broken.
  const mid = '4331051486294436'
  const graph = projectWeiboThread(
    payload({
      post: { mid, user: { uid: '111', screenName: '主人' }, text: '自引用。', quotedMid: mid },
      comments: [],
      issues: [],
    }),
  )
  const quote = graph.edges.find((edge) => edge.kind === 'quotes')!
  assert.equal(quote.to, `post:${mid}`)
  assert.equal(
    graph.coverage.issues.some((issue) => issue.includes(mid)),
    false,
    '自引用不该产生「未读取」提示',
  )
})

test('引用的帖子若已作为转发原帖存在，边仍然指向同一个 post 节点', () => {
  // When a repost carries the original, the graph *does* contain that post node. A
  // quote of the same id then resolves to it — same namespace, same node, one identity.
  const quoted = '4404101091169383'
  const graph = projectWeiboThread(
    payload({
      post: {
        mid: '4331051486294436',
        user: { uid: '111', screenName: '主人' },
        text: '转发 + 引用同一条。',
        quotedMid: quoted,
        retweeted: { mid: quoted, user: { uid: '222', screenName: '对手' }, text: '原始正文。' },
      },
    }),
  )
  const present = graph.nodes.filter((node) => node.id === `post:${quoted}`)
  assert.equal(present.length, 1, '转发原帖恰好产生一个节点')
  const quote = graph.edges.find((edge) => edge.kind === 'quotes')!
  assert.equal(quote.to, `post:${quoted}`, '引用边必须指向那个已存在的节点')
})

test('转发与引用是两条独立的边，不互相替代（v0.2.11）', () => {
  // The two relationships mean different things: `reposts` says "this broadcast points
  // at the original", `quotes` says "this text embeds that post". Conflating them is
  // how an argument gets reconstructed backwards.
  const original = '4404101091169383'
  const graph = projectWeiboThread(
    payload({
      post: {
        mid: '4331051486294436',
        user: { uid: '111', screenName: '主人' },
        text: '同时转发和引用。',
        quotedMid: original,
        retweeted: { mid: original, user: { uid: '222', screenName: '对手' }, text: '原始正文。' },
      },
    }),
  )
  const reposts = graph.edges.filter((edge) => edge.kind === 'reposts')
  const quotes = graph.edges.filter((edge) => edge.kind === 'quotes')
  assert.equal(reposts.length, 1)
  assert.equal(quotes.length, 1)
  assert.notEqual(reposts[0]!.kind, quotes[0]!.kind)
})

test('引用不得被当成回复某条评论（v0.2.11）', () => {
  // The specific wrong inference the old code made: a quoted id in the comment
  // namespace. No `replies_to` edge may be created from a quote.
  const graph = projectWeiboThread(
    payload({
      post: {
        mid: '4331051486294436',
        user: { uid: '111', screenName: '主人' },
        text: '引用。',
        quotedMid: '4404101091169383',
      },
      comments: [
        { id: '4404101091169383', user: { uid: '222', screenName: '对手' }, text: '一条评论' },
      ],
    }),
  )
  assert.equal(
    graph.edges.some((edge) => edge.kind === 'replies_to'),
    false,
    '引用不是回复，不该产生 replies_to',
  )
  // And the quote must not have been re-pointed at the comment that happens to share
  // the id string.
  const quote = graph.edges.find((edge) => edge.kind === 'quotes')!
  assert.equal(quote.to, 'post:4404101091169383')
})
