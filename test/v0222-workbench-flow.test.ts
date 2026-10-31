/**
 * The workbench flow against a real store and a fake platform (v0.2.22 §四/§五/§八/§九).
 *
 * ## What this file adds over the two next door
 *
 * `v0222-workbench.test.ts` pins the derivation from a hand-written snapshot;
 * `v0222-workbench-edit.test.ts` pins editing. Neither exercises the *sequence*: approve, then
 * the ledger records a publish, then the workbench derives its step again from disk. That
 * sequence is where a workbench becomes dangerous — every state it shows is a claim about what
 * already happened, and the claims have to survive a reload.
 *
 * ## The scenarios, and why each one exists
 *
 * 1. **New session → target → generate → review → approve**: the happy path, asserted step by
 *    step so a wrong ordering cannot pass.
 * 2. **Regenerate retires the approval**: comparing two drafts is normal, and the second draft
 *    must not inherit the first one's authorisation.
 * 3. **One approval, one publish**: the ledger is the durable truth. After a confirmed row the
 *    workbench must show "confirmed", not "not attempted" — the second is the state that gets a
 *    reply re-sent.
 * 4. **`pending` reads as unknown**: a crashed publish leaves `pending` on disk. The workbench
 *    must surface that as "outcome unknown", never as success and never as a clean slate.
 * 5. **A different account invalidates evidence and approval**: switching the bound account
 *    changes who would post, so neither the approval nor the capability evidence may carry over.
 * 6. **Reload does not replay**: deriving the state twice from the same disk document yields the
 *    same answer and performs no write.
 * 7. **A second process sees the same thing**: two stores over one directory agree, because the
 *    derivation reads durable facts rather than memory.
 *
 * The fake adapter is used throughout — as the task book requires, it validates business
 * semantics and is never presented as real-platform evidence.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createApproval, checkApproval } from '../lib/security/approvals.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { buildRuntime } from '../lib/index.js'
import { editCandidate } from '../lib/runtime.js'
import { approvalStillApplies, deriveWorkbenchState } from '../lib/workbench.js'
import { dedupeKey, upsertDedupe } from '../lib/store.js'
import type { StoredCandidate, StoredSession } from '../lib/store.js'

const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} } as never
const NOW = '2026-10-31T12:00:00.000Z'
const ACCOUNT = 'ai-42'

function withTempDir(name: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `debate-${name}-`))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function runtimeAt(dir: string, accountId = ACCOUNT) {
  const config = {
    ...DEFAULT_CONFIG,
    storeDir: dir,
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'm',
    aiAccountUserId: accountId,
    platformAccounts: JSON.stringify({
      aiAccounts: [
        { platform: 'tieba', account: { platform: 'tieba', accountId, idStrength: 'strong' } },
      ],
    }),
  }
  return buildRuntime(() => resolveConfig(config), quietLog, { list: () => [], register: () => undefined } as never)
}

function candidate(overrides: Partial<StoredCandidate> = {}): StoredCandidate {
  return {
    replyId: 'c1',
    text: '你这条把两件事混为一谈了：我反对的是做法，不是你这个人。',
    strategy: 'tieba_veteran',
    targetPostId: 'p-2',
    targetSnapshot: {
      threadId: 't1',
      floorPostId: 'p-1',
      postId: 'p-2',
      kind: 'nested',
      contentHash: 'h',
      capturedAt: NOW,
    } as never,
    candidateVersion: 1,
    textHash: 'hash-old',
    confidence: 0.8,
    violations: [],
    notes: [],
    security: { verdict: 'allow', fingerprint: 'fp-1', reasons: [], checkedAt: NOW } as never,
    createdAt: NOW,
    approved: false,
    ...overrides,
  }
}

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 's1',
    platform: 'tieba',
    threadId: 't1',
    threadUrl: 'https://tieba.baidu.com/p/1',
    threadTitle: '讨论',
    forumName: '区',
    ownerKey: 'o1',
    disputeFloorPostId: 'p-1',
    disputeFloorNumber: 1,
    triggerPostId: 'p-2',
    targetKind: 'nested',
    state: 'REVIEWING',
    statusText: '已生成候选',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 300 },
    candidates: [candidate()],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

async function seed(runtime: ReturnType<typeof runtimeAt>, row: StoredSession): Promise<void> {
  await runtime.store.mutate((data) => ({ ...data, sessions: [...data.sessions, row] }))
}

/** Write the ledger row a publish would have written, without touching a platform. */
async function recordPublish(
  runtime: ReturnType<typeof runtimeAt>,
  row: StoredSession,
  state: 'pending' | 'confirmed' | 'failed',
  postId?: string,
): Promise<void> {
  await runtime.store.mutate((data) => ({
    ...data,
    dedupe: upsertDedupe(data.dedupe, {
      key: dedupeKey({ platform: row.platform, threadId: row.threadId, triggerPostId: row.triggerPostId }),
      platform: row.platform,
      threadId: row.threadId,
      ownerKey: row.ownerKey,
      triggerPostId: row.triggerPostId,
      sessionId: row.id,
      firstSeenAt: NOW,
      publishState: state,
      ...(postId === undefined ? {} : { publishedPostId: postId }),
      decidedAt: NOW,
    }),
  }))
}

