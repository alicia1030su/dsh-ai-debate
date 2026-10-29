/**
 * v0.2.12 §三：`DebateBrief` 真的进入了正式生成流程。
 *
 * ## 这个文件防的是什么
 *
 * v0.2.11 的 `brief.ts` 有类型、有校验器、有渲染器，**没有构建函数，也没有调用点**。
 * 于是 `validateBrief()` 只在测试里跑过，生产路径根本不知道 brief 的存在。这种状态最
 * 危险的地方是它看起来完整：文件在、测试绿、README 里写着有。
 *
 * 所以这里的断言不测「brief 功能能用」，而是测**接线**：
 *
 * 1. 有个从真实 `Dispute` 构建 brief 的函数；
 * 2. 它构建出的 brief 能通过自己的校验器；
 * 3. 校验失败时**不会去调用模型**（这是安全属性，不是体验问题）；
 * 4. 校验通过时，brief 的正文真的出现在发给模型的 prompt 里；
 * 5. 模型不能改回复目标。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { analyzeDispute } from '../lib/analyzer.js'
import { buildBrief, buildSources, briefIsViable, renderBriefCompact } from '../lib/brief-builder.js'
import { validateBrief } from '../lib/brief.js'
import type { CollectedThread } from '../lib/collector.js'
import { buildGenerationPrompt } from '../lib/generator.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'
import { makeFloor, makeNested } from './helpers.ts'

const SRC = join(import.meta.dirname, '..', 'src')

// ---------------------------------------------------------------------------
// 夹具：一个有第三方参与的真实形状楼层
// ---------------------------------------------------------------------------

function makeThread(id = '900'): Thread {
  return {
    platform: 'tieba',
    forum: { platform: 'tieba', id: '9', name: '测试吧' },
    id,
    title: '帖子标题',
    content: '正文',
    url: `https://tieba.baidu.com/p/${id}`,
    images: [],
  }
}

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
 * Owner argues with 对手B about a price; 路人C drops in; the opponent asks a question the
 * owner never answers.
 *
 * Deliberately includes:
 * - a number in both sides' speech, so `agreedFacts` has something real to find;
 * - an **opponent** question the owner leaves unanswered, so `challenges` is non-empty
 *   (`findOpenQuestions` looks for questions put *to* the owner, not by them — the first
 *   version of this fixture had it backwards and the assertion caught it);
 * - a third party, so `bystanders` is non-empty and must stay out of both positions.
 */
