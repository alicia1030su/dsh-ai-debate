/**
 * 工作台的批准范围：内容批准 ≠ 目标身份核验。
 *
 * ## 这个文件测的是"界面不能替发表闸门说话"
 *
 * v0.2.21/0.2.22 的工作台把 `approvalStillApplies()` 的结果直接渲染成"已批准"，
 * 而它只比较候选、版本、正文、目标位置四件事。作者换人时它仍然返回 `applies: true`。
 *
 * 这**不是**发表漏洞：`publishCandidate` 会重新读取平台、用 `resolveTarget()` +
 * `snapshotStillValid()` 独立核验作者，对不上就拒绝（见
 * publish-author-identity-binding.test.ts）。但它是一个**诚实性**问题：界面看起来
 * 一切就绪，点下去却被拒，主人会以为闸门坏了，而实际上是自己被页面误导了。
 *
 * ## 本文件定义的契约
 *
 * - 批准的范围只有内容。页面必须同时展示"内容"和"目标身份"两行。
 * - 页面**不得**声称作者已核验——它没有重新读过平台，说"已核验"就是编的。
 * - 能从持久事实确定会被拒的两种情况（无快照 / 无稳定作者 ID），页面必须提前
 *   阻断，而不是摆一个必定失败的按钮。
 * - 发表闸门本身一个字都不改：这里测的是显示，不是放行。
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
import { deriveWorkbenchState, describeTargetIdentity } from '../lib/workbench.js'
import type { StoredCandidate, StoredSession } from '../lib/store.js'
import { FakeAdapter, threePartyThread, grantApproval } from './helpers.ts'

const NOW = '2026-11-02T00:00:00.000Z'
const TEXT = '你这条论据没有出处，我不同意这个结论。'
const BOUND_ACCOUNT = () => ({ aiAccountUserId: '1001', aiAccountName: 'ai-account' })

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'tieba',
    threadId: '900000000000',
    floorPostId: '900000000001',
    floorNumber: 1,
    targetPostId: 'n5',
    targetKind: 'nested',
    // 目标是楼中楼时，真实快照一定带 nestedReplyId（`resolveTarget` 从新鲜读取里取）。
    // 少了它，`snapshotStillValid` 会在对比 nestedReplyId 时判成 nested_mismatch。
    nestedReplyId: 'n5',
    targetAuthorId: 'opp-1',
    targetAuthorName: '对手B',
    // 快照的 contentHash 必须是目标正文的真实哈希：publishCandidate 会重新读一次
    // 平台，用 `snapshotStillValid` 比对正文有没有在审核期间被改过。
    contentHash: contentHash('回复 主人 :那报价是同型号吗？你拿别的型号比没意义吧。'),
    capturedAt: NOW,
    ...overrides,
  }
}

function candidate(overrides: Partial<StoredCandidate> = {}): StoredCandidate {
  return {
    replyId: 'c1',
    text: TEXT,
    strategy: 'tieba_veteran',
    targetPostId: 'n5',
    targetSnapshot: snapshot() as never,
    candidateVersion: 1,
    // 必须是正文真实的哈希，否则 publishCandidate 会先以 candidate_tampered 拒绝。
    textHash: contentHash(TEXT),
    confidence: 0.8,
    violations: [],
    notes: [],
    // real candidate 一定带安全评估记录；没有它，publishCandidate 会在安全闸门处
    // 先拒绝，这条测试就测不到我们要测的东西。
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
      fingerprint: assessmentFingerprint({ reply: TEXT, targetPostId: 'n5', decision: 'allow' }),
    } as never,
    createdAt: NOW,
    approved: true,
    ...overrides,
  }
}

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 's1',
    platform: 'tieba',
    threadId: '900000000000',
    threadUrl: 'https://tieba.baidu.com/p/1',
    threadTitle: '讨论',
    forumName: '测试吧',
    ownerKey: 'owner-1',
    ownerIdentityAssurance: 'verified' as const,
    // The evidence the label refers to: a login name declared by a real
    // surface. Without it the gate refuses the label as unproven.
    ownerIdentityEvidence: { kind: 'handle' as const, value: 'owner-1', source: 'wap_floor' as const },
    ownerName: '主人',
    opponentKey: 'opp-1',
    opponentName: '对手B',
    opponentUserId: 'opp-1',
    disputeFloorPostId: '900000000001',
    disputeFloorNumber: 1,
    triggerPostId: 'n7',
    targetKind: 'nested',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [candidate()],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function adapterFor(): FakeAdapter {
  const fixture = threePartyThread()
  return new FakeAdapter({
    thread: fixture.thread,
    floors: fixture.floors,
    nested: fixture.nested,
    publish: () => ({ status: 'confirmed', postId: 'r-1' }),
  })
}

// ---------------------------------------------------------------------------
// 1. describeTargetIdentity：说清楚"不知道"，而不是说"没问题"
// ---------------------------------------------------------------------------

test('有稳定作者 ID 时，状态是"本页未核验"，绝不能是"已核验"', () => {
  const view = describeTargetIdentity({ targetSnapshot: snapshot() as never }, true)

  assert.equal(view.state, 'not_rechecked')
  assert.equal(view.blocking, false, '这不是阻断，是"还没发生"')
  assert.equal(view.authorId, 'opp-1')
  assert.match(view.detail, /没有重新读取平台|现场核验/, '必须说明核验发生在发表时，不在本页')
  assert.doesNotMatch(view.detail, /已核验/, '本页没有读平台，不能声称核验过')
})

test('没有目标快照时：阻断，并说明发表路径会拒绝', () => {
  const view = describeTargetIdentity({ targetSnapshot: undefined }, true)
  assert.equal(view.state, 'no_snapshot')
  assert.equal(view.blocking, true)
  assert.match(view.detail, /快照/)
  assert.match(view.detail, /拒绝/)
})

test('只有显示昵称、没有稳定 ID 时：阻断，理由指向昵称可被改动', () => {
  const view = describeTargetIdentity(
    { targetSnapshot: snapshot({ targetAuthorId: undefined, targetAuthorName: '贴吧用户_JPEPCR5' }) as never },
    true,
  )
  assert.equal(view.state, 'unverifiable')
  assert.equal(view.blocking, true)
  assert.match(view.detail, /贴吧用户_JPEPCR5/, '要点名是哪个昵称')
  assert.match(view.detail, /昵称/, '要说明为什么昵称不算身份')
  assert.equal(view.authorId, undefined, '不能凭空生成一个作者 ID')
})

test('内容还没批准时，不把身份说成"无法核验"——那是尚未到达的一步', () => {
  const view = describeTargetIdentity({ targetSnapshot: snapshot() as never }, false)
  assert.equal(view.state, 'not_approved')
  assert.equal(view.blocking, false)
})

// ---------------------------------------------------------------------------
// 2. deriveWorkbenchState：步骤与文案
// ---------------------------------------------------------------------------

test('批准有效且作者 ID 稳定：停在发表，但必须同时给出内容批准与身份待核验两句', () => {
  const state = deriveWorkbenchState({ session: session(), approvalApplies: true })

  assert.equal(state.step, 'publish')
  assert.equal(state.approval.content.applies, true)
  assert.equal(state.approval.target.state, 'not_rechecked')
  assert.equal(state.approval.target.blocking, false)

  const notices = state.notices.join('\n')
  assert.match(notices, /内容已批准/, '必须说清批准覆盖的是内容')
  assert.match(notices, /目标作者身份/, '必须单独指出身份不在批准范围内')
  assert.match(notices, /重新读取平台|核对作者/, '必须说明身份在发表时重新核验')
})

test('没有稳定作者 ID：必须从"发表"退回"审阅"，并给出可读的阻断原因', () => {
  const stored = session({
    candidates: [candidate({ targetSnapshot: snapshot({ targetAuthorId: undefined }) as never })],
  })
  const state = deriveWorkbenchState({ session: stored, approvalApplies: true })

  assert.equal(state.step, 'review', '注定被拒的候选不该停在发表步')
  assert.equal(state.approval.target.blocking, true)
  const blockers = state.blockers.join('\n')
  assert.match(blockers, /昵称/, '阻断原因要点出问题在昵称')
  assert.match(blockers, /拒绝/, '要说清后果是被拒绝发表')
})

test('没有目标快照：同样退回审阅，理由指向快照', () => {
  const stored = session({ candidates: [candidate({ targetSnapshot: undefined })] })
  const state = deriveWorkbenchState({ session: stored, approvalApplies: true })

  assert.equal(state.step, 'review')
  assert.match(state.blockers.join('\n'), /快照/)
})

test('已发表并回读确认时，不因为身份状态把"完成"往回拽', () => {
  const state = deriveWorkbenchState({
    session: session({ state: 'PUBLISHED', candidates: [candidate({ publishedPostId: 'r-1' })] }),
    approvalApplies: true,
    lastAttempt: { status: 'confirmed' },
  })
  assert.equal(state.step, 'done')
  assert.equal(state.approval.target.state, 'not_rechecked', '已发出的回复，身份在发表时已经核过一次')
})

// ---------------------------------------------------------------------------
// 3. 页面与闸门必须给同一个答案（不是"页面替代闸门"）
// ---------------------------------------------------------------------------

test('页面说"会拒绝"的候选，publishCandidate 确实拒绝，且一个请求都没发', async () => {
  resetInFlight()
  const dir = mkdtempSync(join(tmpdir(), 'dsd-scope-gate-'))
  try {
    const store = new DebateStore({ dir })
    const stored = session({
      candidates: [candidate({ targetSnapshot: snapshot({ targetAuthorId: undefined, targetAuthorName: '贴吧用户_JPEPCR5' }) as never })],
    })
    await store.mutate((data) => ({ ...data, sessions: [stored] }))
    await grantApproval(store, { sessionId: 's1', candidateId: 'c1', config: BOUND_ACCOUNT })

    const adapter = adapterFor()
    const report = await publishCandidate(
      { adapter, store, policy: { ...DEFAULT_POLICY, mode: 'manual' }, config: BOUND_ACCOUNT },
      { sessionId: 's1', candidateId: 'c1', approvedText: TEXT },
    )

    // 页面侧：同样的会话，工作台提前阻断。
    const page = deriveWorkbenchState({
      session: store.getSession('s1')!,
      approvalApplies: true,
    })

    assert.equal(report.ok, false, '没有稳定作者 ID 必须拒绝')
    assert.equal(adapter.publishes.length, 0, '拒绝时一个 publishReply 都不能发出去')
    assert.equal(page.step, 'review', '页面也必须在同一条候选上停下')
    assert.equal(page.approval.target.blocking, true)
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('页面说"可以发"的候选，闸门也确实放行（对照组）', async () => {
  resetInFlight()
  const dir = mkdtempSync(join(tmpdir(), 'dsd-scope-gate-ok-'))
  try {
    const store = new DebateStore({ dir })
    await store.mutate((data) => ({ ...data, sessions: [session()] }))
    await grantApproval(store, { sessionId: 's1', candidateId: 'c1', config: BOUND_ACCOUNT })

    const page = deriveWorkbenchState({ session: store.getSession('s1')!, approvalApplies: true })
    assert.equal(page.step, 'publish')

    const adapter = adapterFor()
    const report = await publishCandidate(
      { adapter, store, policy: { ...DEFAULT_POLICY, mode: 'manual' }, config: BOUND_ACCOUNT },
      { sessionId: 's1', candidateId: 'c1', approvedText: TEXT },
    )
    assert.equal(report.ok, true, `对照组应当放行，实际被拒：${report.message}`)
    assert.equal(adapter.publishes.length, 1)
  } finally {
    resetInFlight()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. 批准仍然只覆盖内容：作者换人不归它管
// ---------------------------------------------------------------------------

test('approvalStillApplies 保持只比内容：作者换人它仍然报"有效"，但页面不再据此说"全部就绪"', () => {
  // 这条是把边界钉死：不要为了修界面去改这个函数的语义，也不要把它当成发表闸门。
  const state = deriveWorkbenchState({
    session: session({ candidates: [candidate({ targetSnapshot: snapshot({ targetAuthorId: 'opp-2' }) as never })] }),
    // 作者换人时 approvalStillApplies 依然返回 true —— 这正是它只比较内容的结果。
    approvalApplies: true,
  })

  // 但页面必须把"身份未在本页核验"说出来，不能只显示"已批准"。
  assert.equal(state.approval.content.applies, true)
  assert.equal(state.approval.target.state, 'not_rechecked')
  assert.match(state.notices.join(''), /目标作者身份/)
})
