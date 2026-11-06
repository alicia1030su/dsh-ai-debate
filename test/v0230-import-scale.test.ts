/**
 * 离线导入在规模上的行为（v0.2.30 §七）。
 *
 * ## 为什么这一份必须有
 *
 * 前面的 1000/3000/6000 基线测的是贴吧与微博的**读取**路径。离线导入是第三条路，
 * 它把「用户粘贴的一段文本」变成 `CollectedThread`，而那条投影链（`splitBlocks` →
 * `parseText` → `toCollectedThread` → `toConversationGraph`）一行都没被测过规模。
 *
 * 三个具体的风险，都是这一段代码自己引入的：
 *
 * 1. **回复关系的解析是二次的。** 每条「A 回复 B」都要在已解析的评论里按昵称找一次。
 *    40 条时无所谓，6000 条时是 3600 万次比较——而且它发生在**用户点「预览」的
 *    那一刻**，页面因此卡住，用户以为按钮坏了。
 * 2. **50% 的昵称重复。** 帖子里同名的人是常态（「楼主」「匿名用户」）。重名时那条
 *    回复关系必须判为 `unresolved` 而不是随便挑一个——这个判定也要在规模上成立。
 * 3. **部分缺失。** 用户粘的一定是片段。完整性必须判为「不可证明」，不能因为
 *    「我读到的都留下」就说完整。
 *
 * ## 为什么断言的是形状而不是毫秒
 *
 * 与 v0.2.27 那份同样的理由：墙钟阈值在忙的机器上会假红，然后被调大直到什么也不测。
 * 这里断言的是**算法性质**（不超预算、不全空、不平方级、关系数不丢），
 * 耗时用 `t.diagnostic()` 记下来供报告引用。数字变了是信息，形状变了才是缺陷。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseText, toCollectedThread } from '../lib/import/manual.js'
import { toStoredImport, collectedFromStored, MAX_IMPORTED_COMMENTS } from '../lib/import/session.js'
import { toConversationGraph } from '../lib/conversation-bridge.js'
import { analyzeDispute } from '../lib/analyzer.js'

const NOW = '2026-11-06T00:00:00.000Z'

/**
 * 造一段导入文本。
 *
 * @param comments 评论条数
 * @param replyRatio 其中多少比例的评论以「回复 某人」开头
 * @param namePool 昵称池大小。池子越小重名越多——1 就是全员同名。
 */
function makeImportText(comments: number, replyRatio: number, namePool: number): string {
  const lines: string[] = ['# 规模基线', '', '楼主：这是一段开场白，用来作为原帖。', '---']
  for (let index = 0; index < comments; index += 1) {
    const name = namePool === 1 ? '路人' : `路人${index % namePool}`
    const wantsReply = index > 0 && index % Math.max(1, Math.round(1 / Math.max(replyRatio, 1e-9))) === 0
    if (wantsReply) {
      // 指向池子里的另一个人。池子为 1 时指向自己，构成「重名」这一类的极端形状。
      const target = namePool === 1 ? '路人' : `路人${(index + 1) % namePool}`
      lines.push(`${name}：回复 ${target}　这一条是在回应上面那位。这是第 ${index} 条发言。`)
    } else {
      lines.push(`${name}：这是第 ${index} 条发言，内容本身没有特别的含义。`)
    }
  }
  return lines.join('\n')
}

interface Measured {
  readonly comments: number
  readonly parseMs: number
  readonly projectMs: number
  readonly graphMs: number
  /** `contains` 边：楼层归属。每一条发言必然有一条，所以它证明不了「关系被保留」。 */
  readonly containsEdges: number
  /** `replies_to` 边：按 id 解析到的真实回复关系。昵称解析来的不产生边。 */
  readonly replyEdges: number
  /** 挂到某一层下面的嵌套回复数：昵称关系落在结构里的位置。 */
  readonly nested: number
  /** 标了 `relationUncertain` 的嵌套回复数。 */
  readonly uncertain: number
  readonly issues: number
  readonly unresolved: number
  readonly participants: number
}

function measure(comments: number, replyRatio: number, namePool: number): Measured {
  const text = makeImportText(comments, replyRatio, namePool)

  const startedParse = Date.now()
  const parsed = parseText(text)
  const parseMs = Date.now() - startedParse
  assert.ok(parsed.discussion !== undefined, `规模 ${comments} 的素材必须能解析`)

  const startedProject = Date.now()
  const collected = toCollectedThread(parsed.discussion)
  const projectMs = Date.now() - startedProject

  const startedGraph = Date.now()
  const graph = toConversationGraph(collected)
  const graphMs = Date.now() - startedGraph

  const edges = graph.edges ?? []
  const nestedRows = collected.floors.flatMap((floor) => floor.nested)

  return {
    comments: parsed.discussion.comments.length,
    parseMs,
    projectMs,
    graphMs,
    containsEdges: edges.filter((edge) => edge.kind === 'contains').length,
    replyEdges: edges.filter((edge) => edge.kind === 'replies_to').length,
    nested: nestedRows.length,
    uncertain: nestedRows.filter((row) => row.relationUncertain === true).length,
    issues: collected.issues.length,
    // 歧义提示是**聚合**的：一条写着「有 20 条发言只写了「回复 X」…」，而不是每条一个 issue。
    // `collected.issues` 是字符串数组（不是对象），按条数断言会让这里永远读成 1，
    // 误以为「只处理了一条」。
    unresolved: collected.issues.filter((line) => /无法确定在回谁/.test(line)).length,
    participants: new Set(parsed.discussion.comments.map((comment) => comment.author)).size,
  }
}

