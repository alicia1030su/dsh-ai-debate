/**
 * v0.2.21 发表安全回归：作者身份 / 目标 / 正文 三维绑定。
 *
 * ## 这个文件补的是什么缺口
 *
 * `approval-adversarial.test.ts` 已经覆盖了「批准之后目标 postId 被换」「正文被换」
 * 「发表账号被换」。它**没有**覆盖一个更微妙的情形：**postId 不变，但坐在那个 id
 * 上的人变了**。那种变化下上面三条检查全部通过，旧批准会看起来仍然有效，回复就会
 * 落到一个陌生人头上。
 *
 * 这些测试全部走真实的 `publishCandidate`（不是复制一份判断逻辑），并且每个用例都
 * 断言 `adapter.publishes.length`——拒绝必须同时意味着「一个请求都没发出去」。
 *
 * ## 语义约定（本文件即定义，实现不得反向修改以迁就测试）
 *
 * - **有作者 ID 时比较 ID。** 只改显示昵称不算换人：贴吧的 `un` 是登录名，改不了；
 *   `name_show` 是昵称，随便改。同一个 ID 配新昵称，仍是同一个人。
 * - **ID 消失 = 无法核验，不是"没变"。** 宁可拒绝，不可放行。
 * - **ID 变了就是换人**，哪怕显示昵称一模一样。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DebateStore } from '../lib/store.js'
import { publishCandidate, resetInFlight } from '../lib/publisher.js'
import { DEFAULT_POLICY } from '../lib/safety.js'
import { assessmentFingerprint } from '../lib/security/security-policy.js'
import { contentHash } from '../lib/target.js'
import type { StoredSession } from '../lib/store.js'
import { FakeAdapter, threePartyThread, grantApproval } from './helpers.ts'

const BOUND_ACCOUNT = () => ({ aiAccountUserId: '1001', aiAccountName: 'ai-account' })
const TARGET_ID = 'n5'
const TEXT = '你这条论据没有出处，我不同意这个结论。'

function tempStore(): { store: DebateStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsd-author-identity-'))
  return { store: new DebateStore({ dir }), dir }
}

/**
 * A READY session whose candidate answers `n5`.
 *
 * Built from the project's own fixture, because the publish path re-reads the
 * target and compares the snapshot against what the adapter returns. A hand-rolled
 * snapshot fails the hash or author checks first, and the test would then pass for
 * a reason that has nothing to do with what it claims to test.
 */
