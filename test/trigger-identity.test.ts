/**
 * v0.1.5 regressions: stable summon identity, legacy migration, and session capacity.
 *
 * Three ideas are pinned here, and each has already failed at least once in a shipped
 * version:
 *
 * 1. **One summons, one identity.** The ledger key is built from platform, thread and
 *    post — never from a display name. A nickname is user-editable, so keying on it
 *    meant renaming oneself re-opened a summon that had already been answered.
 * 2. **Upgrading must not forget history.** Users hold `state.json` files written by
 *    older versions, keyed by nickname. Those rows carry the publish facts and have to
 *    be found and folded into the canonical key.
 * 3. **`maxSessions` bounds finished history, not live work.** Dropping a `READY`
 *    draft to stay under a cache cap loses work the user cannot recover.
 *
 * The assertions check the persisted ledger and the real platform call count, because a
 * guard that *returns* "refused" while still posting is not a guard.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeDispute } from '../lib/analyzer.js'
import {
  DebateStore,
  canonicalTriggerId,
  dedupeKey,
  findTriggerRecords,
  mergeTriggerRecords,
  type DedupeRecord,
} from '../lib/store.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { runAnalysis, runGeneration, runPublish, type Runtime } from '../lib/runtime.js'
import { FakeAdapter, threePartyThread } from './helpers.ts'

const THREAD_ID = '900000000000'
const OWNER_ID = '111111'
const TRIGGER_ID = 'n7'

/** The post the owner wrote that summons the AI, in the shared fixture. */
const OWNER_TRIGGER = 'n7'

/**
 * A `CollectedThread` shaped the way `analyzeDispute` expects.
 *
 * Built from the shared `threePartyThread` fixture rather than hand-rolled, so the
 * analyzer sees the same relations the rest of the suite exercises.
 */
function collectedThread(ownerName: string, triggerPostId = OWNER_TRIGGER): ReturnType<typeof threePartyThread> & {
  floors: { floor: unknown; nested: unknown[]; nestedComplete: boolean }[]
} {
  const base = threePartyThread()
  const floorPostId = base.floors[0]!.postId
  const nested = base.nested[floorPostId]!.map((reply) =>
    reply.postId === triggerPostId ? { ...reply, authorName: ownerName } : reply,
  )
  return {
    ...base,
    floors: [{ floor: base.floors[0]!, nested, nestedComplete: true }],
  } as never
}

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

function makeRig(input: { dir?: string; maxSessions?: number; sessionTtlMs?: number } = {}): Rig {
  const dir = input.dir ?? mkdtempSync(join(tmpdir(), 'debate-v015-'))
  const store = new DebateStore({
    dir,
    sessionTtlMs: input.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000,
    ...(input.maxSessions === undefined ? {} : { maxSessions: input.maxSessions }),
  })
  const data = threePartyThread()
  const adapter = new FakeAdapter(data)
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    ownerUserId: 'owner-1',
    aiAccountUserId: '1001',
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
  })
  const client = new ScriptedLlmClient(Array.from({ length: 8 }, () => ({ text: modelReply() })))
  const runtime: Runtime = {
    adapter,
    store,
    policy: {
      mode: 'manual',
      maxAutoPublishesPerSession: 0,
      cooldownMs: 0,
      maxPublishesPerThread: 10,
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

/** Wait for the store to see a session (used to assert a live one survived). */
function hasSession(store: DebateStore, id: string): boolean {
  return store.getSession(id) !== undefined
}

// ---------------------------------------------------------------------------
// P0 — canonical identity
// ---------------------------------------------------------------------------

test('P0: a display-name change does not change the dedupe identity', () => {
  const keys = ['主人旧昵称', '主人新昵称', '完全不同的名字'].map((name) => {
    // The fixture keeps the numeric author id and varies only the display name.
    const dispute = analyzeDispute(collectedThread(name) as never, { userId: 'owner-1' }, {
      postId: OWNER_TRIGGER,
    })
    assert.equal(dispute.owner.userId, 'owner-1', '两次分析必须认出同一个稳定用户')
    return dedupeKey({
      platform: 'tieba',
      threadId: THREAD_ID,
      ownerKey: dispute.owner.key,
      triggerPostId: OWNER_TRIGGER,
    })
  })
  assert.equal(new Set(keys).size, 1, '改名不得产生第二个幂等身份')
  assert.equal(
    keys[0],
    canonicalTriggerId({ platform: 'tieba', threadId: THREAD_ID, triggerPostId: OWNER_TRIGGER }),
  )
})

test('P0: an avatar-style profile change is not part of the identity', () => {
  // The identity has no field for it at all, which is the point: only coordinates the
  // platform guarantees are in the key.
  const base = { platform: 'tieba', threadId: THREAD_ID, triggerPostId: 'n7' }
  assert.equal(dedupeKey(base), dedupeKey({ ...base }))
})

test('P0: the same trigger analysed twice yields one session and one ledger row', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    const first = await runAnalysis(rig.runtime, { url: data.thread.url, postId: TRIGGER_ID })
    const second = await runAnalysis(rig.runtime, { url: data.thread.url, postId: TRIGGER_ID })
    assert.equal(first.sessionId, second.sessionId)
    assert.equal(rig.store.snapshot().sessions.filter((s) => s.triggerPostId === TRIGGER_ID).length, 1)
    assert.equal(rig.store.snapshot().dedupe.filter((r) => r.triggerPostId === TRIGGER_ID).length, 1)
  } finally {
    rig.dispose()
  }
})