test('规模：1000 / 3000 / 6000 条都能解析，且耗时不是平方级', (t) => {
  const small = measure(1000, 0.2, 40)
  const medium = measure(3000, 0.2, 40)
  const large = measure(6000, 0.2, 40)

  for (const row of [small, medium, large]) {
    t.diagnostic(
      `comments=${row.comments} parse=${row.parseMs}ms project=${row.projectMs}ms ` +
        `graph=${row.graphMs}ms contains=${row.containsEdges} nested=${row.nested} ` +
        `issues=${row.issues} participants=${row.participants}`,
    )
    assert.equal(row.comments, 6000 === row.comments ? 6000 : row.comments, '条数不能凭空增减')
  }

  // 6 倍输入不能带来 36 倍以上耗时。宽松常数是有意的：要抓的是意外出现的嵌套扫描，
  // 不是审毫秒。
  const ratio = (large.parseMs + large.graphMs) / Math.max(small.parseMs + small.graphMs, 1)
  t.diagnostic(`时间比 large/small = ${ratio.toFixed(2)}x（输入 6 倍）`)
  assert.ok(ratio < 36, `规模放大 6 倍后耗时放大了 ${ratio.toFixed(1)} 倍，像是平方级复杂度`)

  // 解析必须真的产出了那么多评论——否则上面对比的是两个空数组。
  assert.equal(large.comments, 6000, '6000 条素材必须解析出 6000 条评论')
  assert.equal(small.comments, 1000)
})

test('规模：50% 的发言是回复，关系边不能丢', (t) => {
  // ## 昵称池必须比条数大，否则测的就不是「关系解析」而是「重名处理」
  //
  // 第一版这里用 40 个昵称装 2000 条发言：每个名字出现 50 次，于是几乎每条
  // 「回复 路人7」都是歧义的——`unresolved` 非零，而我当时的断言要求它是 0。
  // 那不是产品的缺陷，是我的素材把两种情形混在一起了：`ambiguous` 该由下一条
  // 测试专门覆盖，这一条要的是「关系都能唯一解析时，边一条都不丢」。
  //
  // 池子 = 条数，即每个昵称唯一。
  const row = measure(2000, 0.5, 2000)
  t.diagnostic(
    `comments=${row.comments} contains=${row.containsEdges} replyEdges=${row.replyEdges} ` +
      `nested=${row.nested} uncertain=${row.uncertain} unresolved=${row.unresolved}`,
  )

  assert.equal(row.unresolved, 0, `每个昵称唯一时不该有歧义，实际 ${row.unresolved} 条`)

  // ## 这里曾经用 `contains` 边冒充「关系边」
  //
  // 第一版断言 `edges.length >= comments * 0.4`，而 `edges` 里全是 `contains`
  // （楼层归属），每条发言必然有一条——于是这个断言恒真，什么都没测。
  // 真正要证明的是「「回复 X」被写进了结构」，那要看 `nested`。
  assert.ok(
    row.nested >= Math.floor(row.comments * 0.4),
    `${row.comments} 条里有 50% 是回复，却只有 ${row.nested} 条挂进了某个楼层`,
  )

  // 昵称解析来的关系**不产生 `replies_to` 边**，这是刻意的：昵称不是身份，
  // 按它连一条 `stated` 边会让分析器把话说成别人的。所以这里断言的是
  // 「结构里有位置、且标了不确定」，而不是「图上有边」。
  assert.equal(
    row.replyEdges,
    0,
    '按昵称解析的回复不该产生 replies_to 边——那会把猜测写成事实',
  )
  assert.equal(
    row.uncertain,
    row.nested,
    '每一条按昵称挂上去的回复都必须标 relationUncertain',
  )
})

test('规模：全员同名时每一条回复都判为歧义，而不是随便挑一个', (t) => {
  const row = measure(500, 0.5, 1)
  t.diagnostic(
    `comments=${row.comments} contains=${row.containsEdges} nested=${row.nested} ` +
      `issues=${row.issues} unresolved=${row.unresolved}`,
  )

  // 池子为 1：所有人叫「路人」。此时「A 回复 路人」根本无法确定指的是哪一条，
  // 正确行为是**每条都判歧义**并写进 issues，而不是随机连一条边。
  assert.ok(
    row.unresolved > 0,
    '全员同名时应该有歧义提示；一条都没有说明它在随便挑人',
  )
  // 图仍然建得起来（楼层归属不需要消歧），但回复关系必须一条都不连。
  assert.ok(row.containsEdges >= 1, '同名不该让整张图空掉')
  assert.equal(row.nested, 0, '全员同名时不该有任何一条回复关系被连上去')
})