function session(): StoredSession {
  const fixture = threePartyThread()
  const now = new Date().toISOString()
  const threadId = fixture.thread.id
  const floorPostId = fixture.floors[0]!.postId
  const target = fixture.nested[floorPostId]!.find((post) => post.postId === TARGET_ID)!

  return {
    id: 's-author',
    platform: 'tieba',
    threadId,
    threadUrl: fixture.thread.url,
    threadTitle: fixture.thread.title,
    forumName: '测试吧',
    ownerKey: 'owner-1',
    ownerName: '主人',
    opponentKey: 'opp-1',
    opponentName: '对手B',
    opponentUserId: target.authorId,
    disputeFloorPostId: floorPostId,
    disputeFloorNumber: 1,
    triggerPostId: 'n7',
    targetKind: 'nested',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [
      {
        replyId: 's-author-c1',
        text: TEXT,
        strategy: 'direct_rebuttal',
        targetPostId: TARGET_ID,
        targetSnapshot: {
          platform: 'tieba',
          threadId,
          floorPostId,
          floorNumber: 1,
          nestedReplyId: TARGET_ID,
          targetPostId: TARGET_ID,
          targetKind: 'nested',
          targetAuthorId: target.authorId,
          targetAuthorName: target.authorName,
          contentHash: contentHash(target.content),
          capturedAt: now,
        } as never,
        candidateVersion: 1,
        textHash: contentHash(TEXT),
        confidence: 0.8,
        violations: [],
        notes: [],
        security: {
          injectionDetected: false,
          ownerIdentityValid: true,
          targetIdentityValid: true,
          stanceConsistency: 'consistent',
          ownerDirectedAttack: false,
          unauthorizedInstructionFollowed: false,
          secretLeakRisk: false,
          evidenceIntegrityValid: true,
          decision: 'allow',
          reasons: [],
          fingerprint: assessmentFingerprint({ reply: TEXT, targetPostId: TARGET_ID, decision: 'allow' }),
        },
      },
    ],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as StoredSession
}

function adapterFor(): FakeAdapter {
  const fixture = threePartyThread()
  return new FakeAdapter({
    thread: fixture.thread,
    floors: fixture.floors,
    nested: fixture.nested,
    publish: () => ({ status: 'confirmed', postId: 'author-1' }),
  })
}

/**
 * Grab the live `n5` row out of a fake adapter so a test can mutate it.
 *
 * Returns a mutable view: the whole premise of these tests is that the platform
 * hands back a different author for the same post id, and `NestedReply` declares
 * its fields readonly because production code must never edit them. The cast is
 * the test reaching around that guarantee on purpose — it is what the platform did,
 * not something our code is allowed to do.
 */
function targetOf(adapter: FakeAdapter): { authorId?: string; authorName?: string } {
  const fixture = threePartyThread()
  const floorPostId = fixture.floors[0]!.postId
  const nested = adapter.data.nested?.[floorPostId]
  if (nested === undefined) throw new Error('测试夹具缺少楼中楼数据')
  return nested.find((post) => post.postId === TARGET_ID)! as unknown as { authorId?: string; authorName?: string }
}

/** Publish the approved candidate and hand back the report plus send count. */
async function publish(
  adapter: FakeAdapter,
  store: DebateStore,
  input: { approvedText?: string; candidateId?: string; sessionId?: string } = {},
) {
  const report = await publishCandidate(
    { adapter, store, policy: { ...DEFAULT_POLICY, mode: 'manual' }, config: BOUND_ACCOUNT },
    {
      sessionId: input.sessionId ?? 's-author',
      candidateId: input.candidateId ?? 's-author-c1',
      approvedText: input.approvedText ?? TEXT,
    },
  )
  return { report, sent: adapter.publishes.length }
}

// ---------------------------------------------------------------------------
// 对照组：脚手架本身必须能成功
// ---------------------------------------------------------------------------

test('对照组：作者、目标、正文都不变时能够正常发表', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })
    const adapter = adapterFor()

    const { report, sent } = await publish(adapter, store)
    assert.equal(report.ok, true, `对照组应当发表成功，实际被拒：${report.message}`)
    assert.equal(sent, 1, '对照组必须真的调用一次 publishReply，否则后面的 0 次断言没有意义')
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 测试 1：作者身份变化（postId 不变）
// ---------------------------------------------------------------------------

test('测试1：批准之后目标作者换了人，旧批准不能用于新作者', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })

    const adapter = adapterFor()
    // 关键：postId 保持 n5 不变，只把坐在上面的人换掉。
    targetOf(adapter).authorId = 'opp-2'

    const { report, sent } = await publish(adapter, store)
    assert.equal(report.ok, false, '作者换人后必须拒绝发表')
    assert.equal(report.errorCode, 'target_author_mismatch', `错误码应为 target_author_mismatch，实际 ${report.errorCode}`)
    assert.equal(sent, 0, '拒绝时必须一个 publishReply 都没发出去')
    // The refusal comes from `resolveTarget` re-reading the platform, so it names the
    // two author ids rather than talking about snapshots. Assert on the substance
    // (作者 + 不一致 + 需要重新分析), not on one wording.
    assert.match(report.message, /作者/, '拒绝理由必须指出是作者问题')
    assert.match(report.message, /不一致/, '拒绝理由必须说明为什么不一致')
    assert.match(report.message, /重新分析|重新生成|重新审核/, '拒绝理由必须告诉主人下一步做什么')
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('测试1b：作者 ID 和显示昵称同时换人，同样拒绝', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })

    const adapter = adapterFor()
    const n5 = targetOf(adapter)
    n5.authorId = 'opp-2'
    n5.authorName = '对手C'

    const { report, sent } = await publish(adapter, store)
    assert.equal(report.ok, false)
    assert.equal(report.errorCode, 'target_author_mismatch')
    assert.equal(sent, 0)
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('测试1c：换了作者但显示昵称一样，仍然必须拒绝（不能只看名字）', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })

    const adapter = adapterFor()
    const n5 = targetOf(adapter)
    n5.authorId = 'opp-2'
    // 冒充者取了同样的昵称——只看名字的实现会在这里放行。
    n5.authorName = '对手B'

    const { report, sent } = await publish(adapter, store)
    assert.equal(report.ok, false, '昵称相同不构成身份证明')
    assert.equal(report.errorCode, 'target_author_mismatch')
    assert.equal(sent, 0)
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 测试 2：作者身份消失
// ---------------------------------------------------------------------------

