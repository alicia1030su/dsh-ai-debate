/**
 * Versions and ids have to be unique per session, and they were not.
 *
 * ## What went wrong, and why it was invisible
 *
 * `runGeneration` computed both `replyId` and `candidateVersion` from the `session`
 * object it had read **before** calling the model. That call is the slowest step in the
 * function — seconds, on a real provider. Anything that touched the same session during
 * those seconds (an edit, which bumps `candidateVersion` by design, or a second
 * generation) committed first, and this candidate then landed on a number that was
 * already taken.
 *
 * The evidence was in the store, not in a failing test: after one browser run, one
 * session held
 *
 *     c1  v2  approved=false  「（这句是人工编辑追加的）成本可以分摊到三年…」
 *     c2  v2  approved=true   「成本可以分摊到三年…」
 *
 * Two candidates at the same version. `approvalStillApplies` decides "does this approval
 * cover the text the owner read?" partly by comparing versions, and `publishCandidate`
 * refuses anything older than the newest version — both of those comparisons are
 * meaningless when two rows share a number. It also produced the GUI failure that looked
 * like a flaky test: the edit landed on one row, the approval on the other, and the
 * published text was the unedited one.
 *
 * The fix is to allocate both inside `mutate`, from the document that is about to be
 * written. That is the only place where "the next free number" is knowable.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveConfig, DEFAULT_CONFIG } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import {
  editCandidate,
  getSession,
  runAnalysis,
  runGeneration,
  type Runtime,
} from '../lib/runtime.js'
import { DebateStore } from '../lib/store.js'
import { FakeAdapter, threePartyThread , candidateIdOf} from './helpers.ts'

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

/**
 * The defect, reproduced the way it happened: an edit lands while generation is still
 * waiting on the model.
 *
 * The model client is held open by a promise the test controls, so the interleaving is
 * deterministic rather than a race to be hoped for.
 */
test('an edit during generation does not steal the new candidate version', async () => {
  const data = threePartyThread({ authorSource: 'wap_inline' })
  const adapter = new FakeAdapter(data)
  const dir = mkdtempSync(join(tmpdir(), 'debate-version-'))

  // A model that answers only when the test says so.
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const store = new DebateStore({ dir })
  // Only the *second* call blocks; the first has to finish so there is a candidate to
  // edit while #2 is in flight.
  const client = new (class extends ScriptedLlmClient {
    private calls = 0
    override async complete(input: Parameters<ScriptedLlmClient['complete']>[0]) {
      const result = await super.complete(input)
      this.calls += 1
      if (this.calls >= 2) await gate
      return result
    }
  })([{ text: modelReply() }, { text: modelReply() }])
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
    const first = await runGeneration(runtime, { sessionId: analysis.sessionId })
    assert.equal(
      (await getSession(runtime, analysis.sessionId)).session.candidates[0]?.candidateVersion,
      1,
      '第一条候选应当是第 1 版',
    )

    // Generation #2 starts and blocks inside the model call.
    const inFlight = runGeneration(runtime, { sessionId: analysis.sessionId })
    // An edit to candidate #1 commits while #2 is still waiting on the model. The edit
    // bumps #1 to v2 — this is by design, and it is what used to collide.
    const edited = await editCandidate(runtime, {
      sessionId: analysis.sessionId,
      candidateId: candidateIdOf(first),
      text: '前面已经把报价贴出来了，你是没看还是不想看？要反驳就拿出同型号的价格。（人工补充）',
    })
    assert.equal(edited.ok, true)
    assert.equal(edited.ok && edited.candidateVersion, 2)

    release?.()
    const second = await inFlight

    const session = (await getSession(runtime, analysis.sessionId)).session
    const versions = session.candidates.map((row) => row.candidateVersion)
    const ids = session.candidates.map((row) => row.replyId)

    assert.equal(
      new Set(versions).size,
      versions.length,
      `同一个会话里不能有两条候选共用版本号（实际：${versions.join(', ')}）`,
    )
    assert.equal(new Set(ids).size, ids.length, `候选 id 不能重复（实际：${ids.join(', ')}）`)
    assert.equal(
      second.candidateId,
      session.candidates[session.candidates.length - 1]?.replyId,
      '返回的候选 id 必须就是写进文档的那一条',
    )
    assert.ok(
      (session.candidates.find((row) => row.replyId === second.candidateId)?.candidateVersion ?? 0) > 2,
      '后生成的候选版本号必须大于编辑后的版本号，否则批准无法区分审的是哪一版',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Two generations in flight at once must not be handed the same id or version.
 *
 * This is the same defect from the other side. `newCandidateId(session.id,
 * session.candidates.length + 1)` read the length from the pre-model snapshot, so two
 * overlapping generations both computed `-c2` and both wrote a row under that key. The
 * id is what an approval, an edit and a publish address, so a duplicate there means an
 * action can land on a candidate the owner never looked at.
 */
/**
 * 并发生成在 v0.2.35 里变成了**被拒绝**，而不是「两个都写入」。
 *
 * ## 为什么这一条要改写而不是删掉
 *
 * 它原来断言：两次并发生成各自拿到不同的 id 与版本号，两条都写进文档。那是对
 * v0.2.27 那次修复的验证 —— 版本号在 `mutate` 里分配，所以不会撞号。那个性质仍然
 * 成立，而且仍然重要（编辑与生成并发时还会走到它）。
 *
 * 但 v0.2.35 §6 把「同目标重复点击」定义成不该发生的事：两次并发生成会多花一次模型
 * 调用，并让主人刚做过的一次批准在第二次写入时被作废。现在的正确行为是：第一次
 * 受理，第二次立刻被拒，并且**只写一条候选**。
 *
 * 所以这一条改成断言新契约，而「版本号不撞」由同文件的编辑并发那条继续守着 ——
 * 断言没有删，只是换了要守的对象。
 */
test('两次并发生成：后到的被拒绝，文档里只留一条候选', async () => {
  const data = threePartyThread({ authorSource: 'wap_inline' })
  const adapter = new FakeAdapter(data)
  const dir = mkdtempSync(join(tmpdir(), 'debate-version-'))

  // 一个闸门：让第一次调用停在模型里，第二次才有机会撞上来。
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const store = new DebateStore({ dir })
  const client = new (class extends ScriptedLlmClient {
    override async complete(input: Parameters<ScriptedLlmClient['complete']>[0]) {
      calls += 1
      if (calls === 1) await gate
      return super.complete(input)
    }
  })([{ text: modelReply() }, { text: modelReply() }])

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
    const first = runGeneration(runtime, { sessionId: analysis.sessionId })
    // 等第一次真的进到模型里，再发第二次：否则「拒绝」可能只是因为两个调用还没重叠。
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await runGeneration(runtime, { sessionId: analysis.sessionId }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, message: (error as Error).message }),
    )
    assert.equal(second.ok, false, '同目标的第二次生成必须被拒绝，不能重复花钱')
    assert.match(second.ok ? '' : second.message, /已经在生成中|重复/i)
    release?.()
    const done = await first

    const session = (await getSession(runtime, analysis.sessionId)).session
    assert.equal(session.candidates.length, 1, `只应留下一条候选，实际 ${session.candidates.length}`)
    assert.equal(session.candidates[0]!.replyId, done.candidateId)
    assert.equal(calls, 1, `模型只该被调用一次，实际 ${calls}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
