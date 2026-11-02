/**
 * P0-1 / P0-2 / P0-3: the concurrency, identity and evidence-gate guarantees.
 *
 * ## Why these three live in one file
 *
 * They are the same claim viewed three ways: **a publish may only happen when the plugin can
 * prove, at that moment, that it is allowed to and that it will be attributed correctly.**
 *
 * - P0-1: proof that this authorization is unspent has to be indivisible. A read followed by a
 *   write is two observations, and two requests can interleave between them.
 * - P0-2: proof that the session belongs to the authorized account has to be *known*, not
 *   assumed. "We could not find out who is logged in" cannot mean "send it anyway".
 * - P0-3: proof that publishing works has to reach the real gate. A verification panel whose
 *   verdict the publisher never consults is a dashboard, not a control.
 *
 * ## The concurrency test is 100 real calls
 *
 * `Promise.all` over 100 invocations against the **real** `DebateStore` on a temp directory —
 * not a fake map — because the thing under test is the lock, and a fake has no lock. The
 * assertion is exact: `publishReply` ran once.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { adapterVersionOfAdapter, effectiveCapability } from '../lib/capability-evidence.js'
import { PlatformRegistry } from '../lib/platforms/registry.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { buildRuntime } from '../lib/index.js'
import { DebateStore } from '../lib/store.js'
import type { PublishOutcome, ReplyContext, ThreadRef } from '../lib/types.js'
import type { VerificationAuthorization } from '../lib/verification.js'
import { runVerification, type VerificationRecordStore } from '../lib/verification-runner.js'

const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} } as never

function withTempDir(name: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `debate-${name}-`))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const THREAD = 't-1'
const ACCOUNT = 'ai-42'
const TEXT = '验收一条，稍后可以删'

function authorization(overrides: Partial<VerificationAuthorization> = {}): VerificationAuthorization {
  return {
    platform: 'probe',
    capability: 'comment.publish',
    authorizedAccountId: ACCOUNT,
    authorizedThreadId: THREAD,
    authorizedBy: '主人',
    approvedText: TEXT,
    ...overrides,
  }
}

/** A fake adapter that counts publishes, and can be told to fail. */
function countingAdapter(options: { fail?: boolean; content?: string } = {}) {
  const state = { publishes: 0, reads: 0 }
  const adapter = {
    id: 'probe',
    displayName: '探针',
    async publishReply(): Promise<PublishOutcome> {
      state.publishes += 1
      if (options.fail === true) return { status: 'failed', error: '403', errorCode: 'forbidden' }
      return { status: 'confirmed', postId: 'p-1' }
    },
    async getReplyContext(): Promise<ReplyContext> {
      state.reads += 1
      // `as unknown as` because the fixture only fills the fields the runner reads; `ReplyContext`
      // carries the platform-wide shape and inventing the rest here would be noise.
      return {
        thread: { id: THREAD },
        floor: {
          platform: 'probe',
          postId: 'p-1',
          authorId: ACCOUNT,
          content: options.content ?? TEXT,
          images: [],
        },
        ancestors: [],
        siblings: [],
      } as unknown as ReplyContext
    },
  }
  return { adapter, state }
}

/** A record store backed by the real `DebateStore`, so `claim` is the real lock path. */
function realRecordStore(store: DebateStore): VerificationRecordStore {
  return {
    all: () => store.getVerificationRecords(),
    // The real store can re-read from disk, and the runner uses that to see a claim made by
    // another instance. A double that omits it would let this test pass while the two-process
    // case stayed broken.
    refresh: () => store.refreshVerificationRecords(),
    put: (record) => store.putVerificationRecord(record),
    claim: (record) => store.claimVerificationRecord(record),
  }
}

