/**
 * v0.2.11 §七：让争论分析能看到「谁在场」，并且不把路人当成一方。
 *
 * ## 缺的是什么
 *
 * 任务书列的九项输出里，其余八项 `DebateBrief` 早已有字段，只有「哪些评论是路人参与」
 * 没有。原因不在输出格式，在数据来源：`Dispute.exchange` **刻意**只保留主人和对手两人
 * （那是让重建可读的关键），于是第三方被正确地排除了——同时也被彻底遗忘了。
 *
 * 后果不是格式问题。两个人吵架和有五个人围观、其中三人明确站队，需要不同的回应：
 * 前者要讲清道理，后者要先处理「多数人已经这么想」这件事。生成器看不到这个差别，
 * 就只能按两人对吵来写。
 *
 * ## 这里测两条线
 *
 * 1. **收集**：`Dispute.bystanders` 抓到了同一层里的其他发言人，且没把主人/对手混进去；
 * 2. **校验**：`validateBrief` 拒绝把路人的证据挂在争论某一方名下——那会让「支持人数」
 *    被对手本人灌水。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeDispute } from '../lib/analyzer.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'
import { validateBrief, renderBrief, type BriefSources, type DebateBrief } from '../lib/brief.js'
import { makeFloor, makeNested } from './helpers.ts'

/** A thread header, matching the shape `helpers.ts` fixtures use. */
function makeThread(id = '1'): Thread {
  return {
    platform: 'tieba',
    forum: { platform: 'tieba', id: '9', name: '测试吧' },
    id,
    title: '测试帖',
    content: '正文',
    url: `https://tieba.baidu.com/p/${id}`,
    images: [],
  }
}

/** Wrap one floor and its nested replies into what the analyzer consumes. */
function collected(
  thread: Thread,
  floors: readonly Floor[],
  nested: Readonly<Record<string, readonly NestedReply[]>>,
): CollectedThread {
  return {
    thread,
    floors: floors.map((floor) => ({
      floor,
      nested: nested[floor.postId] ?? [],
      nestedComplete: true,
    })),
    complete: true,
    issues: [],
  } as CollectedThread
}

/**
 * A floor with an owner, an opponent and two third parties.
 *
 * The bystanders sit *between* the owner/opponent posts on purpose: that is the case where
 * dropping them from the exchange is correct and forgetting them entirely is not. It also
 * means the analyzer has to pick the opponent on interaction evidence rather than "whoever
 * spoke last", which is the pre-existing behaviour this fixture must not disturb.
 */
