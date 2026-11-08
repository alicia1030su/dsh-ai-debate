/**
 * v0.2.38 §4：长上下文里的结构保留，以及「压缩不许凭空补事实」。
 *
 * ## 这一组取代的是「看最终分数猜原因」
 *
 * v0.2.37 有一条失败叫「长上下文无法保留论证结构」。当时能看到的只有分数，于是
 * 「为什么掉」只能靠猜：是模型退化了，还是材料被裁掉了？两者在同一个数字里。
 *
 * 现在分两步看：
 *
 * 1. `recordCompression` 逐项记录六样东西在压缩前后是否还在（这份记录是真相）；
 * 2. 只有在**结构还在**的前提下，回复却答偏了，才算模型的问题。
 *
 * ## 这一组同时钉住「压缩不补充事实」
 *
 * 压缩器只裁剪、不改写，所以压缩后的每一行都必须是某条原始发言的子串。这一条是可
 * 验证的，而且它比「看起来没编」强得多：它排除了「压缩器自己补了一句更像样的话」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute, type OwnerIdentity } from '../lib/analyzer.js'
import { buildBrief } from '../lib/brief-builder.js'
import { renderBrief } from '../lib/brief.js'
import { compressContext, resolveBudget, splitBudget } from '../lib/compressor.js'
import { resolvePersona } from '../lib/persona.js'
import { recordCompression, renderCompressionRecord } from '../lib/compression-record.js'
import { isQuantifiedClaim } from '../lib/number-trace.js'
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

/** 按指定预算跑一遍压缩，返回记录与上下文。 */
function compressCase(id: string, preset: 'small' | 'medium' | 'large') {
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
  const briefText = renderBrief(built.brief)
  const total = resolveBudget({ preset })
  const split = splitBudget(total.tokens)
  const context = compressContext({
    collected,
    dispute,
    trigger: { postId: c.pickedPostId },
    persona: resolvePersona({ style: 'aloof', maxLength: 120 }),
    budget: { tokens: split.contextTokens, quoteLimit: total.quoteLimit },
    totalTokens: total.tokens,
  })
  const targetContent = c.floors
    .flatMap((floor) => [floor.author, ...floor.nested])
    .find((post) => post.postId === c.pickedPostId)?.content
  const record = recordCompression(built.brief, targetContent, context, briefText)
  return { c, collected, dispute, brief: built.brief, briefText, context, record }
}

// ---------------------------------------------------------------------------
// 一、六项必须被逐项记录
// ---------------------------------------------------------------------------

test('压缩记录：六项齐全，且每项都带判定依据', () => {
  const { record } = compressCase('quality/long-01', 'medium')
  const keys = record.items.map((item) => item.key)
  assert.deepEqual(keys.sort(), [
    'dispute',
    'opponentArgument',
    'ownerPosition',
    'sourceId',
    'target',
    'uncertainty',
  ])
  for (const item of record.items) {
    assert.ok(item.probe.length > 0, `${item.label} 没有判定片段`)
    assert.ok(['exact', 'proxy', 'absent'].includes(item.basis))
  }
})

test('压缩记录：代理判定必须标出来，不能冒充精确判定', () => {
  const { record } = compressCase('quality/long-01', 'medium')
  const dispute = record.items.find((item) => item.key === 'dispute')
  assert.ok(dispute !== undefined)
  if (dispute.before) {
    assert.equal(dispute.basis, 'proxy', '核心争议没有逐字原文，只能代理判定')
  }
})

test('压缩记录：判定范围包含简报，不能只看对话段', () => {
  // baseline/03 在小预算下对话往来会被裁掉，但简报里带着对方的论据与 id。
  // 只量上下文会记成「论据丢失」—— 那是与事实相反的记录。
  const { record, briefText } = compressCase('baseline/03', 'small')
  assert.ok(briefText.includes('你连预算都没算'), '简报里应当有这条论据')
  const arg = record.items.find((item) => item.key === 'opponentArgument')
  assert.equal(arg?.after, true, '论据在简报里，模型看得到，不能记成丢失')
})

// ---------------------------------------------------------------------------
// 二、长上下文：关键项在三种预算下都要留住
// ---------------------------------------------------------------------------

test('quality/long-01：三种预算下，目标评论、主人立场、对手论据、来源 id 都不丢', () => {
  for (const preset of ['small', 'medium', 'large'] as const) {
    const { record } = compressCase('quality/long-01', preset)
    const required = ['target', 'ownerPosition', 'opponentArgument', 'sourceId']
    const lostRequired = record.lost.filter((key) => required.includes(key))
    assert.deepEqual(
      lostRequired,
      [],
      `${preset} 预算下丢了关键项：${lostRequired.join('、')}\n${renderCompressionRecord(record)}`,
    )
  }
})

