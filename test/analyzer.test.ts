/**
 * Argument analysis tests.
 *
 * The acceptance list is explicit about what must go wrong here: an AI that
 * replies to whoever spoke last instead of the person the owner is arguing with.
 * Test 4 targets exactly that, and test 5 checks the owner's earlier statements
 * survive into the summary.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute, describeParticipants, extractClaims, looksLikeQuestion } from '../lib/analyzer.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'
import { makeFloor, makeNested } from './helpers.ts'

/** Wrap floors and nested replies into the shape the analyzer consumes. */
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
  }
}

/** A thread header used by the fixtures below. */
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

test('test 3: 30 nested replies with several participants resolve their relations', () => {
  const floorPostId = '500'
  const nested: NestedReply[] = []
  const people = ['甲', '乙', '丙']
  for (let index = 0; index < 30; index += 1) {
    const speaker = people[index % people.length] as string
    const target = index === 0 ? undefined : (people[(index - 1) % people.length] as string)
    nested.push(
      makeNested({
        postId: `c${index + 1}`,
        parentPostId: floorPostId,
        authorId: `id-${speaker}`,
        authorName: speaker,
        content: target ? `回复 ${target} :第 ${index + 1} 条` : `第 ${index + 1} 条开场`,
        replyToName: target,
      }),
    )
  }

  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 3, postId: floorPostId, authorId: 'id-甲', authorName: '甲', content: '开场', nestedCount: 30 })],
    { [floorPostId]: nested },
  )

  const participants = describeParticipants(data, 3)
  assert.equal(participants.length, 3, `应该是 3 位参与者，实际 ${participants.length}`)
  assert.deepEqual(
    participants.map((entry) => entry.displayName).sort(),
    ['丙', '乙', '甲'].sort(),
  )
  // 30 nested replies across 3 people plus the floor's own post by 甲 itself.
  const totalPosts = participants.reduce((sum, entry) => sum + entry.postCount, 0)
  assert.equal(totalPosts, 31, `3 位参与者的发言总数应为 31（30 条楼中楼 + 1 楼主体）`)

  const dispute = analyzeDispute(data, { userId: 'id-甲' }, { postId: 'c28' })
  assert.equal(dispute.floorNumber, 3)
  assert.ok(dispute.exchange.length > 0)
})