function deps(
  adapter: unknown,
  records: VerificationRecordStore,
  overrides: { liveAccountId?: string; adapterVersion?: string } = {},
) {
  return {
    adapter: adapter as never,
    capabilityState: () => 'unverified' as const,
    // `'liveAccountId' in overrides` rather than `?? ACCOUNT`: the whole point of P0-2 is that
    // "unknown" is a distinct state, and `??` would silently turn an explicit `undefined` back
    // into the happy-path account — the test would then be measuring its own fallback.
    liveAccountId: async () => ('liveAccountId' in overrides ? overrides.liveAccountId : ACCOUNT),
    records,
    now: () => '2026-10-31T12:00:00.000Z',
    adapterVersion: overrides.adapterVersion ?? 'v1',
  }
}

// ---------------------------------------------------------------------------
// P0-1: atomic authorization claim
// ---------------------------------------------------------------------------

test('P0-1：同一授权并发 100 次，publishReply 恰好被调用一次', async () => {
  const { dir, done } = withTempDir('p01-concurrent')
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const { adapter, state } = countingAdapter()
    const records = realRecordStore(store)

    const results = await Promise.all(
      Array.from({ length: 100 }, () => runVerification(authorization(), deps(adapter, records))),
    )

    assert.equal(state.publishes, 1, `100 次并发只允许一次真实发表，实际 ${state.publishes} 次`)
    const succeeded = results.filter((result) => result.ok)
    assert.equal(succeeded.length, 1, '只应有一次成功')
    const refused = results.filter((result) => result.refusal === 'already_used')
    assert.equal(refused.length, 99, `其余 99 次都应以 already_used 拒绝，实际 ${refused.length} 次`)

    // Exactly one effective key on disk: the pending row was overwritten by the outcome, not
    // duplicated. "Two rows for one authorization" would mean the claim wrote twice.
    const keys = store.getVerificationRecords().map((record) => record.key)
    assert.equal(new Set(keys).size, 1, `持久化记录里只能有一个授权键，实际 ${JSON.stringify(keys)}`)
    assert.equal(keys.length, 1, `同一授权只应有一行记录，实际 ${keys.length} 行`)
  } finally {
    done()
  }
})

test('P0-1：两个独立的 Store 实例（模拟两个进程）争同一份授权，仍然只发一次', async () => {
  const { dir, done } = withTempDir('p01-two-stores')
  try {
    // Two instances over the same directory: this is what two plugin processes look like, and
    // it is the case an in-memory map cannot possibly catch.
    const first = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const second = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const { adapter, state } = countingAdapter()

    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => runVerification(authorization(), deps(adapter, realRecordStore(first)))),
      ...Array.from({ length: 20 }, () => runVerification(authorization(), deps(adapter, realRecordStore(second)))),
    ])

    assert.equal(state.publishes, 1, `跨实例只允许一次发表，实际 ${state.publishes} 次`)
    assert.equal(results.filter((result) => result.ok).length, 1)
    // Read back through a *fresh* instance: neither writer's in-memory copy is authoritative
    // for "what is on disk", and the requirement is about the persisted document.
    const reader = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const persisted = await reader.refreshVerificationRecords()
    assert.equal(persisted.length, 1, `磁盘上只应有一行记录，实际 ${persisted.length} 行`)
  } finally {
    done()
  }
})

test('P0-1：进程重启后再提交同一份授权，被 already_used 拒绝', async () => {
  const { dir, done } = withTempDir('p01-restart')
  try {
    const before = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const firstAdapter = countingAdapter()
    const first = await runVerification(authorization(), deps(firstAdapter.adapter, realRecordStore(before)))
    assert.equal(first.ok, true)
    assert.equal(firstAdapter.state.publishes, 1)

    // A brand-new instance over the same directory is what a restart looks like; nothing of the
    // first instance's memory survives, so only the persisted claim can stop the second publish.
    const after = new DebateStore({ dir, sessionTtlMs: 60_000 })
    await after.ready()
    const secondAdapter = countingAdapter()
    const second = await runVerification(authorization(), deps(secondAdapter.adapter, realRecordStore(after)))

    assert.equal(second.ok, false)
    assert.equal(second.refusal, 'already_used')
    assert.equal(secondAdapter.state.publishes, 0, '重启后同一授权不得再次发表')
  } finally {
    done()
  }
})