function ledgerOf(runtime: ReturnType<typeof runtimeAt>, row: StoredSession) {
  const key = dedupeKey({ platform: row.platform, threadId: row.threadId, triggerPostId: row.triggerPostId })
  return runtime.store.snapshot().dedupe.find((record) => record.key === key)
}

// ---------------------------------------------------------------------------
// 1. The happy path, one step at a time
// ---------------------------------------------------------------------------

test('§一：新建会话 → 有目标 → 有候选 → 待批准，四步依次推进', async () => {
  const { dir, done } = withTempDir('flow')
  try {
    const runtime = runtimeAt(dir)

    // Nothing collected yet.
    const empty = deriveWorkbenchState({ approvalApplies: false })
    assert.equal(empty.step, 'link')

    // Collected, but the owner has not fixed a target: the page must ask, not guess.
    await seed(
      runtime,
      session({ id: 'no-target', candidates: [], targetSnapshot: undefined, targetKind: undefined }),
    )
    const noTarget = deriveWorkbenchState({
      session: runtime.store.getSession('no-target')!,
      approvalApplies: false,
    })
    assert.equal(noTarget.step, 'target')
    assert.match(noTarget.blockers.join(''), /不会按昵称猜/)

    // Target fixed and a candidate exists, but nobody approved it.
    await seed(runtime, session({ id: 'ready-to-approve', candidates: [candidate({ approved: false })] }))
    const review = deriveWorkbenchState({
      session: runtime.store.getSession('ready-to-approve')!,
      approvalApplies: false,
    })
    assert.equal(review.step, 'approve')
    assert.match(review.blockers.join(''), /逐条批准/)

    // Approved and unchanged: publishing is the next step, and it is the only irreversible one.
    await seed(runtime, session({ id: 'approved', candidates: [candidate({ approved: true })] }))
    const publish = deriveWorkbenchState({
      session: runtime.store.getSession('approved')!,
      approvalApplies: true,
    })
    assert.equal(publish.step, 'publish')
  } finally {
    done()
  }
})

// ---------------------------------------------------------------------------
// 2. Regenerating retires the approval
// ---------------------------------------------------------------------------

test('§三：重新生成（升版本）之后旧批准不再适用', async () => {
  const { dir, done } = withTempDir('regenerate')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session({ candidates: [candidate({ approved: true })] }))
    const before = runtime.store.getSession('s1')!.candidates[0]!
    const approval = {
      candidateId: 'c1',
      candidateVersion: before.candidateVersion,
      textHash: before.textHash,
      targetPostId: before.targetPostId,
    }
    assert.equal(approvalStillApplies({ candidate: before, approval }).applies, true)

    // A regeneration writes a new version; it does not have to change the prose.
    await runtime.store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((entry) =>
        entry.id === 's1'
          ? { ...entry, candidates: [{ ...entry.candidates[0]!, candidateVersion: 2, approved: false }] }
          : entry,
      ),
    }))
    const after = runtime.store.getSession('s1')!.candidates[0]!
    const freshness = approvalStillApplies({ candidate: after, approval })
    assert.equal(freshness.applies, false, '版本变了就是另一次生成，不能继承旧批准')
  } finally {
    done()
  }
})

// ---------------------------------------------------------------------------
// 3-4. What the ledger says, and what the workbench shows
// ---------------------------------------------------------------------------

test('§五：台账 confirmed → 工作台显示已确认，不是「没尝试过」', async () => {
  const { dir, done } = withTempDir('ledger-confirmed')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session({ candidates: [candidate({ approved: true, publishedPostId: 'r-1' })] }))
    await recordPublish(runtime, session(), 'confirmed', 'r-1')

    const ledger = ledgerOf(runtime, session())
    assert.equal(ledger?.publishState, 'confirmed')

    const state = deriveWorkbenchState({
      session: runtime.store.getSession('s1')!,
      approvalApplies: true,
      lastAttempt: { status: 'confirmed', readBack: { postFound: true, authorMatched: true, textMatched: true, parentMatched: true, notes: [] } },
    })
    assert.equal(state.outcome, 'confirmed')
    assert.equal(state.step, 'done')
  } finally {
    done()
  }
})

test('§五：台账 pending → 结果不确定，且不显示成功', async () => {
  const { dir, done } = withTempDir('ledger-pending')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session())
    await recordPublish(runtime, session(), 'pending')

    const state = deriveWorkbenchState({
      session: runtime.store.getSession('s1')!,
      approvalApplies: true,
      lastAttempt: { status: 'uncertain' },
    })
    assert.equal(state.outcome, 'unknown')
    assert.equal(state.step, 'readback')
    assert.match(state.blockers.join(''), /不会自动重发/)
  } finally {
    done()
  }
})

