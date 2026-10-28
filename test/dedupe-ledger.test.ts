/**
 * Publish-ledger regressions for v0.1.4.
 *
 * The bug these pin down: a dedupe row records that a trigger was already answered,
 * but the row used to be tied to the session that produced it. When that session aged
 * out of the TTL window, re-analysing the same trigger deleted the row and inserted a
 * blank one, so a confirmed publish became "never sent" and the user could be offered a
 * second reply for a summons already answered.
 *
 * Each test asserts on the persisted ledger and on the number of real publish calls,
 * not on the message a function returns — a guard that returns "refused" while still
 * calling the platform is not a guard.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore, dedupeKey } from '../lib/store.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { runAnalysis, runGeneration, runPublish, type Runtime } from '../lib/runtime.js'
import { FakeAdapter, threePartyThread, grantApproval } from './helpers.ts'

/** A model answer aimed at the fixture's opponent. */
function modelReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'ok',
    owner_position: '成本会翻倍',
    opponent_position: '缺少依据',
    main_dispute: '成本问题',
    latest_argument: '你凭什么说成本会翻倍',
    response_target_id: 'n5',
    strategy: 'demand_evidence',
    confidence: 0.8,
    uncertainties: [],
    reply: '前面已经把报价贴出来了，你是没看还是不想看？要反驳就拿出同型号的价格。',
    ...overrides,
  })
}

interface Rig {
  readonly runtime: Runtime
  readonly adapter: FakeAdapter
  readonly store: DebateStore
  readonly dir: string
  readonly dispose: () => void
}

/**
 * Build a runtime over a fresh store.
 *
 * `sessionTtlMs` is a parameter because the whole point of these regressions is what
 * survives when a session is pruned; passing it here keeps that explicit rather than
 * hidden behind a fixture default.
 */
function makeRig(input: { sessionTtlMs?: number; dir?: string; maxPublishesPerThread?: number } = {}): Rig {
  const dir = input.dir ?? mkdtempSync(join(tmpdir(), 'debate-ledger-'))
  const store = new DebateStore({ dir, sessionTtlMs: input.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000 })
  const data = threePartyThread()
  const adapter = new FakeAdapter(data)
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    ownerUserId: 'owner-1',
    aiAccountUserId: '1001',
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
  })
  // A generous queue: a test that generates a few times must not fail because the
  // scripted model ran dry, which would look like a ledger bug.
  const client = new ScriptedLlmClient(Array.from({ length: 8 }, () => ({ text: modelReply() })))
  const runtime: Runtime = {
    adapter,
    store,
    policy: {
      mode: 'manual',
      maxAutoPublishesPerSession: 0,
      cooldownMs: 0,
      maxPublishesPerThread: input.maxPublishesPerThread ?? 10,
      stopOnChallenge: true,
    },
    config: () => config,
    llm: () => client,
    log: () => undefined,
  }
  return {
    runtime,
    adapter,
    store,
    dir,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Drive a session all the way to a real publish, and return what happened. */
async function publishOnce(rig: Rig, sessionId: string): Promise<{ ok: boolean; message: string }> {
  const generated = await runGeneration(rig.runtime, { sessionId })
  // v0.2.5: the publisher reads a stored approval, not the caller's boolean. Without
  // this the publish is refused in manual mode and the test would be asserting on a
  // refusal rather than on the dedupe behaviour it is about.
  await grantApproval(rig.runtime.store, {
    sessionId,
    candidateId: generated.candidateId,
    config: rig.runtime.config,
  })
  const report = await runPublish(rig.runtime, {
    sessionId,
    candidateId: generated.candidateId,
    approvedText: generated.text,
  })
  return { ok: report.ok, message: report.message }
}

/**
 * Mark the only session in the store as published and stamp the ledger confirmed.
 *
 * This is how the tests simulate "a reply was sent in an earlier process, then the
 * session aged out" without needing a real platform call in the setup.
 */
async function simulateConfirmedPublish(store: DebateStore, key: string, postId: string): Promise<void> {
  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((session) => ({
      ...session,
      state: 'PUBLISHED' as const,
      updatedAt: '2020-01-01T00:00:00Z',
      publishedPostIds: [postId],
    })),
    dedupe: data.dedupe.map((record) =>
      record.key === key
        ? {
            ...record,
            publishState: 'confirmed' as const,
            publishedPostId: postId,
            firstSeenAt: '2020-01-01T00:00:00Z',
          }
        : record,
    ),
  }))
}