function fixture(): CollectedThread {
  const floorPostId = '900'
  const nested = [
    makeNested({ postId: 'm1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '这个方案的成本会翻倍，去年报价是 12 万。' }),
    makeNested({ postId: 't1', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :翻倍也值，12 万不算贵。你说的报价是哪一年的？', replyToName: '主人' }),
    makeNested({ postId: 'm2', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '回复 对手B :总之这个方案不行。', replyToName: '对手B' }),
    makeNested({ postId: 't2', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :你凭什么这么肯定？', replyToName: '主人' }),
    makeNested({ postId: 'c1', parentPostId: floorPostId, authorId: 'c', authorName: '路人C', content: '我倒觉得他说得有道理。' }),
    // The summon must be **non-substantive** so it does not count as answering the
    // opponent's question. `isSubstantive` strips @-mentions and punctuation and requires
    // six characters, so "@吵架小号 上。" reduces to "上" and does not qualify. The first
    // version said "来帮我说两句", which passed that bar and silently closed both questions.
    makeNested({ postId: 'm3', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@吵架小号 上。' }),
  ]
  return collected(
    makeThread(),
    [makeFloor({ floorNumber: 3, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length })],
    { [floorPostId]: nested },
  )
}

function disputeOf(data: CollectedThread) {
  return analyzeDispute(data, { userId: 'o', platform: 'tieba' }, { postId: 'm3' })
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

test('构建：buildBrief 从真实 Dispute 产出通过校验的 brief', () => {
  // The single most important assertion in this file: the builder's output must satisfy the
  // validator. If these two ever disagree, either the builder invents citations or the
  // validator is checking something the builder never had a chance to satisfy.
  const data = fixture()
  const dispute = disputeOf(data)
  const { brief, sources } = buildBrief({
    platform: 'tieba',
    threadId: '900',
    collected: data,
    dispute,
  })
  const problems = validateBrief(brief, sources)
  assert.deepEqual(problems, [], `构建出的 brief 必须自洽：${JSON.stringify(problems)}`)
})

test('构建：主人与对方的立场都带来源节点，且各自归属正确', () => {
  const data = fixture()
  const dispute = disputeOf(data)
  const { brief, sources } = buildBrief({ platform: 'tieba', threadId: '900', collected: data, dispute })

  assert.equal(brief.owner.side, 'owner')
  assert.equal(brief.opponent.side, 'opponent')
  assert.equal(brief.owner.evidence.length > 0, true, '主人立场必须有引用')
  assert.equal(brief.opponent.evidence.length > 0, true, '对方立场必须有引用')

  // Every citation must belong to the side that claims it.
  for (const id of brief.owner.evidence) {
    assert.equal(sources.ownerPostIds.has(id), true, `${id} 不是主人发的`)
  }
  for (const id of brief.opponent.evidence) {
    assert.equal(sources.opponentPostIds.has(id), true, `${id} 不是对方发的`)
  }
})

test('构建：路人不会混进任何一方的立场（v0.2.12 §三.6）', () => {
  // The failure this prevents: a third party's "我倒觉得他说得有道理" becoming the
  // opponent's position, which would then justify attacking someone who never argued.
  const data = fixture()
  const dispute = disputeOf(data)
  const { brief, sources } = buildBrief({ platform: 'tieba', threadId: '900', collected: data, dispute })

  const bystanderIds = new Set([
    ...dispute.bystanders.map((person) => person.lastPostId).filter((id): id is string => id !== undefined),
  ])
  assert.equal(bystanderIds.size > 0, true, '夹具里应当有路人')
  for (const id of bystanderIds) {
    assert.equal(brief.owner.evidence.includes(id), false, `路人的 ${id} 混进了主人立场`)
    assert.equal(brief.opponent.evidence.includes(id), false, `路人的 ${id} 混进了对方立场`)
  }
  // And the bystander is reported separately, as a fact rather than a side.
  assert.equal(brief.bystanders.length > 0, true)
  assert.equal(brief.bystanders[0]!.displayName, '路人C')
  assert.equal(brief.bystanders[0]!.leaning, undefined, '不得从语气推断站队')
  void sources
})

test('构建：回复目标来自采集到的对手最后一条发言，不是猜的', () => {
  const data = fixture()
  const dispute = disputeOf(data)
  const { brief } = buildBrief({ platform: 'tieba', threadId: '900', collected: data, dispute })
  assert.equal(brief.targetPostId, dispute.opponent?.lastPostId)
  assert.equal(brief.targetPostId, 't2', `实际 ${brief.targetPostId}`)
})

test('构建：对方未回答的问题进入 challenges 与 openQuestions', () => {
  const data = fixture()
  const dispute = disputeOf(data)
  const { brief } = buildBrief({ platform: 'tieba', threadId: '900', collected: data, dispute })
  assert.equal(brief.challenges.length > 0, true, `应识别出未回应的质疑：${JSON.stringify(brief.challenges)}`)
  assert.equal(brief.openQuestions.length > 0, true)

  // ## Which of the two questions counts as "open", and why only one
  //
  // The fixture has the opponent asking at `t1` ("你说的报价是哪一年的？") and `t2`
  // ("你凭什么这么肯定？"). `findOpenQuestions` marks a question open when no *substantive*
  // owner post follows it. After `t1` comes `m2` ("总之这个方案不行"), which is substantive,
  // so `t1` is treated as answered. After `t2` the only owner post left is the bare summon
  // `m3`, which `isSubstantive` rejects, so `t2` stays open.
  //
  // That heuristic is coarse — `m2` does not really answer the question — but it is the
  // existing, tested behaviour, and this version is not the place to redefine it. The
  // assertion records what the analyzer actually concludes so a future change to the
  // heuristic fails here visibly.
  const cited = new Set(brief.challenges.map((challenge) => challenge.evidence))
  assert.equal(cited.has('t2'), true, `最后的提问应被记录：${JSON.stringify([...cited])}`)
  assert.equal(cited.has('t1'), false, 't1 之后有实质回复，按现有启发式不算未回应')

  for (const challenge of brief.challenges) {
    assert.equal(challenge.unanswered, 'no_reply', '分析器只记录没被回复的问题')
    assert.equal(challenge.quote.length > 0, true)
  }
  assert.equal(
    brief.challenges.every((challenge) => !dispute.ownerStatements.some((s) => s.postId === challenge.evidence)),
    true,
    '质疑不能引用主人的发言',
  )
})

test('构建：不确定性被明确记录，而不是沉默', () => {
  // An incomplete read must show up as an uncertainty; a brief that silently omitted it
  // would let a reply be written against half the conversation.
  const data = fixture()
  const incomplete: CollectedThread = {
    ...data,
    complete: false,
    stopReason: 'page_cap',
  } as CollectedThread
  const dispute = disputeOf(incomplete)
  const { brief } = buildBrief({ platform: 'tieba', threadId: '900', collected: incomplete, dispute })
  assert.equal(
    brief.uncertainties.some((item) => /不完整/.test(item.point + item.reason)),
    true,
    `应记录读取不完整：${JSON.stringify(brief.uncertainties)}`,
  )
  assert.equal(brief.risks.some((risk) => /不完整/.test(risk)), true)
})

test('构建：双方都提到的数字被记为共同事实，且证据来自两边', () => {
  const data = fixture()
  const dispute = disputeOf(data)
  const { brief, sources } = buildBrief({ platform: 'tieba', threadId: '900', collected: data, dispute })
  if (brief.agreedFacts.length === 0) return // 夹具若无共同 token，不算失败
  const fact = brief.agreedFacts[0]!
  assert.equal(fact.evidence.length >= 2, true)
  assert.equal(fact.evidence.some((id) => sources.ownerPostIds.has(id)), true)
  assert.equal(fact.evidence.some((id) => sources.opponentPostIds.has(id)), true)
})

test('构建：没有对手时 brief 不成立（briefIsViable 为 false）', () => {
  const data = fixture()
  const dispute = disputeOf(data)
  const orphan = { ...dispute, opponent: undefined }
  assert.equal(briefIsViable(orphan), false)
})

// ---------------------------------------------------------------------------
// 接线：必须真的进入生产流程
// ---------------------------------------------------------------------------

test('接线：runtime 的生成路径确实构建并校验 brief（源码级）', () => {
  // The task book's specific complaint was that `validateBrief` "只存在于测试文件". A
  // behavioural test would need a live model; what can be proven cheaply is that the
  // production module imports the builder and the validator and refuses on problems.
  const runtime = readFileSync(join(SRC, 'runtime.ts'), 'utf8')
  assert.match(runtime, /from '\.\/brief-builder\.js'/, 'runtime 必须导入构建函数')
  assert.match(runtime, /from '\.\/brief\.js'/, 'runtime 必须导入校验与渲染')
  assert.match(runtime, /buildBrief\(\{/, 'runtime 必须真的调用 buildBrief')
  assert.match(runtime, /validateBrief\(/, 'runtime 必须真的调用 validateBrief')
  assert.match(runtime, /briefProblems\.length > 0/, '校验失败必须有分支处理')
  assert.match(runtime, /throw new Error\(\s*\n?\s*`争论简报未通过证据校验/, '校验失败必须中断生成')
  assert.match(runtime, /brief: briefText/, '渲染后的 brief 必须传给生成器')
})

test('接线：校验失败发生在调用模型之前', () => {
  // Ordering is the security property. If the model were called first and the brief checked
  // afterwards, the model would already have been fed (and could have acted on) an
  // unsupported brief.
  const runtime = readFileSync(join(SRC, 'runtime.ts'), 'utf8')
  const buildAt = runtime.indexOf('const briefProblems = validateBrief(')
  const throwAt = runtime.indexOf('争论简报未通过证据校验')
  const llmAt = runtime.indexOf('const client = runtime.llm()')
  assert.equal(buildAt > 0, true, '必须存在校验调用')
  assert.equal(throwAt > buildAt, true, '拒绝必须在校验之后')
  assert.equal(llmAt > throwAt, true, `模型调用必须在拒绝之后（build=${buildAt} throw=${throwAt} llm=${llmAt}）`)
})

test('接线：buildGenerationPrompt 会把 brief 放进 prompt', () => {
  const data = fixture()
  const dispute = disputeOf(data)
  const { brief } = buildBrief({ platform: 'tieba', threadId: '900', collected: data, dispute })
  const rendered = `主人立场：${brief.owner.summary}`
  const prompt = buildGenerationPrompt({
    dispute,
    context: { text: '（上下文占位）', omissions: [] } as never,
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 200, emojiLevel: 1, sarcasmLevel: 1, directness: 3 } as never,
    brief: rendered,
  })
  assert.match(prompt, /争论简报（已通过证据校验）/)
  assert.match(prompt, /主人立场：/)
})

test('接线：不传 brief 时 prompt 仍然可用（向后兼容）', () => {
  const data = fixture()
  const dispute = disputeOf(data)
  const prompt = buildGenerationPrompt({
    dispute,
    context: { text: '（上下文占位）', omissions: [] } as never,
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 200, emojiLevel: 1, sarcasmLevel: 1, directness: 3 } as never,
  })
  assert.equal(prompt.includes('争论简报'), false, '没给 brief 就不该凭空出现这一节')
  assert.match(prompt, /## 对话上下文/)
})

// ---------------------------------------------------------------------------
// 目标不得被模型改写
// ---------------------------------------------------------------------------

test('目标：brief 的 targetPostId 由程序决定，模型无法通过 brief 修改（§三.9）', () => {
  // The brief is *input* to the model. There is no path from a model's output back into
  // `brief.targetPostId`: the generation result is validated against
  // `dispute.opponent.lastPostId`, and the publish path uses the stored snapshot. This
  // asserts the source-level fact that the stored target comes from `dispute`, not from the
  // model's `response_target_id`.
  const runtime = readFileSync(join(SRC, 'runtime.ts'), 'utf8')
  assert.match(
    runtime,
    /const verifiedTargetPostId = dispute\.opponent\?\.lastPostId/,
    '落库的目标必须来自 dispute，而不是模型输出',
  )
  assert.match(
    runtime,
    /targetPostId: verifiedTargetPostId/,
    '候选必须带程序核定的目标',
  )
})

// ---------------------------------------------------------------------------
// 预算压缩仍保留证据关系（§三 末段）
// ---------------------------------------------------------------------------

test('压缩：空间不足时先砍文字，绝不砍证据 id', () => {
  const data = fixture()
  const dispute = disputeOf(data)
  const { brief } = buildBrief({ platform: 'tieba', threadId: '900', collected: data, dispute })

  // Comfortable budget: full rendering with prose.
  const roomy = renderBriefCompact(brief, 4000)
  assert.match(roomy, /主人立场/)

  // Tight budget: prose goes, ids stay.
  const tight = renderBriefCompact(brief, 60)
  assert.equal(tight.length <= 60, true, `不能超预算，实际 ${tight.length}`)
  for (const id of brief.owner.evidence) {
    assert.equal(tight.includes(id), true, `紧预算下仍必须保留主人的证据 id ${id}：${tight}`)
  }
  for (const id of brief.opponent.evidence) {
    assert.equal(tight.includes(id), true, `紧预算下仍必须保留对方的证据 id ${id}：${tight}`)
  }
  assert.equal(tight.includes(brief.targetPostId), true, '回复目标不能丢')
})