test('P0-1：抢占用写入失败时，不调用发表接口', async () => {
  const { dir, done } = withTempDir('p01-writefail')
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const { adapter, state } = countingAdapter()
    const failing: VerificationRecordStore = {
      all: () => store.getVerificationRecords(),
      put: (record) => store.putVerificationRecord(record),
      claim: async () => {
        throw new Error('磁盘满')
      },
    }

    const result = await runVerification(authorization(), deps(adapter, failing))

    assert.equal(result.ok, false)
    assert.equal(state.publishes, 0, '记录没能落盘却发表了，等于把「无法追溯」当成「可以发」')
    assert.match(result.message, /没有发表任何内容/)
    assert.match(result.message, /磁盘满/, '失败原因要原样带出，否则读者不知道该修什么')
  } finally {
    done()
  }
})

test('P0-1：抢占失败的两种原因不混为一谈（已用过 ≠ 写不进去）', async () => {
  const { dir, done } = withTempDir('p01-distinct')
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const used = countingAdapter()
    await runVerification(authorization(), deps(used.adapter, realRecordStore(store)))

    const again = await runVerification(authorization(), deps(countingAdapter().adapter, realRecordStore(store)))
    assert.equal(again.refusal, 'already_used')
    assert.equal(again.ok, false)

    const broken = await runVerification(
      authorization({ authorizedThreadId: 'other-thread' }),
      deps(countingAdapter().adapter, {
        all: () => store.getVerificationRecords(),
        put: () => Promise.resolve(),
        claim: () => Promise.reject(new Error('lock timeout')),
      }),
    )
    assert.equal(broken.refusal, undefined, '写失败不是「已用过」，混在一起会让人以为授权被花了')
    assert.match(broken.message, /lock timeout/)
  } finally {
    done()
  }
})

// ---------------------------------------------------------------------------
// P0-2: an unknown live account must refuse
// ---------------------------------------------------------------------------

test('P0-2：真实登录账号读不到时拒绝，且不写 pending、不发表', async () => {
  const { dir, done } = withTempDir('p02-unknown')
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const { adapter, state } = countingAdapter()

    const result = await runVerification(
      authorization(),
      deps(adapter, realRecordStore(store), { liveAccountId: undefined }),
    )

    assert.equal(result.ok, false)
    assert.equal(result.refusal, 'account_unknown', '读不到登录态必须是明确的一种拒绝，不能和「账号不符」共用一条消息')
    assert.equal(state.publishes, 0)
    assert.equal(store.getVerificationRecords().length, 0, '拒绝发生在抢占之前，所以一条记录都不该有')
  } finally {
    done()
  }
})

test('P0-2：空字符串账号同样算未知', async () => {
  const { dir, done } = withTempDir('p02-empty')
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const { adapter, state } = countingAdapter()
    const result = await runVerification(
      authorization(),
      deps(adapter, realRecordStore(store), { liveAccountId: '' }),
    )
    assert.equal(result.refusal, 'account_unknown')
    assert.equal(state.publishes, 0)
  } finally {
    done()
  }
})

test('P0-2：登录账号与授权账号不符时拒绝', async () => {
  const { dir, done } = withTempDir('p02-mismatch')
  try {
    const store = new DebateStore({ dir, sessionTtlMs: 60_000 })
    const { adapter, state } = countingAdapter()
    const result = await runVerification(
      authorization(),
      deps(adapter, realRecordStore(store), { liveAccountId: 'someone-else' }),
    )
    assert.equal(result.refusal, 'account_mismatch')
    assert.equal(state.publishes, 0)
    assert.equal(store.getVerificationRecords().length, 0)
  } finally {
    done()
  }
})

// ---------------------------------------------------------------------------
// P0-3: the evidence gates the real publish path
// ---------------------------------------------------------------------------

