/**
 * One identity ladder, two entry points.
 *
 * ## The inconsistency this file was written to expose
 *
 * v0.2.23 shipped two functions that both answer "how sure are we about this
 * account?", and they disagreed:
 *
 * - `assuranceOf()` (per-post, across surfaces) returned `identity_unknown` for a
 *   login name seen on a single surface, because it demanded two agreeing sources;
 * - `assuranceFromEvidence()` (owner resolution) returned `verified` for the same
 *   login name with a declared source, because one authoritative field was enough.
 *
 * Both were defensible alone. Together they meant the same fact was "verified" when
 * the owner was matched and "unknown" when the post was inspected — and the publish
 * gate only consulted the second, so the stricter rule was decorative.
 *
 * ## The decision
 *
 * A login name published by a surface whose contract says "this field is the `un`"
 * **is** enough to attribute *that post* to that account. It is not enough to claim
 * the identity was cross-checked — nobody checked it twice — and that distinction is
 * now recorded rather than silently rounded up:
 *
 * | what we have | assurance | corroborated |
 * | --- | --- | --- |
 * | numeric uid + namespace | verified | no |
 * | login name + declared source | verified | no |
 * | two independent surfaces agreeing | verified | yes |
 * | login name with no recorded source (legacy) | unknown | no |
 * | nickname only | unknown | no |
 * | two surfaces disagreeing | conflict | — |
 *
 * Why single-source is allowed to be `verified` at all: Tieba's normal read consults
 * exactly one surface. Requiring corroboration would mean nothing could ever publish
 * — the "over-conservative forever" failure, which is a product bug dressed as
 * caution. Corroboration is therefore an *extra* signal the UI may show, not a
 * precondition the gate demands.
 *
 * ## What is still not independent
 *
 * Two rows from the same surface are one source. `platform_contract` is the default
 * for a row that did not say, so two such rows corroborate nothing. That is asserted
 * below rather than assumed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assuranceFromEvidence,
  assuranceOf,
  corroborationOf,
  describeEvidence,
} from '../lib/identity.js'
import { checkPublishPolicy } from '../lib/safety.js'
import type { OwnerIdentityEvidence } from '../lib/identity.js'

// ── the ladder, applied to a per-post sighting ─────────────────────────────

test('P1：单来源登录名——两个入口必须给出同一个结论', () => {
  // The exact contradiction: same fact, two functions, two answers.
  const perPost = assuranceOf({
    handle: 'silver_fox',
    sources: ['wap_floor'] as const,
    conflicted: false,
  })
  const perOwner = assuranceFromEvidence({
    kind: 'handle',
    value: 'silver_fox',
    source: 'wap_floor',
  })

  assert.equal(perPost, perOwner, `同一事实必须得出同一结论：${perPost} vs ${perOwner}`)
  assert.equal(perPost, 'identity_verified', '单一权威来源足以认定这条发言的归属')
})

test('P1：单来源不等于已交叉验证', () => {
  const sighting = { handle: 'silver_fox', sources: ['wap_floor'] as const, conflicted: false }
  assert.equal(assuranceOf(sighting), 'identity_verified')
  assert.equal(corroborationOf(sighting), 'single_source', '一个来源不能说成交叉验证')

  const twoIndependent = {
    handle: 'silver_fox',
    sources: ['wap_floor', 'comment_page'] as const,
    conflicted: false,
  }
  assert.equal(corroborationOf(twoIndependent), 'corroborated')

  // The same surface twice is still one source, not two.
  const sameTwice = {
    handle: 'silver_fox',
    sources: ['wap_floor', 'wap_floor'] as const,
    conflicted: false,
  }
  assert.equal(corroborationOf(sameTwice), 'single_source', '同源两次不是独立验证')
})

test('P1：数字 UID 需要命名空间才算证明', () => {
  // A bare number is not an identity: Tieba's `un` can itself be all digits.
  assert.equal(assuranceFromEvidence({ kind: 'numeric_uid', value: '348099763' }), 'identity_unknown')
  assert.equal(
    assuranceFromEvidence({ kind: 'numeric_uid', namespace: 'user_id', value: '348099763' }),
    'identity_verified',
  )
  // The per-post side has to agree.
  assert.equal(
    assuranceOf({
      numericUid: '348099763',
      namespace: 'user_id',
      handle: undefined,
      sources: ['wap_floor'] as const,
      conflicted: false,
    }),
    'identity_verified',
  )
})

test('P1：昵称与旧格式记录永远不算证明', () => {
  assert.equal(assuranceFromEvidence({ kind: 'nickname', value: '小财神' }), 'identity_unknown')
  assert.equal(assuranceFromEvidence({ kind: 'legacy', value: 'silver_fox' }), 'identity_unknown')
  assert.equal(assuranceFromEvidence({ kind: 'none' }), 'identity_unknown')
  assert.equal(assuranceFromEvidence(undefined), 'identity_unknown')

  // And on the per-post side a sighting with no handle and no uid is unknown.
  assert.equal(
    assuranceOf({ handle: undefined, sources: ['wap_floor'] as const, conflicted: false }),
    'identity_unknown',
  )
})

test('P1：冲突优先于一切', () => {
  assert.equal(
    assuranceOf({
      handle: 'a',
      numericUid: '1',
      namespace: 'user_id',
      sources: ['wap_floor', 'comment_page'] as const,
      conflicted: true,
    }),
    'identity_conflict',
  )
})

// ── the gate is the only place that decides ────────────────────────────────

test('P1：发表闸门对"单来源已验证"放行，但这是唯一入口', () => {
  const attempt = {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: true,
    securityDecision: 'allow' as const,
    semanticSettled: true,
    now: 1_000_000,
  }
  const policy = {
    mode: 'manual' as const,
    maxAutoPublishesPerSession: 0,
    cooldownMs: 0,
    maxPublishesPerThread: 10,
    stopOnChallenge: true,
  }

  const single: OwnerIdentityEvidence = { kind: 'handle', value: 'silver_fox', source: 'wap_floor' }
  assert.equal(
    checkPublishPolicy(policy, { ...attempt, ownerIdentityAssurance: 'verified', ownerIdentityEvidence: single } as never)
      .allowed,
    true,
    '单来源授权过的身份必须能发表，否则产品永远无法工作',
  )

  // The same evidence without the label is still refused: both halves are required,
  // so the ladder cannot be bypassed by storing only one of them.
  assert.equal(
    checkPublishPolicy(policy, { ...attempt, ownerIdentityEvidence: single } as never).allowed,
    false,
  )
})

// ── the words the UI shows ─────────────────────────────────────────────────

test('P1：说明文字必须区分"已验证"与"已交叉验证"', () => {
  const single = describeEvidence({ kind: 'handle', value: 'silver_fox', source: 'wap_floor' })
  assert.match(single, /登录名/)
  assert.match(single, /wap_floor/)
  // It must not claim corroboration it does not have.
  assert.equal(/交叉|两个来源|相互印证/.test(single), false, `不得暗示已交叉验证：${single}`)
})