test('P0: ten concurrent analyses of one trigger produce exactly one session', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    const results = await Promise.all(
      Array.from({ length: 10 }, () => runAnalysis(rig.runtime, { url: data.thread.url, postId: TRIGGER_ID })),
    )
    assert.equal(new Set(results.map((r) => r.sessionId)).size, 1, '并发分析必须落到同一个会话')
    assert.equal(rig.store.snapshot().sessions.filter((s) => s.triggerPostId === TRIGGER_ID).length, 1)
    assert.equal(rig.store.snapshot().dedupe.filter((r) => r.triggerPostId === TRIGGER_ID).length, 1)
  } finally {
    rig.dispose()
  }
})

test('P0: a different trigger in the same thread is a different event', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    const a = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const b = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n1' })
    assert.notEqual(a.sessionId, b.sessionId)
    const rows = rig.store.snapshot().dedupe.filter((r) => r.threadId === data.thread.id)
    assert.equal(rows.length, 2)
    assert.notEqual(rows[0]!.key, rows[1]!.key)
  } finally {
    rig.dispose()
  }
})

test('P0: the same post id in a different thread is a different event', () => {
  const a = dedupeKey({ platform: 'tieba', threadId: 't1', triggerPostId: 'p' })
  const b = dedupeKey({ platform: 'tieba', threadId: 't2', triggerPostId: 'p' })
  assert.notEqual(a, b, '帖子 id 只在帖子范围内唯一，键必须带上 thread')
})

// ---------------------------------------------------------------------------
// P0 — legacy migration
// ---------------------------------------------------------------------------

/** Write a pre-0.1.5 style row, keyed by nickname. */
function legacyRow(input: {
  threadId: string
  ownerKey: string
  triggerPostId: string
  publishState: 'confirmed' | 'pending' | 'failed'
  publishedPostId?: string
  firstSeenAt?: string
}): DedupeRecord {
  // Exactly the pre-0.1.5 shape: platform, thread, owner nickname, trigger, event.
  const key = ['tieba', input.threadId, input.ownerKey, input.triggerPostId, 'na'].join(':')
  return {
    key,
    platform: 'tieba',
    threadId: input.threadId,
    ownerKey: input.ownerKey,
    triggerPostId: input.triggerPostId,
    sessionId: 'legacy-session',
    firstSeenAt: input.firstSeenAt ?? '2025-01-01T00:00:00Z',
    publishState: input.publishState,
    ...(input.publishedPostId ? { publishedPostId: input.publishedPostId } : {}),
  }
}

test('P0: a legacy nickname-keyed confirmed row still blocks publishing after upgrade', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    // Exactly what an older version left behind: the key contains the old nickname.
    await rig.store.mutate((store) => ({
      ...store,
      dedupe: [
        ...store.dedupe,
        legacyRow({
          threadId: data.thread.id,
          ownerKey: '主人旧昵称',
          triggerPostId: TRIGGER_ID,
          publishState: 'confirmed',
          publishedPostId: 'sent-before-upgrade',
        }),
      ],
    }))

    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: TRIGGER_ID })
    const session = rig.store.getSession(analysis.sessionId)
    assert.equal(session?.state, 'PUBLISHED', '旧版已发表记录必须仍然拦住这次召唤')
    assert.deepEqual(session?.publishedPostIds, ['sent-before-upgrade'], '历史 post id 必须保留')

    // And the row has been folded onto the canonical key.
    const rows = rig.store.snapshot().dedupe.filter((r) => r.triggerPostId === TRIGGER_ID)
    assert.equal(rows.length, 1, '迁移后同一条召唤只应留一个键')
    assert.equal(rows[0]!.key, canonicalTriggerId({ platform: 'tieba', threadId: data.thread.id, triggerPostId: TRIGGER_ID }))
    assert.equal(rows[0]!.publishState, 'confirmed')
    assert.equal(rows[0]!.publishedPostId, 'sent-before-upgrade')
    assert.equal(rows[0]!.firstSeenAt, '2025-01-01T00:00:00Z', '首次记录时间必须保留')
  } finally {
    rig.dispose()
  }
})

