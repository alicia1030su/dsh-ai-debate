/**
 * v0.2.38 §5：真实模型采集里跑出来的一个真实缺陷 —— 空候选。
 *
 * ## 缺陷是什么
 *
 * 长楼层那条案例（最早那条实质质疑被 6 条刷屏埋住）连续两轮采集都产出一条
 * `text: ""` 的候选。根因不是模型坏，而是模型**按规则**返回了
 * `status: "needs_more_context"`（第 3 条铁律允许它这么做），而离线链路只判断
 * 「draft 存不存在」—— 存在就落库。
 *
 * 后果有三层，一层比一层严重：
 *
 * 1. 页面上出现一条可以点「复制」的空候选；
 * 2. 采集器只能记下一条空正文，分不清「模型拒绝」与「链路坏了」；
 * 3. 报告的「产出成功 20/20」是假的 —— 其中一条是空字符串。
 *
 * ## 这一组钉住什么
 *
 * - 空正文或 `needs_more_context` 时**不落候选**；
 * - 失败原因里带上模型自己说的缺口，而不是「未知错误」；
 * - 这三条都不影响正常路径（有正文、status=ok 时照旧落库）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateReply } from '../lib/generator.js'
import { analyzeDispute } from '../lib/analyzer.js'
import { compressContext, resolveBudget, splitBudget } from '../lib/compressor.js'
import { resolvePersona } from '../lib/persona.js'
import { ALL_CASES } from './evaluation/index.ts'
import { caseThread } from './evaluation/evaluate-deterministic.ts'

/**
 * 这一组直接测「判据」，不去跑整个导入工作流。
 *
 * 理由：工作流需要 store、路由、配置与一个真实的 `LlmClient`，而这里的规则只有
 * 一条 —— 「draft 存在但正文为空」必须当成拒绝。把它做成纯函数可测，就不会因为
 * 某个装配细节变化而失去意义。
 */

/** 与 `workflow.ts` 里那段判定同一规则。改动这里必须同时改那里（有测试盯着）。 */
function isRefusal(result: { needsInput: boolean; draft?: { reply: string } }): boolean {
  if (result.draft === undefined) return false
  return result.needsInput || result.draft.reply.trim() === ''
}

test('模型返回 needs_more_context 时，正文为空也必须判成拒绝', () => {
  assert.equal(
    isRefusal({
      needsInput: true,
      draft: { reply: '' },
    }),
    true,
  )
})

test('模型返回 ok 但正文是空白，同样判成拒绝（不能落一条看不见的候选）', () => {
  assert.equal(isRefusal({ needsInput: false, draft: { reply: '   \n  ' } }), true)
})

test('正常正文不触发拒绝', () => {
  assert.equal(isRefusal({ needsInput: false, draft: { reply: '这句话是有内容的。' } }), false)
})

test('真实生成链路：needs_more_context 的草稿带着模型自己的原因', async () => {
  const c = ALL_CASES.find((item) => item.id === 'quality/long-01')
  assert.ok(c !== undefined)
  const collected = caseThread(c)
  const dispute = analyzeDispute(collected, ownerOf(c), { postId: c.pickedPostId })

  const total = resolveBudget({ preset: 'small' })
  const split = splitBudget(total.tokens)
  const context = compressContext({
    collected,
    dispute,
    trigger: { postId: c.pickedPostId },
    persona: resolvePersona({ style: 'aloof', maxLength: 120 }),
    budget: { tokens: split.contextTokens, quoteLimit: total.quoteLimit },
    totalTokens: total.tokens,
  })

  const result = await generateReply(
    {
      label: 'scripted-refusal',
      complete: async () => ({
        text: JSON.stringify({
          status: 'needs_more_context',
          owner_position: '',
          opponent_position: '',
          main_dispute: '',
          latest_argument: '',
          response_target_id: c.pickedPostId,
          strategy: 'direct_rebuttal',
          confidence: 0.2,
          uncertainties: [],
          reply: '',
          reason: '楼中楼没有读全，看不到最早的质疑',
        }),
        usage: { inputTokens: 80, outputTokens: 40, elapsedMs: 5 },
      }),
    } as never,
    {
      dispute,
      context,
      persona: resolvePersona({ style: 'aloof', maxLength: 120 }),
      expectedTargetPostId: c.pickedPostId,
    },
  )

  assert.equal(result.needsInput, true, '模型要求补充信息时必须被识别出来')
  assert.match(result.needsInputReason ?? '', /楼中楼没有读全/)
  assert.equal(isRefusal(result), true, '这条结果不能被存成候选')
  assert.equal(result.draft?.reply, '')
})

/** 案例里「主人」的账号，规则与评测通道一致。 */
function ownerOf(c: (typeof ALL_CASES)[number]) {
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
