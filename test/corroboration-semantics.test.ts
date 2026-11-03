/**
 * "Corroborated" must mean two sources agreed, not that two sources exist.
 *
 * ## What was wrong
 *
 * `corroborationOf` returned `corroborated` whenever `sources.size >= 2` and *some*
 * identifier was present. It never looked at whether the sources agreed, and it
 * ignored `conflicted` entirely — so two surfaces that contradicted each other
 * counted as mutual confirmation. It also had **no production call site**, which
 * meant the "cross-verified" claim was neither shown nor checked anywhere.
 *
 * ## The structural fix
 *
 * A count cannot prove agreement. `IdentitySightings` carried one merged
 * `numericUid`/`handle` plus a list of source names, which is not enough to say
 * *what each source said*. It now optionally carries per-source `observations`,
 * and corroboration is computed by comparing them:
 *
 * | situation | verdict |
 * | --- | --- |
 * | two sources, same handle | corroborated |
 * | two sources, same uid + namespace | corroborated |
 * | two sources, different handles | contested |
 * | two sources, uid vs handle (not comparable) | single_source |
 * | two sources, both nickname-only | single_source |
 * | one source, two rows | single_source |
 * | sources disagree (`conflicted`) | contested |
 * | two sources, no observations recorded | single_source |
 *
 * The last row is the important one: "I have two source names but never compared
 * them" is not corroboration. The function refuses to upgrade a count into a claim.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { corroborationOf } from '../lib/identity.js'
import type { IdentityObservation, IdentitySightings } from '../lib/identity.js'

function sightings(parts: Partial<IdentitySightings> & { observations?: readonly IdentityObservation[] }): IdentitySightings {
  return {
    sources: ['wap_floor'],
    conflicted: false,
    ...parts,
  } as IdentitySightings
}

const handleObs = (source: string, value: string): IdentityObservation =>
  ({ source, handle: value }) as IdentityObservation
const uidObs = (source: string, value: string, namespace: 'user_id' | 'tieba_uid'): IdentityObservation =>
  ({ source, numericUid: value, namespace }) as IdentityObservation
const nameOnly = (source: string): IdentityObservation => ({ source }) as IdentityObservation

// ── genuine agreement ─────────────────────────────────────────────────────

test('两个来源，同一账号，登录名一致 → corroborated', () => {
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor', 'comment_page'],
      observations: [handleObs('wap_floor', 'silver_fox'), handleObs('comment_page', 'silver_fox')],
    }),
  )
  assert.equal(result, 'corroborated')
})

test('两个来源，同一数字 UID 与命名空间 → corroborated', () => {
  const result = corroborationOf(
    sightings({
      numericUid: '12345',
      // `comment_page` and `total_comment` are the two real surfaces that can state a
      // numeric uid; the namespace is a separate axis, not a source name.
      sources: ['comment_page', 'total_comment'],
      observations: [
        uidObs('comment_page', '12345', 'user_id'),
        uidObs('total_comment', '12345', 'user_id'),
      ],
    }),
  )
  assert.equal(result, 'corroborated')
})

// ── disagreement is not corroboration ─────────────────────────────────────

test('两个来源，明确不同账号 → contested', () => {
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor', 'comment_page'],
      // The caller already knows they disagree.
      conflicted: true,
      observations: [handleObs('wap_floor', 'silver_fox'), handleObs('comment_page', 'someone_else')],
    }),
  )
  assert.equal(result, 'contested', '互相矛盾的来源不能算作相互印证')
})

test('两个来源，观测值不同但调用方没标 conflicted → 仍然 contested', () => {
  // Defence in depth: the comparison itself catches it, so a caller that forgot to set
  // `conflicted` cannot turn a contradiction into confirmation.
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor', 'comment_page'],
      observations: [handleObs('wap_floor', 'silver_fox'), handleObs('comment_page', 'attacker_b')],
    }),
  )
  assert.equal(result, 'contested')
})

test('sightings.conflicted=true → contested，无论观测如何', () => {
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor', 'comment_page'],
      conflicted: true,
      observations: [handleObs('wap_floor', 'silver_fox'), handleObs('comment_page', 'silver_fox')],
    }),
  )
  assert.equal(result, 'contested', '冲突标记优先，因为调用方看到了本次比较之外的东西')
})

// ── not comparable is not agreement ───────────────────────────────────────

test('两个来源，一个是 UID 一个是登录名 → incomparable', () => {
  // v0.2.23 patch 6 gave "not comparable" its own verdict. Reporting it as
  // `single_source` understated it: two surfaces did speak, they just had no common
  // field — and that difference matters to whoever has to decide what to do next.
  const result = corroborationOf(
    sightings({
      sources: ['wap_floor', 'comment_page'],
      observations: [uidObs('comment_page', '12345', 'user_id'), handleObs('wap_floor', 'silver_fox')],
    }),
  )
  assert.equal(result, 'incomparable', '没有共同字段：既不印证，也不冲突')
})

test('两个来源，都只有同一个昵称 → single_source', () => {
  const result = corroborationOf(
    sightings({
      sources: ['wap_floor', 'comment_page'],
      observations: [nameOnly('wap_floor'), nameOnly('comment_page')],
    }),
  )
  assert.equal(result, 'single_source', '昵称不是账号标识，印证不了身份')
})

test('一个来源重复给出两条数据 → single_source', () => {
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor'],
      observations: [handleObs('wap_floor', 'silver_fox'), handleObs('wap_floor', 'silver_fox')],
    }),
  )
  assert.equal(result, 'single_source', '同源两次不是独立验证')
})

test('来源数量为二，但没有记录观测 → single_source', () => {
  // The old implementation returned `corroborated` here. It had two names and no
  // comparison, which is exactly the "a count substituted for a comparison" failure.
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor', 'comment_page'],
    }),
  )
  assert.equal(result, 'single_source', '没有比对记录就不能声称印证')
})

test('没有账号标识的两个来源 → single_source', () => {
  const result = corroborationOf(
    sightings({
      sources: ['wap_floor', 'comment_page'],
      observations: [nameOnly('wap_floor'), nameOnly('comment_page')],
    }),
  )
  assert.equal(result, 'single_source')
})

test('单一来源 → single_source', () => {
  const result = corroborationOf(
    sightings({
      handle: 'silver_fox',
      sources: ['wap_floor'],
      observations: [handleObs('wap_floor', 'silver_fox')],
    }),
  )
  assert.equal(result, 'single_source')
})

// ── the verdict must be reachable from production ─────────────────────────

test('生产代码里至少有一个调用点', async () => {
  // A function that decides what the product may claim, and that nothing calls, is
  // decoration. This asserts the wiring exists so it cannot silently rot again.
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = join(import.meta.dirname, '..', 'src')
  const files = readdirSync(dir, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.ts'))
    .filter((entry) => !entry.endsWith('identity.ts'))
  const callers = files.filter((entry) =>
    readFileSync(join(dir, entry), 'utf8').includes('corroborationOf('),
  )
  assert.ok(callers.length > 0, `corroborationOf 没有任何生产调用点：${files.length} 个文件里都没有`)
})

// ── it must reach the user, not just exist ────────────────────────────────

test('分析结果里真的出现「来源单一」的说明，而不是只在注释里', async () => {
  // The distinction is worthless if nobody is told. This drives the production
  // `analyzeDispute` over a one-surface capture and asserts the note is present.
  const { analyzeDispute } = await import('../lib/analyzer.js')
  const { buildTimeline } = await import('../lib/collector.js')

  const floor = {
    platform: 'tieba',
    floorNumber: 1,
    postId: '900',
    authorId: 'host_un',
    authorName: '楼主',
    authorSource: 'wap_floor',
    content: '开场',
    images: [],
    nestedCount: 1,
  }
  const nested = {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: '900',
    authorId: 'silver_fox',
    authorName: '主人',
    authorSource: 'wap_inline',
    content: '我的看法。',
    relationUncertain: false,
  }
  const data = {
    thread: {
      platform: 'tieba',
      forum: { platform: 'tieba', id: '9', name: '吧' },
      id: '1',
      title: 't',
      content: 'c',
      url: 'u',
      images: [],
    },
    floors: [{ floor, nested: [nested], nestedComplete: true }],
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
  } as never

  // The collector is what attaches `corroboration`; buildTimeline alone does not.
  const { collectThread } = await import('../lib/collector.js')
  const counters = { reads: 0 }
  const adapter = {
    platform: 'tieba',
    async getThread() {
      counters.reads += 1
      return (data as never as { thread: unknown }).thread
    },
    async getReplies() {
      counters.reads += 1
      return { floors: [floor], hasMore: false, page: 1, declaredTotal: 1 }
    },
    async getNestedReplies() {
      counters.reads += 1
      return { replies: [nested], hasMore: false, page: 1 }
    },
  } as never

  const collected = await collectThread(adapter, {
    platform: 'tieba',
    threadId: '1',
    forumName: '吧',
    url: 'u',
  })
  assert.equal(collected.corroboration?.get('r1'), 'single_source', '单一来源必须被标为 single_source')

  const dispute = analyzeDispute(collected, { handle: 'silver_fox' }, { postId: 'r1' })
  assert.ok(
    dispute.notes.some((note) => /单一|交叉/.test(note)),
    `必须告诉用户尚未交叉核对，实际 notes：${JSON.stringify(dispute.notes)}`,
  )
  // And the pipeline still works: `buildTimeline` on the collected thread is used by
  // the analyzer internally, so this also proves the two agree about post ids.
  assert.ok(buildTimeline(collected).length >= 2)
})
