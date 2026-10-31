/**
 * The two write actions the workbench owns, and the rule that makes them safe together
 * (v0.2.22 §三/§五).
 *
 * ## What is tested here versus in `v0222-workbench.test.ts`
 *
 * That file pins the *derivation* — which step, which blockers, whether an approval still binds.
 * This one pins the two operations that change durable state: editing prose (which must retire
 * the approval and the assessment) and recording a publish outcome (which must never be read
 * back as success unless all four facts held).
 *
 * Both run against the real `DebateStore` on a temp directory, because the thing that can go
 * wrong is what ends up **on disk** — an in-memory double would agree with whatever the code did.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { buildRuntime } from '../lib/index.js'
import { editCandidate } from '../lib/runtime.js'
import { approvalStillApplies, deriveWorkbenchState } from '../lib/workbench.js'
import type { StoredCandidate, StoredSession } from '../lib/store.js'

const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} } as never
const NOW = '2026-10-31T12:00:00.000Z'

function withTempDir(name: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `debate-${name}-`))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function runtimeAt(dir: string) {
  const config = { ...DEFAULT_CONFIG, storeDir: dir, llmBaseUrl: 'http://127.0.0.1:1/v1', llmModel: 'm' }
  return buildRuntime(() => resolveConfig(config), quietLog, { list: () => [], register: () => undefined } as never)
}

function candidate(overrides: Partial<StoredCandidate> = {}): StoredCandidate {
  return {
    replyId: 'c1',
    text: '原来的正文',
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
    security: {
      verdict: 'allow',
      fingerprint: 'fp-1',
      reasons: [],
      checkedAt: NOW,
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

test('编辑正文会重算哈希、升版本、清掉批准与安全评估', async () => {
  const { dir, done } = withTempDir('edit')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session())

    const result = await editCandidate(runtime, {
      sessionId: 's1',
      candidateId: 'c1',
      text: '  改过的正文，前后空白要去掉  ',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return

    const stored = runtime.store.getSession('s1')!.candidates[0]!
    assert.equal(stored.text, '改过的正文，前后空白要去掉', '正文要按去空白后的结果存')
    assert.equal(stored.textHash, result.textHash)
    assert.notEqual(stored.textHash, 'hash-old', '正文改了哈希必须跟着变')
    assert.equal(stored.candidateVersion, 2, '版本要升：重新生成与手工编辑都不该复用旧批准')
    assert.equal(stored.approved, false, '编辑之后必须变成未批准')
    assert.equal(stored.security, undefined, '安全评估是针对旧正文的，改了正文就不能继续沿用')
  } finally {
    done()
  }
})

test('编辑之后旧批准不再适用（同一个候选、旧哈希）', async () => {
  const { dir, done } = withTempDir('edit-approval')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session())
    await editCandidate(runtime, { sessionId: 's1', candidateId: 'c1', text: '新正文' })
    const stored = runtime.store.getSession('s1')!.candidates[0]!

    const freshness = approvalStillApplies({
      candidate: stored,
      approval: {
        candidateId: 'c1',
        candidateVersion: 1,
        textHash: 'hash-old',
        targetPostId: 'p-2',
      },
    })
    assert.equal(freshness.applies, false)
  } finally {
    done()
  }
})

test('编辑后工作台回到「批准」步骤，而不是仍然显示可发表', async () => {
  const { dir, done } = withTempDir('edit-step')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session())
    await editCandidate(runtime, { sessionId: 's1', candidateId: 'c1', text: '新正文' })
    const stored = runtime.store.getSession('s1')!

    const state = deriveWorkbenchState({ session: stored, approvalApplies: false })
    assert.equal(state.step, 'approve', '编辑过就该回到批准，否则页面会请人发一段没人批过的字')
    assert.match(state.blockers.join(''), /失效|没有/)
  } finally {
    done()
  }
})

test('空正文被拒绝，不会把候选改成空回复', async () => {
  const { dir, done } = withTempDir('edit-empty')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session())
    const result = await editCandidate(runtime, { sessionId: 's1', candidateId: 'c1', text: '   ' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /不能是空/)
    assert.equal(runtime.store.getSession('s1')!.candidates[0]!.text, '原来的正文', '拒绝时不得改动正文')
  } finally {
    done()
  }
})

test('已发表的候选不允许编辑', async () => {
  const { dir, done } = withTempDir('edit-published')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session({ candidates: [candidate({ publishedPostId: 'r-1' })] }))
    const result = await editCandidate(runtime, { sessionId: 's1', candidateId: 'c1', text: '想改' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /已经发表过/)
  } finally {
    done()
  }
})

test('找不到会话或候选时明确拒绝，不是静默成功', async () => {
  const { dir, done } = withTempDir('edit-missing')
  try {
    const runtime = runtimeAt(dir)
    await seed(runtime, session())
    const noSession = await editCandidate(runtime, { sessionId: 'nope', candidateId: 'c1', text: 'x' })
    assert.equal(noSession.ok, false)
    const noCandidate = await editCandidate(runtime, { sessionId: 's1', candidateId: 'nope', text: 'x' })
    assert.equal(noCandidate.ok, false)
  } finally {
    done()
  }
})

test('回读四要素逐项透出，而不是只给一个 confirmed', () => {
  const state = deriveWorkbenchState({
    session: session({ state: 'PUBLISHED', candidates: [candidate({ publishedPostId: 'r-1' })] }),
    approvalApplies: true,
    lastAttempt: {
      status: 'confirmed',
      readBack: {
        postFound: true,
        authorMatched: true,
        textMatched: false,
        parentMatched: true,
        notes: ['正文与批准的正文不一致'],
      },
    },
  })
  assert.ok(state.readBack !== undefined, '回读证据必须能到达界面')
  assert.equal(state.readBack?.textMatched, false)
  assert.match(state.readBack?.notes.join('') ?? '', /正文/)
})

test('没有回读证据时不编造四项事实', () => {
  const state = deriveWorkbenchState({
    session: session(),
    approvalApplies: true,
    lastAttempt: { status: 'uncertain' },
  })
  assert.equal(state.readBack, undefined, '没回读就没有证据，不能给一个全 true 的形状')
  assert.equal(state.outcome, 'unknown')
  assert.equal(state.step, 'readback')
})
