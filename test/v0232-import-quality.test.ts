/**
 * v0.2.32 §四：离线导入质量。
 *
 * ## 这一版只补「真实粘贴会撞上、而 v0.2.31 撞错了」的那几种
 *
 * 不是重写解析器。每一条都对应一次实测到的错误行为，并且都在**当前代码上**
 * 复现过，不是照着任务书猜的：
 *
 * 1. `第 2 楼` 一个都认不出——`2 楼` 认得出，`第 2 楼` 认不出。同一段话里
 *    两种写法混用（论坛和贴吧常见的真实情况），一半的楼层号丢失。
 * 2. `第 2 楼：乙：…` —— 楼层号后紧跟冒号时，作者变成「第」，剥掉楼层后退回
 *    「匿名」。一条真实发言挂到不存在的人头上。
 * 3. `乙：回复太长了懒得看` —— 整句被当成一个人名，正文变成空。凭空多出一条
 *    指向不存在的人的回复边。
 *
 * 三条都属于同一类错误：**解析器说了一件它没有证据的话**。前两条让作者错位，
 * 第三条让关系凭空出现。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseImport, parseText } from '../lib/import/manual.js'

function commentsOf(source: string) {
  const result = parseText(source)
  assert.ok(result.discussion !== undefined, `应当解析出讨论：${JSON.stringify(result.issues)}`)
  return result.discussion!.comments
}

test('楼层号：`第 2 楼` 与 `2 楼` 在同一段里混用，两种都要认出来', () => {
  const comments = commentsOf(
    ['甲：原帖正文', '---', '第 2 楼 乙：第一条', '3 楼 丙：第二条', '第 4 楼 丁：第三条'].join('\n'),
  )
  assert.equal(comments.length, 3, '三条评论，不能多出匿名发言')
  assert.deepEqual(
    comments.map((c) => [c.author, c.floor]),
    [
      ['乙', 2],
      ['丙', 3],
      ['丁', 4],
    ],
    '每个作者都要对上自己的楼层号',
  )
})

test('楼层号：单独成行的 `第 2 楼` 归属下一条发言，不自己变成一条匿名发言', () => {
  const comments = commentsOf(['甲：原帖', '---', '第 2 楼', '乙：第一条', '第 3 楼', '丙：第二条'].join('\n'))
  assert.equal(comments.length, 2, '两个楼层标签不能各自变成一条空发言')
  assert.deepEqual(comments.map((c) => c.author), ['乙', '丙'])
  assert.deepEqual(comments.map((c) => c.floor), [2, 3])
})

test('楼层号后紧跟冒号时，真正的作者在冒号之后，而不是「第」', () => {
  const comments = commentsOf(['甲：原帖', '---', '第 2 楼：乙：你说得不对'].join('\n'))
  assert.equal(comments.length, 1)
  assert.equal(comments[0]!.author, '乙', '作者是乙，不是楼层标签的头一个字')
  assert.equal(comments[0]!.text, '你说得不对')
  assert.equal(comments[0]!.floor, 2)
})

test('楼层号写在名字后面同样认：`甲 2 楼：…` 与 `甲 第 2 楼：…`', () => {
  const trailing = commentsOf(['甲：原帖', '---', '乙 2 楼：第一句'].join('\n'))
  assert.equal(trailing[0]!.author, '乙')
  assert.equal(trailing[0]!.floor, 2)
  assert.equal(trailing[0]!.text, '第一句')

  const withDi = commentsOf(['甲：原帖', '---', '丙 第 3 楼：第二句'].join('\n'))
  assert.equal(withDi[0]!.author, '丙')
  assert.equal(withDi[0]!.floor, 3)
  assert.equal(withDi[0]!.text, '第二句')
})

test('以「回复」开头的正常句子不能被当成回复标记', () => {
  /**
   * 「回复太长了懒得看」是中文里的日常说法。v0.2.31 把它解析成
   * 「作者乙，正文空，在回复『太长了懒得看』」——正文消失，还多出一条
   * 指向不存在的人的边。判据：正文必须保留原句，且不能凭空产生 replyTo。
   */
  const comments = commentsOf(['甲：原帖', '---', '乙：回复太长了懒得看'].join('\n'))
  assert.equal(comments[0]!.text, '回复太长了懒得看', '整句都要留在正文里')
  assert.equal(comments[0]!.replyTo, undefined, '不能凭空说它在回复「太长了懒得看」')
})