test('test 4: the AI locks onto the opponent, not whoever spoke last', () => {
  // 主人 argues with 对手B across several exchanges; 路人C drifts in at the end
  // with an unrelated remark. A "reply to the latest speaker" heuristic would
  // pick C. The analyzer must pick B, on interaction evidence.
  const floorPostId = '600'
  const nested = [
    makeNested({ postId: 'a1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '这个方案成本会翻倍。' }),
    makeNested({ postId: 'b1', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :有数据吗？', replyToName: '主人' }),
    makeNested({ postId: 'a2', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '回复 对手B :前面贴过报价了。', replyToName: '对手B' }),
    makeNested({ postId: 'b2', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :那报价是同型号吗？', replyToName: '主人' }),
    makeNested({ postId: 'a3', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '回复 对手B :同型号，去年两次采购。', replyToName: '对手B' }),
    makeNested({ postId: 'c1', parentPostId: floorPostId, authorId: 'c', authorName: '路人C', content: '我倒觉得可以试试，反正不贵。' }),
    makeNested({ postId: 'a4', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@吵架小号 来帮我说两句。' }),
  ]

  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 5, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length })],
    { [floorPostId]: nested },
  )

  const dispute = analyzeDispute(data, { userId: 'o' }, { postId: 'a4' })

  assert.equal(dispute.owner.displayName, '主人')
  assert.equal(dispute.opponent?.displayName, '对手B', '争论对象必须是 对手B，不能是最后发言的路人C')
  // The key is the display name: identity merges across a handle being present on
  // one post and absent on another, which the platform does inconsistently.
  assert.equal(dispute.opponent?.key, '对手B')
  assert.ok(
    (dispute.opponentEvidence?.exchanges ?? 0) >= 4,
    `主人与对手B的往来应该被统计到，实际 ${dispute.opponentEvidence?.exchanges}`,
  )
  assert.ok(
    !dispute.exchange.some((statement) => statement.authorName === '路人C'),
    '争论链里不应混入路人C',
  )
  assert.equal(dispute.needsConfirmation, false)
})

test('test 5: the owner\'s earlier claims survive into the summary', () => {
  const floorPostId = '700'
  const nested = [
    makeNested({ postId: 'e1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '我的观点是成本会翻倍，因为去年采购价已经涨了 40%。' }),
    makeNested({ postId: 'e2', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '补充一下：我说的是三年期的总成本，不是单价。' }),
    makeNested({ postId: 'e3', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :你这算法有问题吧。', replyToName: '主人' }),
    makeNested({ postId: 'e4', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@小号 上。' }),
  ]
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 8, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length })],
    { [floorPostId]: nested },
  )

  const dispute = analyzeDispute(data, { userId: 'o' }, { postId: 'e4' })
  // Three nested owner posts plus the floor body, which is also the owner's.
  assert.equal(dispute.ownerStatements.length, 4)
  const claims = extractClaims(dispute.ownerStatements)
  const joined = claims.join('｜')
  assert.match(joined, /成本会翻倍/, '必须保留主人最早的主张')
  assert.match(joined, /三年期的总成本/, '必须保留主人的补充限定条件')
})

test('a question from the opponent with no reply is reported as open', () => {
  const floorPostId = '800'
  const nested = [
    makeNested({ postId: 'q1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '这个不行。' }),
    makeNested({ postId: 'q2', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :凭什么不行？有依据吗？', replyToName: '主人' }),
    makeNested({ postId: 'q3', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@小号 上。' }),
  ]
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 2, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length })],
    { [floorPostId]: nested },
  )

  const dispute = analyzeDispute(data, { userId: 'o' }, { postId: 'q3' })
  assert.equal(dispute.openQuestions.length, 1)
  assert.match(dispute.openQuestions[0]!.content, /凭什么/)
})

test('the owner is matched by id first, and by name only as a recorded fallback', () => {
  const floorPostId = '900'
  const nested = [
    makeNested({ postId: 'm1', parentPostId: floorPostId, authorId: 'u-1', authorName: '张三', content: '我说的就是这个。' }),
    makeNested({ postId: 'm2', parentPostId: floorPostId, authorId: 'u-2', authorName: '李四', content: '回复 张三 :不对。', replyToName: '张三' }),
  ]
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 1, postId: floorPostId, authorId: 'u-1', authorName: '张三', content: '开场', nestedCount: 2 })],
    { [floorPostId]: nested },
  )

  const byId = analyzeDispute(data, { userId: 'u-1' }, { postId: 'm2' })
  assert.equal(byId.owner.displayName, '张三')

  const byName = analyzeDispute(data, { userName: '张三' }, { postId: 'm2' })
  assert.equal(byName.owner.displayName, '张三')
  assert.ok(
    byName.notes.some((note) => note.includes('昵称')),
    '按昵称匹配必须留下提示，不能静默接受',
  )
})

test('one person with and without a handle is one participant, not two', () => {
  // Found against a live thread: a floor carries the account name as the handle
  // while the same person's nested reply carries only a shown name. Keying on
  // "id if present, else name" split them into two people and made the owner
  // look ambiguous, so the plugin refused to run.
  const floorPostId = '1001'
  const nested = [
    makeNested({ postId: 'h1', parentPostId: floorPostId, authorId: '似水蓝蝶', authorName: '似水蓝蝶', content: '我说的就是这个意思。' }),
    // Same person, no handle on this post.
    makeNested({ postId: 'h2', parentPostId: floorPostId, authorId: undefined, authorName: '似水蓝蝶', content: '再补充一句，我是按去年的价格算的。' }),
    makeNested({ postId: 'h3', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 似水蓝蝶 :那不合适吧。', replyToName: '似水蓝蝶' }),
    // The summon, by the owner, after the argument.
    makeNested({ postId: 'h4', parentPostId: floorPostId, authorId: undefined, authorName: '似水蓝蝶', content: '@小号 过来帮我说两句。' }),
  ]
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 1, postId: floorPostId, authorId: '似水蓝蝶', authorName: '似水蓝蝶', content: '开场', nestedCount: nested.length })],
    { [floorPostId]: nested },
  )

  // The configured name must resolve: not "ambiguous", not "not found".
  const dispute = analyzeDispute(data, { userName: '似水蓝蝶' }, { postId: 'h4' })
  assert.equal(dispute.owner.displayName, '似水蓝蝶')
  // Four posts by that person: the floor body plus three nested replies.
  assert.equal(dispute.owner.postCount, 4)
  assert.equal(dispute.opponent?.displayName, '对手B')
})

test('a name genuinely shared by two accounts is still refused', () => {
  // The merge must not become a way to silently pick the wrong person: if two
  // distinct handles appear under one display name, the owner check refuses.
  const floorPostId = '1002'
  const nested = [
    makeNested({ postId: 'm1', parentPostId: floorPostId, authorId: 'x-1', authorName: '同名', content: '我是 A 号。' }),
    makeNested({ postId: 'm2', parentPostId: floorPostId, authorId: 'x-2', authorName: '同名', content: '我是 B 号。' }),
  ]
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 1, postId: floorPostId, authorId: 'x-1', authorName: '同名', content: '开场', nestedCount: 2 })],
    { [floorPostId]: nested },
  )

  assert.throws(
    () => analyzeDispute(data, { userName: '同名' }, { postId: 'm2' }),
    /出现了 2 个不同的账号/,
  )
})

