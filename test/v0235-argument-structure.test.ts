/**
 * v0.2.35 §3.1/§3.3：论证结构必须被**算出来**，而不是请模型「注意一下」。
 *
 * ## 这一组测试在防什么
 *
 * 上一版简报有了「对方论据」，但仍然有九件事没被表达：主人问过对方没答的问题、
 * 对方问过主人已答的问题、话题转移、前后矛盾、第三方引用、缺失上下文……
 * 模型看不到这些关系时，回复会显得「读了很多但没读懂」。
 *
 * 更要紧的是**方向**：这些字段全都带「谁说的」。`unansweredByOpponent` 如果引用了
 * 对方的帖子，模型就会去追问一个自己刚提过的问题 —— 回复读起来完全正常，只有对着
 * 原帖看才发现反了。所以每条断言都同时检查「有没有」与「归给谁」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeDispute, type OwnerIdentity } from '../lib/analyzer.js'
import { analyzeArguments } from '../lib/argument-structure.js'
import { buildBrief } from '../lib/brief-builder.js'
import { validateBrief } from '../lib/brief.js'
import type { CollectedThread } from '../lib/collector.js'

const owner: OwnerIdentity = { platform: 'weibo', userId: '9001' }

/**
 * Build a Weibo-shaped thread: the body is the owner's, one comment thread hangs under it.
 *
 * ## Why the comments are nested rather than separate floors
 *
 * This is the shape the analyzer actually reconstructs: `exchange` is the *container
 * floor's* timeline, not the whole thread. Making each comment its own floor produced an
 * exchange of one post — and every test then "passed" by finding nothing, which is the
 * failure mode that makes a green suite meaningless. The first comment is the floor, the
 * rest are replies under it, exactly as the real page nests them.
 */
function thread(comments: readonly { id: string; who: 'owner' | 'opponent'; text: string }[]): CollectedThread {
  const platform = 'weibo' as const
  const mk = (postId: string, name: string, content: string) => ({
    postId,
    platform,
    authorId: name,
    authorName: name,
    content,
    createdAt: '2026-11-08T00:00:00Z',
    ...(name === '主人'
      ? { authorNumericUid: '9001', authorNumericUidKind: 'platform:weibo' as const }
      : { authorNumericUid: '9002', authorNumericUidKind: 'platform:weibo' as const }),
  })
  const first = comments[0]
  if (first === undefined) throw new Error('至少需要一条评论')
  return {
    thread: {
      platform,
      forum: { platform, name: '' },
      id: '7001',
      title: '评测',
      content: '这个方案的成本不会翻倍，我算过。',
      bodyNode: 'standalone',
      authorId: '主人',
      authorName: '主人',
      authorSource: 'platform_contract',
      authorNumericUid: '9001',
      authorNumericUidKind: 'platform:weibo',
    },
    floors: [
      {
        floor: mk(first.id, first.who === 'owner' ? '主人' : '对方', first.text),
        nested: comments.slice(1).map((comment) => ({
          ...mk(comment.id, comment.who === 'owner' ? '主人' : '对方', comment.text),
          parentPostId: first.id,
          replyToPostId: first.id,
        })),
        nestedComplete: true,
      },
    ],
    complete: true,
    completeness: { sourceComplete: true, retainedComplete: true, analysisComplete: true, nestedComplete: true, reasons: [] },
    pagesRead: 1,
    notes: [],
    issues: [],
    securityNotes: [],
  } as unknown as CollectedThread
}

/** Analyse one thread and return the structure plus the brief it produced. */
function structureOf(comments: readonly { id: string; who: 'owner' | 'opponent'; text: string }[]) {
  const collected = thread(comments)
  const dispute = analyzeDispute(collected, owner, { postId: comments[0]!.id })
  const structure = analyzeArguments({ collected, dispute })
  const built = buildBrief({
    collected,
    dispute,
    platform: 'weibo',
    threadId: '7001',
    targetPostId: comments[0]!.id,
  })
  return { collected, dispute, structure, built }
}

