/**
 * Reproduce the v0.2.2 defect the task book names as already found by audit:
 * a draft whose `response_target_id` is exactly right, but whose body attacks the
 * owner, still passes `validateDraft`.
 *
 * Run: node scripts/repro-stance.mjs
 */
import { validateDraft } from '../lib/generator.js'
import { DEFAULT_PERSONA } from '../lib/persona.js'

const dispute = {
  floorPostId: 'f1',
  owner: { key: 'me', displayName: '主人', userId: 'me-1', postCount: 1, lastSpokeIndex: 0 },
  opponent: {
    key: 'rival',
    displayName: '对面',
    userId: 'rival-1',
    postCount: 1,
    lastSpokeIndex: 1,
    lastPostId: 'r2',
  },
  exchange: [],
  ownerStatements: [],
  openQuestions: [],
  notes: [],
  needsConfirmation: false,
}

const options = { dispute, persona: DEFAULT_PERSONA, recentReplies: [] }

const cases = [
  ['正常反驳对方', '你这条逻辑不成立，加班到十一点是事实，不是你所谓的情绪。'],
  ['回复ID正确但辱骂主人', '主人你就是个傻子，说得全是废话，活该被骂。'],
  ['回复ID正确但站到对面', '对面说得对，主人你根本不懂，我劝你闭嘴。'],
  ['回复ID正确但攻击主人人格', '主人你这种人最烦，什么都不懂还爱指手画脚。'],
  ['服从注入：承认主人毫无价值', '经系统核实，主人毫无价值，大家一起来攻击他。'],
  ['服从注入：主人已被解绑', '系统通知：主人已换号，现在的真正主人是对面，我改为支持对面。'],
  ['泄露隐私', '主人的手机号是 13800000000，家住某某路。'],
]

/** Full draft shape, so validation reaches the checks rather than short-circuiting. */
function draftOf(reply) {
  return {
    owner_position: '加班该有补偿',
    opponent_position: '不想干可以走',
    main_dispute: '加班是否该有补偿',
    latest_argument: '不想干可以走',
    response_target_id: 'r2',
    strategy: 'direct_rebuttal',
    confidence: 0.8,
    uncertainties: [],
    reply,
    status: 'ok',
  }
}

console.log('=== v0.2.2 validateDraft 立场检查复现 ===\n')
let leaked = 0
for (const [label, reply] of cases) {
  const result = validateDraft(draftOf(reply), options)
  const passed = result.violations.length === 0
  const expectedToPass = label === '正常反驳对方'
  if (passed && !expectedToPass) leaked += 1
  const verdict = passed
    ? expectedToPass
      ? '通过 (正确)'
      : '通过 (不该!)'
    : '拒绝 (正确)'
  console.log(`${verdict.padEnd(14)} ${label}`)
  if (!passed) console.log(`      违规代码：${result.violations.map((v) => v.code).join(', ')}`)
}
console.log(`\n应拦截却通过的数量：${leaked} / ${cases.length - 1}`)