test('an absent owner is a clear error, not a silent empty analysis', () => {
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 1, postId: '1000', authorId: 'z', authorName: '别人', content: '发言', nestedCount: 0 })],
    {},
  )
  // The message names what was configured and states that nickname fallback is
  // deliberately refused — that is the P0-3 contract, so assert on it.
  assert.throws(
    () => analyzeDispute(data, { userId: 'nobody' }, { postId: '1000' }),
    /配置的主人用户 ID 是 nobody.*不会退回去按昵称匹配/s,
  )
})

test('a configured owner id never degrades to a matching nickname', () => {
  // The exact P0-3 reproduction: configured id 99999 + nickname Alice, while the
  // post belongs to uid 12345 who also calls themselves Alice. Accepting that user
  // would put a stranger's words in the owner's mouth.
  const data = collected(
    makeThread(),
    [
      makeFloor({
        floorNumber: 1,
        postId: '1200',
        authorId: '12345',
        authorName: 'Alice',
        content: '这个方案不行',
        nestedCount: 0,
      }),
    ],
    {},
  )
  assert.throws(
    () => analyzeDispute(data, { userId: '99999', userName: 'Alice' }, { postId: '1200' }),
    /配置的主人用户 ID 是 99999.*不会退回去按昵称匹配/s,
  )
})

test('a matching owner id is still accepted when a nickname is also configured', () => {
  // The control: adding a nickname must not break the id match.
  const data = collected(
    makeThread(),
    [
      makeFloor({
        floorNumber: 1,
        postId: '1300',
        authorId: '12345',
        authorName: 'Alice',
        content: '我不同意这个做法',
        nestedCount: 0,
      }),
    ],
    {},
  )
  const dispute = analyzeDispute(data, { userId: '12345', userName: 'Alice' }, { postId: '1300' })
  assert.equal(dispute.owner.userId, '12345')
})

test('a nickname match is refused when ids exist but the configured id is absent', () => {
  // Same name, different id: the id is authoritative, so this must not pass.
  const data = collected(
    makeThread(),
    [
      makeFloor({ floorNumber: 1, postId: '1400', authorId: 'aaa', authorName: '同名', content: '甲说的话', nestedCount: 0 }),
      makeFloor({ floorNumber: 2, postId: '1401', authorId: 'bbb', authorName: '同名', content: '乙说的话', nestedCount: 0 }),
    ],
    {},
  )
  assert.throws(
    () => analyzeDispute(data, { userId: 'ccc', userName: '同名' }, { postId: '1400' }),
    /配置的主人用户 ID 是 ccc/,
  )
})

test('a trigger post outside the collected data is rejected', () => {
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 1, postId: '1100', authorId: 'o', authorName: '主人', content: '发言', nestedCount: 0 })],
    {},
  )
  assert.throws(() => analyzeDispute(data, { userId: 'o' }, { postId: 'missing' }), /不在已采集的对话中/)
})

test('questions are detected in both Chinese and English punctuation', () => {
  assert.equal(looksLikeQuestion('这是什么？'), true)
  assert.equal(looksLikeQuestion('what is this?'), true)
  assert.equal(looksLikeQuestion('你为什么这么说'), true)
  assert.equal(looksLikeQuestion('这个方案不行。'), false)
})

test('claims exclude questions the owner asked', () => {
  const claims = extractClaims([
    {
      postId: '1',
      floorNumber: 1,
      authorKey: 'o',
      content: '这个方案成本会翻倍。为什么你们就是不信？我已经算过了！',
    },
  ])
  assert.ok(claims.some((claim) => claim.includes('成本会翻倍')))
  assert.ok(!claims.some((claim) => claim.includes('为什么你们就是不信')))
})

test('a tie in evidence marks the target as needing confirmation', () => {
  const floorPostId = '1200'
  const nested = [
    makeNested({ postId: 't1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '开场' }),
    makeNested({ postId: 't2', parentPostId: floorPostId, authorId: 'b1', authorName: '甲', content: '回复 主人 :说法一', replyToName: '主人' }),
    makeNested({ postId: 't3', parentPostId: floorPostId, authorId: 'b2', authorName: '乙', content: '回复 主人 :说法二', replyToName: '主人' }),
    makeNested({ postId: 't4', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@小号 上。' }),
  ]
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 1, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length })],
    { [floorPostId]: nested },
  )
  const dispute = analyzeDispute(data, { userId: 'o' }, { postId: 't4' })
  assert.equal(dispute.needsConfirmation, true)
  assert.ok(dispute.notes.some((note) => note.includes('无法可靠判断')))
})