/** A provider whose declaration and adapter are controlled by the test. */
function evidencePlatform(input: {
  readonly declared: 'unverified' | 'unavailable' | 'permission_required' | 'supported'
  readonly accountId: string
  readonly publishOk?: boolean
}) {
  const state = { publishes: 0 }
  const adapter = {
    id: 'probe',
    displayName: '探针',
    getCapabilities: () => ({
      thread: true,
      replies: true,
      nestedReplies: false,
      userProfile: false,
      mentions: false,
      publish: true,
      authCheck: true,
    }),
    checkAuthentication: async () => ({ authenticated: true, userId: input.accountId, userName: '小号' }),
    getThread: async () => ({
      platform: 'probe',
      forum: { platform: 'probe', id: '1', name: '区' },
      id: THREAD,
      title: '帖子',
      content: '正文',
      authorId: 'host-1',
      authorName: '楼主',
      createdAt: '2024-1-1',
      url: 'https://probe.example/thread/t-1',
      declaredReplyCount: 0,
      images: [],
    }),
    getReplies: async () => ({ floors: [], hasMore: false, declaredTotal: 0 }),
    getNestedReplies: async () => ({ floors: [], hasMore: false, declaredTotal: 0 }),
    getUserProfile: async () => ({ userId: 'host-1', userName: '楼主' }),
    getMentions: async () => [],
    getReplyContext: async () => ({
      thread: { id: THREAD },
      floor: { platform: 'probe', postId: 'p-1', authorId: input.accountId, content: TEXT, images: [] },
      ancestors: [],
      siblings: [],
    }),
    publishReply: async (): Promise<PublishOutcome> => {
      state.publishes += 1
      return input.publishOk === false
        ? { status: 'failed', error: '403', errorCode: 'forbidden' }
        : { status: 'confirmed', postId: 'p-1' }
    },
  }

  const provider = {
    id: 'probe',
    displayName: '探针',
    shape: 'other' as const,
    canHandleUrl: (url: string) => url.includes('probe.example'),
    parseUrl: (url: string): ThreadRef => ({ platform: 'probe', threadId: THREAD, url }),
    describeCapabilities: () => ({
      platform: 'probe',
      declaredAt: new Date().toISOString(),
      capabilities: {
        'thread.read': { state: 'supported' as const, reason: '假平台' },
        'comment.publish': { state: input.declared, reason: `假平台的声明：${input.declared}` },
      },
    }),
    createAdapter: () => adapter,
  }

  return { provider, state, adapter }
}

function buildEvidenceRuntime(input: Parameters<typeof evidencePlatform>[0]) {
  const { dir, done } = withTempDir('p03-runtime')
  const platform = evidencePlatform(input)
  const registry = new PlatformRegistry()
  registry.register(platform.provider as never)
  const config = {
    ...DEFAULT_CONFIG,
    storeDir: dir,
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
    aiAccountUserId: input.accountId,
    // The gate resolves the posting identity through `bindingsOf()`, and a per-platform binding
    // is the only way an arbitrary platform id gets one — the legacy `aiAccountUserId` global
    // means tieba. Without this the gate would correctly refuse to bind evidence to anything,
    // and the test would be measuring the fixture instead of the gate.
    platformAccounts: JSON.stringify({
      aiAccounts: [
        {
          platform: 'probe',
          account: { platform: 'probe', accountId: input.accountId, idStrength: 'strong' },
        },
      ],
    }),
  }
  const runtime = buildRuntime(() => resolveConfig(config), quietLog, registry)
  return { runtime, platform, dir, done }
}

test('P0-3：没有验收证据时，正常发表被能力闸门拒绝', async () => {
  const { runtime, platform, done } = buildEvidenceRuntime({ declared: 'unverified', accountId: ACCOUNT })
  try {
    assert.throws(
      () => runtime.platforms!.assertCapability('probe', 'comment.publish'),
      /unverified|不可用/,
      '没有证据就放行，等于把「没验过」当成「验过了」',
    )
    assert.equal(platform.state.publishes, 0)
  } finally {
    done()
  }
})

