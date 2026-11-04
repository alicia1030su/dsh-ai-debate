/**
 * The deterministic gate: 64 cases, every commit, no model, no network.
 *
 * ## Why this is a test and not a script
 *
 * A quality corpus that only runs when someone remembers to run it is documentation, not a
 * gate. These checks have no judgement in them, so there is no reason to treat them as
 * optional: if the analyzer starts answering the wrong comment, or a guard stops rejecting a
 * fabricated quote, this file goes red with the case id and the reason.
 *
 * ## What is *not* asserted here
 *
 * Whether the prose is any good. That needs a model and a reader, and it lives in
 * `evaluate-model.ts`, which reports rather than gates. Conflating the two is how a project
 * ends up with a green suite and a product nobody wants to use.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ALL_CASES } from './evaluation/index.ts'
import { groupSummary, runDeterministic } from './evaluation/evaluate-deterministic.ts'

test('评测集至少有 60 个案例，且每组都有明确覆盖', () => {
  // A count is a weak assertion on its own, so it is paired with the group breakdown: the
  // task book asks for breadth across named situations, not for 60 variations of one.
  assert.ok(ALL_CASES.length >= 60, `案例太少：${ALL_CASES.length}`)
  const groups = groupSummary({
    total: ALL_CASES.length,
    passedCases: ALL_CASES.length,
    failedCases: [],
    checks: [],
    refusals: { total: 0, honoured: 0 },
  })
  for (const [name, row] of Object.entries(groups)) {
    assert.ok(row.total >= 6, `「${name}」只有 ${row.total} 个案例，覆盖不足`)
  }
  const ids = ALL_CASES.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, '案例 id 有重复')
})

test('每个案例都有出处与预期，没有空壳', () => {
  for (const c of ALL_CASES) {
    assert.ok(c.title.trim() !== '', `${c.id} 没有标题`)
    assert.ok(c.origin.trim().length >= 8, `${c.id} 没说清它模拟的是什么现实情况`)
    assert.ok(c.floors.length > 0, `${c.id} 没有任何楼层`)
    const expectsRefusal = c.expectation.expectsRefusal === true
    if (expectsRefusal) {
      assert.ok((c.expectation.refusalReason ?? '').trim() !== '', `${c.id} 声明要拒绝却没说原因`)
    } else {
      assert.ok(c.expectation.checks.length > 0, `${c.id} 没有任何检查项，等于没测`)
    }
  }
})

test('确定性评测：64 个案例全部通过', async () => {
  const report = await runDeterministic()
  const failures = report.checks.filter((c) => !c.passed)
  const lines = failures.map((f) => `  ✖ ${f.caseId} [${f.check}] ${f.detail}`)
  assert.deepEqual(
    report.failedCases,
    [],
    `有 ${report.failedCases.length} 个案例未通过：\n${lines.join('\n')}`,
  )
  assert.equal(report.passedCases, report.total, `${report.passedCases}/${report.total} 通过`)
})

test('该拒绝的案例确实被拒绝了，而且是因为正确的原因', async () => {
  const report = await runDeterministic()
  assert.ok(report.refusals.total >= 4, `拒绝类案例太少：${report.refusals.total}`)
  assert.equal(
    report.refusals.honoured,
    report.refusals.total,
    `${report.refusals.total - report.refusals.honoured} 个该拒绝的案例没有被拒绝`,
  )
})

test('注入类案例全部按「内容」处理，没有一条被执行', async () => {
  const report = await runDeterministic()
  const injection = report.checks.filter((c) => c.check === 'injection_is_data')
  assert.ok(injection.length >= 8, `注入检查太少：${injection.length}`)
  for (const row of injection) {
    assert.ok(row.passed, `${row.caseId}：${row.detail}`)
  }
})

// ── The quality channel's own machinery ─────────────────────────────────────
//
// The channel reports rather than gates, but its *scoring* must still be checked, otherwise a
// bug in the scorer would produce confident numbers about nothing. These tests use a scripted
// client so they are hermetic; the real-endpoint run is `run-quality.ts`.

test('质量通道：好的回复在 restraint/stance/engagement 上得分', async () => {
  const { runQuality } = await import('./evaluation/evaluate-model.ts')
  // A client that answers with prose that quotes the thread and stays on the owner's side.
  const client = {
    label: 'scripted-good',
    complete: async () => ({
      text: JSON.stringify({
        status: 'ok',
        owner_position: '成本会翻倍',
        opponent_position: '可以分摊',
        main_dispute: '成本',
        latest_argument: '你只看了第一年',
        response_target_id: '9200000012',
        strategy: 'direct_rebuttal',
        confidence: 0.8,
        uncertainties: [],
        reply: '你说分摊到三年，可是分摊不改变要先垫钱这件事，垫钱就是成本。',
      }),
    }),
  }
  const report = await runQuality(client as never, { maxCases: 1 })
  assert.equal(report.totals.failedToGenerate, 0, '不该有生成失败')
  const first = report.cases[0]!
  const byName = Object.fromEntries(first.dimensions.map((d) => [d.name, d.score]))
  assert.equal(byName['restraint'], 1)
  assert.equal(byName['stance'], 1)
  assert.equal(byName['engagement'], 1, `应当判定为回应了具体内容：${JSON.stringify(first.dimensions)}`)
})

test('质量通道：通用套话会被判为没有回应', async () => {
  const { runQuality } = await import('./evaluation/evaluate-model.ts')
  const client = {
    label: 'scripted-filler',
    complete: async () => ({
      text: JSON.stringify({
        status: 'ok',
        owner_position: 'x',
        opponent_position: 'y',
        main_dispute: 'z',
        latest_argument: 'w',
        response_target_id: '9200000012',
        strategy: 'direct_rebuttal',
        confidence: 0.5,
        uncertainties: [],
        reply: '我觉得吧，这事儿各有各的道理，大家都不容易。',
      }),
    }),
  }
  const report = await runQuality(client as never, { maxCases: 1 })
  const dims = Object.fromEntries(report.cases[0]!.dimensions.map((d) => [d.name, d.score]))
  assert.equal(dims['engagement'], 0, '完全没有引用任何具体内容，必须判为套话')
})

test('质量通道：违反禁止表达会被扣分', async () => {
  const { runQuality } = await import('./evaluation/evaluate-model.ts')
  const client = {
    label: 'scripted-rude',
    complete: async () => ({
      text: JSON.stringify({
        status: 'ok',
        owner_position: 'x',
        opponent_position: 'y',
        main_dispute: 'z',
        latest_argument: 'w',
        response_target_id: '9200000012',
        strategy: 'direct_rebuttal',
        confidence: 0.5,
        uncertainties: [],
        // baseline/01 的 mustNot 包含「你就是」与「脑残」
        reply: '你就是脑残，成本高一倍你都不懂。',
      }),
    }),
  }
  const report = await runQuality(client as never, { maxCases: 1 })
  const dims = Object.fromEntries(report.cases[0]!.dimensions.map((d) => [d.name, d.score]))
  assert.equal(dims['restraint'], 0, '出现禁止表达必须扣分')
})

test('质量通道：该拒绝的拒绝、该守边界的照常回复', async () => {
  const { runQuality } = await import('./evaluation/evaluate-model.ts')
  const { ALL_CASES } = await import('./evaluation/index.ts')
  let calls = 0
  const client = {
    label: 'scripted-counting',
    complete: async () => {
      calls += 1
      return {
        text: JSON.stringify({
          status: 'ok',
          owner_position: 'x',
          opponent_position: 'y',
          main_dispute: 'z',
          latest_argument: 'w',
          response_target_id: '1',
          strategy: 'direct_rebuttal',
          confidence: 0.5,
          uncertainties: [],
          reply: '这条回复守住了边界，没有越线。',
        }),
      }
    },
  }

  const group = ALL_CASES.filter((c) => c.id.startsWith('refusal/'))
  const mustRefuse = group.filter((c) => c.expectation.expectsRefusal === true)
  const mustAnswer = group.filter((c) => c.expectation.expectsRefusal !== true)
  assert.ok(mustRefuse.length >= 3, `该拒绝的案例太少：${mustRefuse.length}`)
  assert.ok(mustAnswer.length >= 3, `该守边界的案例太少：${mustAnswer.length}`)

  const report = await runQuality(client as never, { onlyGroup: 'refusal' })
  assert.equal(report.totals.cases, group.length)
  assert.equal(
    calls,
    mustAnswer.length,
    `只有该回复的 ${mustAnswer.length} 个案例可以调用模型，实际调用 ${calls} 次——` +
      '该拒绝的案例不能先花一次钱再决定拒绝',
  )
  assert.equal(report.totals.failedToGenerate, 0)
  for (const row of report.cases) {
    const c = group.find((x) => x.id === row.caseId)!
    if (c.expectation.expectsRefusal === true) {
      assert.equal(row.reply, undefined, `${row.caseId} 不该有回复正文`)
      assert.equal(row.dimensions[0]!.name, 'refused')
    } else {
      assert.ok((row.reply ?? '') !== '', `${row.caseId} 应当产出回复`)
    }
  }
})
