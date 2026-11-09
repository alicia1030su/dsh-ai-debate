/**
 * `approved` 字段只能被初始化或被撤销，不能被生成链路授予（v0.2.39 复审 §3）。
 *
 * ## 这条审计为什么必须写下来
 *
 * v0.2.39 在 `runGeneration` 里加了一个分支：没有草稿的结果不再落空候选。改动本身很小，
 * 但它动的是一个**带批准语义**的数组构造式：
 *
 * ```ts
 * candidates: storeCandidate
 *   ? [...(reaimed ? 撤销全部 : entry.candidates), candidate]
 *   : reaimed ? 撤销全部 : entry.candidates
 * ```
 *
 * 一旦这段写错方向（例如把 `reaimed` 写反、或把 `approved: false` 挪到不该在的位置），
 * 后果不是「少一条候选」，而是**把一句主人没批准过的文本变成可发表**。这属于最坏的一类
 * 回归：页面看起来正常，发布路径也不会报错。
 *
 * 所以这里用两种证据夹住它：
 *
 * 1. **静态不变量**：`src/runtime.ts` 里不存在 `approved: true`；每一处 `approved: false`
 *    只能是「新对象的初始值」或「把旧对象映射为撤销」两种形态之一。生成链路没有第三个
 *    写入口 —— 授予批准只发生在 `index.ts` / `workflow.ts` / `publisher.ts` 的显式操作里。
 * 2. **行为断言**：走真实的 `runGeneration`，证明「没草稿的一次生成」既不新增候选，
 *    也不在未重定向时撤销已有批准；而重定向时**必须**撤销。两条都要成立，否则
 *    「只初始化或撤销」就是一句空话。
 *
 * ## 真实 diff 的对照
 *
 * 复审时逐行比对了 `c372091..HEAD` 的 `src/runtime.ts`：新增的 `approved: false` 只有
 * 重定向分支那一处，而它在旧代码里本来就在（只是被重新缩进到三元表达式内）。新候选的
 * `approved: false` 与 `src/index.ts` 里授予批准的那两处都没有变动。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { ScriptedLlmClient } from '../lib/llm.js'
import { runAnalysis, runGeneration, type Runtime } from '../lib/runtime.js'
import { FakeAdapter, threePartyThread } from './helpers.ts'

const ROOT = join(import.meta.dirname, '..')

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

/** 模型要求补材料；`reply` 是空串，正是「没有草稿」的那一类结果。 */
function refusalReply(): string {
  return JSON.stringify({
    status: 'needs_more_context',
    reason: '对方那条被删的评论原文没有读全，缺了要反驳的那句话',
    owner_position: '成本会翻倍',
    opponent_position: '',
    main_dispute: '成本问题',
    latest_argument: '',
    response_target_id: 'n5',
    strategy: 'demand_evidence',
    confidence: 0.4,
    uncertainties: [],
    reply: '',
  })
}

function makeRig(responses: readonly { text: string }[]): {
  runtime: Runtime
  store: DebateStore
  dispose: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'debate-approved-'))
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
  const client = new ScriptedLlmClient([...responses])
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

/** 手工把一条候选标成已批准 —— 真实链路由 `src/index.ts` 的批准动作写入。 */
async function approve(store: DebateStore, sessionId: string, replyId: string): Promise<void> {
  await store.mutate((data) => ({
    ...data,
    sessions: data.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            candidates: session.candidates.map((row) =>
              row.replyId === replyId ? { ...row, approved: true } : row,
            ),
          }
        : session,
    ),
  }))
}

test('静态：runtime.ts 从不写入 approved: true', () => {
  const text = readFileSync(join(ROOT, 'src', 'runtime.ts'), 'utf8')
  assert.doesNotMatch(
    text,
    /approved\s*:\s*true/,
    '生成链路不得授予批准；授予只发生在 index.ts / workflow.ts / publisher.ts 的显式操作里',
  )
})

