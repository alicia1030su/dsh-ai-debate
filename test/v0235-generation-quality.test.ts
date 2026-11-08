/**
 * v0.2.35 §3.2：回复必须对准**主人选定的那一条**，并且不许说假话。
 *
 * ## 这一组测试守的是什么
 *
 * 「你倒是拿出证据来」是这类产品最容易生成、也最丢人的一句话：对方明明给了论据，
 * 回复却说对方没给。读的人一眼就能看出写手没看帖子。这不是文风问题，是事实错误，
 * 所以它必须由程序拦，而不是写在提示词里请模型自觉。
 *
 * 其余三条（重复已回答的内容、答错对象、缺上下文）都属于「读起来完全正常，但对着
 * 原帖看就错了」的类型，只能用结构去查，不能靠通读。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Dispute } from '../lib/analyzer.js'
import type { CompressedContext } from '../lib/compressor.js'
import { SYSTEM_PROMPT, buildGenerationPrompt, parseDraft, validateDraft, type GenerationDraft } from '../lib/generator.js'
import { DEFAULT_PERSONA } from '../lib/persona.js'

/** A minimal dispute: the shapes the validator actually reads. */
function dispute(): Dispute {
  return {
    floorPostId: '7001',
    owner: { key: 'owner', displayName: '主人', matchKind: 'name', postCount: 2, lastSpokeIndex: 3 },
    opponent: {
      key: 'opponent',
      displayName: '对方',
      matchKind: 'name',
      postCount: 2,
      lastSpokeIndex: 4,
      lastPostId: '7002',
    },
    exchange: [],
    ownerStatements: [],
    openQuestions: [],
    bystanders: [],
    needsConfirmation: false,
    notes: [],
    ownerIdentityAssurance: 'verified',
    ownerIdentityEvidence: { kind: 'name', platform: 'weibo' },
  } as unknown as Dispute
}

const context: CompressedContext = {
  text: '主人：这个方案的成本不会翻倍。\n对方：翻倍是暂时的。',
  tokens: 40,
  omissions: [],
  totalBudget: 4000,
} as unknown as CompressedContext

function draft(reply: string): GenerationDraft {
  return {
    owner_position: '成本不会翻倍',
    opponent_position: '翻倍是暂时的',
    main_dispute: '成本是否翻倍',
    latest_argument: '翻倍是暂时的',
    response_target_id: '7002',
    strategy: 'direct_rebuttal',
    confidence: 0.7,
    uncertainties: [],
    reply,
    status: 'ok',
  }
}

const base = {
  dispute: dispute(),
  context,
  persona: DEFAULT_PERSONA,
  expectedTargetPostId: '7002',
}

test('对方已给论据时，说「你没有证据」是违规，不是反驳', () => {
  const result = validateDraft(draft('你倒是拿出证据来啊，空口说谁不会。'), {
    ...base,
    briefFacts: {
      opponentArgumentCount: 3,
      unansweredByOpponent: 0,
      answeredByOwner: [],
      thirdPartyCitationCount: 0,
      missingContextCount: 0,
    },
  })
  const codes = result.violations.map((item) => item.code)
  assert.ok(codes.includes('false_no_evidence'), `必须拦下，实际 ${codes.join(',')}`)
  const message = result.violations.find((item) => item.code === 'false_no_evidence')!.message
  assert.match(message, /3 条论据/, '必须说出对方到底给了几条，否则读的人无法核对')
})

test('追问具体来源不算「说对方没证据」', () => {
  const result = validateDraft(draft('这个数字你从哪看的？把出处贴一下。'), {
    ...base,
    briefFacts: {
      opponentArgumentCount: 3,
      unansweredByOpponent: 0,
      answeredByOwner: [],
      thirdPartyCitationCount: 0,
      missingContextCount: 0,
    },
  })
  assert.deepEqual(
    result.violations.map((item) => item.code),
    [],
    '要出处是合理追问，不该被拦',
  )
})

test('对方本来就没给论据时，这句话不违规', () => {
  const result = validateDraft(draft('你倒是拿出证据来啊。'), {
    ...base,
    briefFacts: {
      opponentArgumentCount: 0,
      unansweredByOpponent: 0,
      answeredByOwner: [],
      thirdPartyCitationCount: 0,
      missingContextCount: 0,
    },
  })
  assert.deepEqual(result.violations.map((item) => item.code), [])
})

test('回复与主人已答过的内容高度重合时给提示，但不拦', () => {
  const result = validateDraft(
    draft('三年总成本我算过，摊销之后每年只多百分之八，这个前面已经说过了。'),
    {
      ...base,
      briefFacts: {
        opponentArgumentCount: 1,
        unansweredByOpponent: 0,
        answeredByOwner: ['三年总成本我算过，摊销之后每年只多 8%'],
        thirdPartyCitationCount: 0,
        missingContextCount: 0,
      },
    },
  )
  assert.deepEqual(result.violations, [], '重复不是硬性违规，删掉主人想强调的一句话反而更糟')
  assert.ok(
    result.notes.some((note) => note.includes('高度重合')),
    `应留下提示，实际：${result.notes.join(' / ')}`,
  )
})

test('回复与选定的那条评论毫无共同话题时给提示', () => {
  const result = validateDraft(draft('你上次说的那个项目早就黄了，别装了。'), {
    ...base,
    targetContent: '这个方案的成本会翻倍，采购设备要一次付清。',
  })
  assert.ok(
    result.notes.some((note) => note.includes('没有任何共同话题')),
    `应提示答错对象，实际：${result.notes.join(' / ')}`,
  )
})

test('提示词把「只回应这一条」写死在任务段，并带上人格的自然度约束', () => {
  const prompt = buildGenerationPrompt({
    ...base,
    brief: '## 对方的核心论据\n- 成本会翻倍（7002）',
  })
  assert.match(prompt, /回复对象的 post id 应为 7002/)
  // 那条铁律在 system 里（另一次调用参数），不在 user 提示里 —— 两个都要查，
  // 否则「写在系统提示里」这件事没人守。
  assert.match(SYSTEM_PROMPT, /不要自动转去回应对方最新的一句/, '系统提示里那条铁律要在')
  assert.match(SYSTEM_PROMPT, /不许说「你没有证据」|那是事实错误/, '反「没证据」那条要在')
  assert.match(prompt, /自然度/, '人格块必须带自然度约束')
  assert.match(prompt, /不要用「首先\/其次\/最后/, '不许写作文结构')
})

test('解析器仍然只认 JSON，并且把缺字段的回答当成可解析的草稿', () => {
  // 「缺字段」不是解析失败：结构化检查会把它报成问题，而解析失败会触发一次修复重试。
  // 两者代价不同，不能混。
  const parsed = parseDraft('{"status":"ok","reply":"这句话是完整的。"}')
  assert.ok(parsed.draft !== undefined)
  assert.equal(parsed.draft!.response_target_id, '')
  const missing = validateDraft(parsed.draft!, base)
  assert.ok(missing.violations.some((item) => item.code === 'missing_target'))
})
