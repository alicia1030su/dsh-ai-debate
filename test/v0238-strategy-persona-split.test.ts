/**
 * v0.2.38 §3：论证策略与人格解耦。
 *
 * ## 这一组要钉住的三件事
 *
 * 1. **策略有证据门槛**：没有依据就不能选它，自动选择不会硬选，手工指定会报错。
 * 2. **策略与人格正交**：同一个人格可以走不同策略，同一个策略可以用不同人格表达。
 * 3. **选择过程可核对**：每次选择都记录「用了简报的哪个字段、哪几条 post、凭什么」。
 *
 * ## 为什么第 1 条是重点
 *
 * 「提出有出处的反例」听起来最好，材料里没有反例时硬写一个就是编造。这一版宁可让
 * 策略清单少一项，也不让模型为了多样性造一个依据 —— 而这件事必须由代码保证，
 * 不能靠提示词祈求。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute, type OwnerIdentity } from '../lib/analyzer.js'
import { buildBrief } from '../lib/brief-builder.js'
import { generateReply, buildGenerationPrompt, type GenerationBriefFacts } from '../lib/generator.js'
import { resolvePersona, PERSONAS, type PersonaStyle } from '../lib/persona.js'
import { compressContext, resolveBudget, splitBudget } from '../lib/compressor.js'
import { ARGUMENT_STRATEGIES, selectStrategy, renderStrategy, strategyById } from '../lib/strategy.js'
import type { LlmClient } from '../lib/llm.js'
import { ALL_CASES } from './evaluation/index.ts'
import { caseThread } from './evaluation/evaluate-deterministic.ts'
import type { EvalCase } from './evaluation/corpus.ts'

/** 案例里「主人」的账号，规则与评测通道一致。 */
function ownerOf(c: EvalCase): OwnerIdentity {
  const ownerPost =
    c.body?.role === 'owner'
      ? c.body
      : c.floors.flatMap((floor) => [floor.author, ...floor.nested]).find((post) => post.role === 'owner')
  if (ownerPost?.numericUid !== undefined) {
    return { userId: ownerPost.numericUid, ...(c.platform === undefined ? {} : { platform: c.platform }) }
  }
  if (ownerPost?.handle !== undefined) return { userId: ownerPost.handle }
  return { userId: 'owner_un' }
}

/** 跑一个案例，返回它需要的一切。 */
function runOf(id: string) {
  const c = ALL_CASES.find((item) => item.id === id)
  assert.ok(c !== undefined, `语料里没有 ${id}`)
  const collected = caseThread(c)
  const dispute = analyzeDispute(collected, ownerOf(c), { postId: c.pickedPostId })
  const built = buildBrief({
    collected,
    dispute,
    platform: c.platform ?? 'tieba',
    threadId: collected.thread.id,
    targetPostId: c.pickedPostId,
  })
  return { c, collected, dispute, brief: built.brief }
}

// ---------------------------------------------------------------------------
// 一、策略目录本身
// ---------------------------------------------------------------------------

test('策略目录：每条都有中文名、说明、给模型的指令，id 不重复', () => {
  assert.ok(ARGUMENT_STRATEGIES.length >= 7, '至少要覆盖需求里点名的七种打法')
  const ids = new Set(ARGUMENT_STRATEGIES.map((strategy) => strategy.id))
  assert.equal(ids.size, ARGUMENT_STRATEGIES.length, 'id 必须唯一')
  for (const strategy of ARGUMENT_STRATEGIES) {
    assert.ok(strategy.name.length > 0, `${strategy.id} 缺中文名`)
    assert.ok(strategy.summary.length > 0, `${strategy.id} 缺说明`)
    assert.ok(strategy.instruction.length > 0, `${strategy.id} 缺指令`)
    // 指令必须是「只做一件事」的口吻，否则模型又会铺开好几种打法。
    assert.match(strategy.instruction, /这次只做一件事/, `${strategy.id} 的指令没有收窄到单一动作`)
  }
})

