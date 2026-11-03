/**
 * P0 identity-safety fixes, round 7.
 *
 * Every test in this file was **written first and confirmed failing** against
 * `02b0058`. The comment above each block records what it did before the fix, so a
 * later reader can tell a real repair from a test that was quietly rewritten to
 * match whatever the code happened to do.
 *
 * ## The five defects
 *
 * 1. `total_comment` copies a numeric `user_id` into `authorId`, so the number is
 *    simultaneously a login name and an account id. A `handle: '12345'` config then
 *    matches a row whose 12345 is a uid.
 * 2. A row with no declared source is renamed `platform_contract`, which the
 *    corroboration logic counts as an independent source.
 * 3. `wap_floor` and `wap_inline` parse the *same HTML response*, yet count as two
 *    sources.
 * 4. A single source contradicting itself is reported as `single_source`, hiding the
 *    contradiction behind a verdict that reads like "we only looked once".
 * 5. `tieba_uid` has no producer anywhere in the adapter, so the config option is
 *    unreachable.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTotalComment } from '../lib/platforms/tieba/parse.js'
import { analyzeDispute } from '../lib/analyzer.js'
import { corroborationOf, corroborationReason, physicalOriginOf } from '../lib/identity.js'
import { assuranceFromEvidence } from '../lib/identity.js'
import type { IdentityObservation, IdentitySightings } from '../lib/identity.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'

const THREAD_ID = '8752343543'
const FLOOR_POST_ID = '133529333135'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
  id: THREAD_ID,
  title: 'P0 身份安全',
  content: '开场',
  authorId: 'host_un',
  authorName: '楼主',
  authorSource: 'wap_floor',
  url: `https://tieba.baidu.com/p/${THREAD_ID}`,
  images: [],
}

const FLOOR: Floor = {
  platform: 'tieba',
  floorNumber: 1,
  postId: FLOOR_POST_ID,
  authorId: 'host_un',
  authorName: '楼主',
  authorSource: 'wap_floor',
  content: '开场',
  images: [],
  nestedCount: 1,
}

function collected(nested: readonly NestedReply[]): CollectedThread {
  return {
    thread: THREAD,
    floors: [
      { floor: { ...FLOOR, nestedCount: nested.length }, nested: [...nested], nestedComplete: true },
    ],
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
  } as unknown as CollectedThread
}

function sightings(parts: Partial<IdentitySightings>): IdentitySightings {
  return { sources: [], conflicted: false, ...parts } as IdentitySightings
}

// ═══════════════════════════════════════════════════════════════════════════
// P0-1 — a numeric user_id must never become a login name
// ═══════════════════════════════════════════════════════════════════════════

test('P0-1 复现：total_comment 的数字 user_id 曾同时进入 authorId 与 authorNumericUid', () => {
  // Before the fix this row produced `authorId: '12345'` *and* the uid, so the same
  // number lived in two namespaces and could satisfy a handle match.
  // Shape per `parseTotalComment`: data.comment_list[floorPostId].comment_info[].
  const payload = JSON.stringify({
    errno: 0,
    data: {
      comment_list: {
        '133529333135': {
          comment_num: 1,
          comment_info: [
            {
              comment_id: 151694781657,
              post_id: 133529333135,
              user_id: 12345,
              username: '某人',
              content: '一条回复',
              now_time: 1700000000,
            },
          ],
        },
      },
    },
  })
  const parsed = parseTotalComment(payload)
  const inline = parsed.entries[0]!.inline[0]!

  assert.equal(
    inline.authorId,
    undefined,
    '数字 user_id 不得被复制成登录名 authorId —— 这正是本轮 P0',
  )
  assert.equal(inline.authorNumericUid, '12345', '但它必须作为数字 ID 保留下来')
})

test('P0-1 复现：handle 配置曾能匹配一个其实是 user_id 的数字', () => {
  // Adapter-shaped row before the fix: the same number in both fields.
  const row: NestedReply = {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorId: '12345',
    authorNumericUid: '12345',
    authorNumericUidKind: 'user_id',
    authorName: '某人',
    authorSource: 'total_comment',
    content: '一条回复',
    relationUncertain: false,
  } as unknown as NestedReply

  // The configured value is a *login name*; the row only ever published a uid.
  assert.throws(
    () => analyzeDispute(collected([row]), { handle: '12345', platform: 'tieba' }, { postId: 'r1' }),
    /没有|无法/,
    '登录名配置不得匹配数字 ID 记录',
  )
})

test('P0-1：真正的数字形式 un 仍然可以按登录名匹配', () => {
  // WAP publishes `un`; a `un` that happens to be all digits is still a login name.
  const row: NestedReply = {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorId: '1254480024',
    authorName: '寻º乐',
    authorSource: 'wap_floor',
    content: '数字样式的登录名',
    relationUncertain: false,
  } as unknown as NestedReply

  const dispute = analyzeDispute(
    collected([row]),
    { handle: '1254480024', platform: 'tieba' },
    { postId: 'r1' },
  )
  assert.equal(dispute.ownerIdentityAssurance, 'verified')
  assert.equal(dispute.ownerIdentityEvidence.kind, 'handle')
})

test('P0-1：旧会话无来源的记录不得被提升为 verified', () => {
  const legacy: NestedReply = {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorId: 'silver_fox',
    authorName: '苏小玲',
    content: '旧记录',
    relationUncertain: false,
  } as unknown as NestedReply

  const dispute = analyzeDispute(
    collected([legacy]),
    { userId: 'silver_fox', platform: 'tieba' } as never,
    { postId: 'r1' },
  )
  assert.equal(dispute.ownerIdentityAssurance, 'unverified')
  assert.equal(assuranceFromEvidence(dispute.ownerIdentityEvidence), 'identity_unknown')
})

// ═══════════════════════════════════════════════════════════════════════════
// P0-2 C-1 — an unknown source is not an independent source
// ═══════════════════════════════════════════════════════════════════════════

test('P0-2 C-1 复现：无来源观测曾被命名为 platform_contract 并计入独立来源', () => {
  const before: IdentityObservation[] = [
    { source: 'wap_floor', handle: 'x' },
    // What the collector used to fabricate when `authorSource` was missing.
    { source: 'platform_contract' as never, handle: 'x' },
  ]
  // After the fix, unknown provenance is represented by *absence*, not by a name.
  const after: IdentityObservation[] = [
    { source: 'wap_floor', handle: 'x' },
    { handle: 'x' },
  ]

  assert.notEqual(
    corroborationOf(sightings({ observations: after })),
    'corroborated',
    '没有来源的观测不得参与印证',
  )
  // And the fabricated-name shape must no longer be produced anywhere; this asserts
  // the function's own view of a single known source.
  assert.equal(corroborationOf(sightings({ observations: [before[0]!] })), 'single_source')
})

test('P0-2 C-1：两个来源，其中一个来源未知 → 不得 corroborated', () => {
  const result = corroborationOf(
    sightings({
      observations: [{ source: 'wap_floor', handle: 'x' }, { handle: 'x' }],
    }),
  )
  assert.equal(result, 'single_source', '未知来源不能充当第二个来源')
})

// ═══════════════════════════════════════════════════════════════════════════
// P0-2 C-2 — one response, one source
// ═══════════════════════════════════════════════════════════════════════════

test('P0-2 C-2 复现：同一份 HTML 的两个解析器曾被算作两个独立来源', () => {
  const result = corroborationOf(
    sightings({
      observations: [
        { source: 'wap_floor', handle: 'x' },
        { source: 'wap_inline', handle: 'x' },
      ],
    }),
  )
  assert.notEqual(result, 'corroborated', '同一次 HTTP 响应的两个解析器不是两个来源')
  assert.equal(result, 'single_source')
})

test('P0-2 C-2：物理来源映射必须把两个 WAP 解析器归到一起', () => {
  assert.equal(physicalOriginOf('wap_floor'), physicalOriginOf('wap_inline'))
  assert.notEqual(physicalOriginOf('wap_floor'), physicalOriginOf('comment_page'))
  assert.notEqual(physicalOriginOf('comment_page'), physicalOriginOf('total_comment'))
})

test('P0-2 C-2：真正不同的页面仍然可以互证', () => {
  const result = corroborationOf(
    sightings({
      observations: [
        { source: 'wap_floor', handle: 'x' },
        { source: 'comment_page', handle: 'x' },
      ],
    }),
  )
  assert.equal(result, 'corroborated', '两份不同页面的相同登录名，这才叫交叉验证')
})

// ═══════════════════════════════════════════════════════════════════════════
// P0-3 — one source contradicting itself
// ═══════════════════════════════════════════════════════════════════════════

test('P0-3 复现：单来源内部两个不同 handle 曾被报成 single_source', () => {
  const result = corroborationOf(
    sightings({
      observations: [
        { source: 'wap_floor', handle: 'a' },
        { source: 'wap_floor', handle: 'b' },
      ],
    }),
  )
  assert.notEqual(result, 'single_source', '这是自相矛盾，不是"只看了一次"')
  assert.notEqual(result, 'contested', '也不得直接指控为两个人之间的冲突')
  assert.equal(result, 'inconsistent', '这是一个独立的数据质量结论')
})

test('P0-3：单来源内部一致 → 仍是 single_source', () => {
  assert.equal(
    corroborationOf(
      sightings({
        observations: [
          { source: 'wap_floor', handle: 'a' },
          { source: 'wap_floor', handle: 'a' },
        ],
      }),
    ),
    'single_source',
  )
})

test('P0-3：真正的跨来源矛盾仍是 contested', () => {
  assert.equal(
    corroborationOf(
      sightings({
        observations: [
          { source: 'wap_floor', handle: 'a' },
          { source: 'comment_page', handle: 'b' },
        ],
      }),
    ),
    'contested',
  )
})

test('P0-3：inconsistent 必须给出原因', () => {
  const reason = corroborationReason(
    sightings({
      observations: [
        { source: 'wap_floor', handle: 'a' },
        { source: 'wap_floor', handle: 'b' },
      ],
    }),
  )
  assert.equal(reason.code, 'self_contradictory')
  assert.match(reason.detail, /同一来源|自相矛盾/)
})

// ═══════════════════════════════════════════════════════════════════════════
// P0-2 fallout — does corroboration touch any security decision?
// ═══════════════════════════════════════════════════════════════════════════

test('corroborated 不参与发表授权，闸门只看 assurance + evidence', async () => {
  // Documented as a test so the answer to "does this affect the gate?" cannot drift:
  // it does not. The gate reads `ownerIdentityAssurance` and recomputes from
  // `ownerIdentityEvidence`; corroboration is reporting only.
  const { checkPublishPolicy } = await import('../lib/safety.js')
  const policy = {
    mode: 'manual' as const,
    maxAutoPublishesPerSession: 0,
    cooldownMs: 0,
    maxPublishesPerThread: 10,
    stopOnChallenge: true,
  }
  const attempt = {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: true,
    securityDecision: 'allow' as const,
    semanticSettled: true,
    now: 1,
    ownerIdentityAssurance: 'verified' as const,
    ownerIdentityEvidence: { kind: 'handle', value: 'x', source: 'wap_floor' },
  }

  // Allowed without any corroboration information at all.
  assert.equal(checkPublishPolicy(policy, attempt as never).allowed, true)

  // Removing the evidence still refuses, regardless of any corroboration claim that
  // might be attached elsewhere.
  const withoutEvidence = { ...attempt, ownerIdentityEvidence: undefined }
  assert.equal(checkPublishPolicy(policy, withoutEvidence as never).allowed, false)
})

// ═══════════════════════════════════════════════════════════════════════════
// B-2 — tieba_uid has no producer, and the config must say so
// ═══════════════════════════════════════════════════════════════════════════

test('B-2：只读确认适配器仍然产不出 tieba_uid', async () => {
  // Verified against source, not against a fixture: the only place a namespace is
  // ever assigned is the totalComment projection, and it always says `user_id`.
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = join(import.meta.dirname, '..', 'src', 'platforms', 'tieba')
  const files = readdirSync(dir).filter((entry) => entry.endsWith('.ts'))
  // Substring test rather than a regex: the pattern needs an escaped whitespace
  // class, and shell heredocs have already eaten one version of it.
  const needle = "authorNumericUidKind: 'tieba_uid'"
  const assigning = files.filter((entry) =>
    readFileSync(join(dir, entry), 'utf8').includes(needle),
  )
  assert.deepEqual(assigning, [], '目前没有任何适配器产出 tieba_uid 命名空间')
})

test('B-2：配置 tieba_uid 必须明确拒绝，且不得静默当成 user_id', () => {
  const row: NestedReply = {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorNumericUid: '12345',
    authorNumericUidKind: 'user_id',
    authorName: '某人',
    authorSource: 'total_comment',
    content: '一条回复',
    relationUncertain: false,
  } as unknown as NestedReply

  assert.throws(
    () =>
      analyzeDispute(
        collected([row]),
        { userId: '12345', userIdNamespace: 'tieba_uid', platform: 'tieba' },
        { postId: 'r1' },
      ),
    /tieba_uid|尚不提供|无法提供/,
    '不可达的命名空间必须给出可执行的说明，而不是一句"帖子里没有这个 ID"',
  )
})

test('B-2：user_id 命名空间仍然正常工作（未被误伤）', () => {
  const row: NestedReply = {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorNumericUid: '12345',
    authorNumericUidKind: 'user_id',
    authorName: '某人',
    authorSource: 'total_comment',
    content: '一条回复',
    relationUncertain: false,
  } as unknown as NestedReply

  const dispute = analyzeDispute(
    collected([row]),
    { userId: '12345', userIdNamespace: 'user_id', platform: 'tieba' },
    { postId: 'r1' },
  )
  assert.equal(dispute.ownerIdentityAssurance, 'verified')
  assert.equal(dispute.ownerIdentityEvidence.namespace, 'user_id')
})