test('测试2：重新读取时作者 ID 消失，视为无法核验而不是"没变"', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })

    const adapter = adapterFor()
    targetOf(adapter).authorId = undefined

    const { report, sent } = await publish(adapter, store)
    assert.equal(report.ok, false, '作者 ID 消失时必须拒绝')
    assert.equal(report.errorCode, 'target_author_unverifiable', `错误码应为 target_author_unverifiable，实际 ${report.errorCode}`)
    assert.equal(sent, 0)
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 测试 3：仅显示昵称变化 —— 语义固化
// ---------------------------------------------------------------------------

test('测试3：只改显示昵称（作者 ID 不变）不视为换人，发表照常进行', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })

    const adapter = adapterFor()
    // 同一个人改了昵称：un 不变，name_show 变了。
    targetOf(adapter).authorName = '对手B（改名了）'

    const { report, sent } = await publish(adapter, store)
    assert.equal(report.ok, true, `仅昵称变化不该被当成换人，实际被拒：${report.message}`)
    assert.equal(sent, 1)
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 测试 4：目标 postId 变化
// ---------------------------------------------------------------------------

test('测试4：批准之后目标 postId 被换，旧批准失效', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })

    await store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((entry) => ({
        ...entry,
        candidates: entry.candidates.map((row) => ({ ...row, targetPostId: 'n9' })),
      })),
    }))

    const adapter = adapterFor()
    const { report, sent } = await publish(adapter, store)
    assert.equal(report.ok, false)
    assert.equal(sent, 0, '目标被换后不能发出任何请求')
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 测试 5：正文变化
// ---------------------------------------------------------------------------

test('测试5：批准之后正文被改，旧批准失效', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })

    const adapter = adapterFor()
    // 用「主人批准的是原文，实际发的是改过的文本」这个口径。
    const { report, sent } = await publish(adapter, store, { approvedText: `${TEXT}（偷偷加一句）` })
    assert.equal(report.ok, false)
    assert.equal(sent, 0)
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('测试5b：候选的 textHash 与自身正文不一致时视为被篡改', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })

    await store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((entry) => ({
        ...entry,
        candidates: entry.candidates.map((row) => ({ ...row, textHash: 'deadbeefdeadbeef' })),
      })),
    }))

    const adapter = adapterFor()
    const { report, sent } = await publish(adapter, store)
    assert.equal(report.ok, false)
    assert.equal(report.errorCode, 'candidate_tampered')
    assert.equal(sent, 0)
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 组合：三种变化叠加，仍然必须拒绝，且理由要具体
// ---------------------------------------------------------------------------

test('组合：作者与正文同时变化时，拒绝理由必须是可读的且不发送', async () => {
  resetInFlight()
  const { store, dir } = tempStore()
  try {
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's-author', candidateId: 's-author-c1', config: BOUND_ACCOUNT })

    const adapter = adapterFor()
    targetOf(adapter).authorId = 'opp-2'

    const { report, sent } = await publish(adapter, store, { approvedText: `${TEXT}！` })
    assert.equal(report.ok, false)
    assert.equal(sent, 0)
    assert.ok(report.message.length > 0, '拒绝必须带理由，不能只返回一个 false')
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})
