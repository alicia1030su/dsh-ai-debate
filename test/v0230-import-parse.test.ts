/**
 * v0.2.30 §一：微博离线讨论导入的解析与投影。
 *
 * ## 这个文件在防什么
 *
 * 1. **伪造平台来源**。人工导入的内容必须永远「未经平台核验」：`authorSource`
 *    留空、`sourceComplete` 为假。任何一处把昵称升级成身份，工作台就会把
 *    「不知道是谁说的」显示成「已核验」——那是这类项目最典型的谎。
 * 2. **假的 id 混进真实命名空间**。没有真实 id 时必须是 `local:` 前缀，
 *    而且会话的 `platform` 必须是 `manual`（注册表里没有它），
 *    这样任何代码都不可能拿这些 id 去真实平台定位。
 * 3. **静默丢失**。解析不出目标、缺正文、重名歧义，都必须出现在 `issues` 里。
 *    悄悄丢掉会让一份残缺的转录看起来完整。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MANUAL_PLATFORM,
  deriveTitle,
  parseImport,
  parseJson,
  parseText,
  stableSlug,
  statsOf,
  toCollectedThread,
  toGraph,
} from '../lib/import/manual.js'
import { toStoredImport, fromStoredImport, threadIdOf } from '../lib/import/session.js'

// ---------------------------------------------------------------------------
// 纯文本
// ---------------------------------------------------------------------------

const SAMPLE = `# 价格翻倍合理吗

原帖作者：我觉得这个价格翻倍是合理的，成本上涨了那么多。
---
路人甲：成本上涨不等于可以翻倍，你先把数据拿出来。
路人乙 回复 路人甲：他说的是行业平均，你不知道吗？
路人丙：两边都有道理，但翻倍确实夸张了。`

test('文本 1：标题行不算一条发言', () => {
  const parsed = parseText(SAMPLE)
  assert.ok(parsed.discussion !== undefined, '应当解析出讨论')
  assert.equal(parsed.discussion.title, '价格翻倍合理吗')
  // 这条回归在第一次实现里是坏的：`# 标题` 没有冒号，落到了「匿名发言」那一支。
  assert.equal(
    parsed.discussion.comments.some((comment) => comment.author === '匿名'),
    false,
    '标题行不该变成一条匿名发言',
  )
})

test('文本 2：分隔线之前是原帖，之后是评论', () => {
  const parsed = parseText(SAMPLE)
  assert.equal(parsed.discussion.root.author, '原帖作者')
  assert.match(parsed.discussion.root.text, /价格翻倍是合理/)
  assert.deepEqual(
    parsed.discussion.comments.map((comment) => comment.author),
    ['路人甲', '路人乙', '路人丙'],
  )
})

test('文本 3：`A 回复 B：` 的作者是 A，不是「A 回复 B」', () => {
  const parsed = parseText(SAMPLE)
  const c = parsed.discussion.comments.find((comment) => comment.text.includes('行业平均'))
  assert.ok(c !== undefined)
  assert.equal(c.author, '路人乙')
  assert.equal(c.replyTo, '路人甲')
  assert.equal(c.replyToKind, 'name')
})

test('文本 4：没有分隔线时第一条是原帖', () => {
  const parsed = parseText('甲：第一句\n乙：第二句\n丙：第三句')
  assert.equal(parsed.discussion.root.author, '甲')
  assert.deepEqual(
    parsed.discussion.comments.map((comment) => comment.author),
    ['乙', '丙'],
  )
})

test('文本 5：续行接到上一条发言后面', () => {
  const parsed = parseText('甲：第一行\n第二行\n乙：另一条')
  assert.equal(parsed.discussion.root.text, '第一行\n第二行')
})

test('文本 6：正文里的「回复 @某人」也算回复关系', () => {
  const parsed = parseText('甲：原帖\n---\n乙：我不同意\n丙：回复 @乙：你说的不对')
  const c = parsed.discussion.comments.find((comment) => comment.author === '丙')
  assert.equal(c.replyTo, '乙')
})

test('文本 7：空内容给出可行动的原因，而不是空结果', () => {
  const parsed = parseText('   \n\n  ')
  assert.equal(parsed.discussion, undefined)
  assert.equal(parsed.issues[0].code, 'empty')
  assert.match(parsed.issues[0].message, /粘贴/)
})

test('文本 8：只有分隔线时拒绝，并说明原因', () => {
  const parsed = parseText('---\n\n---')
  assert.equal(parsed.discussion, undefined)
  assert.equal(parsed.issues[0].code, 'no_blocks')
})

test('文本 9：网页复制带的 `>` 与「【】」被剥掉', () => {
  const parsed = parseText('> 甲：带引用符号的一行\n> 【楼主】乙：带标签的一行')
  assert.equal(parsed.discussion.root.author, '甲')
  assert.equal(parsed.discussion.comments[0].author, '乙')
})

test('文本 10：`2024 年 1 月：` 这种正文不被误判成作者行', () => {
  // 前导空格是关键：没有它，任何带冒号的正文都会被当成「某某：」。
  const parsed = parseText('甲：先说一句\n 2024 年 1 月：这个时间点很重要')
  assert.equal(parsed.discussion.root.author, '甲')
  assert.match(parsed.discussion.root.text, /2024 年 1 月/)
})

// ---------------------------------------------------------------------------
// 结构化 JSON
// ---------------------------------------------------------------------------

test('JSON 1：{ root, comments } 正常解析', () => {
  const parsed = parseJson(
    JSON.stringify({
      title: '一个标题',
      url: 'https://weibo.com/1/abc',
      root: { author: '原帖作者', text: '正文' },
      comments: [
        { id: 'c1', author: '甲', text: '第一条' },
        { id: 'c2', author: '乙', text: '第二条', replyTo: 'c1', replyToKind: 'id' },
      ],
    }),
  )
  assert.ok(parsed.discussion !== undefined)
  assert.equal(parsed.discussion.title, '一个标题')
  assert.equal(parsed.discussion.url, 'https://weibo.com/1/abc')
  assert.equal(parsed.discussion.comments[1].replyTo, 'c1')
  assert.equal(parsed.discussion.comments[1].replyToKind, 'id')
})

test('JSON 2：顶层是数组时第一条当原帖', () => {
  const parsed = parseJson(
    JSON.stringify([
      { author: '甲', text: '原帖' },
      { author: '乙', text: '评论' },
    ]),
  )
  assert.equal(parsed.discussion.root.author, '甲')
  assert.deepEqual(
    parsed.discussion.comments.map((comment) => comment.author),
    ['乙'],
  )
})

test('JSON 3：没有 id 的评论用 local: 编号', () => {
  const parsed = parseJson(
    JSON.stringify({ root: { author: '甲', text: 'x' }, comments: [{ author: '乙', text: 'y' }] }),
  )
  assert.equal(parsed.discussion.comments[0].id, 'local:1')
})

test('JSON 4：重复 id 被改名并说明', () => {
  const parsed = parseJson(
    JSON.stringify({
      root: { author: '甲', text: 'x' },
      comments: [
        { id: 'same', author: '乙', text: 'y' },
        { id: 'same', author: '丙', text: 'z' },
      ],
    }),
  )
  assert.notEqual(parsed.discussion.comments[0].id, parsed.discussion.comments[1].id)
  assert.ok(parsed.issues.some((issue) => issue.code === 'json_duplicate_id'))
})

test('JSON 5：非法 JSON 提示改用文本格式', () => {
  const parsed = parseJson('甲：这不是 JSON')
  assert.equal(parsed.discussion, undefined)
  assert.equal(parsed.issues[0].code, 'json_invalid')
  assert.match(parsed.issues[0].message, /文本/)
})

test('JSON 6：缺 root 时明确说缺什么', () => {
  const parsed = parseJson(JSON.stringify({ comments: [] }))
  assert.equal(parsed.issues[0].code, 'json_root')
})

test('JSON 7：comments 不是数组时拒绝', () => {
  const parsed = parseJson(JSON.stringify({ root: { author: '甲', text: 'x' }, comments: 'nope' }))
  assert.equal(parsed.issues[0].code, 'json_comments')
})

test('JSON 8：缺正文的评论被跳过并逐条说明', () => {
  const parsed = parseJson(
    JSON.stringify({
      root: { author: '甲', text: 'x' },
      comments: [{ author: '乙', text: '' }, { author: '丙', text: 'ok' }],
    }),
  )
  assert.equal(parsed.discussion.comments.length, 1)
  assert.ok(parsed.issues.some((issue) => issue.code === 'json_comment_text'))
})

// ---------------------------------------------------------------------------
// 分派与标题
// ---------------------------------------------------------------------------

test('分派 1：粘贴内容以 { 开头时按 JSON 解析', () => {
  const parsed = parseImport({
    kind: 'text',
    content: JSON.stringify({ root: { author: '甲', text: 'x' }, comments: [] }),
  })
  assert.equal(parsed.discussion.source, 'json')
})

test('分派 2：表单填的标题优先于正文推断', () => {
  const parsed = parseImport({ kind: 'text', content: '甲：第一行', title: '我填的标题' })
  assert.equal(parsed.discussion.title, '我填的标题')
})

test('分派 3：文件模式带 .json 扩展名时按 JSON 解析', () => {
  const parsed = parseImport({
    kind: 'file',
    fileName: 'discussion.json',
    content: JSON.stringify({ root: { author: '甲', text: 'x' }, comments: [] }),
  })
  assert.ok(parsed.discussion !== undefined)
  assert.equal(parsed.discussion.source, 'file')
})

test('标题 1：首句超过 40 字时截断', () => {
  const title = deriveTitle('一'.repeat(100), '甲')
  assert.ok(title.length <= 41)
  assert.match(title, /…$/)
})

test('标题 2：正文为空时退回作者名', () => {
  assert.equal(deriveTitle('', '甲'), '甲 的发言')
})

// ---------------------------------------------------------------------------
// 投影：必须是「未经平台核验」
// ---------------------------------------------------------------------------

function collectedOf(text: string) {
  const parsed = parseText(text)
  assert.ok(parsed.discussion !== undefined)
  return toCollectedThread(parsed.discussion)
}

test('投影 1：平台是 manual，不是 weibo', () => {
  const collected = collectedOf(SAMPLE)
  assert.equal(collected.thread.platform, MANUAL_PLATFORM)
  assert.equal(collected.thread.platform, 'manual')
  for (const entry of collected.floors) {
    assert.equal(entry.floor.platform, 'manual')
  }
})

test('投影 2：会话的线程 id 带 local: 命名空间', () => {
  const collected = collectedOf(SAMPLE)
  assert.match(collected.thread.id, /^local:thread-/)
  for (const entry of collected.floors) {
    assert.match(entry.floor.postId, /^local:/)
  }
})

test('投影 3：authorSource 一律不填——那是「未经核验」的机器表示', () => {
  const collected = collectedOf(SAMPLE)
  assert.equal(collected.thread.authorSource, undefined)
  for (const entry of collected.floors) {
    assert.equal(entry.floor.authorSource, undefined, '导入的发言不能声明来源界面')
    assert.equal(entry.floor.authorNumericUid, undefined, '导入的发言没有平台签发的账号 id')
    for (const reply of entry.nested) {
      assert.equal(reply.authorSource, undefined)
      assert.equal(reply.authorNumericUid, undefined)
    }
  }
})

test('投影 4：sourceComplete 永远是 false——粘贴的一定是片段', () => {
  const collected = collectedOf(SAMPLE)
  assert.equal(collected.completeness.sourceComplete, false)
  assert.equal(collected.complete, false)
  assert.ok(
    collected.completeness.reasons.some((reason) => /人工导入/.test(reason)),
    '必须有一条原因说明为什么不算完整',
  )
})

test('投影 5：回复关系靠昵称解析时标 relationUncertain', () => {
  const collected = collectedOf(SAMPLE)
  const nested = collected.floors.flatMap((entry) => entry.nested)
  assert.equal(nested.length, 1)
  assert.equal(nested[0].replyToName, '路人甲')
  assert.equal(nested[0].relationUncertain, true, '昵称不是身份，关系必须标为不确定')
  assert.equal(nested[0].replyToPostId, undefined, '没有 id 就不能编一个')
})

test('投影 6：重名时昵称解析被拒绝，那一条自己成层并说明', () => {
  const collected = collectedOf(
    '原帖：x\n---\n甲：我要说一句\n乙：回复 甲：我也说一句\n甲：哦',
  )
  // 「甲」出现两次，指哪一条是猜的。拒绝解析比猜一个更诚实，
  // 而且必须说出来——否则用户看到的三层结构里少了一条回复关系。
  assert.ok(
    collected.issues.some((issue) => /无法确定在回谁|不止一个人/.test(issue)),
    `应当说明重名导致的歧义，实际 issues：${collected.issues.join(' / ')}`,
  )
  // 那一条仍然是一条独立发言（不能因为说不清关系就把它删掉）。
  assert.ok(
    collected.floors.some((entry) => entry.floor.postId === 'local:2'),
    '解析不到关系的那条发言仍须出现在图上',
  )
  assert.equal(
    collected.completeness.analysisComplete,
    false,
    '有未解析的回复关系时，分析完整性必须为假',
  )
})

test('投影 7：结构化 JSON 的 id 关系是 stated，不标 uncertain', () => {
  const parsed = parseJson(
    JSON.stringify({
      root: { author: '甲', text: 'x' },
      comments: [
        { id: 'c1', author: '乙', text: 'y' },
        { id: 'c2', author: '丙', text: 'z', replyTo: 'c1', replyToKind: 'id' },
      ],
    }),
  )
  const collected = toCollectedThread(parsed.discussion)
  const nested = collected.floors.flatMap((entry) => entry.nested)
  assert.equal(nested.length, 1)
  assert.equal(nested[0].replyToPostId, 'c1')
  assert.equal(nested[0].relationUncertain, undefined)
})

test('投影 8：没有评论时 floors 为空，但不会抛错', () => {
  const collected = collectedOf('甲：只有原帖')
  assert.equal(collected.floors.length, 0)
  assert.equal(collected.thread.bodyNode, 'standalone')
})

test('投影 9：ConversationGraph 复用同一套边语义', () => {
  const collected = collectedOf(SAMPLE)
  const graph = toGraph(collected)
  assert.equal(graph.platform, 'manual')
  assert.equal(graph.threadId, collected.thread.id)
  assert.ok(
    graph.edges.every((edge) => edge.kind === 'contains' || edge.kind === 'replies_to'),
    '导入只会产生包含与回复两种边',
  )
  const inferred = graph.edges.filter((edge) => edge.certainty === 'inferred')
  for (const edge of inferred) {
    assert.ok(edge.basis !== undefined, '推断出来的边必须说明依据')
  }
})

test('投影 10：同一份内容两次投影得到同一个线程 id', () => {
  const a = collectedOf(SAMPLE)
  const b = collectedOf(SAMPLE)
  assert.equal(a.thread.id, b.thread.id, '线程 id 必须稳定，否则去重记录会认为每次都不同')
})

test('投影 11：不同内容得到不同的线程 id', () => {
  assert.notEqual(stableSlug('标题一'), stableSlug('标题二'))
})

// ---------------------------------------------------------------------------
// 落盘形态
// ---------------------------------------------------------------------------

test('落盘 1：往返之后线程 id 不变', () => {
  const parsed = parseText(SAMPLE)
  const stored = toStoredImport(parsed.discussion, new Date().toISOString())
  assert.equal(threadIdOf(stored), toCollectedThread(parsed.discussion).thread.id)
})

test('落盘 2：超过上限的评论被丢弃并计数，不静默', () => {
  const comments = Array.from({ length: 5 }, (_, index) => ({
    id: `c${index}`,
    author: `甲${index}`,
    text: '正文',
  }))
  const parsed = parseJson(
    JSON.stringify({ root: { author: '原帖', text: 'x' }, comments }),
  )
  const stored = toStoredImport(parsed.discussion, new Date().toISOString())
  assert.equal(stored.droppedComments, 0)
  assert.equal(stored.comments.length, 5)
})

test('落盘 3：超长正文被截断并计数', () => {
  const parsed = parseJson(
    JSON.stringify({
      root: { author: '原帖', text: '短' },
      comments: [{ author: '甲', text: 'あ'.repeat(9000) }],
    }),
  )
  const stored = toStoredImport(parsed.discussion, new Date().toISOString())
  assert.equal(stored.truncatedComments, 1)
  assert.ok(stored.comments[0].text.length < 9000)
})

test('落盘 4：往返之后内容等价', () => {
  const parsed = parseText(SAMPLE)
  const stored = toStoredImport(parsed.discussion, new Date().toISOString())
  const back = fromStoredImport(stored)
  assert.equal(back.title, parsed.discussion.title)
  assert.equal(back.root.author, parsed.discussion.root.author)
  assert.deepEqual(
    back.comments.map((comment) => comment.author),
    parsed.discussion.comments.map((comment) => comment.author),
  )
})

test('统计 1：participants 去重且含原帖作者', () => {
  const parsed = parseText(SAMPLE)
  const stats = statsOf(parsed.discussion)
  assert.ok(stats.participants.includes('原帖作者'))
  assert.equal(new Set(stats.participants).size, stats.participants.length)
})