test('静态：每一处 approved: false 只能是「新对象初始值」或「撤销映射」', () => {
  const text = readFileSync(join(ROOT, 'src', 'runtime.ts'), 'utf8')
  const lines = text.split(/\r?\n/)
  const writes = lines.filter((line) => /approved\s*:/.test(line))
  assert.ok(writes.length > 0, '找不到任何 approved 写入点，说明审计本身失效了')

  for (const line of writes) {
    const trimmed = line.trim()
    const initializer = trimmed === 'approved: false,'
    const revocation = /map\(\(row\) => \(\{ \.\.\.row, approved: false \}\)\)/.test(trimmed)
    assert.ok(
      initializer || revocation,
      `出现了第三种 approved 写入形态，必须重新审核：\n    ${trimmed}`,
    )
  }
})

test('行为：新生成的候选一律未批准', async () => {
  const rig = makeRig([{ text: modelReply() }])
  try {
    const data = threePartyThread({ authorSource: 'wap_inline' })
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const generated = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })

    const session = await rig.store.getSession(analysis.sessionId)
    assert.ok(session !== undefined)
    const candidate = session.candidates.find((row) => row.replyId === generated.candidateId)
    assert.ok(candidate !== undefined, '候选必须落盘')
    assert.equal(candidate.approved, false, '刚生成的候选不可能已获批准')
  } finally {
    rig.dispose()
  }
})

test('行为：没有草稿的生成既不加候选，也不撤销一次普通（未重定向）生成前的批准', async () => {
  const rig = makeRig([{ text: modelReply() }, { text: refusalReply() }])
  try {
    const data = threePartyThread({ authorSource: 'wap_inline' })
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const first = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })
    assert.ok(first.candidateId !== undefined)
    await approve(rig.store, analysis.sessionId, first.candidateId)

    const before = await rig.store.getSession(analysis.sessionId)
    const countBefore = before?.candidates.length ?? 0

    // 同一个目标，不重定向：这次模型只要求补材料。
    const refused = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })
    assert.ok(
      refused.outcome === 'needs_more_context' || refused.outcome === 'unjustified_refusal',
      `没有草稿的结果必须被分类成拒绝类，实际 ${refused.outcome}`,
    )
    assert.equal(refused.text, '', '拒绝不返回正文')
    assert.equal(refused.candidateId, undefined, '拒绝不产生候选 id')

    const after = await rig.store.getSession(analysis.sessionId)
    assert.equal(after?.candidates.length, countBefore, '拒绝不得追加空候选')
    const kept = after?.candidates.find((row) => row.replyId === first.candidateId)
    assert.equal(
      kept?.approved,
      true,
      '目标没变时，之前的批准仍然有效；撤销它会让主人白批一次',
    )
  } finally {
    rig.dispose()
  }
})

test('行为：重定向后的拒绝会撤销旧批准，且仍然不追加空候选', async () => {
  const rig = makeRig([{ text: modelReply() }, { text: refusalReply() }])
  try {
    const data = threePartyThread({ authorSource: 'wap_inline' })
    const analysis = await runAnalysis(rig.runtime, { url: data.thread.url, postId: 'n7' })
    const first = await runGeneration(rig.runtime, { sessionId: analysis.sessionId })
    assert.ok(first.candidateId !== undefined)
    await approve(rig.store, analysis.sessionId, first.candidateId)

    const before = await rig.store.getSession(analysis.sessionId)
    const countBefore = before?.candidates.length ?? 0

    // 显式改答另一个人：旧候选的字节对着别人，批准必须失效 —— 即使这次没有新草稿。
    const refused = await runGeneration(rig.runtime, {
      sessionId: analysis.sessionId,
      targetPostId: 'n3',
    })
    assert.ok(
      refused.outcome === 'needs_more_context' || refused.outcome === 'unjustified_refusal',
      `重定向后的拒绝仍然是拒绝类，实际 ${refused.outcome}`,
    )

    const after = await rig.store.getSession(analysis.sessionId)
    assert.equal(after?.candidates.length, countBefore, '拒绝不得追加空候选')
    const old = after?.candidates.find((row) => row.replyId === first.candidateId)
    assert.equal(old?.approved, false, '重定向后旧候选不能还挂着批准')
  } finally {
    rig.dispose()
  }
})