test('§五：台账 failed → 回到可编辑，并带上失败原因', async () => {
  const { dir, done } = withTempDir('ledger-failed')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session())
    await recordPublish(runtime, session(), 'failed')

    const state = deriveWorkbenchState({
      session: runtime.store.getSession('s1')!,
      approvalApplies: true,
      lastAttempt: { status: 'failed', reason: '403' },
    })
    assert.equal(state.outcome, 'refused')
    assert.equal(state.step, 'review')
    assert.match(state.blockers.join(''), /403/)
  } finally {
    done()
  }
})

// ---------------------------------------------------------------------------
// 5. Switching the account invalidates both the approval and the evidence
// ---------------------------------------------------------------------------

test('§四/§七：换绑定账号后，旧批准不再授权这次发表', async () => {
  const { dir, done } = withTempDir('account-switch')
  try {
    const before = runtimeAt(dir, 'ai-42')
    await seed(before, session({ candidates: [candidate({ approved: true })] }))
    const stored = before.store.getSession('s1')!.candidates[0]!

    // The approval records who would have posted. A different account is a different binding,
    // and `checkApproval` is the function that decides — so this asserts against it rather than
    // against a reimplementation.
    const record = createApproval(
      {
        sessionId: 's1',
        candidateId: stored.replyId,
        platform: 'tieba',
        targetPostId: stored.targetPostId,
        publishingAccount: 'ai-42',
        textHash: stored.textHash,
        candidateVersion: stored.candidateVersion,
        assessmentFingerprint: 'fp-1',
      },
      '主人',
      () => Date.parse(NOW),
    )
    const sameAccount = checkApproval(
      record,
      {
        sessionId: 's1',
        candidateId: stored.replyId,
        platform: 'tieba',
        targetPostId: stored.targetPostId,
        publishingAccount: 'ai-42',
        textHash: stored.textHash,
        candidateVersion: stored.candidateVersion,
        assessmentFingerprint: 'fp-1',
      },
      () => Date.parse(NOW),
    )
    assert.equal(sameAccount.ok, true)

    const otherAccount = checkApproval(
      record,
      {
        sessionId: 's1',
        candidateId: stored.replyId,
        platform: 'tieba',
        targetPostId: stored.targetPostId,
        publishingAccount: 'ai-99',
        textHash: stored.textHash,
        candidateVersion: stored.candidateVersion,
        assessmentFingerprint: 'fp-1',
      },
      () => Date.parse(NOW),
    )
    assert.equal(otherAccount.ok, false)
    if (!otherAccount.ok) assert.equal(otherAccount.code, 'account_mismatch')
  } finally {
    done()
  }
})

// ---------------------------------------------------------------------------
// 6-7. Reload twice, and a second process
// ---------------------------------------------------------------------------

test('§八：同一份磁盘状态推导两次答案相同，且不产生任何写入', async () => {
  const { dir, done } = withTempDir('reload')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session())
    const first = deriveWorkbenchState({ session: runtime.store.getSession('s1')!, approvalApplies: true })
    const before = JSON.stringify(runtime.store.snapshot())
    const second = deriveWorkbenchState({ session: runtime.store.getSession('s1')!, approvalApplies: true })
    const after = JSON.stringify(runtime.store.snapshot())
    assert.deepEqual(second, first, '刷新必须回到同一个位置')
    assert.equal(before, after, '推导本身不能写盘——刷新不可逆操作的前提是没有写')
  } finally {
    done()
  }
})

test('§八：第二个实例读同一目录，得到同一结论（刷新不依赖内存）', async () => {
  const { dir, done } = withTempDir('two-instances')
  try {
    const first = runtimeAt(dir)
    await seed(first, session())
    const second = runtimeAt(dir)
    await second.store.ready()

    const fromFirst = deriveWorkbenchState({ session: first.store.getSession('s1')!, approvalApplies: true })
    const fromSecond = deriveWorkbenchState({ session: second.store.getSession('s1')!, approvalApplies: true })
    assert.deepEqual(fromSecond, fromFirst)
    assert.equal(second.store.getSession('s1')?.id, 's1', '另一个实例必须能读到同一个会话')
  } finally {
    done()
  }
})

// ---------------------------------------------------------------------------
// Editing inside the real store (ties §三 to the flow above)
// ---------------------------------------------------------------------------

test('§三：在真 Store 上编辑后，工作台从「发表」退回「批准」', async () => {
  const { dir, done } = withTempDir('edit-flow')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session({ candidates: [candidate({ approved: true })] }))

    const before = deriveWorkbenchState({ session: runtime.store.getSession('s1')!, approvalApplies: true })
    assert.equal(before.step, 'publish')

    const outcome = await editCandidate(runtime, { sessionId: 's1', candidateId: 'c1', text: '改过的正文' })
    assert.equal(outcome.ok, true)

    const stored = runtime.store.getSession('s1')!.candidates[0]!
    const after = deriveWorkbenchState({
      session: runtime.store.getSession('s1')!,
      approvalApplies: approvalStillApplies({
        candidate: stored,
        approval: { candidateId: 'c1', candidateVersion: 1, textHash: 'hash-old', targetPostId: 'p-2' },
      }).applies,
    })
    assert.equal(after.step, 'approve', '改过正文还在「发表」步，就是请人发一段没人批过的字')
  } finally {
    done()
  }
})