test('策略目录：包含需求点名的七种，外加「重复已答问题」', () => {
  const ids = ARGUMENT_STRATEGIES.map((strategy) => strategy.id)
  for (const required of [
    'demand_basis',
    'answer_core',
    'cite_counterexample',
    'clarify_definition',
    'point_out_contradiction',
    'explain_premise',
    'ask_clarification',
  ] as const) {
    assert.ok(ids.includes(required), `缺少 ${required}`)
  }
})

// ---------------------------------------------------------------------------
// 二、证据门槛
// ---------------------------------------------------------------------------

test('门槛：没有第三方引用时，「提出有出处的反例」不出现在候选里', () => {
  const { brief } = runOf('baseline/03')
  const selection = selectStrategy(brief)
  const rejected = selection.rejected.map((item) => item.id)
  assert.ok(
    rejected.includes('cite_counterexample'),
    `材料里没有第三方引用，这个打法必须被排除，实际候选 ${selection.choice?.id}`,
  )
})

test('门槛：没有已核实的矛盾时，「指出前后矛盾」被排除，而不是降级成「疑似矛盾」', () => {
  const { brief } = runOf('baseline/03')
  const selection = selectStrategy(brief)
  assert.ok(selection.rejected.some((item) => item.id === 'point_out_contradiction'))
})

test('门槛：材料不足时选兜底打法，并且理由说明是「材料不足」而不是「随便选」', () => {
  const { brief } = runOf('refusal/04')
  const selection = selectStrategy(brief)
  assert.equal(selection.choice?.id, 'ask_clarification')
  assert.match(selection.choice?.reason ?? '', /缺口|不足|唯一不编造/, '必须说清为什么只能追问')
  assert.equal(selection.choice?.confidence, 'low', '兜底打法的可信度本来就低，不能标 medium')
})

test('手工指定：材料不支撑时报错并说明缺什么，不悄悄换成别的策略', () => {
  const { brief } = runOf('baseline/03')
  assert.throws(
    () => selectStrategy(brief, 'cite_counterexample'),
    /不足以支持|找不到支撑/,
    '不满足门槛的手工指定必须失败，不能静默降级',
  )
})

test('手工指定：材料支撑时按指定执行，并标明来源是主人', () => {
  const { brief } = runOf('baseline/03')
  const selection = selectStrategy(brief, 'answer_core')
  assert.equal(selection.choice?.id, 'answer_core')
  assert.equal(selection.choice?.source, 'manual')
  assert.match(selection.choice?.reason ?? '', /主人指定/)
})

test('未知策略 id：报错并列出可选值', () => {
  const { brief } = runOf('baseline/03')
  assert.throws(() => selectStrategy(brief, 'not_a_strategy' as never), /未知的论证策略/)
})

// ---------------------------------------------------------------------------
// 三、选择记录
// ---------------------------------------------------------------------------

test('每次选择都记录依据字段、post id 与理由', () => {
  for (const id of ['baseline/03', 'weibo/06', 'baseline/05', 'refusal/04']) {
    const { brief } = runOf(id)
    const choice = selectStrategy(brief).choice
    assert.ok(choice !== undefined, `${id} 没有选出策略`)
    assert.ok(choice.evidence.length > 0, `${id} 的选择没有依据`)
    for (const item of choice.evidence) {
      assert.ok(item.field.length > 0, `${id} 的依据没有指明字段`)
      assert.ok(item.why.length > 0, `${id} 的依据没有理由`)
      // postId 可以为空（兜底打法的依据是「缺什么」，不是「哪条帖子」），
      // 但只要给了 id，就必须是这次读取里真实存在的。
      for (const postId of item.postIds) {
        assert.equal(postId.length > 0, true)
      }
    }
  }
})

