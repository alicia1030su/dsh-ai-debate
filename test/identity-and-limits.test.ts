/**
 * P1 regressions for v0.1.4: identity that is only a display name, and per-thread
 * limits that must survive session expiry.
 *
 * Both are fail-closed rules, so the assertions are about *not* calling the platform
 * as much as about the message returned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { runAnalysis, runGeneration, runPublish, type Runtime } from '../lib/runtime.js'
import { hasStableAuthor } from '../lib/target.js'
import { FakeAdapter, threePartyThread, grantApproval } from './helpers.ts'

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

function makeRig(input: {
  sessionTtlMs?: number
  maxPublishesPerThread?: number
  /** Drop every author id, so the fixture behaves like a name-only platform. */
  stripAuthorIds?: boolean
  /** Which post the scripted model claims to answer. */
  replyTargetId?: string
  /** Thread fixture to serve, for the two-thread cases. */
  data?: ReturnType<typeof threePartyThread>
  /** Reuse an existing store directory, to simulate a restart. */
  dir?: string
} = {}): {
  runtime: Runtime
  adapter: FakeAdapter
  store: DebateStore
  dir: string
  dispose: () => void
} {
  const dir = input.dir ?? mkdtempSync(join(tmpdir(), 'debate-p1-'))
  const store = new DebateStore({ dir, sessionTtlMs: input.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000 })
  const base = input.data ?? threePartyThread()
  const data = input.stripAuthorIds
    ? {
        thread: base.thread,
        floors: base.floors.map((floor) => ({ ...floor, authorId: '' })),
        nested: Object.fromEntries(
          Object.entries(base.nested).map(([key, replies]) => [key, replies.map((r) => ({ ...r, authorId: '' }))]),
        ),
      }
    : base
  const adapter = new FakeAdapter(data as typeof base)
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    ownerUserId: 'owner-1',
    aiAccountUserId: '1001',
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
  })
  const target = input.replyTargetId ?? 'n5'
  const client = new ScriptedLlmClient(
    Array.from({ length: 8 }, () => ({ text: modelReply({ response_target_id: target }) })),
  )
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

test('a snapshot with only a display name is not a stable author', () => {
  const named = {
    platform: 'tieba' as const,
    threadId: '1',
    floorPostId: 'f1',
    floorNumber: 1,
    targetPostId: 'n1',
    targetKind: 'nested' as const,
    targetAuthorName: '对手B',
    contentHash: 'abc',
    capturedAt: '2026-01-01T00:00:00Z',
  }
  assert.equal(hasStableAuthor(named), false, '只有昵称不能算稳定作者')

  const withId = { ...named, targetAuthorId: '6631433126' }
  assert.equal(hasStableAuthor(withId), true, '有数字 ID 才算稳定作者')

  const emptyId = { ...named, targetAuthorId: '' }
  assert.equal(hasStableAuthor(emptyId), false, '空字符串不算稳定 ID')
})

test('publishing is refused when the target is identified only by a nickname', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const generated = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })

    // Simulate a platform read that exposed no id for the target — the shape that
    // motivates the rule. The name is still there, and still not proof.
    await rig.store.mutate((store) => ({
      ...store,
      sessions: store.sessions.map((session) => ({
        ...session,
        candidates: session.candidates.map((candidate) =>
          candidate.targetSnapshot
            ? {
                ...candidate,
                targetSnapshot: {
                  ...candidate.targetSnapshot,
                  targetAuthorId: undefined,
                  targetAuthorName: candidate.targetSnapshot.targetAuthorName ?? '对手B',
                },
              }
            : candidate,
        ),
      })),
    }))

    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: analysis.sessionId, candidateId: generated.candidateId, config: rig.runtime.config })
    const report = await runPublish(rig.runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
    })

    assert.equal(report.ok, false, '只有昵称的作者不允许发表')
    assert.equal(report.errorCode, 'author_unverifiable', `拒绝理由应是作者不可核实，实际是 ${report.errorCode}`)
    assert.equal(rig.adapter.publishes.length, 0, '被拒绝的发表不能真的调用平台')
  } finally {
    rig.dispose()
  }
})

test('publishing still works when the target carries a stable id', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const generated = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })
    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: analysis.sessionId, candidateId: generated.candidateId, config: rig.runtime.config })
    const report = await runPublish(rig.runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
    })
    assert.equal(report.ok, true, `有稳定 ID 时应该能发表：${report.message}`)
    assert.equal(rig.adapter.publishes.length, 1)
  } finally {
    rig.dispose()
  }
})

