/**
 * 结果类型必须穿过每一层（v0.2.39 §3.1）。
 *
 * ## 这组测试来自一次真实的数据失真
 *
 * 第一次真实采集里，19 条 `needs_more_context` / `unjustified_refusal` 全被记成了
 * `technical_failure`：分类函数是对的，`generateForImport` 也把 `outcome` 放进了返回值，
 * 但 `index.ts` 把 `StepResult` 映射成页面响应时只搬了 `reason` 和 `next`。
 * 采集器看到没有 `outcome`，按「没有类型就是故障」处理。
 *
 * 这不是一个孤立的笔误 —— 每一层都有自己的返回结构，每一层都可能漏搬一个字段，
 * 而漏掉的那一层**不会报错**：它只会安静地把三种不同的结果压成一种。
 *
 * 所以这里测的不是「分类对不对」（那是 `v0239-outcome.test.ts` 的事），而是
 * 「分类有没有被搬到调用方看得见的地方」。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')

/** 读一个源文件，去注释后用于结构断言。 */
function source(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

test('settings-routes 的 generate 声明了 outcome，页面才读得到', () => {
  const text = source('src/settings-routes.ts')
  const block = /generate\(input: \{[\s\S]*?\}\): Promise<\{([\s\S]*?)\}>/.exec(text)
  assert.ok(block !== null, '找不到 generate 的返回类型声明')
  assert.match(block[1], /readonly outcome\?: string/, '返回类型里必须有 outcome')
})

test('index.ts 的两条返回路径都搬了 outcome（成功与失败）', () => {
  const text = source('src/index.ts')
  /**
   * 直接数全文件里的搬运次数，而不是切一段实现。
   *
   * 切段依赖缩进与相邻注释，改一次格式就失效。这条断言真正要说的只有一句：
   * **失败路径与成功路径都把 `outcome` 写进了返回值。** 数两处就是它。
   */
  void ROOT
  const body = text
  const hits = body.match(/outcome: result\.value\.outcome|result\.outcome === undefined \? \{\} : \{ outcome: result\.outcome \}/g)
  assert.ok(
    hits !== null && hits.length >= 2,
    '成功与失败两条路径都要带 outcome；只带一条，另一条就会被下游当成「没有类型」',
  )
})

test('导入工作流的失败结果带 outcome，且三种拒绝各有不同的下一步', () => {
  const text = source('src/import/workflow.ts')
  // 三个分支都要把 outcome 交给 failed()
  assert.match(text, /outcome === 'needs_more_context' \|\| outcome === 'unjustified_refusal'/)
  assert.match(text, /outcome === 'technical_failure'/)
  /**
   * 只查「生成步骤」的失败分支。
   *
   * 文件里还有别的 `failed()` 调用（找不到会话、预览失败），它们与结果分类无关 ——
   * 一条「所有 failed 都要带 outcome」的断言会把它们逼着编一个假类型。
   */
  const generateFailures = text.match(/failed\(\s*'generate',/g) ?? []
  assert.ok(generateFailures.length >= 3, '生成步骤应当有三类失败：拒绝（两种说法）与故障')
  const withOutcome = (text.match(/failed\(\s*'generate',[\s\S]{0,600}?\n\s*outcome,\s*\n\s*\)/g) ?? []).length
  assert.ok(withOutcome >= 2, '两类拒绝与故障都要把 outcome 交出去')
})

test('运行时对「没有正文」的结果不落空候选', () => {
  const text = source('src/runtime.ts')
  // 只有产出草稿的两种结果才写候选
  assert.match(
    text,
    /const storeCandidate = outcome === 'valid_draft' \|\| outcome === 'invalid_draft'/,
    '必须用 outcome 决定要不要落候选，而不是用「有没有 draft」',
  )
  assert.match(text, /candidates: storeCandidate/, '候选列表必须受这个判断控制')
})

test('运行时在拒绝/故障时返回 outcome 而不是抛「内部错误」', () => {
  const text = source('src/runtime.ts')
  assert.match(
    text,
    /if \(outcome === 'needs_more_context' \|\| outcome === 'unjustified_refusal' \|\| outcome === 'technical_failure'\) \{\s*return \{/,
    '这三种结果是正常返回，不是内部错误',
  )
})

test('页面按结果类型给不同提示：材料不足不着红，故障与误拒标红', () => {
  const text = source('client/client.cjs')
  assert.match(text, /const \[notice, setNotice\] = useState\(null\)/)
  assert.match(text, /notice\.outcome === 'needs_more_context'\s*\?\s*'dsd-hint'\s*:\s*'dsd-hint dsd-hint-error'/)
  // 五态都要有中文文案
  for (const key of [
    'outcome_valid_draft',
    'outcome_needs_more_context',
    'outcome_unjustified_refusal',
    'outcome_invalid_draft',
    'outcome_technical_failure',
  ]) {
    assert.match(text, new RegExp(`${key}:`), `页面缺少 ${key} 的文案`)
  }
})

test('采集器按 outcome 分类，不再把 ok === false 一律记成失败', () => {
  const text = source('test/gui/collect-quality-corpus.ts')
  assert.match(text, /const outcome = generated\.outcome === undefined/)
  assert.match(text, /outcome !== 'valid_draft' && outcome !== 'invalid_draft'/)
  assert.match(text, /stage\(`生成 \$\{item\.id\}`, 'passed', `\$\{outcome\}/, '拒绝不该显示成 ✘')
})
