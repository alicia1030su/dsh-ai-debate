/**
 * What "two sources agree" is allowed to mean.
 *
 * ## The two defects this file nails down
 *
 * **1. Counting entries instead of sources.** `corroborationOf` compared
 * `handleEchoes >= 2` where the echoes were *observation rows*. One surface can
 * emit several rows for the same post id (the collector records every sighting), so
 * a single source answering twice, plus a second source that only knew a nickname,
 * satisfied the check — and the product claimed cross-verification it never had.
 *
 * **2. Treating incomparable as conflict.** `user_id: 12345` and `tieba_uid: 12345`
 * are two unrelated namespaces. The digits match by coincidence. The old code built
 * a namespace-tagged set, saw two members, and returned `contested` — accusing two
 * accounts of being different people on the strength of a comparison that never
 * happened. Neither `contested` nor `corroborated` is honest there; the answer is
 * "not comparable", with the reason stated.
 *
 * ## The rule now
 *
 * - `corroborated`: two *distinct* sources each supplied the same comparable
 *   identifier (same handle, or same uid within the same namespace).
 * - `contested`: two distinct sources each supplied a *comparable* identifier and
 *   they differ — same namespace, different value, or different handles.
 * - `incomparable`: identifiers exist but no two of them can be compared. Nothing
 *   is inferred from a coincidence of digits.
 * - `single_source`: one source, or two sources with nothing comparable between
 *   them (a nickname does not participate in identity corroboration at all).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { corroborationOf, corroborationReason } from '../lib/identity.js'
import type { IdentityObservation, IdentitySightings } from '../lib/identity.js'

function sightings(parts: Partial<IdentitySightings>): IdentitySightings {
  return { sources: ['wap_floor'], conflicted: false, ...parts } as IdentitySightings
}

const h = (source: string, value: string): IdentityObservation =>
  ({ source, handle: value }) as IdentityObservation
const u = (
  source: string,
  value: string,
  namespace: 'user_id' | 'tieba_uid',
): IdentityObservation => ({ source, numericUid: value, namespace }) as IdentityObservation
const nameOnly = (source: string): IdentityObservation => ({ source }) as IdentityObservation

// ── task 1: a repeated row is not a second source ─────────────────────────

test('T1 复现：同一来源给两条相同观测 + 另一来源只有昵称 → 不得 corroborated', () => {
  // The exact false positive. `wap_floor` answered twice (two rows for one post id),
  // `comment_page` knew only the nickname. Old code counted three handle echoes and
  // called it cross-verified.
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor', 'comment_page'],
      observations: [
        h('wap_floor', 'silver_fox'),
        h('wap_floor', 'silver_fox'),
        nameOnly('comment_page'),
      ],
    }),
  )
  assert.notEqual(result, 'corroborated', '一个来源重复给两条数据，不是两个来源印证')
  assert.equal(result, 'single_source')
})

test('T1：同一来源两条相同观测、没有其他来源 → single_source', () => {
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor'],
      observations: [h('wap_floor', 'silver_fox'), h('wap_floor', 'silver_fox')],
    }),
  )
  assert.equal(result, 'single_source')
})

test('T1：两个真实来源给同一个登录名 → corroborated', () => {
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor', 'comment_page'],
      observations: [h('wap_floor', 'silver_fox'), h('comment_page', 'silver_fox')],
    }),
  )
  assert.equal(result, 'corroborated')
})

test('T1：两个来源，第二个只有昵称 → 不参与印证', () => {
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor', 'comment_page'],
      observations: [h('wap_floor', 'silver_fox'), nameOnly('comment_page')],
    }),
  )
  assert.equal(result, 'single_source', '昵称不是可比标识，不能充当第二个来源的证据')
})

test('T1：两个来源仅声明存在、无观测数据 → 保持未交叉验证', () => {
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor', 'comment_page'],
    }),
  )
  assert.equal(result, 'single_source', '来源清单不是比对记录')
})

test('T1：只有明确冲突才返回 contested', () => {
  assert.equal(
    corroborationOf(
      sightings({
        handle: 'a',
        sources: ['wap_floor', 'comment_page'],
        observations: [h('wap_floor', 'a'), h('comment_page', 'b')],
      }),
    ),
    'contested',
    '同命名空间的两个不同登录名是明确冲突',
  )
  // …but "different" here must be a real comparison, not a namespace coincidence.
  assert.equal(
    corroborationOf(
      sightings({
        sources: ['wap_floor', 'comment_page'],
        observations: [u('comment_page', '12345', 'user_id'), u('total_comment', '99999', 'user_id')],
      }),
    ),
    'contested',
    '同命名空间内两个不同数字才是冲突',
  )
})

// ── task 2: different namespaces are not a conflict ───────────────────────

test('T2 复现：user_id=12345 与 tieba_uid=12345 → 无法比较，不是冲突', () => {
  const result = corroborationOf(
    sightings({
      sources: ['comment_page', 'total_comment'],
      observations: [u('comment_page', '12345', 'user_id'), u('total_comment', '12345', 'tieba_uid')],
    }),
  )
  assert.notEqual(result, 'contested', '数字相同、命名空间不同，无从比较，不能判为冲突')
  assert.notEqual(result, 'corroborated', '也不能因为数字相同就判为印证')
  assert.equal(result, 'incomparable')
})

test('T2：同命名空间、相同值 → corroborated', () => {
  assert.equal(
    corroborationOf(
      sightings({
        sources: ['comment_page', 'total_comment'],
        observations: [
          u('comment_page', '12345', 'user_id'),
          u('total_comment', '12345', 'user_id'),
        ],
      }),
    ),
    'corroborated',
  )
})

test('T2：同命名空间、不同值 → contested', () => {
  assert.equal(
    corroborationOf(
      sightings({
        sources: ['comment_page', 'total_comment'],
        observations: [
          u('comment_page', '12345', 'user_id'),
          u('total_comment', '99999', 'user_id'),
        ],
      }),
    ),
    'contested',
  )
})

test('T2：UID 与登录名 → 无法比较', () => {
  const result = corroborationOf(
    sightings({
      sources: ['comment_page', 'wap_floor'],
      observations: [u('comment_page', '12345', 'user_id'), h('wap_floor', 'silver_fox')],
    }),
  )
  assert.equal(result, 'incomparable', '数字与登录名是两类标识，既不印证也不冲突')
})

test('T2：无法比较时必须给出原因', () => {
  // A status with no explanation is only marginally better than a wrong one. The
  // helper exists so the caller can say *why* nothing was cross-checked.
  const reason = corroborationReason({
    sources: ['comment_page', 'total_comment'],
    conflicted: false,
    observations: [u('comment_page', '12345', 'user_id'), u('total_comment', '12345', 'tieba_uid')],
  } as IdentitySightings)
  assert.equal(reason.code, 'namespace_mismatch')
  assert.match(reason.detail, /命名空间|namespace/)
})

// ── the shape of the answer ───────────────────────────────────────────────

test('一个新状态，而不是两个状态的伪装', () => {
  // `incomparable` must be its own value: folding it into `single_source` would hide
  // that two sources *did* speak, and folding it into `contested` would accuse an
  // account of being someone else.
  const result = corroborationOf(
    sightings({
      sources: ['comment_page', 'total_comment'],
      observations: [u('comment_page', '1', 'user_id'), u('total_comment', '1', 'tieba_uid')],
    }),
  )
  assert.equal(result, 'incomparable')
})