test('confirmed publish survives session expiry and blocks a second one', async () => {
  const rig = makeRig({ sessionTtlMs: 60_000 })
  try {
    const data = threePartyThread()
    const first = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const key = rig.store.snapshot().dedupe[0]!.key
    await simulateConfirmedPublish(rig.store, key, 'already-sent')

    // The prune drops the session; the ledger row must not follow it.
    assert.equal(rig.store.getSession(first.sessionId), undefined, '旧会话应该已经被 TTL 清理')
    assert.equal(rig.store.findDedupe(key)?.publishState, 'confirmed', '清理会话不能删除已确认发表的防重记录')

    const again = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const after = rig.store.findDedupe(key)
    assert.equal(after?.publishState, 'confirmed', '重新分析不得把 confirmed 覆盖成 undefined')
    assert.equal(after?.publishedPostId, 'already-sent', '历史已发表的 postId 不能被丢弃')

    // The new session is read-only: it records the history and cannot be published.
    const session = rig.store.getSession(again.sessionId)
    assert.equal(session?.state, 'PUBLISHED', '重分析应生成只读会话，而不是可发布的新会话')
    assert.deepEqual(session?.publishedPostIds, ['already-sent'], '只读会话应带上历史 post id')

    // v0.2.5: no approval is created here on purpose. The session is read-only, so
    // the publish is refused by the state check, which runs before authorisation —
    // that refusal is what this test is about, and minting a record for a session
    // with no candidates would fail for an unrelated reason.
    const report = await runPublish(rig.runtime, {
      sessionId: again.sessionId,
      candidateId: `${again.sessionId}-c1`,
      approvedText: '不会发出去',
    })
    assert.equal(report.ok, false, '已发表的召唤不允许再次发表')
    assert.equal(rig.adapter.publishes.length, 0, '被拒绝的发表不能真的调用平台')
  } finally {
    rig.dispose()
  }
})

test('pending publish survives session expiry and still blocks a retry', async () => {
  const rig = makeRig({ sessionTtlMs: 60_000 })
  try {
    const data = threePartyThread()
    const first = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const key = rig.store.snapshot().dedupe[0]!.key

    // An attempt whose outcome was never confirmed: it may have been sent.
    // The session is put in a terminal state so the TTL prune removes it — the
    // pending *ledger* row is what must survive.
    await rig.store.mutate((store) => ({
      ...store,
      sessions: store.sessions.map((session) => ({
        ...session,
        state: 'FAILED' as const,
        updatedAt: '2020-01-01T00:00:00Z',
      })),
      dedupe: store.dedupe.map((record) =>
        record.key === key ? { ...record, publishState: 'pending' as const, firstSeenAt: '2020-01-01T00:00:00Z' } : record,
      ),
    }))
    void first

    assert.equal(rig.store.findDedupe(key)?.publishState, 'pending', 'pending 记录必须保留')

    const again = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    assert.equal(rig.store.findDedupe(key)?.publishState, 'pending', '重新分析不得清除 pending')

    const session = rig.store.getSession(again.sessionId)
    assert.equal(session?.state, 'NEEDS_CONFIRMATION', 'pending 历史应产出待人工核实的只读会话')

    // v0.2.5: no approval is created here on purpose. The session is read-only, so
    // the publish is refused by the state check, which runs before authorisation —
    // that refusal is what this test is about, and minting a record for a session
    // with no candidates would fail for an unrelated reason.
    const report = await runPublish(rig.runtime, {
      sessionId: again.sessionId,
      candidateId: `${again.sessionId}-c1`,
      approvedText: '不会发出去',
    })
    assert.equal(report.ok, false, 'pending 的召唤不允许直接重试发表')
    assert.equal(rig.adapter.publishes.length, 0, '被拒绝的发表不能真的调用平台')
  } finally {
    rig.dispose()
  }
})

test('a confirmed publish survives a process restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-restart-'))
  let key = ''
  try {
    const first = makeRig({ dir, sessionTtlMs: 60_000 })
    const analysis = await runAnalysis(first.runtime, { url: threePartyThread().thread.url, postId: 'n7' })
    key = first.store.snapshot().dedupe[0]!.key
    await simulateConfirmedPublish(first.store, key, 'sent-before-restart')
    void analysis

    // A brand-new store over the same directory: nothing in memory survives.
    const second = makeRig({ dir, sessionTtlMs: 60_000 })
    await second.store.ready()
    const restored = second.store.findDedupe(key)
    assert.equal(restored?.publishState, 'confirmed', '重启后 confirmed 必须还在')
    assert.equal(restored?.publishedPostId, 'sent-before-restart', '重启后 post id 必须还在')

    const again = await runAnalysis(second.runtime, { url: threePartyThread().thread.url, postId: 'n7' })
    assert.equal(second.store.findDedupe(key)?.publishState, 'confirmed', '重启后再分析仍不得覆盖')
    assert.equal(second.store.getSession(again.sessionId)?.state, 'PUBLISHED', '重启后也应是只读会话')
    assert.equal(second.adapter.publishes.length, 0, '重启后不得重新发表')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two concurrent analyses of one trigger produce exactly one session', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    // Both calls start before either finishes, which is the race the store's
    // single-mutate decision has to absorb.
    const [a, b] = await Promise.all([
      runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' }),
      runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' }),
    ])

    assert.equal(a.sessionId, b.sessionId, '同一条召唤的并发分析必须复用同一个会话')
    const sessions = rig.store.snapshot().sessions.filter((session) => session.triggerPostId === 'n7')
    assert.equal(sessions.length, 1, '并发分析不能创建第二个会话')
    assert.equal(rig.store.snapshot().dedupe.filter((r) => r.triggerPostId === 'n7').length, 1, '防重记录不能重复')
  } finally {
    rig.dispose()
  }
})