function threeWayFloor(): CollectedThread {
  const floorPostId = '700'
  const nested = [
    makeNested({ postId: 'q1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '这个说法站不住脚，请拿出证据。' }),
    makeNested({ postId: 'r1', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :你这才是抬杠。', replyToName: '主人' }),
    makeNested({ postId: 's1', parentPostId: floorPostId, authorId: 'c', authorName: '路人甲', content: '回复 对手B :我倒觉得他说得有道理。', replyToName: '对手B' }),
    makeNested({ postId: 'q2', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '回复 对手B :常识也要有依据。', replyToName: '对手B' }),
    makeNested({ postId: 's2', parentPostId: floorPostId, authorId: 'd', authorName: '路人乙', content: '围观一下。' }),
    makeNested({ postId: 's3', parentPostId: floorPostId, authorId: 'c', authorName: '路人甲', content: '回复 主人 :而且你也没解释清楚。', replyToName: '主人' }),
    makeNested({ postId: 'r2', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :总之我不认同。', replyToName: '主人' }),
    makeNested({ postId: 'q3', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@吵架小号 来帮我说两句。' }),
  ]
  return collected(
    makeThread(),
    [
      makeFloor({
        floorNumber: 1,
        postId: floorPostId,
        authorId: 'o',
        authorName: '主人',
        content: '开场',
        nestedCount: nested.length,
      }),
    ],
    { [floorPostId]: nested },
  )
}

const OWNER = { userId: 'o' }

test('分析：同一层里的第三方被收集为 bystanders（v0.2.11）', () => {
  const dispute = analyzeDispute(threeWayFloor(), OWNER, { postId: 'q3' })
  const names = dispute.bystanders.map((bystander) => bystander.displayName)
  assert.deepEqual(names.sort(), ['路人乙', '路人甲'].sort(), `路人应被收集，实际 ${names.join(',') || '(空)'}`)
  // And the two sides must NOT appear in the list — that would double-count them.
  assert.equal(names.includes('主人'), false, '主人不是路人')
  assert.equal(names.includes('对手B'), false, '对手不是路人')
})

test('分析：路人按发言次数排序，说得多的在前', () => {
  // "Loudest first" is the ordering that matters to a reader deciding whether the opponent
  // has support: 路人甲 spoke twice, 路人乙 once.
  const dispute = analyzeDispute(threeWayFloor(), OWNER, { postId: 'q3' })
  assert.equal(dispute.bystanders[0]?.displayName, '路人甲', '发言两次的排第一')
  assert.equal(dispute.bystanders[0]?.postCount, 2)
})

test('分析：没有第三方时 bystanders 是空数组，不是 undefined', () => {
  // A missing field would make every caller guard against `undefined`; an empty array says
  // "nobody else spoke", which is the ordinary case and a real fact.
  const floorPostId = '710'
  const nested = [
    makeNested({ postId: 'x1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '请拿出证据。' }),
    makeNested({ postId: 'x2', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :我不需要。', replyToName: '主人' }),
    makeNested({ postId: 'x3', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@吵架小号 说两句。' }),
  ]
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 1, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length })],
    { [floorPostId]: nested },
  )
  const dispute = analyzeDispute(data, OWNER, { postId: 'x3' })
  assert.deepEqual(dispute.bystanders, [])
})

// ---------------------------------------------------------------------------
// 呈现与校验
// ---------------------------------------------------------------------------

function sources(overrides: Partial<BriefSources> = {}): BriefSources {
  return {
    ownerPostIds: new Set(['p0', 'p3']),
    opponentPostIds: new Set(['p1', 'p6']),
    allPostIds: new Set(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']),
    ...overrides,
  }
}

function brief(overrides: Partial<DebateBrief> = {}): DebateBrief {
  return {
    platform: 'tieba',
    threadId: 't1',
    targetPostId: 'p6',
    owner: { side: 'owner', summary: '要求拿出证据。', evidence: ['p0'] },
    opponent: { side: 'opponent', summary: '认为这是抬杠。', evidence: ['p1'] },
    disagreements: ['常识是否需要依据'],
    agreedFacts: [],
    arguments: [],
    challenges: [],
    openQuestions: [],
    uncertainties: [],
    directions: ['rebut'],
    risks: [],
    bystanders: [],
    ...overrides,
  }
}

test('校验：路人证据指向争论某一方时被拒绝（v0.2.11）', () => {
  // The failure this prevents: counting the opponent's own post as a third party agreeing
  // with them. That inflates "how much support the opponent has" with the opponent.
  const problems = validateBrief(
    brief({
      bystanders: [{ displayName: '路人甲', postCount: 1, leaning: 'opponent', evidence: ['p1'] }],
    }),
    sources(),
  )
  const hit = problems.find((problem) => problem.field.startsWith('bystanders['))
  assert.ok(hit !== undefined, `应报错，实际问题：${JSON.stringify(problems)}`)
  assert.match(hit!.reason, /属于争论的一方/)
})

test('校验：声称路人站队却不给证据时被拒绝', () => {
  const problems = validateBrief(
    brief({ bystanders: [{ displayName: '路人甲', postCount: 1, leaning: 'owner' }] }),
    sources(),
  )
  assert.equal(
    problems.some((problem) => /没有引用任何一条发言/.test(problem.reason)),
    true,
    JSON.stringify(problems),
  )
})

test('校验：不站队就不该挂证据（避免暗示立场）', () => {
  const problems = validateBrief(
    brief({ bystanders: [{ displayName: '路人甲', postCount: 1, evidence: ['p2'] }] }),
    sources(),
  )
  assert.equal(
    problems.some((problem) => /没有说明站队却给了证据/.test(problem.reason)),
    true,
    JSON.stringify(problems),
  )
})

test('校验：引用没读过的帖子同样被拒绝（路人也不例外）', () => {
  const problems = validateBrief(
    brief({
      bystanders: [{ displayName: '路人甲', postCount: 1, leaning: 'opponent', evidence: ['p99'] }],
    }),
    sources(),
  )
  assert.equal(
    problems.some((problem) => /未读取的帖子 p99/.test(problem.reason)),
    true,
    JSON.stringify(problems),
  )
})

test('校验：站队有据、证据属于路人自己时通过', () => {
  const problems = validateBrief(
    brief({
      bystanders: [{ displayName: '路人甲', postCount: 2, leaning: 'opponent', evidence: ['p2'] }],
    }),
    sources(),
  )
  assert.deepEqual(
    problems.filter((problem) => problem.field.startsWith('bystanders[')),
    [],
    `合法引用不该报错：${JSON.stringify(problems)}`,
  )
})

test('渲染：路人有独立小节，且说明「不要当成对手」', () => {
  const text = renderBrief(
    brief({
      bystanders: [
        { displayName: '路人甲', postCount: 2, leaning: 'opponent', evidence: ['p2'] },
        { displayName: '路人乙', postCount: 1 },
      ],
    }),
  )
  assert.match(text, /同一层里的其他参与者/)
  assert.match(text, /路人甲：发言 2 次，明确支持对方（p2）/)
  assert.match(text, /路人乙：发言 1 次，不站队/)
  assert.match(text, /不要把他们当成对手/, '必须明确说明这些人不是交锋对象')
})

test('渲染：没有路人时不出现该小节（空标题像是一个结论）', () => {
  const text = renderBrief(brief())
  assert.equal(text.includes('同一层里的其他参与者'), false, text)
})