test('the per-thread cap is counted from the ledger, so expiry cannot reset it', async () => {
  // One publish allowed per thread. The first publish succeeds; then every session
  // is aged out, so only the permanent ledger row is left to remember it.
  const first = makeRig({ maxPublishesPerThread: 1 })
  const dir = first.dir
  try {
    const data = threePartyThread()
    const analysis = await runAnalysis(first.runtime, { url: data.thread.url, postId: 'n7' })
    const generated = await runGeneration(first.runtime, { sessionId: analysis.sessionId })
    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(first.runtime.store, { sessionId: analysis.sessionId, candidateId: generated.candidateId, config: first.runtime.config })
    const sent = await runPublish(first.runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
    })
    assert.equal(sent.ok, true, `首次发表应该成功：${sent.message}`)
    assert.equal(first.adapter.publishes.length, 1)

    await first.store.mutate((store) => ({
      ...store,
      sessions: store.sessions.map((s) => ({ ...s, state: 'PUBLISHED' as const, updatedAt: '2020-01-01T00:00:00Z' })),
    }))

    // A fresh process over the same directory: the session is gone, the ledger is not.
    // The model still answers 对手B (whose latest post is n5) — the point of this test
    // is the quota, not the target, so the reply stays aimed where the fixture expects.
    const second = makeRig({ dir, maxPublishesPerThread: 1, sessionTtlMs: 1 })
    await second.store.ready()
    assert.equal(second.store.getSession(analysis.sessionId), undefined, '旧会话应已被清理')
    // The signature takes (platform, threadId) since v0.2.1: thread ids are only
    // unique within a platform, so counting activity without one was a
    // cross-platform bug waiting for a second platform to exist.
    assert.equal(
      second.store.threadPublishActivity(data.thread.platform, data.thread.id).confirmed,
      1,
      '流水账应记住这次发表',
    )

    // A different trigger on the same thread, which has already used its quota.
    const other = await runAnalysis(second.runtime, { url: data.thread.url, postId: 'n4' })
    const otherGen = await runGeneration(second.runtime, { sessionId: other.sessionId })
    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(second.runtime.store, { sessionId: other.sessionId, candidateId: otherGen.candidateId, config: second.runtime.config })
    const blocked = await runPublish(second.runtime, {
      sessionId: other.sessionId,
      candidateId: otherGen.candidateId,
      approvedText: otherGen.text,
    })

    assert.equal(blocked.ok, false, '本帖已达上限，会话过期不能把额度清零')
    assert.equal(blocked.errorCode, 'thread_limit', `拒绝理由应是帖子级上限，实际是 ${blocked.errorCode}：${blocked.message}`)
    assert.equal(second.adapter.publishes.length, 0, '被上限拦下的发表不能调用平台')
  } finally {
    first.dispose()
  }
})

test('the cap for one thread does not block another thread', async () => {
  const rig = makeRig({ maxPublishesPerThread: 1 })
  try {
    const data = threePartyThread()
    const first = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const gen = await runGeneration(rig.runtime, { sessionId: first.sessionId })
    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: first.sessionId, candidateId: gen.candidateId, config: rig.runtime.config })
    const sent = await runPublish(rig.runtime, {
      sessionId: first.sessionId,
      candidateId: gen.candidateId,
      approvedText: gen.text,
    })
    assert.equal(sent.ok, true, `首次发表应该成功：${sent.message}`)
    assert.equal(rig.adapter.publishes.length, 1)

    // A second thread with its own quota, sharing the same ledger.
    const other = threePartyThread({ threadId: '900000000999', postPrefix: 'x' })
    const otherAdapter = new FakeAdapter(other)
    const otherClient = new ScriptedLlmClient(
      Array.from({ length: 8 }, () => ({ text: modelReply({ response_target_id: 'xn5' }) })),
    )
    const otherRuntime: Runtime = {
      ...rig.runtime,
      adapter: otherAdapter,
      llm: () => otherClient,
    }
    const otherAnalysis = await runAnalysis(otherRuntime, { url: other.thread.url, postId: 'xn7' })
    const otherGen = await runGeneration(otherRuntime, { sessionId: otherAnalysis.sessionId })
    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(otherRuntime.store, { sessionId: otherAnalysis.sessionId, candidateId: otherGen.candidateId, config: otherRuntime.config })
    const otherSent = await runPublish(otherRuntime, {
      sessionId: otherAnalysis.sessionId,
      candidateId: otherGen.candidateId,
      approvedText: otherGen.text,
    })

    assert.equal(otherSent.ok, true, `另一个帖子不应受限：${otherSent.message}`)
    assert.equal(otherAdapter.publishes.length, 1)
  } finally {
    rig.dispose()
  }
})

test('an unresolved attempt occupies a thread slot', async () => {
  const rig = makeRig({ maxPublishesPerThread: 1 })
  try {
    const data = threePartyThread()
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })

    // A prior attempt on this thread whose outcome was never confirmed.
    await rig.store.mutate((store) => ({
      ...store,
      dedupe: store.dedupe.map((record) => ({ ...record, publishState: 'pending' as const })),
    }))

    const generated = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })
    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: analysis.sessionId, candidateId: generated.candidateId, config: rig.runtime.config })
    const report = await runPublish(rig.runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
    })

    assert.equal(report.ok, false, '未决结果应占住名额，不能当作空位')
    assert.equal(rig.adapter.publishes.length, 0)
  } finally {
    rig.dispose()
  }
})
