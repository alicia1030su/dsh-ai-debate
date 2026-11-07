/**
 * v0.2.31 §三/§四：智能解析与人工纠错。
 *
 * ## 这一组测试在防什么
 *
 * 三件只在真实粘贴与真实操作里才会发生的事：
 *
 * 1. **解析器把论坛格式读错**：楼层号 / 时间戳 / `>>` 各占一行时，每条真实发言
 *    前面会多出两条「匿名」假发言，参与者里多一个人。分析器会把这个匿名者
 *    当成一个从不正面回应的人。
 * 2. **修正产出的关系谎称平台核验过**：用户手工指定回复目标之后，图上的边原来
 *    硬编码着「平台返回了被回复的 post id」。没有平台参与过，而这句话会跟着边
 *    进入转录与模型上下文。
 * 3. **修正只改一半**：作者改了但分析用的还是旧作者，或者候选没作废。
 *    界面看起来对，实际在对着一个不存在的人写回复。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseText, toCollectedThread, toGraph } from '../lib/import/manual.js'
import { applyCorrections, hasCorrections, sanitizeCorrections } from '../lib/import/corrections.js'
import { describeImport } from '../lib/import/preview.js'

// ---------------------------------------------------------------------------
// 智能解析
// ---------------------------------------------------------------------------

test('解析 1：楼层号与时间戳单独成行时，不算发言', () => {
  const parsed = parseText(
    ['楼主：原帖正文', '---', '2 楼', '2024-01-01 12:00', '甲：第一句', '3 楼', '刚刚', '乙：第二句'].join(
      '\n',
    ),
  )
  const discussion = parsed.discussion!
  assert.equal(discussion.comments.length, 2, '四条元信息行不能变成发言')
  assert.equal(discussion.comments[0]!.author, '甲')
  assert.equal(discussion.comments[0]!.floor, 2)
  assert.equal(discussion.comments[0]!.createdAt, '2024-01-01 12:00')
  assert.equal(discussion.comments[1]!.author, '乙')
  assert.equal(discussion.comments[1]!.floor, 3)
})

test('解析 2：作者行里的楼层号与括号时间被剥出来，名字不长出半截时间', () => {
  // 时间是含冒号的（12:00）。通用作者行按冒号切，会把作者切成「甲（2024-01-01 12」。
  const parsed = parseText(['甲（2024-01-01 12:00）：先修'].join('\n'))
  const discussion = parsed.discussion!
  assert.equal(discussion.root.author, '甲')
  assert.equal(discussion.root.text, '先修')
  assert.equal(discussion.root.createdAt, '2024-01-01 12:00')
})

test('解析 3：`3 楼 甲：` 这种作者行里的楼层号被剥出来', () => {
  const parsed = parseText(['原帖：x', '---', '3 楼 甲：我要说一句'].join('\n'))
  const comment = parsed.discussion!.comments[0]!
  assert.equal(comment.author, '甲')
  assert.equal(comment.floor, 3)
  assert.equal(comment.text, '我要说一句')
})

test('解析 4：`===`、`***`、带中文标注的 `---` 都认作分隔符', () => {
  for (const separator of ['===', '***', '___', '···', '--- 评论区 ---']) {
    const parsed = parseText(['甲：原帖', separator, '乙：评论'].join('\n'))
    assert.equal(parsed.discussion?.root.author, '甲', `分隔符「${separator}」没被识别`)
    assert.equal(parsed.discussion?.comments.length, 1, `分隔符「${separator}」之后的评论丢了`)
    assert.equal(parsed.discussion?.comments[0]?.author, '乙')
  }
})

test('解析 5：`>> 甲` 是回复标记，不是引用装饰', () => {
  // 单个 `>` 是引用装饰（要剥），两个是回复标记（要保留成关系）。
  // 两者都当装饰剥掉时，`>> 甲` 会变成一条「匿名：甲」的假发言。
  const parsed = parseText(['甲：原帖', '***', '>> 甲', '乙：你这个说法有问题'].join('\n'))
  const discussion = parsed.discussion!
  assert.equal(discussion.comments.length, 1, '`>> 甲` 不能变成一条发言')
  assert.equal(discussion.comments[0]!.author, '乙')
  assert.equal(discussion.comments[0]!.replyTo, '甲')
  assert.match(discussion.comments[0]!.replyBasis ?? '', />>/)
})

test('解析 6：`@甲 正文` 与 `回复 @甲：正文` 都识别成回复关系', () => {
  const at = parseText(['甲：原帖', '---', '@乙 你说得不对', '乙：我哪里不对'].join('\n'))
  assert.equal(at.discussion!.comments[0]!.replyTo, '乙')

  const reply = parseText(['甲：原帖', '---', '乙：回复 @丙：我也觉得', '丙：嗯'].join('\n'))
  assert.equal(reply.discussion!.comments[0]!.replyTo, '丙')
  assert.equal(reply.discussion!.comments[0]!.text, '我也觉得', '前缀要从正文里剥掉')
})

test('解析 7：原始输入逐条保留，解析不改写原文', () => {
  const text = ['甲 2 楼 2024-01-01 12:00：先修'].join('\n')
  const parsed = parseText(text)
  const raw = parsed.discussion!.comments[0]?.raw ?? parsed.discussion!.rootRaw!
  assert.equal(raw, text, 'raw 必须与用户输入逐字相同')
  assert.equal(parsed.discussion!.root.author, '甲', '但解析结果可以是剥过的')
})

test('解析 8：楼层号后面的空行不影响归属，悬空标记会被说出来', () => {
  const parsed = parseText(['甲：原帖', '---', '9 楼'].join('\n'))
  // 只有楼层号、没有发言：不能凭空造一条「匿名：9 楼」。
  assert.equal(parsed.discussion?.comments.length, 0)
  assert.ok(
    parsed.issues.some((issue) => issue.code === 'dangling_meta'),
    `应当说明悬空的楼层标记，实际：${parsed.issues.map((i) => i.code).join(',')}`,
  )
})

// ---------------------------------------------------------------------------
// 修正层
// ---------------------------------------------------------------------------

const BASE = ['楼主：原帖正文', '---', '甲：第一句', '乙：回复 甲：第二句', '丙：第三句'].join('\n')

function parsedOf(text: string) {
  const parsed = parseText(text)
  assert.ok(parsed.discussion !== undefined, '样本必须能解析')
  return parsed.discussion
}

test('修正 1：改作者名只改解析结果，不动原文', () => {
  const discussion = parsedOf(BASE)
  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [{ id: 'local:1', author: '甲改' }],
  })
  assert.equal(result.discussion.comments[0]!.author, '甲改')
  assert.equal(result.discussion.comments[0]!.raw, discussion.comments[0]!.raw, 'raw 不能被改写')
  assert.equal(result.audit.length, 1)
  assert.equal(result.audit[0]!.before, '甲')
  assert.equal(result.audit[0]!.after, '甲改')
})

test('修正 2：手工指定的回复目标可以显式为 stated，但依据必须写明是人指定的', () => {
  // ## 这条测试的名字原来写的是「不能升级成 stated」，而断言要求 `stated`
  //
  // 名字与断言互相矛盾，两者都通过了——因为断言测的是产品，名字测的是我当时的
  // 想法。v0.2.31 收尾时把它改对了：**指向**是明确的（用户点了哪一条就是哪一条，
  // 不是从昵称猜的），所以 `certainty` 是 `stated`；而**依据**必须写明这条关系
  // 是用户指定的，不是平台返回的。
  //
  // 真正的风险从来不是 `stated` 这个词，是那句「平台返回了被回复的 post id」
  // 被硬编码到图上——见 `修正 13`。
  const discussion = parsedOf(BASE)
  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [{ id: 'local:3', replyTo: 'local:1' }],
  })
  const comments = result.discussion.comments
  assert.equal(comments[2]!.replyTo, 'local:1')
  assert.equal(comments[2]!.replyToKind, 'id', '按 id 指定，解析层按 id 处理')

  const collected = toCollectedThread(result.discussion)
  const nested = collected.floors.flatMap((entry) => entry.nested)
  const target = nested.find((reply) => reply.postId === 'local:3')
  assert.ok(target !== undefined, 'local:3 应当成为一条嵌套回复')
  assert.equal(target!.relationUncertain, undefined, '按 id 指定的关系是确定的')

  const structure = describeImport(result.discussion)
  const node = structure.comments.find((entry) => entry.id === 'local:3')!
  assert.equal(node.certainty, 'stated', '按 id 指定的关系在界面上显示为 stated')
  assert.match(node.basis ?? '', /你手工指定/, '必须显示这个关系是人为指定的')
})

test('修正 13：人工修正产出的图边不能声称依据来自平台', () => {
  // ## 这条防的是一句具体的假话
  //
  // `conversation-bridge` 原来对所有带 `replyToPostId` 的边都写
  // 「平台返回了被回复的 post id」。人工导入没有平台参与，而那行字会一路走到
  // 图和转录里，让用户以为平台核对过这条关系。
  const discussion = parsedOf(BASE)
  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [{ id: 'local:3', replyTo: 'local:1' }],
  })
  const graph = toGraph(toCollectedThread(result.discussion))
  const edge = graph.edges.find((entry) => entry.kind === 'replies_to')
  assert.ok(edge !== undefined, '手工指定之后应当有一条 replies_to 边')
  assert.doesNotMatch(
    edge!.basis ?? '',
    /平台返回/,
    '人工导入的边不能声称依据来自平台——没有任何平台参与过',
  )
  assert.match(edge!.basis ?? '', /你手工指定/, '依据必须说明是用户指定的')
})

test('修正 3：标为「确认不了」时，即使有 id 也只算 unresolved', () => {
  const discussion = parsedOf(BASE)
  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [{ id: 'local:3', replyTo: 'local:1', unconfirmed: true }],
  })
  const structure = describeImport(result.discussion)
  const node = structure.comments.find((entry) => entry.id === 'local:3')!
  assert.equal(node.certainty, 'unresolved', '用户说确认不了，就不能显示成确定')
  assert.equal(node.unconfirmed, true)
})

test('修正 4：解除回复关系后它自己成层', () => {
  const discussion = parsedOf(BASE)
  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [{ id: 'local:2', replyTo: 'none' }],
  })
  const collected = toCollectedThread(result.discussion)
  const nested = collected.floors.flatMap((entry) => entry.nested)
  assert.equal(nested.length, 0, '解除关系之后不该还有嵌套边')
  assert.ok(
    collected.floors.some((entry) => entry.floor.postId === 'local:2'),
    '那条发言仍在图上，只是自己成层',
  )
})

test('修正 5：同名拆开之后，两个人变成两个参与者', () => {
  const discussion = parsedOf(['原帖：x', '---', '甲：第一句', '甲：第二句'].join('\n'))
  const before = describeImport(discussion)
  assert.equal(before.sharedNames.length, 1, '同名必须被指出来')

  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [{ id: 'local:2', localIdentity: '另一个甲' }],
  })
  const after = describeImport(result.discussion)
  assert.equal(after.comments[1]!.author, '甲（另一个甲）')
  assert.equal(after.sharedNames.length, 0, '拆开之后不该再报同名')
  assert.equal(after.participants.length, 3, '原帖作者 + 两个甲')
})

test('修正 6：把某条评论提升为原帖，原原帖变成评论', () => {
  const discussion = parsedOf(['甲：第一句', '---', '乙：这才是原帖'].join('\n'))
  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [],
    rootFromCommentId: 'local:1',
  })
  assert.equal(result.discussion.root.author, '乙')
  assert.equal(result.discussion.root.text, '这才是原帖')
  assert.ok(
    result.discussion.comments.some((comment) => comment.author === '甲'),
    '原来的原帖必须变成一条评论',
  )
  assert.equal(result.audit[0]!.field, 'root')
})

test('修正 7：非法修正被拒绝并说明，不静默丢弃', () => {
  const discussion = parsedOf(BASE)
  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [
      { id: 'local:999', author: '谁' },
      { id: 'local:1', replyTo: 'local:1' },
      { id: 'local:2', replyTo: 'local:404' },
    ],
  })
  const codes = result.issues.map((issue) => issue.code)
  assert.ok(codes.includes('correction_unknown_id'), '指向不存在的发言要报出来')
  assert.ok(codes.includes('correction_self_reply'), '自己回复自己要报出来')
  assert.ok(codes.includes('correction_reply_missing'), '目标不存在要报出来')
  assert.equal(result.discussion.comments[1]!.replyTo, '甲', '被拒绝的修正不能改掉原值')
})

test('修正 8：同样输入两次应用，结果完全相同', () => {
  const discussion = parsedOf(BASE)
  const corrections = {
    version: 1 as const,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [{ id: 'local:3', author: '丙改' }],
  }
  const a = applyCorrections(discussion, corrections)
  const b = applyCorrections(discussion, corrections)
  assert.deepEqual(a.discussion.comments, b.discussion.comments)
  assert.deepEqual(a.audit, b.audit)
})

test('修正 9：空清单等于没改，`hasCorrections` 认得出来', () => {
  const empty = { version: 1 as const, revisedAt: '2026-11-06T00:00:00.000Z', entries: [] }
  assert.equal(hasCorrections(empty), false)
  assert.equal(hasCorrections(undefined), false)
  assert.equal(hasCorrections({ ...empty, demoteRoot: true }), true)
  assert.equal(
    hasCorrections({ ...empty, rootFromCommentId: 'local:1' }),
    true,
    '只换原帖也算一次修正',
  )
})

test('修正 10：来路不明的修正清单被清洗，不合法字段不会进下游', () => {
  const sanitized = sanitizeCorrections({
    version: 1,
    revisedAt: 123,
    entries: [
      { id: 'local:1', author: '甲' },
      { id: '', author: '空 id' },
      { id: 'local:2' },
      { id: 'local:3', author: 42 },
      'nonsense',
    ],
  })
  assert.ok(sanitized !== undefined)
  assert.deepEqual(
    sanitized!.entries.map((entry) => entry.id),
    ['local:1'],
    '空 id、无字段、非对象的条目都要被丢掉',
  )
  assert.equal(sanitizeCorrections({ entries: [] }), undefined, '缺少 version 时整体拒绝')
  assert.equal(sanitizeCorrections(null), undefined)
})

test('修正 11：修正不会碰 authorSource —— 那是「已核验」的机器表示', () => {
  const discussion = parsedOf(BASE)
  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [{ id: 'local:1', author: '甲改' }, { id: 'local:2', localIdentity: '乙2' }],
  })
  const collected = toCollectedThread(result.discussion)
  const sources = [
    ...collected.floors.map((entry) => entry.floor.authorSource),
    ...collected.floors.flatMap((entry) => entry.nested.map((reply) => reply.authorSource)),
  ]
  assert.ok(
    sources.every((value) => value === undefined),
    '人工导入的作者来源必须始终为空——填了就等于声称平台核验过',
  )
})

test('修正 12：修正之后线程 id 不变，刷新不会变成另一个讨论', () => {
  const discussion = parsedOf(BASE)
  const before = toCollectedThread(discussion).thread.id
  const result = applyCorrections(discussion, {
    version: 1,
    revisedAt: '2026-11-06T00:00:00.000Z',
    entries: [{ id: 'local:1', author: '甲改' }],
  })
  assert.equal(toCollectedThread(result.discussion).thread.id, before)
})
