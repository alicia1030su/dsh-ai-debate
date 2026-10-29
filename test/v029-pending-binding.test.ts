/**
 * v0.2.9 §一：待批准列表必须按**完整绑定**判断「这条是不是已经批准过」。
 *
 * ## 缺陷
 *
 * v0.2.8 的 `listPendingApprovals()` 用
 *
 *     `${record.sessionId}\u0000${record.candidateId}`
 *
 * 判断一条候选是否已经有有效批准。那是这条记录的**身份**，不是它的**授权范围**：
 * 它分不清「这段正文被批准了」和「这个 id 在某时刻被批准过」。
 *
 * 后果是双向的，而且两个方向都错：
 *
 *  - 候选重新生成过（正文变了、版本变了），旧批准仍然把这个 id 从列表里隐藏掉，
 *    主人看到一个没有按钮的候选，同时批准路由又拒绝那条记录 —— 页面在说谎。
 *  - 批准记录已消费、已撤销、已过期，同样让候选消失，主人以为「没什么要处理的」。
 *
 * ## 为什么这些测试直接调生产代码
 *
 * `checkApproval()` 是发表路径用的同一个函数。测试如果自己复刻一份比较逻辑，
 * 就只能证明「我又写了一遍」，证明不了列表真的用了它。所以这里的断言是：
 * 给定一条记录，`checkApproval` 判它无效的每一种情况，候选都必须**留在列表里**。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { hashText } from '../lib/security/approvals.js'
import {
  checkApproval,
  APPROVAL_TTL_MS,
  type ApprovalBinding,
  type ApprovalRecord,
} from '../lib/security/approvals.js'

/** The binding for the candidate as it currently exists. */
function currentBinding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    sessionId: 'sess-1',
    candidateId: 'cand-1',
    platform: 'tieba',
    targetPostId: 'n5',
    publishingAccount: '900',
    textHash: hashText('你这条论据没有出处。'),
    candidateVersion: 2,
    assessmentFingerprint: 'fp-current',
    ...overrides,
  }
}

/** A stored approval matching `currentBinding()` at the time it was granted. */
function storedApproval(
  binding: ApprovalBinding = currentBinding(),
  overrides: Partial<ApprovalRecord> = {},
): ApprovalRecord {
  return {
    id: 'ap-1',
    ...binding,
    grantedBy: 'owner',
    grantedAt: new Date().toISOString(),
    ...overrides,
  }
}

/** The rule `listPendingApprovals` now applies: a row is hidden only if this passes. */
function hidesFromList(record: ApprovalRecord, binding: ApprovalBinding, now = Date.now()): boolean {
  return checkApproval(record, binding, () => now).ok
}

test('基线：完全匹配且未消费未过期的批准，会隐藏这条候选', () => {
  // The positive control. Without it, every "must stay listed" assertion below could be
  // satisfied by a rule that never hides anything — which would leave the original
  // "approve the same row repeatedly" bug in place.
  assert.equal(hidesFromList(storedApproval(), currentBinding()), true)
})

test('正文被重新生成：旧批准不得隐藏新候选（v0.2.9）', () => {
  // The candidate was regenerated, so the body the owner once approved is gone. The id
  // is unchanged, which is exactly why an id-only check cannot see this.
  const stale = storedApproval({
    ...currentBinding(),
    textHash: hashText('旧的那一版正文。'),
  })
  assert.equal(hidesFromList(stale, currentBinding()), false, '正文变了，旧批准不该再隐藏候选')
})

test('候选版本号前进：旧批准不得隐藏新候选（v0.2.9）', () => {
  const stale = storedApproval({ ...currentBinding(), candidateVersion: 1 })
  assert.equal(hidesFromList(stale, currentBinding()), false, '版本变了就是另一条东西')
})

test('回复目标被改：旧批准不得隐藏新候选（v0.2.9）', () => {
  const stale = storedApproval({ ...currentBinding(), targetPostId: 'n7' })
  assert.equal(hidesFromList(stale, currentBinding()), false, '批准的是回复另一条发言')
})