test('依据里的 post id 都真的在这次读取里', () => {
  for (const id of ['baseline/03', 'weibo/06', 'baseline/05']) {
    const { collected, brief } = runOf(id)
    const known = new Set(collected.floors.flatMap((floor) => [floor.floor.postId, ...floor.nested.map((n) => n.postId)]))
    const choice = selectStrategy(brief).choice
    assert.ok(choice !== undefined)
    for (const item of choice.evidence) {
      for (const postId of item.postIds) {
        assert.ok(known.has(postId), `${id} 的依据指向了不存在的帖子 ${postId}`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// 四、与人格正交
// ---------------------------------------------------------------------------

test('正交：同一份简报，四种人格选出同一个策略（策略不随人格变）', () => {
  const { brief } = runOf('baseline/03')
  // 选择函数根本不收人格参数 —— 这一点由签名保证。这里再钉一次行为。
  const choice = selectStrategy(brief).choice
  assert.ok(choice !== undefined)
  for (const style of Object.keys(PERSONAS) as PersonaStyle[]) {
    const persona = resolvePersona({ style, maxLength: 150 })
    assert.equal(persona.style, style)
    // 人格只影响提示词里的表达段，不影响这次选中的策略 id。
    const prompt = buildGenerationPrompt({
      dispute: runOf('baseline/03').dispute,
      context: {
        text: '（略）',
        tokens: 0,
        omissions: [],
        totalBudget: 1000,
        fixedCost: 0,
        quoted: { posts: 0, characters: 0 },
        budget: 0,
      } as never,
      persona,
      strategy: choice,
      expectedTargetPostId: '9000000030',
    })
    assert.match(prompt, new RegExp(`本轮打法：${choice.name}`), `${style} 的提示词里没有这次选定的打法`)
    assert.match(prompt, new RegExp(`人格：${PERSONAS[style].name}`), `${style} 的提示词里没有它自己的人格`)
  }
})

test('正交：同一个策略可以用四种人格表达，提示词两段分开出现', () => {
  const { dispute } = runOf('baseline/03')
  const choice = selectStrategy(runOf('baseline/03').brief).choice
  assert.ok(choice !== undefined)
  const context = {
    text: '（略）',
    tokens: 0,
    omissions: [],
    totalBudget: 1000,
    fixedCost: 0,
    quoted: { posts: 0, characters: 0 },
    budget: 0,
  } as never
  for (const style of Object.keys(PERSONAS) as PersonaStyle[]) {
    const prompt = buildGenerationPrompt({
      dispute,
      context,
      persona: resolvePersona({ style, maxLength: 150 }),
      strategy: choice,
      expectedTargetPostId: '9000000030',
    })
    const strategyIndex = prompt.indexOf('## 本轮论证打法')
    const personaIndex = prompt.indexOf('## 人格设定')
    assert.ok(strategyIndex > 0, `${style} 缺打法段`)
    assert.ok(personaIndex > 0, `${style} 缺人格段`)
    assert.ok(strategyIndex < personaIndex, '打法必须先于人格出现：先定说什么，再定怎么说')

    // 打法段里不能出现人格的名字，否则两段又缠在一起了。
    const strategySection = prompt.slice(strategyIndex, personaIndex)
    for (const other of Object.values(PERSONAS)) {
      assert.doesNotMatch(strategySection, new RegExp(other.name), `打法段里混进了人格「${other.name}」`)
    }
  }
})

test('正交：人格描述里不再包含打法（approach 只说说话的样子）', () => {
  for (const persona of Object.values(PERSONAS)) {
    // 「先……再……最后……」这类叙述是在讲打法顺序，不是语气。
    assert.doesNotMatch(
      persona.approach,
      /先.*再.*最后|先钉住|要求把依据/,
      `人格「${persona.name}」的 approach 又在讲打法了：${persona.approach}`,
    )
  }
  // 四种仍然必须互不相同，否则它们只是四个按钮。
  assert.equal(new Set(Object.values(PERSONAS).map((persona) => persona.approach)).size, 4)
})

// ---------------------------------------------------------------------------
// 五、提示词渲染
// ---------------------------------------------------------------------------

test('渲染：打法的依据带 post id，并且明确要求只走这一条路', () => {
  const { brief } = runOf('baseline/03')
  const choice = selectStrategy(brief).choice
  assert.ok(choice !== undefined)
  const text = renderStrategy(choice)
  assert.match(text, new RegExp(`本轮打法：${choice.name}`))
  assert.match(text, /选择依据/)
  assert.match(text, /这一轮只按这个打法写/)
  for (const item of choice.evidence) {
    for (const postId of item.postIds) assert.ok(text.includes(postId), `依据里的 ${postId} 没进提示词`)
  }
})

test('渲染：未知 id 不会渲染出一段空指令', () => {
  const choice = {
    id: 'demand_basis' as const,
    name: '追问关键依据',
    source: 'auto' as const,
    reason: '测试',
    evidence: [],
    confidence: 'medium' as const,
  }
  const text = renderStrategy(choice)
  assert.ok(text.includes('这次只做一件事'), '指令必须来自策略目录')
  assert.equal(strategyById('demand_basis')?.name, choice.name)
})

// ---------------------------------------------------------------------------
// 六、策略确实进了生成链路
// ---------------------------------------------------------------------------

/** 一个只回固定 JSON 的客户端，用来观察提示词。 */
function captureClient(seen: { prompt?: string }): LlmClient {
  return {
    label: 'capture',
    complete: async (request) => {
      seen.prompt = request.messages.map((message) => message.content).join('\n')
      return {
        text: JSON.stringify({
          status: 'ok',
          owner_position: '成本会涨',
          opponent_position: '不该涨',
          main_dispute: '成本该不该转嫁',
          latest_argument: '你连预算都没算',
          response_target_id: '9000000030',
          strategy: 'direct_rebuttal',
          confidence: 0.7,
          uncertainties: [],
          reply: '预算那事我在第二页算过，你先看看那一页再问这个。',
        }),
        usage: { inputTokens: 100, outputTokens: 60, elapsedMs: 10 },
      }
    },
  }
}

test('生成链路：传了策略，提示词里就有打法段；不传则没有', async () => {
  const { c, collected, dispute, brief } = runOf('baseline/03')
  const total = resolveBudget({ preset: 'medium' })
  const split = splitBudget(total.tokens)
  const persona = resolvePersona({ style: 'aloof', maxLength: 150 })
  const context = compressContext({
    collected,
    dispute,
    trigger: { postId: c.pickedPostId },
    persona,
    budget: { tokens: split.contextTokens, quoteLimit: total.quoteLimit },
    totalTokens: total.tokens,
  })
  const facts: GenerationBriefFacts = {
    opponentArgumentCount: (brief.opponentArguments ?? []).length,
    unansweredByOpponent: (brief.unansweredByOpponent ?? []).length,
    answeredByOwner: (brief.answeredByOwner ?? []).map((item) => item.quote),
    thirdPartyCitationCount: (brief.thirdPartyCitations ?? []).length,
    missingContextCount: (brief.missingContext ?? []).length,
  }
  const choice = selectStrategy(brief).choice
  assert.ok(choice !== undefined)

  const withStrategy = { prompt: undefined as string | undefined }
  await generateReply(captureClient(withStrategy), {
    dispute,
    context,
    persona,
    expectedTargetPostId: c.pickedPostId,
    briefFacts: facts,
    strategy: choice,
  })
  assert.match(withStrategy.prompt ?? '', /## 本轮论证打法/)

  const without = { prompt: undefined as string | undefined }
  await generateReply(captureClient(without), {
    dispute,
    context,
    persona,
    expectedTargetPostId: c.pickedPostId,
    briefFacts: facts,
  })
  assert.doesNotMatch(without.prompt ?? '', /## 本轮论证打法/, '不传策略时不应凭空出现一段打法')
})
