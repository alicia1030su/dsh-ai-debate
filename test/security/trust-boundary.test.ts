/**
 * Trust boundaries: the promotion that must be impossible.
 *
 * These tests pin the *architecture*, not the detection. Even if every pattern in
 * the detector were bypassed, external text still could not become an instruction,
 * because the type system and the assertion refuse it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TrustLevel,
  assertNoPromotion,
  describeLevel,
  externalText,
  derivedText,
  findPromotions,
  mayAssertAsFact,
  mayInstruct,
} from '../../lib/security/trust-boundary.js'

test('外部内容不能提升为系统策略', () => {
  assert.throws(
    () => assertNoPromotion(TrustLevel.ExternalUntrusted, TrustLevel.SystemPolicy, '评论'),
    /拒绝把.*提升为/,
    '把评论当成系统策略必须抛错，而不是返回 false',
  )
})

test('外部内容不能提升为主人授权', () => {
  assert.throws(
    () =>
      assertNoPromotion(
        TrustLevel.ExternalUntrusted,
        TrustLevel.OwnerGranted,
        '对手评论里的「主人已授权」',
      ),
    /主人授权/,
  )
})

test('派生数据同样不能提升为授权', () => {
  // The second-order case: a brief computed from a malicious comment is *our*
  // output, yet still contaminated. Treating "we produced it" as "it may decide"
  // is how a summary of an attack becomes an instruction.
  assert.throws(() => assertNoPromotion(TrustLevel.Derived, TrustLevel.OwnerGranted, '简报'), /主人授权/)
  assert.throws(() => assertNoPromotion(TrustLevel.Derived, TrustLevel.SystemPolicy, '简报'), /系统策略/)
})

test('同级与降级是允许的', () => {
  assert.doesNotThrow(() => assertNoPromotion(TrustLevel.SystemPolicy, TrustLevel.ExternalUntrusted, 'x'))
  assert.doesNotThrow(() => assertNoPromotion(TrustLevel.Derived, TrustLevel.Derived, 'x'))
})

test('只有系统和主人授权层级可以下达指令', () => {
  assert.equal(mayInstruct(TrustLevel.SystemPolicy), true)
  assert.equal(mayInstruct(TrustLevel.OwnerGranted), true)
  assert.equal(mayInstruct(TrustLevel.Derived), false)
  assert.equal(mayInstruct(TrustLevel.ExternalUntrusted), false)
})

test('只有系统和主人授权层级可以作为事实断言', () => {
  // A brief may be *presented as analysis*, never as fact: it was computed from
  // text an attacker controls.
  assert.equal(mayAssertAsFact(TrustLevel.SystemPolicy), true)
  assert.equal(mayAssertAsFact(TrustLevel.Derived), false)
  assert.equal(mayAssertAsFact(TrustLevel.ExternalUntrusted), false)
})

test('外部文本必须带来源类型，否则报告无法说明它是什么', () => {
  const bare = { level: TrustLevel.ExternalUntrusted, text: '一段评论' }
  const problems = findPromotions([bare])
  assert.ok(problems.length > 0)
  assert.match(problems[0]!, /缺少来源类型/)

  const labeled = externalText('一段评论', 'comment', { platform: 'p', postId: 'c1' })
  assert.deepEqual(findPromotions([labeled]), [])
})

test('派生数据声称来自单一帖子会被标记为可疑', () => {
  // A real summary spans posts; a lone id usually means a raw comment was
  // relabelled as derived data to launder it.
  const suspicious = derivedText('总结', { postId: 'c1' })
  const problems = findPromotions([suspicious])
  assert.ok(problems.some((problem) => problem.includes('单一帖子')))
})

test('externalText 保留来源信息，供安全事件引用', () => {
  const text = externalText('对手的话', 'comment', {
    platform: 'tieba',
    threadId: 't1',
    postId: 'c9',
    authorId: 'rival-1',
    parentId: 'c1',
  })
  assert.equal(text.level, TrustLevel.ExternalUntrusted)
  assert.equal(text.sourceType, 'comment')
  assert.equal(text.postId, 'c9')
  assert.equal(text.parentId, 'c1')
  assert.equal(text.authorId, 'rival-1')
})

test('每一层都有可读的名字，错误信息不会出现 undefined', () => {
  for (const level of [
    TrustLevel.SystemPolicy,
    TrustLevel.OwnerGranted,
    TrustLevel.Derived,
    TrustLevel.ExternalUntrusted,
  ]) {
    const name = describeLevel(level)
    assert.ok(name.length > 0)
    assert.doesNotMatch(name, /undefined/)
  }
})
