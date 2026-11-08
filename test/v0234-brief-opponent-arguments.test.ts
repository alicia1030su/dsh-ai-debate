/**
 * v0.2.34 §4.2：简报必须写出**对方的**核心论据，且不能与主人的混在一起。
 *
 * ## 这一条补的是什么
 *
 * 此前简报有「对方立场」（一句摘要）与「尚未被回应的质疑」，但没有对方**逐条**的
 * 论据。结果模型只能泛泛地说「你的说法站不住」，无法指名反驳第二条。
 *
 * ## 为什么断言里要检查「不在主人那一段」
 *
 * 只断言「出现了对方的话」是不够的：如果构造逻辑把两边的语句合进一个列表，
 * 断言照样通过，而模型会拿着对方的话当主人的立场去坚持 —— 那是替主人改口，
 * 比漏掉一条论据严重得多。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBrief, renderBriefCompact } from '../lib/brief-builder.js'
import { renderBrief, validateBrief } from '../lib/brief.js'
import { analyzeDispute } from '../lib/analyzer.js'
import type { CollectedThread, OwnerIdentity } from '../lib/types.js'

/** 一条微博形状的讨论：主人发了正文，评论里在吵。 */
function thread(): CollectedThread {
  const platform = 'weibo' as const
  const mk = (postId: string, authorName: string, content: string, extra: Record<string, unknown> = {}) => ({
    postId,
    platform,
    authorId: authorName,
    authorName,
    content,
    createdAt: '2026-11-08T00:00:00Z',
    ...extra,
  })

  return {
    thread: {
      platform,
      forum: { platform, name: '' },
      id: '8001',
      title: '评测',
      content: '预算我算过，翻倍不至于。',
      bodyNode: 'standalone',
      authorId: '主人',
      authorName: '主人',
      authorSource: 'platform_contract',
      authorNumericUid: '5001',
      authorNumericUidKind: 'platform:weibo',
    },
    floors: [
      {
        floor: mk('8002', '对方', '成本至少翻一倍，你根本没算过。', {
          authorNumericUid: '5002',
          authorNumericUidKind: 'platform:weibo',
        }),
        nested: [
          mk('8003', '对方', '而且你只看了第一年，三年下来差得更多。', {
            authorNumericUid: '5002',
            authorNumericUidKind: 'platform:weibo',
          }),
        ],
      },
    ],
    complete: true,
    pagesRead: 1,
    notes: [],
    issues: [],
    securityNotes: [],
  } as unknown as CollectedThread
}

const owner: OwnerIdentity = { platform: 'weibo', userId: '5001' }

test('对方的多条论据都进简报，且各自带自己的 postId', () => {
  const collected = thread()
  const dispute = analyzeDispute(collected, owner, { postId: '8002' })
  const { brief } = buildBrief({ dispute, platform: 'weibo', threadId: '8001', collected })

  assert.ok(brief.opponentArguments.length >= 2, `期望至少两条对方论据，实际 ${brief.opponentArguments.length}`)
  for (const argument of brief.opponentArguments) {
    assert.ok(argument.evidence.length > 0, `论据「${argument.claim}」没有出处`)
    assert.ok(
      ['8002', '8003'].includes(argument.evidence[0]!),
      `对方论据引用了 ${argument.evidence[0]}，那不是对方发的`,
    )
  }
})

test('主人的论据里不出现对方的话，反之亦然', () => {
  const collected = thread()
  const dispute = analyzeDispute(collected, owner, { postId: '8002' })
  const { brief } = buildBrief({ dispute, platform: 'weibo', threadId: '8001', collected })

  const opponentTexts = brief.opponentArguments.map((item) => item.claim).join('\n')
  const ownerTexts = brief.arguments.map((item) => item.claim).join('\n')

  // 对方说的是「成本至少翻一倍」，主人说的是「预算我算过」——两边的关键词不能串。
  assert.equal(opponentTexts.includes('翻倍不至于'), false, '对方的论据里混进了主人的话')
  assert.equal(ownerTexts.includes('成本至少翻一倍'), false, '主人的论据里混进了对方的话')
})

test('渲染出的提示词里，对方论据单独成段并带出处', () => {
  const collected = thread()
  const dispute = analyzeDispute(collected, owner, { postId: '8002' })
  const { brief } = buildBrief({ dispute, platform: 'weibo', threadId: '8001', collected })
  const text = renderBrief(brief)

  assert.match(text, /## 对方的核心论据/)
  // 出处必须印出来：没有 id 的论据无法核对。
  assert.match(text, /8002|8003/)
  // 段的顺序：对方论据在「核心分歧」之前（模型读到分歧时手上已有两组具体句子）。
  const opponentAt = text.indexOf('## 对方的核心论据')
  const disputeAt = text.indexOf('## 核心分歧')
  if (disputeAt !== -1) assert.ok(opponentAt < disputeAt, '对方论据必须排在核心分歧之前')
})

test('简报校验覆盖对方论据的出处：伪造一条对方论据会被拦下', () => {
  const collected = thread()
  const dispute = analyzeDispute(collected, owner, { postId: '8002' })
  const { brief, sources } = buildBrief({ dispute, platform: 'weibo', threadId: '8001', collected })

  // 把一条「主人」的 postId 塞进对方论据，模拟构造逻辑写错方向的后果。
  const tampered = {
    ...brief,
    opponentArguments: [{ claim: '伪造的对方论据', evidence: [brief.owner.evidence[0] ?? '8001'] }],
  }
  const problems = validateBrief(tampered, sources)
  assert.ok(
    problems.some((problem) => problem.field.startsWith('opponentArguments')),
    `应当报出对方论据的出处问题，实际：${JSON.stringify(problems)}`,
  )
})

test('紧凑渲染在放得下时保留对方论据，放不下时保留数量与 id', () => {
  const collected = thread()
  const dispute = analyzeDispute(collected, owner, { postId: '8002' })
  const { brief } = buildBrief({ dispute, platform: 'weibo', threadId: '8001', collected })

  const roomy = renderBriefCompact(brief, 4000)
  assert.match(roomy, /对方论据：/)

  /**
   * 只够放 id 与计数、放不下逐条论据的窗口。
   *
   * 80 这个数不是随便挑的：完整版约 120 字符，压缩版约 60——落在中间，
   * 于是断言的是「压缩发生了，且压缩后仍然保留了论据数量」。
   * 给 30 会连压缩版都被截断，那时看到的是 slice 的结果，测不到这个分支。
   */
  const tight = renderBriefCompact(brief, 80)
  assert.match(tight, /对方论据数：/, `压缩版丢了论据计数：${JSON.stringify(tight)}`)
  // 压缩版不该再带逐条正文（否则等于没压缩）。
  assert.doesNotMatch(tight, /对方论据：/)
})