test('AI 账号被切换：旧批准不得隐藏新候选（v0.2.9）', () => {
  // Switching the account changes who speaks. An approval granted for account A must
  // not authorise anything under account B — and must not hide the row either, or the
  // owner cannot re-approve for the account that is actually bound now.
  const stale = storedApproval({ ...currentBinding(), publishingAccount: '2002' })
  assert.equal(hidesFromList(stale, currentBinding()), false)
})

test('安全评估发生变化：旧批准不得隐藏新候选（v0.2.9）', () => {
  const stale = storedApproval({ ...currentBinding(), assessmentFingerprint: 'fp-old' })
  assert.equal(hidesFromList(stale, currentBinding()), false)
})

test('平台不一致：旧批准不得隐藏新候选（v0.2.9）', () => {
  const stale = storedApproval({ ...currentBinding(), platform: 'weibo' })
  assert.equal(hidesFromList(stale, currentBinding()), false)
})

test('已消费的批准不得隐藏候选（v0.2.9）', () => {
  // The reply went out under this approval; if the owner regenerates and comes back,
  // the row must be visible again rather than silently suppressed.
  const consumed = storedApproval(currentBinding(), { consumedAt: new Date().toISOString() })
  assert.equal(hidesFromList(consumed, currentBinding()), false)
})

test('已撤销的批准不得隐藏候选（v0.2.9）', () => {
  const revoked = storedApproval(currentBinding(), { revokedAt: new Date().toISOString() })
  assert.equal(hidesFromList(revoked, currentBinding()), false)
})

test('已过期的批准不得隐藏候选（v0.2.9）', () => {
  // TTL is the one dimension an id-only check also happened to filter — but it filtered
  // by "granted within 30 minutes", not by the shared `APPROVAL_TTL_MS`, so the two
  // could drift. This pins them to the same constant.
  const expired = storedApproval(currentBinding(), {
    grantedAt: new Date(Date.now() - APPROVAL_TTL_MS - 1000).toISOString(),
  })
  assert.equal(hidesFromList(expired, currentBinding()), false)
  // And just inside the window it does hide, so the boundary is not "always visible".
  const fresh = storedApproval(currentBinding(), {
    grantedAt: new Date(Date.now() - APPROVAL_TTL_MS + 60_000).toISOString(),
  })
  assert.equal(hidesFromList(fresh, currentBinding()), true)
})

test('批准属于别的候选或会话：不得隐藏（v0.2.9）', () => {
  assert.equal(hidesFromList(storedApproval({ ...currentBinding(), candidateId: 'cand-2' }), currentBinding()), false)
  assert.equal(hidesFromList(storedApproval({ ...currentBinding(), sessionId: 'sess-2' }), currentBinding()), false)
})

test('多条记录里只要有一条真正有效，就必须隐藏（v0.2.9）', () => {
  // The real list iterates history: an old stale record must not *prevent* a newer
  // valid one from being found, and vice versa. This is the shape a `.some()` has and a
  // Set-of-keys lookup did not.
  const records = [
    storedApproval({ ...currentBinding(), textHash: hashText('更早的那一版。') }),
    storedApproval({ ...currentBinding(), grantedAt: new Date(Date.now() - 1000).toISOString() }),
  ]
  const anyAuthorising = records.some((record) => hidesFromList(record, currentBinding()))
  assert.equal(anyAuthorising, true, '有一条能授权就该隐藏，旧记录不该把它压掉')
})

test('全部记录都失效时，列表必须把候选露出来（v0.2.9）', () => {
  const records = [
    storedApproval({ ...currentBinding(), textHash: hashText('旧的 A。') }),
    storedApproval({ ...currentBinding(), candidateVersion: 1 }),
    storedApproval(currentBinding(), { consumedAt: new Date().toISOString() }),
  ]
  assert.equal(records.some((record) => hidesFromList(record, currentBinding())), false)
})