test('different triggers keep independent ledger rows', async () => {
  const rig = makeRig({ sessionTtlMs: 60_000 })
  try {
    const data = threePartyThread()
    const first = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const firstKey = dedupeKey({
      platform: 'tieba',
      threadId: data.thread.id,
      ownerKey: rig.store.getSession(first.sessionId)!.ownerKey,
      triggerPostId: 'n7',
    })
    await simulateConfirmedPublish(rig.store, firstKey, 'sent-for-n7')

    // A second, different trigger: the owner's earlier reply in the same thread.
    // The first session is PUBLISHED and dated 2020, so it is pruned first — which
    // also proves the second analysis is not blocked by the first one's history.
    const other = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n1' })

    assert.notEqual(other.sessionId, first.sessionId, '不同召唤必须是不同会话')
    const sessions = rig.store.snapshot().sessions
    assert.equal(sessions.length, 1, '过期的第一条会话应被清理，只留下新的这条')
    assert.equal(sessions[0]!.triggerPostId, 'n1')
    const otherRow = rig.store.snapshot().dedupe.find((r) => r.triggerPostId === 'n1')
    assert.notEqual(otherRow?.publishState, 'confirmed', '不同召唤不得共享发表状态')
    assert.equal(rig.store.getSession(other.sessionId)?.state !== 'PUBLISHED', true, '第二条召唤不该被当成已发表')
    assert.equal(rig.store.findDedupe(firstKey)?.publishState, 'confirmed', '第一条召唤的记录不受影响')
    assert.equal(rig.store.snapshot().dedupe.filter((r) => r.publishState === 'confirmed').length, 1)
  } finally {
    rig.dispose()
  }
})

test('a failed publish may be retried, and the retry keeps the original firstSeenAt', async () => {
  // A 60-second TTL would prune a `failed` row dated years ago — by design, since
  // nothing was sent. This test needs the row to *survive* the prune so the merge
  // path is what gets exercised, so the timestamp is recent and the TTL is long.
  const rig = makeRig({ sessionTtlMs: 7 * 24 * 60 * 60 * 1000 })
  try {
    const data = threePartyThread()
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const key = rig.store.snapshot().dedupe[0]!.key
    const firstSeen = new Date(Date.now() - 1000).toISOString()

    await rig.store.mutate((store) => ({
      ...store,
      dedupe: store.dedupe.map((record) =>
        record.key === key ? { ...record, publishState: 'failed' as const, firstSeenAt: firstSeen } : record,
      ),
    }))
    void analysis

    // `failed` means nothing was sent, so the row stays retryable.
    const again = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const row = rig.store.findDedupe(key)
    assert.notEqual(row?.publishState, 'confirmed')
    assert.equal(row?.firstSeenAt, firstSeen, 'firstSeenAt 是历史事实，不得被重写')
    assert.notEqual(
      rig.store.getSession(again.sessionId)?.state,
      'PUBLISHED',
      'failed 不应产出只读会话',
    )
  } finally {
    rig.dispose()
  }
})

test('the ledger row is merged, never replaced with a blank one', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const key = rig.store.snapshot().dedupe[0]!.key
    void analysis

    // Re-analyse after the session is pruned; the stored row must keep its payload.
    await rig.store.mutate((store) => ({
      ...store,
      sessions: store.sessions.map((session) => ({ ...session, state: 'CANCELLED' as const, updatedAt: '2020-01-01T00:00:00Z' })),
      dedupe: store.dedupe.map((record) =>
        record.key === key ? { ...record, publishState: 'confirmed' as const, publishedPostId: 'kept-id' } : record,
      ),
    }))
    await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })

    const row = rig.store.findDedupe(key)
    assert.equal(row?.publishState, 'confirmed')
    assert.equal(row?.publishedPostId, 'kept-id')
    assert.equal(row?.platform, 'tieba', '重写不应丢掉身份字段')
    assert.equal(row?.triggerPostId, 'n7')
  } finally {
    rig.dispose()
  }
})

test('publishing twice through the full pipeline sends exactly one reply', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const first = await publishOnce(rig, analysis.sessionId)
    assert.equal(first.ok, true, `首次发表应该成功：${first.message}`)
    assert.equal(rig.adapter.publishes.length, 1, '首次发表应调用平台一次')

    // Re-analyse the same trigger in the same process, then try again.
    const again = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const second = await publishOnce(rig, again.sessionId).catch((error: Error) => ({
      ok: false,
      message: error.message,
    }))
    assert.equal(second.ok, false, '同一条召唤不允许发表第二次')
    assert.equal(rig.adapter.publishes.length, 1, '第二次尝试不能调用平台')
  } finally {
    rig.dispose()
  }
})
