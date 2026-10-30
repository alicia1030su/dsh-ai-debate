/**
 * Independent re-check of the seven v0.1.3 audit invariants against the current
 * `lib/` build.
 *
 * Written from the documented invariant list rather than by copying the old script,
 * which is the point of a regression re-check: it should fail if a later change
 * quietly removed one of these guards. No network, no real publishing.
 *
 * Run with:
 *   node --experimental-transform-types scripts/audit-invariants.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { runAnalysis, runGeneration, runPublish } from '../lib/runtime.js'
// `grantApproval` is a test helper: it mints the approval record the publisher now requires
// (v0.2.5 removed the caller-supplied boolean on purpose).
import { FakeAdapter, grantApproval, threePartyThread } from '../test/helpers.ts'

let failures = 0
const results = []

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function modelReply(overrides = {}) {
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

function makeRig({ publisher, text } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-seven-'))
  const store = new DebateStore({ dir })
  const base = threePartyThread()
  const data = publisher ? { ...base, publish: publisher } : base
  const adapter = new FakeAdapter(data)
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    ownerUserId: 'owner-1',
    aiAccountUserId: '1001',
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'audit',
  })
  const client = new ScriptedLlmClient(Array.from({ length: 6 }, () => ({ text: text ?? modelReply() })))
  const runtime = {
    adapter,
    store,
    policy: { mode: 'manual', maxAutoPublishesPerSession: 0, cooldownMs: 0, maxPublishesPerThread: 10, stopOnChallenge: true },
    config: () => config,
    llm: () => client,
    log: () => undefined,
  }
  return { runtime, adapter, store, dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

const data = threePartyThread()

// 1. OLD_CANDIDATE — a stale candidate must not be published.
{
  const rig = makeRig()
  try {
    const a = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const first = await runGeneration(rig.runtime, { sessionId: a.sessionId })
    await runGeneration(rig.runtime, { sessionId: a.sessionId }) // bumps version
    const report = await runPublish(rig.runtime, {
      sessionId: a.sessionId,
      candidateId: first.candidateId,
      approvedText: first.text,
    })
    check('OLD_CANDIDATE 旧版本候选被拒', report.ok, false)
    check('OLD_CANDIDATE 平台调用次数', rig.adapter.publishes.length, 0)
  } finally {
    rig.dispose()
  }
}

// 2. THROWN_TIMEOUT — a throw after the request was sent is "uncertain", not "failed".
{
  let calls = 0
  const rig = makeRig({
    publisher: () => {
      calls += 1
      const error = new Error('socket hang up')
      error.code = 'ECONNRESET'
      throw error
    },
  })
  try {
    const a = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const g = await runGeneration(rig.runtime, { sessionId: a.sessionId })
    // v0.2.5+: an approval is a record, not a caller-supplied boolean.
await grantApproval(rig.store, {
  sessionId: a.sessionId,
  candidateId: g.candidateId,
  config: rig.runtime.config,
})
const report = await runPublish(rig.runtime, {
  sessionId: a.sessionId,
  candidateId: g.candidateId,
  approvedText: g.text,
})
    const key = rig.store.snapshot().dedupe[0]?.key
    check('THROWN_TIMEOUT 发表结果', report.status, 'uncertain')
    check('THROWN_TIMEOUT 去重状态', rig.store.findDedupe(key)?.publishState, 'pending')
    check('THROWN_TIMEOUT 平台调用次数', calls, 1)
  } finally {
    rig.dispose()
  }
}

// 3. UNBOUND_AI_ACCOUNT — publishing without a bound AI account must be refused.
{
  const dir = mkdtempSync(join(tmpdir(), 'audit-unbound-'))
  const store = new DebateStore({ dir })
  const adapter = new FakeAdapter(data)
  const config = resolveConfig({ ...DEFAULT_CONFIG, ownerUserId: 'owner-1', llmBaseUrl: 'http://127.0.0.1:1/v1', llmModel: 'audit' })
  const client = new ScriptedLlmClient(Array.from({ length: 4 }, () => ({ text: modelReply() })))
  const runtime = {
    adapter,
    store,
    policy: { mode: 'manual', maxAutoPublishesPerSession: 0, cooldownMs: 0, maxPublishesPerThread: 10, stopOnChallenge: true },
    config: () => config,
    llm: () => client,
    log: () => undefined,
  }
  try {
    const a = await runAnalysis(runtime, { url: data.thread.url, postId: 'n7' })
    const g = await runGeneration(runtime, { sessionId: a.sessionId })
      // v0.2.5+: an approval is a stored record, not a caller-supplied boolean.
      await grantApproval(runtime.store, {
        sessionId: a.sessionId,
        candidateId: g.candidateId,
        config: runtime.config,
      })
    const report = await runPublish(runtime, {
      sessionId: a.sessionId,
      candidateId: g.candidateId,
      approvedText: g.text,
    })
    check('UNBOUND_AI_ACCOUNT 被拒', report.ok, false)
    check('UNBOUND_AI_ACCOUNT 原因', report.errorCode, 'identity_unbound')
    check('UNBOUND_AI_ACCOUNT 平台调用次数', adapter.publishes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 4. CAP_CONFIRMED — the text cap must keep whole sentences, not swallow the opening one.
{
  const rig = makeRig()
  try {
    const a = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const g = await runGeneration(rig.runtime, { sessionId: a.sessionId })
    // A long body: the guard must reject or trim rather than silently store a stub.
    const long = '第一句话必须留下。' + '中间的填充内容。'.repeat(400) + '最后一句也要在。'
      // v0.2.5+: an approval is a stored record, not a caller-supplied boolean.
      await grantApproval(rig.runtime.store, {
        sessionId: a.sessionId,
        candidateId: g.candidateId,
        config: rig.runtime.config,
      })
    const report = await runPublish(rig.runtime, {
      sessionId: a.sessionId,
      candidateId: g.candidateId,
      approvedText: long,
    })
    check('CAP_CONFIRMED 超长正文被拒', report.ok, false)
    check('CAP_CONFIRMED 平台调用次数', rig.adapter.publishes.length, 0)
  } finally {
    rig.dispose()
  }
}

// 5. MISSING_POST_ID — success without a post id is uncertain, not confirmed.
{
  const rig = makeRig({ publisher: () => ({ status: 'confirmed' }) })
  try {
    const a = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const g = await runGeneration(rig.runtime, { sessionId: a.sessionId })
      // v0.2.5+: an approval is a stored record, not a caller-supplied boolean.
      await grantApproval(rig.runtime.store, {
        sessionId: a.sessionId,
        candidateId: g.candidateId,
        config: rig.runtime.config,
      })
    const report = await runPublish(rig.runtime, {
      sessionId: a.sessionId,
      candidateId: g.candidateId,
      approvedText: g.text,
    })
    const key = rig.store.snapshot().dedupe[0]?.key
    check('MISSING_POST_ID 结果不是 confirmed', report.status === 'confirmed', false)
    check('MISSING_POST_ID 去重不是 confirmed', rig.store.findDedupe(key)?.publishState === 'confirmed', false)
  } finally {
    rig.dispose()
  }
}

// 6. CACHED_FLOOR — a publish must re-read the target, not reuse a cached body.
{
  const rig = makeRig()
  try {
    const a = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const g = await runGeneration(rig.runtime, { sessionId: a.sessionId })
    // Count context reads by wrapping the adapter; the fake has no counter for them.
    let reads = 0
    const inner = rig.runtime.adapter
    rig.runtime.adapter = {
      ...inner,
      getReplyContext: (...args) => {
        reads += 1
        return inner.getReplyContext(...args)
      },
      getCapabilities: () => inner.getCapabilities(),
      getThread: (...args) => inner.getThread(...args),
      getReplies: (...args) => inner.getReplies(...args),
      getNestedReplies: (...args) => inner.getNestedReplies(...args),
      getUserProfile: (...args) => inner.getUserProfile(...args),
      getMentions: (...args) => inner.getMentions(...args),
      publishReply: (...args) => inner.publishReply(...args),
      checkAuthentication: (...args) => inner.checkAuthentication(...args),
    }
      // v0.2.5+: an approval is a stored record, not a caller-supplied boolean.
      await grantApproval(rig.runtime.store, {
        sessionId: a.sessionId,
        candidateId: g.candidateId,
        config: rig.runtime.config,
      })
    await runPublish(rig.runtime, {
      sessionId: a.sessionId,
      candidateId: g.candidateId,
      approvedText: g.text,
    })
    check('CACHED_FLOOR 发表前重新读取了目标', reads > 0, true)
  } finally {
    rig.dispose()
  }
}

// 7. NAME_AUTHOR_DRIFT — a renamed author is a mismatch, not "no drift".
{
  const rig = makeRig({
    publisher: () => ({ status: 'confirmed', postId: 'x1' }),
  })
  try {
    const a = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const g = await runGeneration(rig.runtime, { sessionId: a.sessionId })
    // Rename the target's author between generation and publish, and drop the id so
    // the name is the only signal — this is the shape the drift check exists for.
    // (With an id present the id wins, and a rename is correctly not a mismatch.)
    const nested = Object.fromEntries(
      Object.entries(data.nested).map(([key, replies]) => [
        key,
        replies.map((r) => (r.postId === 'n5' ? { ...r, authorName: '改过名的对手', authorId: '' } : r)),
      ]),
    )
    rig.runtime.adapter = new FakeAdapter({ ...data, nested })
      // v0.2.5+: an approval is a stored record, not a caller-supplied boolean.
      await grantApproval(rig.runtime.store, {
        sessionId: a.sessionId,
        candidateId: g.candidateId,
        config: rig.runtime.config,
      })
    const report = await runPublish(rig.runtime, {
      sessionId: a.sessionId,
      candidateId: g.candidateId,
      approvedText: g.text,
    })
    check('NAME_AUTHOR_DRIFT 改名后被拒', report.ok, false)
    check('NAME_AUTHOR_DRIFT 平台调用次数', rig.runtime.adapter.publishes.length, 0)
  } finally {
    rig.dispose()
  }
}

console.log(results.join('\n'))
console.log(`\n${results.length} 项检查，失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