test('长楼层刷屏不影响最早那条实质质疑（结构层）', () => {
  const { brief, context } = compressCase('quality/long-01', 'small')
  assert.ok(
    (brief.opponentArguments ?? []).length > 0,
    '最早那条实质质疑必须在简报里 —— 它是长上下文里最容易被压掉的',
  )
  assert.ok(
    context.text.includes('忽略了迁移成本'),
    '目标评论的原文必须出现在给模型的对话材料里',
  )
  // 路人的刷屏不应该占据主要内容。
  assert.ok(
    !context.text.includes('第 20 条'),
    '预算紧张时不该把刷屏留在材料里',
  )
})

test('压缩掉了什么，记录里能指出来（不是「整体感觉变差」）', () => {
  // 小预算必然掉背景，这是设计如此；关键是记录里能看见掉了哪一段。
  const { record } = compressCase('quality/long-01', 'small')
  assert.ok(record.omissions.length > 0, '小预算下应当有裁剪记录')
  assert.ok(
    record.omissions.some((item) => item.includes('其他参与者') || item.includes('帖子背景')),
    `裁剪记录里应能看出掉了哪一段：${record.omissions.join('｜')}`,
  )
})

// ---------------------------------------------------------------------------
// 三、压缩不许补事实
// ---------------------------------------------------------------------------

test('压缩后每一行对话都必须是某条原始发言的子串（不补、不改写）', () => {
  for (const id of ['quality/long-01', 'baseline/03', 'weibo/06']) {
    const { c, collected, context } = compressCase(id, 'medium')
    const sources = [
      ...collected.floors.flatMap((floor) => [
        floor.floor.content,
        ...floor.nested.map((post) => post.content),
      ]),
      c.floors.flatMap((floor) => [floor.author.content, ...floor.nested.map((post) => post.content)]).join(''),
      collected.thread.title,
      collected.thread.content,
      collected.thread.forum.name,
      collected.thread.authorName ?? '',
      collected.thread.authorId ?? '',
    ]
      .filter((item) => item.length > 0)
      .map((item) => item.replace(/\s+/g, ''))

    const joined = sources.join('\u0000')
    for (const chunk of context.chunks) {
      for (const line of chunk.text.split('\n')) {
        // 只校验「说话」的行：`[位置] 某人：内容`。
        const match = /^\[[^\]]*\]\s*[^：:]{1,40}[：:](.*)$/.exec(line)
        if (match === null) continue
        const body = (match[1] as string).replace(/\s+/g, '')
        if (body.length < 4) continue
        // 压缩可能截断，所以按前缀匹配：截断后仍必须是原文的前缀。
        const head = body.slice(0, Math.min(12, body.length))
        assert.ok(
          joined.includes(head),
          `${id} 的压缩材料里出现了一句原文没有的话：${line.slice(0, 60)}`,
        )
      }
    }
  }
})

test('压缩后的数字都来自原文：不新增数字', () => {
  for (const id of ['weibo/06', 'quality/long-01']) {
    const { c, collected, context } = compressCase(id, 'medium')
    const sourceText = [
      ...collected.floors.flatMap((floor) => [
        floor.floor.content,
        ...floor.nested.map((post) => post.content),
      ]),
      c.floors.flatMap((floor) => [floor.author.content, ...floor.nested.map((post) => post.content)]).join(''),
      collected.thread.title,
      collected.thread.content,
    ].join('\n')
    for (const match of context.text.matchAll(/\d+(?:\.\d+)?%?/g)) {
      const token = match[0]
      // 只看「在陈述数量」的数字：`owner_v34` 里的 34 是昵称的一部分，不是事实主张。
      // 这条判定与产品侧 `fabricated_number` 用的是同一个函数，避免两边标准不一。
      if (!isQuantifiedClaim(token, context.text)) continue
      // 位置标记 `[楼层 6502]` 里的是帖子 id，来自 thread 结构而不是正文，单独放行。
      if (sourceText.includes(token)) continue
      const inId =
        collected.floors.some(
          (floor) => floor.floor.postId === token || floor.nested.some((post) => post.postId === token),
        ) ||
        collected.thread.id === token ||
        (c.body?.postId ?? '') === token
      assert.ok(inId, `${id} 的压缩材料里出现了一个原文没有的数字：${token}`)
    }
  }
})

// ---------------------------------------------------------------------------
// 四、记录可读
// ---------------------------------------------------------------------------

test('渲染：丢了哪一项、为什么，一行一项地说清楚', () => {
  const { record, dispute } = compressCase('baseline/03', 'small')
  const text = renderCompressionRecord(record, dispute)
  assert.match(text, /压缩占用 \d+ \/ \d+ tokens/)
  for (const item of record.items) {
    assert.ok(text.includes(item.label), `渲染里缺了「${item.label}」`)
  }
  if (record.lost.length > 0) assert.match(text, /丢掉 \d+ 项/)
})