test('P0-3：验收成功写入证据后，正常发表的闸门才通过', async () => {
  const { runtime, platform, done } = buildEvidenceRuntime({ declared: 'unverified', accountId: ACCOUNT })
  try {
    // Before: refused.
    assert.throws(() => runtime.platforms!.assertCapability('probe', 'comment.publish'))

    const adapterVersion = adapterVersionOfAdapter(platform.adapter as never)
    await runtime.store.putVerificationRecord({
      key: 'k1',
      platform: 'probe',
      capability: 'comment.publish',
      authorizedAccountId: ACCOUNT,
      authorizedThreadId: THREAD,
      authorizedBy: '主人',
      approvedText: TEXT,
      startedAt: '2026-10-31T12:00:00.000Z',
      adapterVersion,
      outcome: 'succeeded',
      publishedPostId: 'p-1',
      readBack: {
        postFound: true,
        authorMatched: true,
        textMatched: true,
        parentMatched: true,
        notes: [],
      },
    })

    // After: passes — but note what did *not* change: the declaration is still `unverified`.
    assert.equal(
      runtime.platforms!.capabilitiesOf('probe').capabilities['comment.publish'].state,
      'unverified',
      '证据不得改写静态声明',
    )
    runtime.platforms!.assertCapability('probe', 'comment.publish')
  } finally {
    done()
  }
})

test('P0-3：换了账号，旧证据立即失效', async () => {
  const { runtime, platform, done } = buildEvidenceRuntime({ declared: 'unverified', accountId: ACCOUNT })
  try {
    await runtime.store.putVerificationRecord({
      key: 'k1',
      platform: 'probe',
      capability: 'comment.publish',
      authorizedAccountId: 'another-account',
      authorizedThreadId: THREAD,
      authorizedBy: '主人',
      approvedText: TEXT,
      startedAt: '2026-10-31T12:00:00.000Z',
      adapterVersion: adapterVersionOfAdapter(platform.adapter as never),
      outcome: 'succeeded',
      readBack: { postFound: true, authorMatched: true, textMatched: true, parentMatched: true, notes: [] },
    })
    assert.throws(
      () => runtime.platforms!.assertCapability('probe', 'comment.publish'),
      /账号/,
      '别的账号验过的能力不能算到当前账号头上',
    )
  } finally {
    done()
  }
})

test('P0-3：适配器实现变了，旧证据立即失效', async () => {
  const { runtime, done } = buildEvidenceRuntime({ declared: 'unverified', accountId: ACCOUNT })
  try {
    await runtime.store.putVerificationRecord({
      key: 'k1',
      platform: 'probe',
      capability: 'comment.publish',
      authorizedAccountId: ACCOUNT,
      authorizedThreadId: THREAD,
      authorizedBy: '主人',
      approvedText: TEXT,
      startedAt: '2026-10-31T12:00:00.000Z',
      // A build that is not this one: the publish method that succeeded is not the one that
      // would run now, so the evidence says nothing about the current code.
      adapterVersion: 'deadbeef',
      outcome: 'succeeded',
      readBack: { postFound: true, authorMatched: true, textMatched: true, parentMatched: true, notes: [] },
    })
    assert.throws(
      () => runtime.platforms!.assertCapability('probe', 'comment.publish'),
      /适配器/,
      '换了实现就要重新取证',
    )
  } finally {
    done()
  }
})

test('P0-3：回读不完整的记录不能提升能力', async () => {
  const { runtime, platform, done } = buildEvidenceRuntime({ declared: 'unverified', accountId: ACCOUNT })
  try {
    await runtime.store.putVerificationRecord({
      key: 'k1',
      platform: 'probe',
      capability: 'comment.publish',
      authorizedAccountId: ACCOUNT,
      authorizedThreadId: THREAD,
      authorizedBy: '主人',
      approvedText: TEXT,
      startedAt: '2026-10-31T12:00:00.000Z',
      adapterVersion: adapterVersionOfAdapter(platform.adapter as never),
      outcome: 'succeeded',
      // Author matched but the body did not: "something was written", not "this reply was".
      readBack: { postFound: true, authorMatched: true, textMatched: false, parentMatched: true, notes: ['正文不符'] },
    })
    assert.throws(() => runtime.platforms!.assertCapability('probe', 'comment.publish'), /回读/)
  } finally {
    done()
  }
})

