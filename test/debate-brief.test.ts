/**
 * DebateBrief: the structure a reply is generated from, and its citations.
 *
 * The brief's whole value is that every claim points at a post. These tests
 * therefore attack the citations: a brief that cites a post nobody read, puts the
 * opponent's words in the owner's mouth, or calls a one-sided claim "agreed" must
 * be rejected before it can influence generation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  renderBrief,
  validateBrief,
  type BriefSources,
  type DebateBrief,
} from '../lib/brief.js'

/** Citation universe: three owner posts, three opponent posts. */
function sources(): BriefSources {
  const owner = new Set(['o1', 'o2', 'o3'])
  const opponent = new Set(['r1', 'r2', 'r3'])
  return {
    ownerPostIds: owner,
    opponentPostIds: opponent,
    allPostIds: new Set([...owner, ...opponent]),
  }
}

/** A brief that passes every check, as the baseline to break in each test. */
function validBrief(): DebateBrief {
  return {
    platform: 'demo',
    threadId: 't1',
    targetPostId: 'r3',
    owner: { side: 'owner', summary: '加班该有补偿', evidence: ['o1', 'o2'] },
    opponent: { side: 'opponent', summary: '不想干可以走', evidence: ['r1'] },
    disagreements: ['加班是不是应该给补偿'],
    agreedFacts: [{ statement: '公司最近都在加班', evidence: ['o1', 'r1'] }],
    arguments: [{ claim: '连续加班影响健康', evidence: ['o2'] }],
    challenges: [
      { quote: '你那是事实还是情绪', evidence: 'r2', unanswered: 'no_reply' },
    ],
    openQuestions: [],
    uncertainties: [],
    directions: ['rebut'],
    risks: [],
  }
}

test('完整的简报通过校验', () => {
  assert.deepEqual(validateBrief(validBrief(), sources()), [])
})

test('引用未读取的帖子会被拒绝', () => {
  const brief = validBrief()
  const broken: DebateBrief = {
    ...brief,
    arguments: [{ claim: '有个论据', evidence: ['ghost-post'] }],
  }
  const problems = validateBrief(broken, sources())
  assert.ok(problems.length > 0, '引用不存在的帖子必须报错')
  assert.ok(problems.some((problem) => problem.reason.includes('未读取')))
})

test('把对方的发言当作主人的立场会被拒绝', () => {
  // This is the "argues on a stranger's behalf" failure at the brief layer: the
  // owner's position citing the opponent's post would make the generator defend
  // something the owner never said.
  const brief = validBrief()
  const broken: DebateBrief = {
    ...brief,
    owner: { side: 'owner', summary: '对方观点被当成了主人观点', evidence: ['r1'] },
  }
  const problems = validateBrief(broken, sources())
  assert.ok(
    problems.some((problem) => problem.field === 'owner'),
    '主人的立场引用了对方的帖子必须报错',
  )
})

test('没有证据引用的立场会被拒绝', () => {
  const broken: DebateBrief = {
    ...validBrief(),
    opponent: { side: 'opponent', summary: '凭空捏造的观点', evidence: [] },
  }
  const problems = validateBrief(broken, sources())
  assert.ok(problems.some((problem) => problem.reason.includes('没有任何证据引用')))
})

test('「双方确认的事实」若证据只来自一方会被拒绝', () => {
  const broken: DebateBrief = {
    ...validBrief(),
    agreedFacts: [{ statement: '只有主人这么说', evidence: ['o1', 'o2'] }],
  }
  const problems = validateBrief(broken, sources())
  assert.ok(
    problems.some((problem) => problem.reason.includes('证据只来自一方')),
    '单方面的说法不能标成双方确认的事实',
  )
})

test('没有指出任何分歧的简报会被拒绝', () => {
  const broken: DebateBrief = { ...validBrief(), disagreements: [] }
  const problems = validateBrief(broken, sources())
  assert.ok(problems.some((problem) => problem.field === 'disagreements'))
})

test('回复目标必须在本次读取的对话里', () => {
  const broken: DebateBrief = { ...validBrief(), targetPostId: 'not-read' }
  const problems = validateBrief(broken, sources())
  assert.ok(problems.some((problem) => problem.field === 'targetPostId'))
})

test('质疑必须引用对方原话，不能只写概括', () => {
  const broken: DebateBrief = {
    ...validBrief(),
    challenges: [{ quote: '   ', evidence: 'r2', unanswered: 'no_reply' }],
  }
  const problems = validateBrief(broken, sources())
  assert.ok(problems.some((problem) => problem.field === 'challenges[0].quote'))
})

test('把主人的发言归成对方的质疑会被拒绝', () => {
  const broken: DebateBrief = {
    ...validBrief(),
    challenges: [{ quote: '主人自己的话', evidence: 'o1', unanswered: 'no_reply' }],
  }
  const problems = validateBrief(broken, sources())
  assert.ok(problems.some((problem) => problem.field === 'challenges[0].evidence'))
})

test('一次报出所有问题，而不是只报第一个', () => {
  // Three separate fabrications in one brief should be reported together; fixing
  // them one round-trip at a time wastes the reviewer's attention.
  const broken: DebateBrief = {
    ...validBrief(),
    owner: { side: 'owner', summary: 'x', evidence: ['ghost1'] },
    opponent: { side: 'opponent', summary: 'y', evidence: ['ghost2'] },
    arguments: [{ claim: 'z', evidence: ['ghost3'] }],
  }
  const problems = validateBrief(broken, sources())
  assert.ok(problems.length >= 3, `应一次报出全部问题，实际只报了 ${problems.length} 个`)
})

test('渲染出的审阅文本包含所有引用，便于逐条核对', () => {
  const text = renderBrief(validBrief())
  // Every cited id must be visible: a review that hides the evidence is theatre.
  for (const postId of ['o1', 'o2', 'r1', 'r2']) {
    assert.ok(text.includes(postId), `审阅文本里应能看到引用 ${postId}`)
  }
  assert.match(text, /核心分歧/)
  assert.match(text, /对方尚未被回应的质疑/)
})

test('渲染结果不包含 undefined', () => {
  const brief: DebateBrief = { ...validBrief(), uncertainties: [], openQuestions: [] }
  const text = renderBrief(brief)
  assert.doesNotMatch(text, /undefined/)
})