test('主人问过、对方没答的问题：带的是主人那条帖子的 id', () => {
  const { structure } = structureOf([
    // 楼层从对方那句开始：真实讨论里，主人的追问总是跟在对方发言之后。若让主人先说，
    // 分析器按设计会拒绝认定对手（「主人发言之前没有其他参与者」），这一条就测不到结构。
    { id: '7100', who: 'opponent', text: '这个方案的成本至少要翻一倍，你们根本没算过。' },
    { id: '7101', who: 'owner', text: '你说成本会翻倍，那个数字是哪来的？有没有具体的测算？' },
    { id: '7102', who: 'opponent', text: '反正我身边做这行的人都这么说，你不会懂的。' },
  ])

  const questions = structure.unansweredByOpponent
  assert.ok(questions.length > 0, '主人明确问了「哪来的」，结构里必须有这一条')
  for (const question of questions) {
    assert.equal(question.postId, '7101', `问题应归给主人那条帖子，实际 ${question.postId}`)
    assert.equal(question.answerPostId, undefined, '对方没有回答，不应出现回答帖')
    assert.match(question.quote, /哪来的|测算|翻倍/)
  }
})

test('对方问过、主人已经回答的问题：提问归对方、回答归主人', () => {
  const { structure } = structureOf([
    { id: '7200', who: 'opponent', text: '这个方案成本太高了，你们算过账没有？' },
    { id: '7201', who: 'opponent', text: '你说不会翻倍，那你算过三年期的总成本吗？' },
    { id: '7202', who: 'owner', text: '三年总成本我算过，摊销之后每年只多 8%，这个数字在正文里。' },
    { id: '7203', who: 'opponent', text: '8% 也不少了。' },
  ])

  const answered = structure.answeredByOwner
  assert.ok(answered.length > 0, '主人已经回答过这个问题，台账里必须有')
  // 台账里可能有不止一条（对方问了两句），要找的是「三年总成本」这一条。
  const entry = answered.find((item) => item.postId === '7201')
  assert.ok(entry !== undefined, `应记录 7201 这条提问，实际：${JSON.stringify(answered.map((i) => i.postId))}`)
  assert.equal(entry!.answerPostId, '7202', '回答帖必须是主人那条')
})

test('前后矛盾：同一说法一句肯定一句否定才会被认出', () => {
  const { structure } = structureOf([
    { id: '7301', who: 'opponent', text: '这个方案的成本会翻倍，根本做不了。' },
    { id: '7302', who: 'owner', text: '翻倍这个结论你有测算吗？' },
    { id: '7303', who: 'opponent', text: '其实这个方案的成本不会翻倍，问题在别的地方。' },
  ])

  const found = structure.contradictions
  assert.equal(found.length, 1, `应识别出一处前后矛盾，实际 ${found.length}`)
  assert.equal(found[0]!.firstPostId, '7301')
  assert.equal(found[0]!.secondPostId, '7303')
  assert.ok(found[0]!.subject.length >= 2, '必须给出两句共同的说法，否则读者无法核对')
})

test('立场不同但不是矛盾：两个人各说各的不会被标成前后矛盾', () => {
  const { structure } = structureOf([
    { id: '7401', who: 'opponent', text: '我更看重上线速度，这个方案太慢了。' },
    { id: '7402', who: 'owner', text: '速度我理解，但成本这块你没有回应。' },
    { id: '7403', who: 'opponent', text: '成本可以以后再算，先上线。' },
  ])
  assert.equal(structure.contradictions.length, 0, '没有同句肯定/否定，就不该报矛盾')
})

test('转移话题：必须先有一条在话题上的发言作对照', () => {
  const { structure } = structureOf([
    { id: '7501', who: 'opponent', text: '这个方案的成本会翻倍，因为要重新采购设备。' },
    { id: '7502', who: 'owner', text: '采购设备的钱可以分摊到三年。' },
    { id: '7503', who: 'opponent', text: '你这人说话态度就有问题，难怪没人愿意跟你合作。' },
  ])

  const shifts = structure.topicShifts
  assert.ok(shifts.length >= 1, '从成本跳到人身，应被识别为转移话题')
  assert.equal(shifts[0]!.postId, '7503')
  assert.equal(shifts[0]!.previousPostId, '7501', '对照必须是之前那条在话题上的发言')
})

test('第三方引用：单独成条，不当成对方自己的主张', () => {
  const { structure, built } = structureOf([
    { id: '7601', who: 'opponent', text: '「专家说成本会翻倍」，这不是我一个人这么看。' },
    { id: '7602', who: 'owner', text: '哪个专家？有原文吗？' },
  ])

  const citations = structure.thirdPartyCitations
  assert.equal(citations.length, 1, `应识别出一条第三方引用，实际 ${citations.length}`)
  assert.equal(citations[0]!.postId, '7601')
  assert.match(citations[0]!.quote, /成本会翻倍/)
  assert.ok(citations[0]!.attribution?.includes('专家'), '应记下是谁说的')

  // 简报里它必须在「第三方」那一段，而不是「对方的核心论据」里。
  const brief = built.brief
  assert.equal(brief.thirdPartyCitations?.length, 1)
  const problems = validateBrief(brief, built.sources)
  assert.deepEqual(problems, [], `简报不应有校验问题：${JSON.stringify(problems)}`)
})

