/**
 * v0.2.35 §6：迟到的模型响应不能落地。
 *
 * ## 场景
 *
 * 主人点「生成」，等了两秒觉得问错人了，改成另一条评论再点一次。第二次很快回来了；
 * 第一次在第八秒才回来。
 *
 * 旧行为：第一次的结果照样写进会话，于是页面上出现两条候选，一条答的是主人**已经
 * 放弃**的那条评论，而且它的 `approved` 是 false、版本号比后来那条**大**——
 * 谁是最新候选，从版本号看是反的。
 *
 * 新行为：切换目标的那一刻，旧请求被标记为过期；它回来时结果被丢弃，并且明确告诉
 * 调用方「已被更新的目标取代」，而不是静默成功。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { GenerationGuard } from '../lib/generation-guard.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { getSession, runAnalysis, runGeneration, type Runtime } from '../lib/runtime.js'
import { DebateStore } from '../lib/store.js'
import { FakeAdapter, threePartyThread } from './helpers.ts'

/** The JSON contract a scripted model answers with, aimed at a given post. */
function answer(target: string, reply: string): string {
  return JSON.stringify({
    status: 'ok',
    owner_position: '成本会翻倍',
    opponent_position: '拿不出依据',
    main_dispute: '成本问题',
    latest_argument: '你凭什么说成本会翻倍',
    response_target_id: target,
    strategy: 'direct_rebuttal',
    confidence: 0.8,
    uncertainties: [],
    reply,
  })
}

test('守卫：同目标重复开始被拒，换目标则取代', () => {
  const guard = new GenerationGuard()
  const first = guard.begin('s1', 'p1')
  assert.equal(first.ok, true)

  const duplicate = guard.begin('s1', 'p1')
  assert.equal(duplicate.ok, false, '同一个目标不能同时跑两次')
  assert.equal(duplicate.ok === false ? duplicate.active.token : 0, first.ok ? first.claim.token : -1)

  const other = guard.begin('s1', 'p2')
  assert.equal(other.ok, true, '换了目标就该立刻生效，不能排队')
  assert.equal(guard.isStale('s1', first.ok ? first.claim : { token: -1, targetPostId: '', startedAt: 0 }), true)
  assert.equal(guard.isStale('s1', other.ok ? other.claim : { token: -1, targetPostId: '', startedAt: 0 }), false)

  // 旧请求结束时不能把新请求的占用一起清掉。
  guard.finish('s1', first.ok ? first.claim : { token: -1, targetPostId: '', startedAt: 0 })
  assert.equal(guard.activeClaim('s1')?.token, other.ok ? other.claim.token : -2)

  guard.finish('s1', other.ok ? other.claim : { token: -1, targetPostId: '', startedAt: 0 })
  assert.equal(guard.activeClaim('s1'), undefined)
})

test('守卫：失败的调用必须释放占用，否则一次 429 会锁死会话', () => {
  const guard = new GenerationGuard()
  const claim = guard.begin('s2', 'p1')
  assert.equal(claim.ok, true)
  guard.finish('s2', claim.ok ? claim.claim : { token: -1, targetPostId: '', startedAt: 0 })
  assert.equal(guard.begin('s2', 'p1').ok, true, '释放之后应能重新开始')
})

test('换目标后旧响应被丢弃，会话里只留新目标的候选', async () => {
  const data = threePartyThread({ authorSource: 'wap_inline' })
  const adapter = new FakeAdapter(data)
  const dir = mkdtempSync(join(tmpdir(), 'debate-stale-'))
  const store = new DebateStore({ dir })

  /**
   * 第一个请求卡住，第二个立刻返回。
   *
   * 这是并发顺序的关键：只有让 A 比 B 晚回来，才能测到「迟到的响应」。
   */
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let call = 0
  const client = new (class extends ScriptedLlmClient {
    override async complete(input: Parameters<ScriptedLlmClient['complete']>[0]) {
      call += 1
      const mine = call
      if (mine === 1) await firstGate
      const result = await super.complete(input)
      void mine
      return result
    }
  })([
    { text: answer('n2', '第一条回复，答的是旧的这条评论。') },
    { text: answer('n5', '第二条回复，答的是主人改成的那条评论。') },
  ])

  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    ownerHandle: 'owner-1',
    aiAccountUserId: '1001',
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmModel: 'test-model',
  })
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

  try {
    const analysis = await runAnalysis(runtime, { url: data.thread.url, postId: 'n7' })
    const stale = runGeneration(runtime, { sessionId: analysis.sessionId, targetPostId: 'n2' })
    // 等第一次真的进了模型，再发第二次。
    while (call === 0) await new Promise((resolve) => setTimeout(resolve, 0))

    const fresh = await runGeneration(runtime, { sessionId: analysis.sessionId, targetPostId: 'n5' })
    assert.equal(fresh.candidateId.length > 0, true)

    releaseFirst?.()
    const discarded = await stale.then(
      () => undefined,
      (error: unknown) => error as Error,
    )
    assert.ok(discarded !== undefined, '旧请求必须失败，而不是静默成功')
    assert.match(discarded.message, /已被更新的目标取代|结果已丢弃/)

    const session = (await getSession(runtime, analysis.sessionId)).session
    assert.equal(session.candidates.length, 1, `只应留下一条候选，实际 ${session.candidates.length}`)
    assert.equal(session.candidates[0]!.targetPostId, 'n5', '留下的必须是新目标那条')
    assert.equal(session.candidates[0]!.approved, false, '新候选永远从「未批准」开始')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
