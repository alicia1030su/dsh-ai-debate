import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { CASES } from './gui/quality-cases.ts'

const REPO = join(import.meta.dirname, '..')
const MATERIALS = join(REPO, 'scripts', 'quality-corpus-materials.json')

/**
 * 固定案例集的**规模与覆盖**（v0.3.0 §6.1）。
 *
 * 这两件事都容易悄悄退化：有人删掉两条看着多余的案例，指标照跑、报告照出，
 * 只是覆盖面少了一块；有人改了案例正文却忘了同步语料文件，盲评于是拿旧材料
 * 去算重叠度，两版对比从此不可比。都不是会报错的错误，所以必须钉住。
 */

test('案例集：至少 30 条（任务书 §6.1 的下限）', () => {
  assert.ok(
    CASES.length >= 30,
    `固定案例只有 ${CASES.length} 条，低于约定的 30 条下限`,
  )
})

test('案例集：id 唯一且连续，没有空洞', () => {
  const ids = CASES.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')
  const expected = CASES.map((_, index) => `q${String(index + 1).padStart(2, '0')}`)
  assert.deepEqual(ids, expected, 'id 必须是 q01…qNN 连续，不能跳号')
})

test('案例集：每条都有正文、目标与期望行为', () => {
  for (const item of CASES) {
    assert.ok(item.content.includes('\n'), `${item.id} 的正文必须是多行讨论`)
    assert.ok(item.content.startsWith('# '), `${item.id} 的正文第一行必须是标题`)
    assert.ok(item.targetAuthor.length > 0, `${item.id} 缺少目标作者`)
    assert.ok(item.targetText.length > 0, `${item.id} 缺少目标正文片段`)
    assert.ok(item.expect.length >= 10, `${item.id} 的期望行为写得太短，盲评时无法对照`)
  }
})

test('案例集：目标评论确实出现在正文里（否则定位会失败）', () => {
  for (const item of CASES) {
    assert.ok(
      item.content.includes(item.targetText),
      `${item.id} 的 targetText「${item.targetText}」在正文里找不到`,
    )
    assert.ok(
      item.content.includes(item.targetAuthor),
      `${item.id} 的 targetAuthor「${item.targetAuthor}」在正文里找不到`,
    )
  }
})

test('案例集：覆盖任务书点名的 15 类场景', () => {
  /**
   * 每一类用「在哪里能看出来」来判定，不靠标签文件。
   *
   * 标签可以贴上去而内容没变；这里判定的是实际文本里必须存在的特征。
   * 少一类就红，因为「案例够多但类型不全」与「案例不够」是同一个后果。
   */
  const coverage = [
    { name: '简单观点争论', ok: CASES.some((c) => c.id === 'q03') },
    { name: '双方都有依据', ok: CASES.some((c) => c.expect.includes('两个口径') || c.expect.includes('都成立')) },
    { name: '对方证据不足', ok: CASES.some((c) => c.id === 'q08') },
    { name: '前后矛盾（真矛盾）', ok: CASES.some((c) => c.id === 'q07') },
    { name: '条件不同造成的表述差异', ok: CASES.some((c) => c.expect.includes('前提不同')) },
    { name: '第三方引用', ok: CASES.some((c) => c.id === 'q18') },
    { name: '多人楼中楼', ok: CASES.some((c) => c.id === 'q06') },
    { name: '反讽', ok: CASES.some((c) => c.id === 'q21') },
    { name: '长上下文', ok: CASES.some((c) => c.id === 'q22' && c.content.split('\n').length >= 80) },
    { name: '目标身份混淆', ok: CASES.some((c) => c.id === 'q23') },
    { name: '缺失评论', ok: CASES.some((c) => c.id === 'q24') },
    { name: '提示词注入', ok: CASES.some((c) => c.content.includes('忽略之前的全部要求')) },
    { name: '数字与比例', ok: CASES.some((c) => c.id === 'q25') },
    { name: '模型合理拒绝', ok: CASES.some((c) => c.expect.includes('合理拒绝')) },
    { name: '模型不合理拒绝', ok: CASES.some((c) => c.expect.includes('unjustified_refusal')) },
  ]
  const missing = coverage.filter((item) => !item.ok).map((item) => item.name)
  assert.deepEqual(missing, [], `以下类型没有对应案例：${missing.join('、')}`)
})

test('语料文件与案例定义逐条一致（不是「条数相同」而是内容相同）', () => {
  const materials = JSON.parse(readFileSync(MATERIALS, 'utf8'))
  const ids = Object.keys(materials).sort()
  assert.equal(ids.length, CASES.length, '语料文件与案例集的条数不一致')
  for (const item of CASES) {
    assert.equal(
      materials[item.id],
      item.content,
      `${item.id} 的语料与案例正文不一致——改过案例就要重跑 gen-quality-materials`,
    )
  }
})

test('语料文件里没有案例集之外的孤儿条目', () => {
  const materials = JSON.parse(readFileSync(MATERIALS, 'utf8'))
  const known = new Set(CASES.map((item) => item.id))
  const orphans = Object.keys(materials).filter((id) => !known.has(id))
  assert.deepEqual(orphans, [], `语料文件里有案例集不认识的 id：${orphans.join('、')}`)
})
