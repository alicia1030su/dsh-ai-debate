/**
 * v0.1.5 checks for the two "extra review" items: what a read-back actually proves,
 * and how the login identity is established.
 *
 * Both are about not overstating what the plugin knows. A post id that resolves to
 * *a* reply is not proof that the approved reply was posted; a page that shows a login
 * banner is not proof of *which* account. These tests hold the line at that distinction
 * so a future change cannot quietly turn "unconfirmed" into "verified".
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
import { NO_MARKER_REASON, readAuthFromHtml } from '../lib/platforms/tieba/adapter.js'
import { FakeAdapter, threePartyThread, grantApproval } from './helpers.ts'

const TRIGGER = 'n7'

function modelReply(): string {
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
  })
}

function makeRig(input: { adapter?: FakeAdapter } = {}): {
  runtime: Runtime
  adapter: FakeAdapter
  store: DebateStore
  dir: string
  dispose: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'debate-v015-verify-'))
  const store = new DebateStore({ dir })
  const adapter = input.adapter ?? new FakeAdapter(threePartyThread())
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    ownerUserId: 'owner-1',
    aiAccountUserId: '1001',
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
  })
  const client = new ScriptedLlmClient(Array.from({ length: 6 }, () => ({ text: modelReply() })))
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
  return { runtime, adapter, store, dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Drive a session to the point where publishing is the next step. */
async function prepare(rig: ReturnType<typeof makeRig>): Promise<{ sessionId: string; candidateId: string; text: string }> {
  const data = threePartyThread()
  const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: TRIGGER })
  const generated = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })
  return { sessionId: analysis.sessionId, candidateId: generated.candidateId, text: generated.text }
}

test('a read-back that matches is reported as verified', async () => {
  const rig = makeRig()
  try {
    const prep = await prepare(rig)
    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: prep.sessionId, candidateId: prep.candidateId, config: rig.runtime.config })
    const report = await runPublish(rig.runtime, {
      sessionId: prep.sessionId,
      candidateId: prep.candidateId,
      approvedText: prep.text,
    })
    assert.equal(report.ok, true, `发表应成功：${report.message}`)
    // The fake adapter echoes the body and the bound account, so every check that the
    // platform enables should pass.
    assert.equal(report.verified, true, '正文、作者、位置都可核对时应标记为已验证')
  } finally {
    rig.dispose()
  }
})

/**
 * Wrap an adapter so only the *post-publish read-back* is tampered with.
 *
 * The publish path re-reads the target before sending, so tampering unconditionally
 * would fail the target check and never reach the verification step — the wrapper has
 * to activate only once `publishes` is non-empty.
 */
function tamperAfterPublish(
  inner: FakeAdapter,
  patch: (context: Awaited<ReturnType<FakeAdapter['getReplyContext']>>) => unknown,
): FakeAdapter {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'getReplyContext') {
        return async (ref: never, postId: string, signal?: AbortSignal) => {
          const context = await target.getReplyContext(ref, postId, signal)
          return target.publishes.length > 0 ? patch(context) : context
        }
      }
      if (property === 'publishes') return target.publishes
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('a reply that exists but has the wrong body is a mismatch, not a success', async () => {
  const rig = makeRig()
  try {
    const prep = await prepare(rig)
    // The platform returns an id, but reading it back yields different text — exactly
    // the "something was posted, but not what was approved" case.
    rig.runtime.adapter = tamperAfterPublish(rig.adapter, (context) =>
      context.nested ? { ...context, nested: { ...context.nested, content: '完全不相干的正文' } } : context,
    )

    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: prep.sessionId, candidateId: prep.candidateId, config: rig.runtime.config })
    const report = await runPublish(rig.runtime, {
      sessionId: prep.sessionId,
      candidateId: prep.candidateId,
      approvedText: prep.text,
    })
    assert.equal(report.ok, false, '回读正文不一致不能算成功')
    assert.equal(report.errorCode, 'verification_mismatch', `实际是 ${report.errorCode}：${report.message}`)
    // It posted *something*, so the ledger must not invite a retry.
    const key = rig.store.snapshot().dedupe.find((r) => r.triggerPostId === TRIGGER)?.key
    assert.equal(rig.store.findDedupe(key!)?.publishState, 'pending', '不一致时不能记 failed，否则会重试')
  } finally {
    rig.dispose()
  }
})

test('a reply posted by another account is a mismatch', async () => {
  const rig = makeRig()
  try {
    const prep = await prepare(rig)
    rig.runtime.adapter = tamperAfterPublish(rig.adapter, (context) =>
      context.nested ? { ...context, nested: { ...context.nested, authorId: '9999' } } : context,
    )

    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: prep.sessionId, candidateId: prep.candidateId, config: rig.runtime.config })
    const report = await runPublish(rig.runtime, {
      sessionId: prep.sessionId,
      candidateId: prep.candidateId,
      approvedText: prep.text,
    })
    assert.equal(report.ok, false, '作者不是绑定账号时不能算成功')
    assert.equal(report.errorCode, 'verification_mismatch', `实际是 ${report.errorCode}：${report.message}`)
  } finally {
    rig.dispose()
  }
})

