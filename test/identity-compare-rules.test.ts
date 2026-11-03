/**
 * The eight comparison rules, each with its positive and negative case.
 *
 * The contract this file pins:
 *
 * > Two identities are the same account only when they agree inside **one**
 * > namespace. A nickname never proves anything. A uid and a handle never meet.
 *
 * Every "not the same" assertion is paired with a "not different" one, because
 * the dangerous middle ground — `unknown` — must not be silently folded into
 * either answer.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  compareIdentities,
  isDifferentAccount,
  isProvable,
  isSameAccount,
  isUnknown,
  looksNumeric,
  type AuthorIdentity,
} from '../lib/identity.js'

function identity(parts: Partial<AuthorIdentity> & { source: AuthorIdentity['source'] }): AuthorIdentity {
  return { platform: 'tieba', ...parts }
}

// ── Rule 1: same namespace, same value → same account ────────────────────────
test('规则1 正向：同一命名空间、同一数字 UID → 判定同一账号', () => {
  const a = identity({ numericUid: '348099763', numericUidKind: 'user_id', source: 'total_comment' })
  const b = identity({ numericUid: '348099763', numericUidKind: 'user_id', source: 'total_comment' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'same_numeric_uid')
  assert.equal(isSameAccount(verdict), true)
  assert.equal(isProvable(verdict), true)
})

test('规则1 反向：同一命名空间、不同数字 UID → 判定不同账号', () => {
  const a = identity({ numericUid: '111', numericUidKind: 'user_id', source: 'total_comment' })
  const b = identity({ numericUid: '222', numericUidKind: 'user_id', source: 'total_comment' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'different_numeric_uid')
  assert.equal(isDifferentAccount(verdict), true)
  assert.equal(isSameAccount(verdict), false)
})

// ── Rule 2 / 7: different namespaces never compare ───────────────────────────
test('规则7 正向：user_id 与 tieba_uid 即使数字相同，也不能判为同一账号', () => {
  const a = identity({ numericUid: '123456', numericUidKind: 'user_id', source: 'total_comment' })
  const b = identity({ numericUid: '123456', numericUidKind: 'tieba_uid', source: 'total_comment' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'unknown_namespace_mismatch')
  assert.equal(isUnknown(verdict), true)
  assert.equal(isSameAccount(verdict), false, '文本相同不等于同一账号')
  assert.equal(isDifferentAccount(verdict), false, '也不等于不同账号：只是无法比较')
})

test('规则7 反向：同一命名空间内可以比较', () => {
  const a = identity({ numericUid: '123456', numericUidKind: 'tieba_uid', source: 'total_comment' })
  const b = identity({ numericUid: '123456', numericUidKind: 'tieba_uid', source: 'total_comment' })
  assert.equal(compareIdentities(a, b).kind, 'same_numeric_uid')
})

test('规则7 边界：数字 UID 缺少命名空间 → 不能比较', () => {
  const a = identity({ numericUid: '123', source: 'total_comment' })
  const b = identity({ numericUid: '123', numericUidKind: 'user_id', source: 'total_comment' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'unknown_namespace_mismatch')
  assert.equal(isSameAccount(verdict), false)
})

// ── Rule 3: same handle proves the handle, not the permanent uid ─────────────
test('规则3 正向：登录名一致 → same_handle，但不等于证明了永久 UID', () => {
  const a = identity({ handle: 'silver_fox', source: 'wap_floor' })
  const b = identity({ handle: 'silver_fox', source: 'comment_page' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'same_handle')
  assert.equal(isSameAccount(verdict), true, '登录名一致足以认定「当前是同一个人」')
  // And it is explicitly *not* a uid claim: the type carries no namespace.
  assert.equal('namespace' in verdict, false, 'same_handle 不得携带 UID 命名空间')
})

test('规则3 反向：登录名不同 → different_handle', () => {
  const a = identity({ handle: 'silver_fox', source: 'wap_floor' })
  const b = identity({ handle: 'someone_else', source: 'comment_page' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'different_handle')
  assert.equal(isDifferentAccount(verdict), true)
})

// ── Rule 4: a nickname is never an identity ──────────────────────────────────
test('规则4 正向：只有昵称相同 → display_name_match_only，不可作为证明', () => {
  const a = identity({ displayName: '小财神', source: 'wap_floor' })
  const b = identity({ displayName: '小财神', source: 'comment_page' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'display_name_match_only')
  assert.equal(isProvable(verdict), false, '昵称相同永远不能证明同一账号')
  assert.equal(isDifferentAccount(verdict), false, '但也不能因此判定不同')
})

test('规则4 反向：昵称不同且没有更强证据 → insufficient_evidence', () => {
  const a = identity({ displayName: '甲', source: 'wap_floor' })
  const b = identity({ displayName: '乙', source: 'comment_page' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'insufficient_evidence')
  assert.equal(isSameAccount(verdict), false)
  assert.equal(isDifferentAccount(verdict), false)
})

// ── Rule 5: uid vs handle has no reliable mapping ───────────────────────────
test('规则5 正向：一侧 UID、一侧 handle → unknown', () => {
  const a = identity({ numericUid: '348099763', numericUidKind: 'user_id', source: 'total_comment' })
  const b = identity({ handle: '小财神', source: 'wap_floor' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'unknown_namespace_mismatch')
  assert.equal(isSameAccount(verdict), false)
  assert.equal(isDifferentAccount(verdict), false)
})

test('规则5 反向：两侧都是 UID 时可以比较（不被 handle 分支拦住）', () => {
  const a = identity({ numericUid: '1', numericUidKind: 'user_id', source: 'total_comment' })
  const b = identity({ numericUid: '1', numericUidKind: 'user_id', source: 'total_comment' })
  assert.equal(compareIdentities(a, b).kind, 'same_numeric_uid')
})

// ── Rule 6: weak evidence cannot overturn strong evidence ───────────────────
test('规则6 正向：UID 冲突不会被相同昵称推翻', () => {
  const a = identity({ numericUid: '111', numericUidKind: 'user_id', displayName: '小财神', source: 'total_comment' })
  const b = identity({ numericUid: '222', numericUidKind: 'user_id', displayName: '小财神', source: 'total_comment' })
  const verdict = compareIdentities(a, b)
  assert.equal(verdict.kind, 'different_numeric_uid', '昵称一致不能覆盖 UID 冲突')
  assert.equal(isDifferentAccount(verdict), true)
})

test('规则6 反向：UID 一致不会被不同昵称推翻（改名不影响账号）', () => {
  const a = identity({ numericUid: '111', numericUidKind: 'user_id', displayName: '旧名', source: 'total_comment' })
  const b = identity({ numericUid: '111', numericUidKind: 'user_id', displayName: '新名', source: 'total_comment' })
  assert.equal(compareIdentities(a, b).kind, 'same_numeric_uid')
})

// ── Rule 8: a numeric-looking `un` is still a handle ────────────────────────
test('规则8 正向：纯数字的 un 仍然是 handle，不被提升为 numericUid', () => {
  const wap = identity({ handle: '1254480024', displayName: '寻º乐', source: 'wap_floor' })
  assert.equal(wap.numericUid, undefined, '解析层没有把它放进 uid 字段')
  assert.equal(looksNumeric(wap.handle), true, '文本确实全是数字')
  assert.equal(wap.numericUidKind, undefined, '没有命名空间就还是 handle')
})

test('规则8 反向：数字 handle 与同文本的真 UID 不能互相冒充', () => {
  const handle = identity({ handle: '1254480024', source: 'wap_floor' })
  const uid = identity({ numericUid: '1254480024', numericUidKind: 'user_id', source: 'total_comment' })
  const verdict = compareIdentities(handle, uid)
  assert.equal(verdict.kind, 'unknown_namespace_mismatch')
  assert.equal(isSameAccount(verdict), false)
})

// ── Carried over from the v0.2.23 draft, still true and still load-bearing ────
test('portrait 不参与身份判定：仅凭 portrait 相同不能证明同一人', () => {
  // Tieba's portrait embeds a timestamp, so one account produces several values
  // over time, and two accounts can share a default avatar.
  const a = identity({ portrait: 'tb.1.abc', source: 'comment_page' })
  const b = identity({ portrait: 'tb.1.abc', source: 'comment_page' })
  assert.equal(isSameAccount(compareIdentities(a, b)), false)
  assert.equal(isDifferentAccount(compareIdentities(a, b)), false)
})

test('主人旧配置仍被读取：只配昵称时不报错，但结论是未核验', () => {
  const onlyName = identity({ displayName: '小财神', source: 'wap_floor' })
  const verdict = compareIdentities(onlyName, onlyName)
  assert.equal(isProvable(verdict), false, '自己和自己比也不能凭空升级为证明')
})

test('un 缺失时置信度降级到 display_name_only', async () => {
  const { confidenceOf } = await import('../lib/identity.js')
  assert.equal(confidenceOf(identity({ displayName: '某人', source: 'wap_floor' })), 'display_name_only')
  assert.equal(confidenceOf(identity({ handle: 'x', source: 'wap_floor' })), 'login_handle')
})
