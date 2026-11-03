/**
 * Can anything still turn an unknown source, an unclear namespace, or an
 * uncomparable identity into `verified` and get past the publish gate?
 *
 * This file exists because the answer to that question must not be "should be
 * fine". It enumerates **every way** an identity can reach `resolveOwnerKey`, and
 * for each one asserts the outcome that the gate will act on. Where a path is
 * refused, it also asserts the refusal survives all the way to
 * `checkPublishPolicy` — a rejection in the analyzer that the gate never sees would
 * be worthless.
 *
 * ## The paths, and why they are the complete set
 *
 * `resolveOwnerKey` has exactly three entry branches:
 *
 *   1. `owner.userId` set, numeric → namespace comparison (user_id only)
 *   2. `owner.userId` set, non-numeric → handle compatibility path
 *   3. `owner.handle` / `owner.userName` → handle or nickname path
 *
 * Within those, the only inputs that can vary are: whether the row declared a
 * source, which source it declared, whether it carried a uid, and whether that uid
 * had a namespace. Every combination that could plausibly verify is listed below.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute } from '../lib/analyzer.js'
import { assuranceFromEvidence } from '../lib/identity.js'
import { checkPublishPolicy } from '../lib/safety.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'

const THREAD_ID = '8752343543'
const FLOOR_POST_ID = '133529333135'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
  id: THREAD_ID,
  title: '穷举',
  content: 'c',
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
  content: 'c',
  images: [],
  nestedCount: 1,
}

function collected(rows: readonly NestedReply[]): CollectedThread {
  return {
    thread: THREAD,
    floors: [{ floor: { ...FLOOR, nestedCount: rows.length }, nested: [...rows], nestedComplete: true }],
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

const POLICY = {
  mode: 'manual' as const,
  maxAutoPublishesPerSession: 0,
  cooldownMs: 0,
  maxPublishesPerThread: 10,
  stopOnChallenge: true,
}

const ATTEMPT = {
  sessionId: 's',
  threadId: 't',
  sessionPublishes: 0,
  threadPublishes: 0,
  humanApproved: true,
  securityDecision: 'allow' as const,
  semanticSettled: true,
  now: 1,
}

/** Run analysis and report whether the resulting session could publish. */
function outcome(rows: readonly NestedReply[], owner: Record<string, unknown>) {
  let dispute: ReturnType<typeof analyzeDispute> | undefined
  try {
    dispute = analyzeDispute(collected(rows), owner as never, { postId: rows[0]!.postId })
  } catch {
    // A refused resolution never reaches the gate at all.
    return { analysis: 'refused' as const, gate: 'refused' as const }
  }
  const decision = checkPublishPolicy(POLICY, {
    ...ATTEMPT,
    ownerIdentityAssurance: dispute.ownerIdentityAssurance,
    ownerIdentityEvidence: dispute.ownerIdentityEvidence,
  } as never)
  return {
    analysis: dispute.ownerIdentityAssurance,
    evidence: dispute.ownerIdentityEvidence,
    gate: decision.allowed ? ('allowed' as const) : ('refused' as const),
  }
}

function row(parts: Partial<Record<string, unknown>>): NestedReply {
  return {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorName: '某人',
    content: 'x',
    relationUncertain: false,
    ...parts,
  } as unknown as NestedReply
}

// ═══════════════════════════════════════════════════════════════════════════
// The exhaustive table
// ═══════════════════════════════════════════════════════════════════════════

