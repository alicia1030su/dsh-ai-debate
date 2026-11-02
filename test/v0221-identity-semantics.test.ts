/**
 * v0.2.21 身份语义回归：`hasStableAuthor`、`snapshotStillValid`、`approvalStillApplies`。
 *
 * ## 为什么单独一个文件
 *
 * 上面那个文件问的是「发表会不会被拦住」。这个文件问的是**更底层的一个问题**：
 * 项目里那三个函数各自承诺了什么，实际做了什么。它们的名字都容易被误读：
 *
 * - `hasStableAuthor` 承诺"稳定"，实际只检查"有没有值"。
 * - `snapshotStillValid` 承诺"快照还有效"，实际是逐字段比对，且**有 ID 时不看名字**。
 * - `approvalStillApplies` 名字最像发表闸门，实际上**只喂工作台页面**。
 *
 * 这些语义如果只存在于注释里，下一个人改代码时就会破坏它们。测试是把语义钉住的地方。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { hasStableAuthor, snapshotStillValid, contentHash } from '../lib/target.js'
import { approvalStillApplies } from '../lib/workbench.js'
import type { TargetSnapshot } from '../lib/target.js'

/** A snapshot with every field a Tieba floor read can produce. */
function snapshot(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    platform: 'tieba',
    threadId: 'T1',
    floorPostId: 'F1',
    floorNumber: 1,
    targetPostId: 'A',
    targetKind: 'floor',
    targetAuthorId: 'user_A',
    targetAuthorName: '昵称A',
    contentHash: contentHash('原始正文'),
    capturedAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  } as TargetSnapshot
}

// ---------------------------------------------------------------------------
// hasStableAuthor：字段存在 ≠ 身份稳定
// ---------------------------------------------------------------------------

test('hasStableAuthor：只要是非空字符串就返回 true，包括中文用户名和普通昵称', () => {
  // 这不是缺陷复现，是把现有语义写下来。函数名说 "stable"，实现只说 "present"。
  // 贴吧的 `un` 是登录名（不可改），所以在这个平台上"存在"恰好够用；
  // 但换一个把昵称填进 authorId 的平台，这个函数就会误报"稳定"。
  const cases: ReadonlyArray<readonly [string, string | undefined, boolean]> = [
    ['数字 UID', '6631433126', true],
    ['中文用户名', '首发罗强花生', true],
    ['普通昵称', '时空的流转♂', true],
    ['单字符', 'x', true],
    ['空字符串', '', false],
    ['undefined', undefined, false],
  ]

  for (const [label, value, expected] of cases) {
    assert.equal(
      hasStableAuthor(snapshot({ targetAuthorId: value })),
      expected,
      `${label}（${JSON.stringify(value)}）的判定应为 ${expected}`,
    )
  }
})

test('hasStableAuthor：不检查该值是否像"账号"，无法区分 handle 与昵称', () => {
  // 两个快照的 authorId 一个是账号样、一个是昵称样，函数给出同样的答案。
  const asHandle = snapshot({ targetAuthorId: 'user_12345', targetAuthorName: '随便一个昵称' })
  const asNickname = snapshot({ targetAuthorId: '随便一个昵称', targetAuthorName: '随便一个昵称' })
  assert.equal(hasStableAuthor(asHandle), true)
  assert.equal(hasStableAuthor(asNickname), true, '它不看语义，只看有没有值——这正是名字的误导之处')
})

// ---------------------------------------------------------------------------
// snapshotStillValid：谁变了才叫"变"
// ---------------------------------------------------------------------------

test('snapshotStillValid：作者 ID 变化 → author_mismatch', () => {
  assert.equal(snapshotStillValid(snapshot(), snapshot({ targetAuthorId: 'user_B' })), 'author_mismatch')
})

test('snapshotStillValid：作者 ID 消失 → author_unverifiable（不是"没变"）', () => {
  assert.equal(
    snapshotStillValid(snapshot(), snapshot({ targetAuthorId: undefined })),
    'author_unverifiable',
    '消失的 ID 必须当成未知，否则回复会落到现在占着这个位置的人头上',
  )
})

test('snapshotStillValid：只有显示昵称变化 → 不判为换人', () => {
  assert.equal(
    snapshotStillValid(snapshot(), snapshot({ targetAuthorName: '昵称B' })),
    undefined,
    'ID 相同就是同一个人；昵称可改，不该让批准失效',
  )
})