test('真正的回复前缀仍然要认：冒号分隔与空格分隔都算', () => {
  const byColon = commentsOf(['甲：原帖', '---', '乙：回复甲：这段话有问题'].join('\n'))
  assert.equal(byColon[0]!.replyTo, '甲')
  assert.equal(byColon[0]!.text, '这段话有问题')

  const bySpace = commentsOf(['甲：原帖', '---', '乙：回复 甲 你说得不对'].join('\n'))
  assert.equal(bySpace[0]!.replyTo, '甲')
  assert.equal(bySpace[0]!.text, '你说得不对')

  const withAt = commentsOf(['甲：原帖', '---', '乙：回复 @甲：你说得不对'].join('\n'))
  assert.equal(withAt[0]!.replyTo, '甲')
  assert.equal(withAt[0]!.text, '你说得不对')
})

test('只有一个冒号的「回复：…」是正文，不是回复标记', () => {
  const comments = commentsOf(['甲：原帖', '---', '乙：回复：这个说法有问题'].join('\n'))
  assert.equal(comments[0]!.replyTo, undefined, '冒号后面没有名字，不能猜一个人在回复')
  assert.equal(comments[0]!.text, '回复：这个说法有问题')
})

test('多层引用：连续两个 `>>` 只算一层关系，被引用的人名不会被吞进正文', () => {
  const comments = commentsOf(['甲：原帖', '---', '乙：>> 甲：>> 丙：你说得对'].join('\n'))
  assert.equal(comments.length, 1, '多层引用不能裂成多条发言')
  assert.equal(comments[0]!.author, '乙')
  assert.equal(comments[0]!.replyTo, '甲', '最近一层是甲')
})

test('表情与特殊 Unicode 不破坏分块，也不被当成作者名的一部分', () => {
  const comments = commentsOf(['甲：原帖', '---', '乙：😂😂😂 你说得太对了👍', '丙：🤔 我不同意'].join('\n'))
  assert.equal(comments.length, 2)
  assert.equal(comments[0]!.author, '乙')
  assert.equal(comments[0]!.text, '😂😂😂 你说得太对了👍')
  assert.equal(comments[1]!.author, '丙')
  assert.equal(comments[1]!.text, '🤔 我不同意')
})

test('同名不同人：两段同名发言保持为两条，不能被合并成一条', () => {
  const comments = commentsOf(['甲：原帖', '---', '乙：第一条', '乙：第二条'].join('\n'))
  assert.equal(comments.length, 2, '同名不等于同一条')
  assert.deepEqual(comments.map((c) => c.text), ['第一条', '第二条'])
  assert.notEqual(comments[0]!.id, comments[1]!.id, '两条发言的 id 必须不同')
})

test('错误 JSON 说清是格式不对，而不是「没有解析出任何发言」', () => {
  for (const [label, content, expected] of [
    ['语法错误', '{甲: 1,}', 'json_invalid'],
    ['没有 root', '{}', 'json_root'],
    ['顶层是 null', 'null', 'json_shape'],
  ] as const) {
    const result = parseImport({ kind: 'json', content })
    assert.equal(result.discussion, undefined, `${label} 不该产出讨论`)
    const codes = (result.issues ?? []).map((issue) => issue.code)
    assert.ok(codes.includes(expected), `${label} 的错误码应当是 ${expected}，实际是 ${codes.join(',')}`)
    const message = (result.issues ?? [])[0]?.message ?? ''
    assert.ok(message.length > 8, `${label} 必须给出可读的解释`)
  }
})

test('重复导入：同样的文本两次导入，产出逐字段相同的结构（不因次数而漂移）', () => {
  const source = ['甲：原帖正文', '---', '第 2 楼 乙：第一条', '3 楼 丙：回复 乙：第二条'].join('\n')
  const first = parseText(source).discussion
  const second = parseText(source).discussion
  assert.ok(first !== undefined && second !== undefined)
  assert.deepEqual(second!.comments, first!.comments, '同一份输入必须产出同一份结构')
})
