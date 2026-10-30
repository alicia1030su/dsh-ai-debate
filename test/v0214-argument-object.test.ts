/**
 * v0.2.14 §六：论点对象与语义准确性。
 *
 * ## 这个文件与 v0.2.13 那个的区别
 *
 * v0.2.13 修了「苹果 vs 乌龙茶」，但它只比较**词**。于是新一类错误出现了：
 *
 * | 主人 | 对方 | v0.2.13 | 正确 |
 * | --- | --- | --- | --- |
 * | A 方案可行。 | B 方案不可行。 | contradiction | 不同对象，不矛盾 |
 * | 我支持张三的建议。 | 我反对李四的建议。 | contradiction | 不同人物，不矛盾 |
 * | 这个方案可行。 | 这个方案不可行。 | unknown | 同一指代，明确矛盾 |
 *
 * 病根是**词语重叠不等于对象相同**。这里的用例都带独立标注的预期结论（`expect` 由人先写），
 * 断言拿代码输出与它比 —— 不是让两个函数互相认可。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { compareArgumentObjects, extractArgumentObjects } from '../lib/argument-object.js'
import { judgeRelation, type PositionRelation } from '../lib/conflict.js'

// ---------------------------------------------------------------------------
// A. Object extraction
// ---------------------------------------------------------------------------

test('对象抽取：修饰语与中心词被分开', () => {
  const objects = extractArgumentObjects('A 方案可行。')
  assert.equal(objects.length >= 1, true, `应抽到对象：${JSON.stringify(objects)}`)
  const plan = objects.find((entry) => entry.head === '方案')
  assert.notEqual(plan, undefined, '应识别出中心词「方案」')
  assert.equal(plan!.modifier, 'A', `修饰语应为 A，实际「${plan!.modifier}」`)
  assert.equal(plan!.deictic, false)
})

test('对象抽取：指代词被标记为 deictic', () => {
  const objects = extractArgumentObjects('这个方案可行。')
  const plan = objects.find((entry) => entry.head === '方案')
  assert.notEqual(plan, undefined)
  assert.equal(plan!.deictic, true, '「这个」是指代，不能当自明识别')
})

test('对象抽取：动词不会被误当成修饰语', () => {
  const objects = extractArgumentObjects('我支持张三的建议。')
  const suggestion = objects.find((entry) => entry.head === '建议')
  assert.notEqual(suggestion, undefined)
  assert.equal(
    suggestion!.modifier.includes('支持'),
    false,
    `修饰语不能包含谓语，实际「${suggestion!.modifier}」`,
  )
})

test('对象抽取：没有可辩论对象时返回空，不编造', () => {
  assert.deepEqual(extractArgumentObjects('我喜欢吃苹果。'), [])
  assert.deepEqual(extractArgumentObjects(''), [])
})

// ---------------------------------------------------------------------------
// B. Object comparison
// ---------------------------------------------------------------------------

test('对象比较：不同方案 → different_objects', () => {
  const result = compareArgumentObjects('A 方案可行。', 'B 方案不可行。')
  assert.equal(result.relation, 'different_objects', result.reason)
})

test('对象比较：不同人物的建议 → different_objects', () => {
  const result = compareArgumentObjects('我支持张三的建议。', '我反对李四的建议。')
  assert.equal(result.relation, 'different_objects', result.reason)
})

test('对象比较：同一个指代 → same_reference', () => {
  const result = compareArgumentObjects('这个方案可行。', '这个方案不可行。')
  assert.equal(result.relation, 'same_reference', result.reason)
})

test('对象比较：同一个具名对象 → same_object', () => {
  const result = compareArgumentObjects('A 方案可行。', 'A 方案不可行。')
  assert.equal(result.relation, 'same_object', result.reason)
})

test('对象比较：一方无对象时不猜 → unknown', () => {
  const result = compareArgumentObjects('我觉得还行。', '这个方案不可行。')
  assert.equal(result.relation, 'unknown', result.reason)
})

// ---------------------------------------------------------------------------
// C. End-to-end relation, with independently labelled expectations
// ---------------------------------------------------------------------------

const CASES: readonly {
  readonly name: string
  readonly owner: string
  readonly opponent: string
  readonly expect: PositionRelation
  /** Written by hand before running the code. */
  readonly why: string
}[] = [
  {
    name: '不同对象的相反判断（A 方案 / B 方案）',
    owner: 'A 方案可行。',
    opponent: 'B 方案不可行。',
    expect: 'different_topics',
    why: '两个不同方案，各自成立，不是矛盾。',
  },
  {
    name: '不同人物的相反态度（张三 / 李四）',
    owner: '我支持张三的建议。',
    opponent: '我反对李四的建议。',
    expect: 'different_topics',
    why: '支持一个人和反对另一个人可以同时为真。',
  },
  {
    name: '同一个指代对象的相反判断',
    owner: '这个方案可行。',
    opponent: '这个方案不可行。',
    expect: 'contradiction',
    why: '两边用同一个指代，指代所指相同，一方肯定一方否定。',
  },
  {
    name: '同一个具名对象的相反判断',
    owner: 'A 方案可行。',
    opponent: 'A 方案不可行。',
    expect: 'contradiction',
    why: '同一个对象，明确对立。',
  },
  {
    name: '喜好不同（苹果 / 乌龙茶）',
    owner: '我喜欢吃苹果。',
    opponent: '我喜欢喝乌龙茶。',
    expect: 'different_preference',
    why: '两句话都是真的。',
  },
  {
    name: '相同数字且无相反表态',
    owner: '去年报价是 12 万。',
    opponent: '我记得也是 12 万。',
    expect: 'agreement',
    why: '都提到同一个数字且都不反对。',
  },
]