test('P0: a legacy pending row still blocks a retry after upgrade', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread()
    await rig.store.mutate((store) => ({
      ...store,
      dedupe: [
        ...store.dedupe,
        legacyRow({ threadId: data.thread.id, ownerKey: '旧昵称', triggerPostId: TRIGGER_ID, publishState: 'pending' }),
      ],
    }))
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: TRIGGER_ID })
    assert.equal(rig.store.getSession(analysis.sessionId)?.state, 'NEEDS_CONFIRMATION')
    assert.equal(rig.store.findDedupe(canonicalTriggerId({ platform: 'tieba', threadId: data.thread.id, triggerPostId: TRIGGER_ID }))?.publishState, 'pending')
    assert.equal(rig.adapter.publishes.length, 0)
  } finally {
    rig.dispose()
  }
})

test('P0: conflicting legacy confirmed rows are reported, not resolved by picking one', () => {
  const records = [
    legacyRow({ threadId: 't', ownerKey: '旧名', triggerPostId: 'p', publishState: 'confirmed', publishedPostId: 'reply-a' }),
    legacyRow({ threadId: 't', ownerKey: '新名', triggerPostId: 'p', publishState: 'confirmed', publishedPostId: 'reply-b' }),
  ]
  const merged = mergeTriggerRecords(records)
  assert.equal(merged.found, true)
  if (!merged.found) return
  assert.equal(merged.publishState, 'confirmed', '已确认的事实不能被降级')
  assert.equal(merged.conflicting, true, '两条已确认记录指向不同回复，必须报告冲突')
  assert.ok(merged.reason && merged.reason.length > 0)
})

test('P0: a legacy row and a canonical row for one trigger are found together', () => {
  const identity = { platform: 'tieba', threadId: 't', triggerPostId: 'p' }
  const records = [
    legacyRow({ threadId: 't', ownerKey: '旧名', triggerPostId: 'p', publishState: 'failed' }),
    {
      key: canonicalTriggerId(identity),
      platform: 'tieba',
      threadId: 't',
      ownerKey: '新名',
      triggerPostId: 'p',
      sessionId: 's2',
      firstSeenAt: '2025-02-01T00:00:00Z',
      publishState: 'confirmed' as const,
      publishedPostId: 'x',
    },
  ]
  const found = findTriggerRecords(records, identity)
  assert.equal(found.length, 2, '新旧两种键都必须被同一个身份匹配到')
  const merged = mergeTriggerRecords(found)
  assert.equal(merged.found && merged.publishState, 'confirmed', 'confirmed 优先于 failed')
})

test('P0: a legacy row for a different trigger is not migrated into this one', () => {
  const identity = { platform: 'tieba', threadId: 't', triggerPostId: 'p' }
  const records = [legacyRow({ threadId: 't', ownerKey: '旧名', triggerPostId: 'other', publishState: 'confirmed' })]
  assert.equal(findTriggerRecords(records, identity).length, 0)
})

test('P0: failed legacy rows leave the summon free to proceed', () => {
  const merged = mergeTriggerRecords([
    legacyRow({ threadId: 't', ownerKey: '旧名', triggerPostId: 'p', publishState: 'failed' }),
  ])
  assert.equal(merged.found && merged.publishState, 'failed')
  assert.equal(merged.found && merged.conflicting, false)
})