const CASES: ReadonlyArray<{
  name: string
  rows: NestedReply[]
  owner: Record<string, unknown>
  expect: 'allowed' | 'refused'
  why: string
}> = [
  {
    name: '无来源行 + 精确登录名配置',
    rows: [row({ authorId: 'silver_fox' })],
    owner: { handle: 'silver_fox' },
    expect: 'refused',
    why: '没有来源就没有可核验的归属，只读可以，发表不行',
  },
  {
    name: '无来源行 + userId 填了登录名（旧配置）',
    rows: [row({ authorId: 'silver_fox' })],
    owner: { userId: 'silver_fox', platform: 'tieba' },
    expect: 'refused',
    why: '同一份证据，闸门也必须拒绝',
  },
  {
    name: '数字 uid 无命名空间',
    rows: [row({ authorNumericUid: '12345', authorSource: 'total_comment' })],
    owner: { userId: '12345', platform: 'tieba' },
    expect: 'refused',
    why: '数字没有命名空间就无法定位，不能猜',
  },
  {
    name: '数字 uid + tieba_uid（不可达命名空间）',
    rows: [row({ authorNumericUid: '12345', authorNumericUidKind: 'tieba_uid', authorSource: 'total_comment' })],
    owner: { userId: '12345', userIdNamespace: 'tieba_uid', platform: 'tieba' },
    expect: 'refused',
    why: '没有适配器产出 tieba_uid，必须明确拒绝',
  },
  {
    name: '数字 uid 无命名空间 + tieba_uid 配置',
    rows: [row({ authorNumericUid: '12345', authorSource: 'total_comment' })],
    owner: { userId: '12345', userIdNamespace: 'tieba_uid', platform: 'tieba' },
    expect: 'refused',
    why: '同上',
  },
  {
    name: '数字 user_id 被旧适配器塞进 authorId',
    rows: [row({ authorId: '12345', authorNumericUid: '12345', authorNumericUidKind: 'user_id', authorSource: 'total_comment' })],
    owner: { handle: '12345', platform: 'tieba' },
    expect: 'refused',
    why: 'C-1 的核心：数字不得从 handle 通道通过',
  },
  {
    name: '未声明来源但配置了 handle',
    rows: [row({ authorId: '12345', authorNumericUid: '12345', authorNumericUidKind: 'user_id' })],
    owner: { handle: '12345', platform: 'tieba' },
    expect: 'refused',
    why: '来源不明 + 数字形态：双重不确定',
  },
  {
    name: '只有昵称',
    rows: [row({ authorName: '某人' })],
    owner: { userName: '某人' },
    expect: 'refused',
    why: '昵称从来不是身份',
  },
  {
    name: '跨平台相同 user_id',
    rows: [{ ...row({ authorNumericUid: '12345', authorNumericUidKind: 'user_id', authorSource: 'total_comment' }), platform: 'weibo' } as NestedReply],
    owner: { userId: '12345', userIdNamespace: 'user_id', platform: 'tieba' },
    expect: 'refused',
    why: 'ID 只在所属平台内有意义',
  },
  {
    name: '命名空间与数值同时吻合（合法对照组）',
    rows: [row({ authorNumericUid: '12345', authorNumericUidKind: 'user_id', authorSource: 'total_comment' })],
    owner: { userId: '12345', userIdNamespace: 'user_id' as const, platform: 'tieba' },
    // This one is the legitimate control.
    expect: 'allowed',
    why: '命名空间与数值都对上，这才是应当放行的路径',
  },
]

for (const item of CASES) {
  test(`穷举：${item.name} → ${item.expect === 'allowed' ? '允许' : '拒绝'}`, () => {
    const result = outcome(item.rows, item.owner)
    if (item.expect === 'refused') {
      assert.equal(
        result.gate,
        'refused',
        `${item.name} 必须被拒绝：${item.why}；实际 ${JSON.stringify(result)}`,
      )
    } else {
      assert.equal(
        result.gate,
        'allowed',
        `${item.name} 应当放行：${item.why}；实际 ${JSON.stringify(result)}`,
      )
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// The gate itself cannot be talked into it
// ═══════════════════════════════════════════════════════════════════════════

test('穷举：闸门不接受任何"看起来像已核验"的替代物', () => {
  // Every shape a caller might hope the gate treats as equivalent to real evidence.
  const shapes: Array<Record<string, unknown>> = [
    { ownerIdentityAssurance: 'verified' },
    { ownerIdentityEvidence: { kind: 'handle', value: 'x', source: 'wap_floor' } },
    { ownerIdentityAssurance: 'verified', ownerIdentityEvidence: { kind: 'nickname', value: 'x' } },
    { ownerIdentityAssurance: 'verified', ownerIdentityEvidence: { kind: 'legacy', value: 'x' } },
    { ownerIdentityAssurance: 'verified', ownerIdentityEvidence: { kind: 'none' } },
    { ownerIdentityAssurance: 'verified', ownerIdentityEvidence: { kind: 'numeric_uid', value: '1' } },
    { ownerIdentityAssurance: 'verified', ownerIdentityEvidence: { kind: 'handle', value: 'x' } },
  ]
  for (const shape of shapes) {
    const decision = checkPublishPolicy(POLICY, { ...ATTEMPT, ...shape } as never)
    assert.equal(decision.allowed, false, `不得放行：${JSON.stringify(shape)}`)
  }
})

test('穷举：evidence 与 assurance 必须同时成立，缺一即拒', () => {
  const good = { kind: 'handle', value: 'x', source: 'wap_floor' }
  assert.equal(
    checkPublishPolicy(POLICY, { ...ATTEMPT, ownerIdentityAssurance: 'verified', ownerIdentityEvidence: good } as never)
      .allowed,
    true,
  )
  assert.equal(
    checkPublishPolicy(POLICY, { ...ATTEMPT, ownerIdentityAssurance: 'unverified', ownerIdentityEvidence: good } as never)
      .allowed,
    false,
  )
  assert.equal(
    checkPublishPolicy(POLICY, { ...ATTEMPT, ownerIdentityAssurance: 'verified' } as never).allowed,
    false,
  )
})

test('穷举：assuranceFromEvidence 对未知形态一律 identity_unknown', () => {
  for (const evidence of [
    undefined,
    { kind: 'nickname', value: 'x' },
    { kind: 'legacy', value: 'x' },
    { kind: 'none' },
    { kind: 'numeric_uid', value: '1' },
    { kind: 'handle', value: 'x' },
  ] as never[]) {
    assert.equal(
      assuranceFromEvidence(evidence),
      'identity_unknown',
      `不得判为已核验：${JSON.stringify(evidence)}`,
    )
  }
})
