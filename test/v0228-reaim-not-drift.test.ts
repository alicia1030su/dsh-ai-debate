/**
 * v0.2.28：主人显式选了一条评论时，「对手变了」不是漂移，是重新定向。
 *
 * ## 要防的那个 bug
 *
 * `detectOpponentDrift` 只看一件事：本次分析出来的对手和会话里记的那个人是否
 * 相同。它分不清两种情形：
 *
 * 1. 平台那边变了，重新读出来指向另一个人。没人要求这样，继续生成就会回复一个
 *    主人从没选过的人，所以必须停。
 * 2. 主人点了「用这条」。对手**必然**变——那正是这个按钮的作用。
 *
 * 第二种被当成第一种拒绝时，按钮在最需要它的场合下不可用。这不是设想：微博正文
 * 下面三个人互动证据相同，首次分析歧义，主人纠正到「后说话的」，得到的是
 * 「争论对象已变化」+ 四个浏览器阶段全红 + 一个候选都没有。
 *
 * ## 断言的口径
 *
 * 全部走生产的 `runGeneration`，不断言中间函数。要证明的是三件可证伪的事：
 * 显式目标能生成、候选真的对着那个人、以及没有显式目标时旧的硬停**仍然**在。
 * 第三条同样重要：修一个漏判不能顺手把守卫拆了。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { runAnalysis, runGeneration, type Runtime } from '../lib/runtime.js'
import { FakeAdapter, threePartyThread } from './helpers.ts'

function modelReply(target = 'n5'): string {
  return JSON.stringify({
    status: 'ok',
    owner_position: '成本会翻倍',
    opponent_position: '缺少依据',
    main_dispute: '成本问题',
    latest_argument: '你凭什么说成本会翻倍',
    response_target_id: target,
    strategy: 'demand_evidence',
    confidence: 0.8,
    uncertainties: [],
    reply: '前面已经把报价贴出来了，你是没看还是不想看？要反驳就拿出同型号的价格。',
  })
}

function makeRig(): {
  runtime: Runtime
  store: DebateStore
  dispose: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'debate-reaim-'))
  const store = new DebateStore({ dir, sessionTtlMs: 7 * 24 * 60 * 60 * 1000 })
  const data = threePartyThread({ authorSource: 'wap_inline' })
  const adapter = new FakeAdapter(data)
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    ownerHandle: 'owner-1',
    aiAccountUserId: '1001',
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
  })
  // A long enough script that a test which generates more than once cannot run dry and
  // fail for the wrong reason.
  const client = new ScriptedLlmClient(Array.from({ length: 12 }, () => ({ text: modelReply() })))
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
  return { runtime, store, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test('主人显式选一条别人的发言时，对手变化不阻止生成', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread({ authorSource: 'wap_inline' })
    // The summon sits on the owner's own post, so the analysis infers the opponent
    // from the exchange — the fixture points it at 对手B.
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const before = await rig.store.getSession(analysis.sessionId)
    assert.ok(before?.opponentKey !== undefined, '前置条件：首次分析必须已经认定了一个对手')

    // Now the owner answers 路人C instead. Before v0.2.28 this threw
    // 「争论对象已变化」 and no candidate was ever written.
    const generated = await runGeneration(rig.runtime, {
      sessionId: analysis.sessionId,
      targetPostId: 'n3',
    })

    assert.ok(generated.candidateId !== undefined && generated.candidateId !== '', '必须产出候选')

    const after = await rig.store.getSession(analysis.sessionId)
    assert.ok(after !== undefined)
    const candidate = after.candidates.find((row) => row.replyId === generated.candidateId)
    assert.ok(candidate !== undefined, '候选必须落盘')

    // The decisive fact: the candidate is addressed at the post the owner picked,
    // not at whoever the first analysis guessed.
    assert.equal(candidate.targetPostId, 'n3', `候选必须对着 n3，实际 ${candidate.targetPostId}`)
    assert.equal(candidate.targetSnapshot?.targetPostId, 'n3', '目标快照必须与候选一致')

    // And the session's own idea of the opponent moved with it, so the *next*
    // generate (which carries no targetPostId) does not refuse as drift.
    //
    // Compared by *name* rather than by the key literal: the key's prefix encodes
    // which identity surface the fixture exposed (`handle:` here, `uid:` on a
    // platform that has numeric ids), and pinning the prefix would make this test
    // about the fixture's identity shape instead of about the re-aim.
    assert.equal(after.opponentName, '路人C', `对手应更新为路人C，实际 ${after.opponentName}`)
    assert.ok(
      after.opponentKey?.endsWith(':other-1') === true,
      `对手 key 必须指向路人C，实际 ${after.opponentKey}`,
    )
    // The choice itself is stored, which is what makes 「用这条」 sticky.
    assert.equal(after.selectedTargetPostId, 'n3', `必须记住选中的目标，实际 ${after.selectedTargetPostId}`)
  } finally {
    rig.dispose()
  }
})

test('重新定向后紧接着的普通生成不会被自己触发的漂移拦住', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread({ authorSource: 'wap_inline' })
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    await runGeneration(rig.runtime, { sessionId: analysis.sessionId, targetPostId: 'n3' })

    // No targetPostId this time — exactly what a plain 「生成候选」 press sends.
    // Before the session's opponent record was updated alongside the re-aim, this
    // was the same bug one turn later: drift against a session that is internally
    // consistent.
    const second = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })
    assert.ok(second.candidateId !== undefined && second.candidateId !== '', '第二次生成必须成功')
    assert.notEqual(second.candidateId, undefined)
  } finally {
    rig.dispose()
  }
})

test('重新定向会让旧候选的批准失效', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread({ authorSource: 'wap_inline' })
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const first = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })

    // Approve the first candidate by hand — the store is the authority, and the
    // publish path is what normally writes this.
    await rig.store.mutate((store) => ({
      ...store,
      sessions: store.sessions.map((session) =>
        session.id === analysis.sessionId
          ? {
              ...session,
              candidates: session.candidates.map((row) =>
                row.replyId === first.candidateId ? { ...row, approved: true } : row,
              ),
            }
          : session,
      ),
    }))

    await runGeneration(rig.runtime, { sessionId: analysis.sessionId, targetPostId: 'n3' })

    const after = await rig.store.getSession(analysis.sessionId)
    assert.ok(after !== undefined)
    const old = after.candidates.find((row) => row.replyId === first.candidateId)
    assert.ok(old !== undefined)
    // Those bytes answer a different person; leaving them approved is the
    // two-truths-at-once a review step exists to prevent.
    assert.equal(old.approved, false, '重新定向后旧候选不能还挂着批准')
  } finally {
    rig.dispose()
  }
})

test('没有显式目标时，平台那边真的换了人仍然硬停', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread({ authorSource: 'wap_inline' })
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })

    // Simulate the platform moving on: the stored session now remembers somebody the
    // fresh analysis will not agree with. Nothing was asked for, so this must stop.
    await rig.store.mutate((store) => ({
      ...store,
      sessions: store.sessions.map((session) =>
        session.id === analysis.sessionId
          ? { ...session, opponentKey: 'uid:tieba:someone-else', opponentName: '另一个人' }
          : session,
      ),
    }))

    const before = await rig.store.getSession(analysis.sessionId)
    const countBefore = before?.candidates.length ?? 0

    await assert.rejects(
      () => runGeneration(rig.runtime, { sessionId: analysis.sessionId }),
      /争论对象已变化/,
      '没有显式目标时，漂移必须继续硬化',
    )

    const after = await rig.store.getSession(analysis.sessionId)
    assert.equal(after?.candidates.length, countBefore, '被拒的生成不得留下候选')
  } finally {
    rig.dispose()
  }
})

test('显式目标不在这次读取里时，仍然拒绝而不是凭空生成', async () => {
  const rig = makeRig()
  try {
    const data = threePartyThread({ authorSource: 'wap_inline' })
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })

    // Re-aiming is allowed; inventing a target is not. The comment list is the
    // authority on what was actually read, and an id outside it has no identity
    // check, no floor and no content behind it.
    await assert.rejects(
      () => runGeneration(rig.runtime, { sessionId: analysis.sessionId, targetPostId: 'n999' }),
      /不在这次读取到的评论里/,
      '没读过的 id 必须被拒',
    )

    const after = await rig.store.getSession(analysis.sessionId)
    assert.equal(after?.candidates.length, 0, '被拒的生成不得留下候选')
  } finally {
    rig.dispose()
  }
})