test('P0: after a nickname change the confirmed publish is not re-opened', async () => {
  // The end-to-end shape of the reported bug: publish, rename, re-analyse, try again.
  const rig = makeRig()
  try {
    // `n7` is the owner's own "@AI 来帮忙" post in the shared fixture.
    const before = collectedThread('主人旧昵称')
    const analysis = await runAnalysis(rig.runtime, { url: before.thread.url, postId: OWNER_TRIGGER })
    const generated = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })
    const sent = await runPublish(rig.runtime, {
      sessionId: analysis.sessionId,
      candidateId: generated.candidateId,
      approvedText: generated.text,
      humanApproved: true,
    })
    assert.equal(sent.ok, true, `首次发表应该成功：${sent.message}`)
    assert.equal(rig.adapter.publishes.length, 1)

    // The owner renames. The ledger row still holds the OLD name in `ownerKey`.
    const renamed = threePartyThread()
    const floorPostId = renamed.floors[0]!.postId
    const nested = renamed.nested[floorPostId]!.map((reply) =>
      reply.postId === OWNER_TRIGGER ? { ...reply, authorName: '主人新昵称' } : reply,
    )
    rig.runtime.adapter = new FakeAdapter({ ...renamed, nested: { [floorPostId]: nested } })
    const after = await runAnalysis(rig.runtime, { url: renamed.thread.url, postId: OWNER_TRIGGER })
    const session = rig.store.getSession(after.sessionId)
    assert.equal(session?.state, 'PUBLISHED', '改名后不得重新获得发布资格')

    const retry = await runPublish(rig.runtime, {
      sessionId: after.sessionId,
      candidateId: `${after.sessionId}-c1`,
      approvedText: '再发一次',
      humanApproved: true,
    })
    assert.equal(retry.ok, false)
    assert.equal(rig.runtime.adapter.publishes.length, 0, '平台不能被再次调用')
  } finally {
    rig.dispose()
  }
})