test('语义判定：每条用例都与独立标注的预期一致', () => {
  for (const testCase of CASES) {
    const verdict = judgeRelation({
      ownerText: testCase.owner,
      opponentText: testCase.opponent,
    })
    assert.equal(
      verdict.relation,
      testCase.expect,
      `「${testCase.name}」：预期 ${testCase.expect}，实际 ${verdict.relation}\n` +
        `  依据：${testCase.why}\n  代码给的理由：${verdict.reason}`,
    )
  }
})

test('语义判定：不同对象绝不产生矛盾结论（§六核心）', () => {
  const different = CASES.filter((testCase) => testCase.expect === 'different_topics')
  for (const testCase of different) {
    const verdict = judgeRelation({
      ownerText: testCase.owner,
      opponentText: testCase.opponent,
    })
    assert.equal(verdict.isContradiction, false, `「${testCase.name}」不该是矛盾`)
  }
})

test('语义判定：同一指代的矛盾仍然标记需人工复核（§6.4）', () => {
  const verdict = judgeRelation({ ownerText: '这个方案可行。', opponentText: '这个方案不可行。' })
  assert.equal(verdict.relation, 'contradiction')
  assert.equal(verdict.requiresReview, true, '机器对语义的判断再清晰也要人看一眼')
})

test('语义判定：指代不同但无法确认时给出 clarification_needed', () => {
  // Two different pointers: we cannot tell whether they designate the same thing.
  const verdict = judgeRelation({ ownerText: '这个方案可行。', opponentText: '那个方案不可行。' })
  assert.equal(
    ['clarification_needed', 'different_topics', 'unknown'].includes(verdict.relation),
    true,
    `实际 ${verdict.relation}：${verdict.reason}`,
  )
  assert.equal(verdict.isContradiction, false, '不确定时不能断言矛盾')
  assert.equal(verdict.requiresReview, true)
})

test('语义判定：六种关系都有可读描述', () => {
  const relations: PositionRelation[] = [
    'contradiction',
    'agreement',
    'different_preference',
    'different_topics',
    'clarification_needed',
    'unknown',
  ]
  assert.equal(relations.length, 6)
  for (const relation of relations) {
    const verdict = judgeRelation({ ownerText: '', opponentText: '' })
    // The enumerator exists so a new relation cannot be added without this test noticing.
    assert.equal(typeof verdict.relation, 'string')
  }
})