test('P0-3：unavailable 与 permission_required 不能被证据救活', async () => {
  for (const declared of ['unavailable', 'permission_required'] as const) {
    const { runtime, platform, done } = buildEvidenceRuntime({ declared, accountId: ACCOUNT })
    try {
      await runtime.store.putVerificationRecord({
        key: 'k1',
        platform: 'probe',
        capability: 'comment.publish',
        authorizedAccountId: ACCOUNT,
        authorizedThreadId: THREAD,
        authorizedBy: '主人',
        approvedText: TEXT,
        startedAt: '2026-10-31T12:00:00.000Z',
        adapterVersion: adapterVersionOfAdapter(platform.adapter as never),
        outcome: 'succeeded',
        readBack: { postFound: true, authorMatched: true, textMatched: true, parentMatched: true, notes: [] },
      })
      assert.throws(
        () => runtime.platforms!.assertCapability('probe', 'comment.publish'),
        /不可用|需要授权/,
        `${declared} 是集成或权限的结论，一次成功发表不能改写它`,
      )
    } finally {
      done()
    }
  }
})

test('P0-3：证据规则与 effectiveCapability 一致（同一套判定，不是第二套）', () => {
  const query = { platform: 'probe', capability: 'comment.publish' as const, accountId: ACCOUNT, adapterVersion: 'v1' }
  const record = {
    platform: 'probe',
    capability: 'comment.publish' as const,
    accountId: ACCOUNT,
    adapterVersion: 'v1',
    verifiedAt: '2026-10-31T12:00:00.000Z',
    method: 'live' as const,
    readBackComplete: true,
  }
  // The gate above builds exactly this shape; asserting the shared function's verdict here keeps
  // the two from drifting into "the gate said yes, the panel said no".
  assert.equal(effectiveCapability('unverified', query, [record]).effective, 'supported')
  assert.equal(effectiveCapability('unavailable', query, [record]).effective, 'unavailable')
  assert.equal(effectiveCapability('permission_required', query, [record]).effective, 'permission_required')
})

// ---------------------------------------------------------------------------
// P1: the delivery pipeline must notice changes to the gate it ships
// ---------------------------------------------------------------------------

test('P1：ship-core 的行级规则能识别装配根与 store 里的敏感改动', async () => {
  const { classifySensitive } = await import('../scripts/lib/ship-core.mjs')

  // The gate and the claim live in files that cannot be marked wholesale sensitive (they also
  // hold tool registration and session bookkeeping), so the pipeline has to notice the specific
  // lines. Without this, changing who may publish would auto-merge.
  const landed = classifySensitive([
    {
      path: 'src/index.ts',
      addedLines: ["        const accountId = configuredAccountOf(resolve(), platform) ?? ''"],
      removedLines: [],
    },
    {
      path: 'src/store.ts',
      addedLines: ['  async claimVerificationRecord('],
      removedLines: [],
    },
  ])
  assert.equal(landed.sensitive, true, '改了发表闸门与授权抢占却没有被识别，等于给自动合并开了口子')

  // And the other direction: prose about those same names is not a change to them. A rule that
  // fires on comments gets switched off within a week, which is how the pipeline defect this
  // whole version is about survived.
  const prose = classifySensitive([
    {
      path: 'src/index.ts',
      addedLines: ['  // 说明：这里以前没有调用 assertCapability，现在有了'],
      removedLines: [],
    },
  ])
  assert.equal(prose.sensitive, false, `注释行不该触发：${JSON.stringify(prose.reasons)}`)
})