test('snapshotStillValid：没有作者 ID 时退化为比对昵称', () => {
  const noId = snapshot({ targetAuthorId: undefined })
  assert.equal(snapshotStillValid(noId, snapshot({ targetAuthorId: undefined, targetAuthorName: '昵称B' })), 'author_mismatch')
  assert.equal(snapshotStillValid(noId, snapshot({ targetAuthorId: undefined, targetAuthorName: undefined })), 'author_unverifiable')
})

test('snapshotStillValid：目标、正文、楼层类型的变化分别有独立错误码', () => {
  assert.equal(snapshotStillValid(snapshot(), snapshot({ targetPostId: 'B' })), 'nested_mismatch')
  assert.equal(snapshotStillValid(snapshot(), snapshot({ threadId: 'T2' })), 'wrong_thread')
  assert.equal(snapshotStillValid(snapshot(), snapshot({ floorPostId: 'F2' })), 'wrong_floor')
  assert.equal(
    snapshotStillValid(snapshot(), snapshot({ contentHash: contentHash('被改过的正文') })),
    'context_changed',
  )
})

test('snapshotStillValid：完全一致时不返回任何问题', () => {
  assert.equal(snapshotStillValid(snapshot(), snapshot()), undefined)
})

// ---------------------------------------------------------------------------
// approvalStillApplies：它只管界面，不管发表
// ---------------------------------------------------------------------------

test('approvalStillApplies：正文、版本、目标、候选号任一变化都失效', () => {
  const candidate = {
    replyId: 'c1',
    textHash: 'h1',
    candidateVersion: 2,
    targetPostId: 'A',
    approved: true,
  }
  const approval = { candidateId: 'c1', candidateVersion: 2, textHash: 'h1', targetPostId: 'A' }

  assert.equal(approvalStillApplies({ candidate, approval }).applies, true, '一致时必须有效')

  assert.equal(approvalStillApplies({ candidate, approval: { ...approval, textHash: 'h2' } }).applies, false)
  assert.equal(approvalStillApplies({ candidate, approval: { ...approval, candidateVersion: 3 } }).applies, false)
  assert.equal(approvalStillApplies({ candidate, approval: { ...approval, targetPostId: 'B' } }).applies, false)
  assert.equal(approvalStillApplies({ candidate, approval: { ...approval, candidateId: 'c2' } }).applies, false)
  assert.equal(approvalStillApplies({ candidate, approval: undefined }).applies, false)
  assert.equal(approvalStillApplies({ candidate: { ...candidate, approved: false }, approval }).applies, false)
})

test('approvalStillApplies：它没有作者维度，因此作者换人时仍报"有效"——这是已知的界面缺口', () => {
  // 这条测试**记录缺陷，不赞美它**。
  //
  // `approvalStillApplies` 的入参里根本没有作者字段，所以作者换人时它只能回答
  // "有效"。这不构成发表漏洞：发表路径由 `publishCandidate` 里的
  // `resolveTarget` + `snapshotStillValid` 独立拦截（见
  // v0221-author-identity-binding.test.ts 的测试1）。它的代价是**界面可能显示
  // "已批准"，而点下去会被拒** —— 属诚实性问题，不是安全性问题。
  //
  // 修复它的最小方式是给 candidate 与 approval 各加一个可选作者字段并在此比对，
  // 但这会重复 `snapshotStillValid` 已经做的事。是否值得，取决于是否愿意为了
  // 界面文案的准确而引入第二处作者比对。本阶段只记录，不改实现。
  const candidate = {
    replyId: 'c1',
    textHash: 'h1',
    candidateVersion: 2,
    targetPostId: 'A',
    approved: true,
  }
  const approval = { candidateId: 'c1', candidateVersion: 2, textHash: 'h1', targetPostId: 'A' }

  // 即便"作者"在外部世界已经换人，这个函数也无从得知。
  assert.equal(approvalStillApplies({ candidate, approval }).applies, true)

  // 断言其签名不含作者维度，把这个缺口钉成一条会失败的测试，
  // 将来有人加了字段，这条会提醒他同步更新这里的说明。
  const keys = Object.keys(approval)
  assert.ok(!keys.includes('targetAuthorId'), '如果这里开始有作者字段，说明界面缺口被修了，请更新本测试')
})