test('以偏概全：个例 + 全称结论才会被认出', () => {
  const { structure } = structureOf([
    { id: '7701', who: 'opponent', text: '我朋友公司就是这么干的，所以所有公司都会翻倍。' },
    { id: '7702', who: 'owner', text: '一家公司的经验推不到所有公司。' },
  ])
  const codes = structure.fallacies.map((item) => item.code)
  assert.ok(codes.includes('hasty_generalization'), `应识别以偏概全，实际 ${codes.join(',')}`)
})

test('一条平静的、就事论事的讨论不会产出任何逻辑谬误', () => {
  const { structure } = structureOf([
    { id: '7801', who: 'opponent', text: '我担心的是现金流，一次性支出 30 万会压得很紧。' },
    { id: '7802', who: 'owner', text: '这 30 万分三期付，每期 10 万，现金流压力会小很多。' },
    { id: '7803', who: 'opponent', text: '三期的话利息怎么算？' },
  ])
  assert.deepEqual(
    structure.fallacies,
    [],
    `不该凭立场推断谬误，实际：${JSON.stringify(structure.fallacies.map((f) => f.code))}`,
  )
})

test('引文必须真的在它标注的帖子里：伪造一条会被校验拦下', () => {
  const { built } = structureOf([
    { id: '7901', who: 'opponent', text: '这个方案的成本会翻倍。' },
    { id: '7902', who: 'owner', text: '翻倍这个结论你有测算吗？' },
  ])
  const tampered = {
    ...built.brief,
    fallacies: [
      {
        code: 'hasty_generalization' as const,
        label: '以偏概全',
        postId: '7901',
        quote: '这句话根本不在那条帖子里',
        why: '测试伪造',
        confidence: 'high' as const,
      },
    ],
  }
  const problems = validateBrief(tampered, built.sources)
  assert.ok(
    problems.some((problem) => problem.reason.includes('不在它标注的帖子')),
    `伪造引文必须被拦下，实际：${JSON.stringify(problems)}`,
  )
})

test('方向校验：把主人的问题归给对方，简报校验必须报错', () => {
  const { built } = structureOf([
    { id: '7951', who: 'owner', text: '你这个数字是哪来的？' },
    { id: '7952', who: 'opponent', text: '不用你管。' },
  ])
  const tampered = {
    ...built.brief,
    unansweredByOpponent: [
      { quote: '你这个数字是哪来的？', postId: '7952' },
    ],
  }
  const problems = validateBrief(tampered, built.sources)
  assert.ok(
    problems.some((problem) => problem.reason.includes('不是主人发的')),
    `把主人的问题挂到对方帖子上必须被拦下，实际：${JSON.stringify(problems)}`,
  )
})

test('矛盾只能归给对方：挂在主人名下会被校验拦下', () => {
  const { built } = structureOf([
    { id: '7961', who: 'owner', text: '成本会翻倍。' },
    { id: '7962', who: 'opponent', text: '成本不会翻倍。' },
  ])
  const tampered = {
    ...built.brief,
    contradictions: [
      { firstPostId: '7961', firstQuote: '成本会翻倍。', secondPostId: '7962', secondQuote: '成本不会翻倍。', subject: '成本' },
    ],
  }
  const problems = validateBrief(tampered, built.sources)
  assert.ok(problems.length > 0, '把主人卷进「对方前后矛盾」必须被拦下')
  assert.ok(problems.some((problem) => problem.reason.includes('不是对方发的')))
})

test('没有对方的帖子时，结构为空而不是崩溃', () => {
  const collected = thread([{ id: '7971', who: 'owner', text: '我自己补充一句，这个方案我算过。' }])
  const dispute = analyzeDispute(collected, owner, { postId: '7971' })
  const structure = analyzeArguments({ collected, dispute })
  assert.deepEqual(structure.unansweredByOpponent, [])
  assert.deepEqual(structure.contradictions, [])
  assert.deepEqual(structure.fallacies, [])
})