test('an unreadable read-back leaves the publish unverified but recorded', async () => {
  const rig = makeRig()
  try {
    const prep = await prepare(rig)
    rig.runtime.adapter = new Proxy(rig.adapter, {
      get(target, property, receiver) {
        if (property === 'getReplyContext') {
          return async (ref: never, postId: string, signal?: AbortSignal) => {
            if (target.publishes.length > 0) throw new Error('回读被限流')
            return target.getReplyContext(ref, postId, signal)
          }
        }
        if (property === 'publishes') return target.publishes
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as never

    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: prep.sessionId, candidateId: prep.candidateId, config: rig.runtime.config })
    const report = await runPublish(rig.runtime, {
      sessionId: prep.sessionId,
      candidateId: prep.candidateId,
      approvedText: prep.text,
    })
    // The platform said it published; not being able to read it back is not proof it
    // failed, so this stays a success with `verified: false` rather than a failure.
    assert.equal(report.ok, true, `平台确认过就应算发表成功：${report.message}`)
    assert.equal(report.verified, false, '读不回来就不能宣称已验证')
    const key = rig.store.snapshot().dedupe.find((r) => r.triggerPostId === TRIGGER)?.key
    assert.equal(rig.store.findDedupe(key!)?.publishState, 'confirmed', '平台确认过就应记为已发表')
  } finally {
    rig.dispose()
  }
})

// ---------------------------------------------------------------------------
// Login identity
// ---------------------------------------------------------------------------

test('a page with no login marker is distinguishable from a logged-out page', () => {
  const noMarker = readAuthFromHtml('<html><body>nothing here</body></html>')
  assert.equal(noMarker.authenticated, false)
  assert.equal(noMarker.reason, NO_MARKER_REASON, '没有标记应可被识别，以便换一页再试')

  const loggedOut = readAuthFromHtml('<script>data_editor:{"user":{"is_login":0}},base_url</script>')
  assert.equal(loggedOut.authenticated, false)
  assert.notEqual(loggedOut.reason, NO_MARKER_REASON, '明确说未登录，不应被当成"没读到"')
})

test('a logged-in page reports the account id when the platform exposes it', () => {
  const html = '<script>data_editor:{"user":{"is_login":1,"uid":1001},"can_post":1},base_url</script>'
  const state = readAuthFromHtml(html)
  assert.equal(state.authenticated, true)
  assert.equal(state.userId, '1001')
})

test('a logged-in page without an account id is authenticated but not identified', () => {
  // This is the distinction the task asks for: logged in != identity confirmed.
  const html = '<script>data_editor:{"user":{"is_login":1},"can_post":1},base_url</script>'
  const state = readAuthFromHtml(html)
  assert.equal(state.authenticated, true, '仍然是已登录')
  assert.equal(state.userId, undefined, '但没有暴露账号 ID')
})

test('publishing is refused when the login cannot be identified', async () => {
  const rig = makeRig({
    adapter: new FakeAdapter({
      ...threePartyThread(),
      auth: { authenticated: true, userName: 'someone' },
    }),
  })
  try {
    const prep = await prepare(rig)
    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: prep.sessionId, candidateId: prep.candidateId, config: rig.runtime.config })
    const report = await runPublish(rig.runtime, {
      sessionId: prep.sessionId,
      candidateId: prep.candidateId,
      approvedText: prep.text,
    })
    assert.equal(report.ok, false, '无法确认账号身份时必须拒绝')
    assert.equal(report.errorCode, 'identity_unverified')
    assert.equal(rig.adapter.publishes.length, 0, '拒绝就不能调用平台')
  } finally {
    rig.dispose()
  }
})

test('the login probe is not pinned to one hard-coded thread', async () => {
  // The adapter must accept a caller-supplied probe and must not require the historic
  // sample id. Reading the real target thread is what the publisher now does.
  const rig = makeRig()
  try {
    const prep = await prepare(rig)
    const seen: string[] = []
    const inner = rig.adapter
    rig.runtime.adapter = {
      ...inner,
      getCapabilities: () => inner.getCapabilities(),
      getThread: (...a) => inner.getThread(...a),
      getReplies: (...a) => inner.getReplies(...a),
      getNestedReplies: (...a) => inner.getNestedReplies(...a),
      getUserProfile: (...a) => inner.getUserProfile(...a),
      getMentions: (...a) => inner.getMentions(...a),
      publishReply: (...a) => inner.publishReply(...a),
      getReplyContext: (...a) => inner.getReplyContext(...a),
      checkAuthentication: (signal?: AbortSignal, threadId?: string) => {
        if (threadId) seen.push(threadId)
        return inner.checkAuthentication(signal, threadId)
      },
    } as never

    // v0.2.5: a stored approval authorises the send; `humanApproved` is
    // ignored by the publisher now, so create the record the old flag stood for.
    await grantApproval(rig.runtime.store, { sessionId: prep.sessionId, candidateId: prep.candidateId, config: rig.runtime.config })
    const report = await runPublish(rig.runtime, {
      sessionId: prep.sessionId,
      candidateId: prep.candidateId,
      approvedText: prep.text,
    })
    assert.equal(report.ok, true, report.message)
    assert.deepEqual(
      seen,
      ['900000000000'],
      '登录检查应读取本次要发表的帖子，而不是固定样例帖',
    )
  } finally {
    rig.dispose()
  }
})