test('P0: a restart does not re-open a nickname-keyed publish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-v015-restart-'))
  try {
    const first = makeRig({ dir })
    const data = threePartyThread()
    await first.store.mutate((store) => ({
      ...store,
      dedupe: [
        ...store.dedupe,
        legacyRow({
          threadId: data.thread.id,
          ownerKey: '主人旧昵称',
          triggerPostId: TRIGGER_ID,
          publishState: 'confirmed',
          publishedPostId: 'pre-restart',
        }),
      ],
    }))

    const second = makeRig({ dir })
    await second.store.ready()
    const analysis = await runAnalysis(second.runtime, { url: data.thread.url, postId: TRIGGER_ID })
    assert.equal(second.store.getSession(analysis.sessionId)?.state, 'PUBLISHED')
    assert.equal(second.adapter.publishes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// P1 — session capacity
// ---------------------------------------------------------------------------

function readySession(id: string, triggerPostId: string): Record<string, unknown> {
  const stamp = new Date().toISOString()
  return {
    id,
    platform: 'tieba',
    threadId: THREAD_ID,
    triggerPostId,
    ownerKey: 'owner',
    state: 'READY',
    candidates: [],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: stamp,
    updatedAt: stamp,
  }
}

test('P1: maxSessions=1 does not delete the older READY session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-v015-cap1-'))
  try {
    const store = new DebateStore({ dir, maxSessions: 1 })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [...data.sessions, readySession('A', 't-a')] as never }))
    await store.mutate((data) => ({ ...data, sessions: [...data.sessions, readySession('B', 't-b')] as never }))
    assert.ok(hasSession(store, 'A'), '较早的活跃会话不能被容量上限静默删除')
    assert.ok(hasSession(store, 'B'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1: maxSessions=2 keeps both live sessions and reports full capacity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-v015-cap2-'))
  try {
    const store = new DebateStore({ dir, maxSessions: 2 })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [...data.sessions, readySession('A', 't-a')] as never }))
    await store.mutate((data) => ({ ...data, sessions: [...data.sessions, readySession('B', 't-b')] as never }))
    assert.ok(hasSession(store, 'A'))
    assert.ok(hasSession(store, 'B'))
    const capacity = store.capacity()
    assert.equal(capacity.active, 2)
    assert.equal(capacity.full, true, '两个活跃会话已占满 2 的上限')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1: GENERATING and PUBLISHING sessions are never dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-v015-inflight-'))
  try {
    const store = new DebateStore({ dir, maxSessions: 1 })
    await store.ready()
    const generating = { ...readySession('G', 't-g'), state: 'GENERATING' }
    const publishing = { ...readySession('P', 't-p'), state: 'PUBLISHING' }
    await store.mutate((data) => ({ ...data, sessions: [...data.sessions, generating] as never }))
    await store.mutate((data) => ({ ...data, sessions: [...data.sessions, publishing] as never }))
    assert.ok(hasSession(store, 'G'), '正在生成的会话不能删')
    assert.ok(hasSession(store, 'P'), '正在发表的会话不能删')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1: a NEEDS_CONFIRMATION session waiting for the user survives the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-v015-needs-'))
  try {
    const store = new DebateStore({ dir, maxSessions: 1 })
    await store.ready()
    const waiting = { ...readySession('W', 't-w'), state: 'NEEDS_CONFIRMATION' }
    const newer = { ...readySession('N', 't-n'), state: 'READY' }
    await store.mutate((data) => ({ ...data, sessions: [...data.sessions, waiting] as never }))
    await store.mutate((data) => ({ ...data, sessions: [...data.sessions, newer] as never }))
    assert.ok(hasSession(store, 'W'), '等待用户确认的会话不能被缓存上限清掉')
    assert.ok(hasSession(store, 'N'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1: expired terminal sessions are still pruned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-v015-ttl-'))
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 60_000, maxSessions: 200 })
    await store.ready()
    const old = { ...readySession('old', 't-old'), state: 'PUBLISHED', updatedAt: '2020-01-01T00:00:00Z' }
    const live = readySession('live', 't-live')
    await store.mutate((data) => ({ ...data, sessions: [old, live] as never }))
    assert.equal(store.getSession('old'), undefined, '过期的终态会话应当被清理')
    assert.ok(hasSession(store, 'live'), '活跃会话不受 TTL 影响')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1: the cap counts live sessions only, not finished history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-v015-count-'))
  try {
    const store = new DebateStore({ dir, maxSessions: 3 })
    await store.ready()
    const stamp = new Date().toISOString()
    const finished = Array.from({ length: 5 }, (_, i) => ({
      ...readySession(`done-${i}`, `t-done-${i}`),
      state: 'PUBLISHED',
      updatedAt: stamp,
    }))
    await store.mutate((data) => ({ ...data, sessions: finished as never }))
    const capacity = store.capacity()
    assert.equal(capacity.active, 0, '已完成的会话不占用活跃名额')
    assert.equal(capacity.full, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1: a capacity error is raised instead of silently dropping a live session', async () => {
  const rig = makeRig({ maxSessions: 1 })
  try {
    const data = threePartyThread()
    const first = await runAnalysis(rig.runtime, { url: data.thread.url, postId: TRIGGER_ID })
    assert.ok(hasSession(rig.store, first.sessionId))

    // The first analysis left a live session; starting another must be refused, not
    // buy room by deleting the first.
    await assert.rejects(
      runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n1' }),
      (error: Error) => {
        assert.match(error.message, /活跃会话已达上限/)
        return true
      },
    )
    assert.ok(hasSession(rig.store, first.sessionId), '被拒绝的新任务不能牺牲已有会话')
  } finally {
    rig.dispose()
  }
})

test('P1: confirmed publish history is untouched by session pruning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-v015-ledger-'))
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 1, maxSessions: 1 })
    await store.ready()
    await store.mutate((data) => ({
      ...data,
      sessions: [{ ...readySession('x', 't-x'), state: 'PUBLISHED', updatedAt: '2020-01-01T00:00:00Z' }] as never,
      dedupe: [
        {
          key: canonicalTriggerId({ platform: 'tieba', threadId: THREAD_ID, triggerPostId: 't-x' }),
          platform: 'tieba',
          threadId: THREAD_ID,
          ownerKey: 'owner',
          triggerPostId: 't-x',
          sessionId: 'x',
          firstSeenAt: '2020-01-01T00:00:00Z',
          publishState: 'confirmed' as const,
          publishedPostId: 'kept',
        },
      ],
    }))
    assert.equal(store.getSession('x'), undefined, '会话应被 TTL 清理')
    const key = canonicalTriggerId({ platform: 'tieba', threadId: THREAD_ID, triggerPostId: 't-x' })
    assert.equal(store.findDedupe(key)?.publishState, 'confirmed', '发表记录不随会话清理消失')
    assert.equal(store.findDedupe(key)?.publishedPostId, 'kept')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1: pruning interacts safely with a concurrent publish write', async () => {
  const rig = makeRig({ maxSessions: 50 })
  try {
    const data = threePartyThread()
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: TRIGGER_ID })
    const generated = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })

    // A prune-triggering write and a publish at the same time: neither may lose the
    // other's state, because both go through the same serialised `mutate`.
    const [, report] = await Promise.all([
      rig.store.mutate((store) => ({ ...store, sessions: [...store.sessions] })),
      runPublish(rig.runtime, {
        sessionId: analysis.sessionId,
        candidateId: generated.candidateId,
        approvedText: generated.text,
        humanApproved: true,
      }),
    ])
    assert.equal(report.ok, true, `发表应成功：${report.message}`)
    assert.equal(rig.store.getSession(analysis.sessionId)?.state, 'PUBLISHED', '发表状态不能被并发清理覆盖')
  } finally {
    rig.dispose()
  }
})