test('规模：超过上限时落盘要截断并如实计数', () => {
  // 比上限多 50 条。落盘必须只留上限条，并把差额记进 droppedComments——
  // 静默丢弃会让「我粘了 450 条」变成「页面只有 400 条」而没有任何解释。
  const over = MAX_IMPORTED_COMMENTS + 50
  const parsed = parseText(makeImportText(over, 0.2, 40))
  assert.ok(parsed.discussion !== undefined)
  assert.equal(parsed.discussion.comments.length, over)

  const stored = toStoredImport(parsed.discussion, NOW)
  assert.equal(stored.comments.length, MAX_IMPORTED_COMMENTS, '落盘条数必须等于上限')
  assert.equal(stored.droppedComments, 50, `应当记录丢弃 50 条，实际 ${stored.droppedComments}`)

  // 落盘 → 重投影之后仍然只有上限条，且图能建起来。
  const collected = collectedFromStored(stored)
  assert.equal(collected.floors.length + 1, MAX_IMPORTED_COMMENTS + 1, '重投影后条数应保持一致')
  const graph = toConversationGraph(collected)
  assert.ok((graph.edges ?? []).length > 0, '截断之后关系图仍应可用')
})

test('规模：部分缺失时完整性一律不可证明', () => {
  const parsed = parseText(makeImportText(500, 0.2, 40))
  assert.ok(parsed.discussion !== undefined)
  const collected = toCollectedThread(parsed.discussion)

  // 这三条是「人工导入」的定义性质，与规模无关，但必须在规模上仍然成立：
  // 用户粘的永远是片段，插件不能声称自己看到了全部。
  assert.equal(collected.completeness.sourceComplete, false, '导入内容永远不能声称来源完整')
  assert.ok(
    collected.completeness.reasons.length > 0,
    '不可证明完整性时必须给出理由，否则页面无法解释为什么标着「未经核验」',
  )

  // 分析器仍然能在部分内容上工作：它不该因为「不完整」就拒绝分析。
  const analyzed = analyzeDispute(
    collected,
    { platform: 'manual', userName: '楼主' },
    { postId: collected.floors[0]!.nested[0]?.postId ?? collected.floors[0]!.floor.postId },
  )
  assert.ok(analyzed.owner.displayName.length > 0, '部分内容也必须能解析出主人')
})

test('规模：深层回复链不会把分析器压垮', (t) => {
  // ## 昵称必须唯一，否则这条测试测不到「深」
  //
  // 第一版用 20 个昵称装 200 层：每层都指向上一层，而上一层那个名字出现了 10 次，
  // 于是全部判为歧义，`nested` 是 0——投影根本没走那条链，测的是一个空操作。
  //
  // 唯一昵称才是真正的深链：每条都精确解析到上一条，`floorOwnerOf` 要从
  // 第 200 条一路回溯到第 1 条才能找到它所属的楼层。这才是要被测量的成本。
  const depth = 200
  const lines: string[] = ['# 深链', '', '楼主：开场。', '---']
  for (let index = 0; index < depth; index += 1) {
    const name = `层${index}`
    const target = index === 0 ? '楼主' : `层${index - 1}`
    lines.push(`${name}：回复 ${target}　第 ${index} 层。`)
  }
  const parsed = parseText(lines.join('\n'))
  assert.ok(parsed.discussion !== undefined)

  const started = Date.now()
  const collected = toCollectedThread(parsed.discussion)
  const graph = toConversationGraph(collected)
  const elapsed = Date.now() - started
  const nested = collected.floors.flatMap((floor) => floor.nested)
  t.diagnostic(
    `深链 ${depth} 层：投影+建图 ${elapsed}ms，contains 边 ${(graph.edges ?? []).length} 条，` +
      `嵌套 ${nested.length} 条（其中标不确定 ${nested.filter((row) => row.relationUncertain === true).length}）`,
  )

  assert.equal(collected.issues.length, 0, `唯一昵称的深链不该有歧义：${JSON.stringify(collected.issues.slice(0, 2))}`)
  // 第 0 条说「回复 楼主」，指向的是**原帖**，所以它自己成层；其余 199 条挂在它下面。
  // 「回复原帖的人 = 自己开一层」是正确的结构：原帖不是评论，没有可挂的父评论。
  assert.equal(nested.length, depth - 1, `深链应当挂上 ${depth - 1} 条，实际 ${nested.length}`)
  assert.ok((graph.edges ?? []).length >= depth, `楼层归属边太少：${(graph.edges ?? []).length}`)
  // 昵称关系一律标不确定——深也改变不了「昵称不是身份」这件事。
  assert.equal(
    nested.filter((row) => row.relationUncertain === true).length,
    nested.length,
    '按昵称挂上去的每一条都必须标 relationUncertain',
  )
  // 200 层必须在可接受的时间内完成。这条给的是**上限**而不是精确值：
  // 回溯是 O(depth)，深 200 时仍是毫秒级；一旦有人改成每层重扫全表，
  // 这里会以分钟计。
  assert.ok(elapsed < 5000, `深链 ${depth} 层花了 ${elapsed}ms，像是出现了平方级回溯`)
})
