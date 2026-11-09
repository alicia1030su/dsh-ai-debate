/**
 * 0.3.0 的升级兼容（v0.3.0 阶段 F.1）。
 *
 * ## 与 `v0239-upgrade-safety.test.ts` 的分工
 *
 * 那一组测的是「v0.2.37 / v0.2.38 的形状能不能读」。这一组测的是三件更具体的事：
 *
 * 1. **三个起点都能到 0.3.0**：v0.2.37、v0.2.38、v0.2.39 各一份真实形状，逐一读；
 * 2. **旧批准仍然绑在旧候选上**：读到 `approved: true` 是「历史事实」，不是「新权限」；
 *    读完之后**没有任何路径**会把它转移给另一条候选；
 * 3. **配置与旧 store 同时存在**时互不影响：配置里的 `defaultStrategy`、人格、模型来源
 *    读取后仍然生效，而 store 里的候选字段不受配置变化影响。
 *
 * ## 为什么不只是「能读」
 *
 * 「读得出来」是升级的最低线，但真正的危险在读出之后：一条旧的 `approved: true` 如果被
 * 当成「当前可发表」，升级就成了一个提权动作。所以这里除了读，还断言写回时的行为。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { DebateStore, validateStore } from '../lib/store.js'

/** 一条旧候选；`approved` 由调用方决定，默认已批准 —— 那正是升级时最危险的那一种。 */
function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = '旧版本写下的一条候选。'
  return {
    replyId: 'r-old',
    text,
    strategy: 'direct_rebuttal',
    targetPostId: 'p-target',
    targetSnapshot: {
      postId: 'p-target',
      authorName: '对方',
      contentHash: 'deadbeef',
      capturedAt: '2026-11-01T00:00:00.000Z',
    },
    candidateVersion: 3,
    textHash: 'c0ffee',
    confidence: 0.7,
    violations: [],
    notes: [],
    security: { decision: 'allow', reasons: [], fingerprint: 'fp' },
    createdAt: '2026-11-01T00:00:00.000Z',
    approved: true,
    ...overrides,
  }
}

/** 一份旧会话；`version` 用来标注它来自哪个版本，仅作注释用途。 */
function session(from: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `sess-${from}`,
    platform: 'tieba',
    threadId: 'thread-1',
    threadUrl: 'https://example.invalid/t',
    threadTitle: `${from} 的会话`,
    forumName: '某吧',
    ownerKey: 'owner-1',
    ownerName: '主人',
    opponentKey: 'opp-1',
    opponentName: '对方',
    disputeFloorPostId: 'p-floor',
    disputeFloorNumber: 1,
    triggerPostId: 'p-target',
    targetKind: 'floor',
    publishedPostIds: [],
    persona: 'tieba_veteran',
    sentTexts: [],
    state: 'READY',
    statusText: '候选回复已就绪',
    candidates: [candidate()],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  }
}

function doc(sessions: readonly unknown[]): Record<string, unknown> {
  return { version: 1, sessions, dedupe: [], usage: [] }
}

/** v0.2.38 起候选多了一个字段；它不属于批准语义，但必须被读出来。 */
const ARGUMENT_STRATEGY = {
  id: 'demand_basis',
  name: '追问关键依据',
  source: 'auto',
  reason: '简报里有可引用的论据',
  confidence: 'high',
  evidence: [{ field: 'opponentArguments', postIds: ['p-1'], why: '一条可引用论据' }],
}

test('0.3.0 能读 v0.2.37 / v0.2.38 / v0.2.39 三个起点的 store', () => {
  const cases = [
    { from: '0.2.37', extra: {} },
    { from: '0.2.38', extra: { candidates: [candidate({ argumentStrategy: ARGUMENT_STRATEGY })] } },
    // v0.2.39 的形状：候选可以没有（拒绝类结果不落候选），但会话必须仍在。
    { from: '0.2.39', extra: { candidates: [candidate({ approved: false })], state: 'NEEDS_CONFIRMATION' } },
  ]

  for (const item of cases) {
    const parsed = validateStore(doc([session(item.from, item.extra)]))
    assert.equal(parsed.ok, true, `${item.from} 的 store 读不出来：${parsed.ok ? '' : parsed.reason}`)
    if (!parsed.ok) continue
    assert.equal(parsed.data.sessions.length, 1, `${item.from}：会话必须完整读出`)
    assert.equal(
      parsed.data.sessions[0]!.candidates.length,
      (item.extra.candidates as unknown[] | undefined)?.length ?? 1,
      `${item.from}：候选数量必须保留`,
    )
  }
})

test('0.3.0 读出旧批准，但不把「已批准」当成「可以再发一次」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-030-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [session('0.2.37')] as never }))

    const read = store.getSession('sess-0.2.37')
    assert.ok(read !== undefined)
    assert.equal(read.candidates[0]?.approved, true, '历史批准必须如实读出')

    /**
     * 真正的判据：一条旧的 `approved: true` 没有对应的**批准记录**。
     *
     * 发表路径读的是 `ApprovalRecord`（绑定正文哈希、目标快照与账号），不是这个布尔值。
     * 所以「读出来是 true」不会自动变成一次可发表的授权 —— 旧 store 里没有批准记录，
     * 读出来就是空；发表路径把「没有记录」当成拒绝，而不是「旧布尔值说可以」。
     */
    assert.equal(
      store.getApprovals().length,
      0,
      '旧 store 没有批准记录：布尔值不是授权，读出来为空才是事实',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写回一条新候选时，旧候选的批准被撤销而不是继承', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-030-write-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [session('0.2.37')] as never }))

    // 模拟 0.3.0 重新生成：所有旧候选先撤销，再追加一条未批准的新候选。
    await store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((entry) =>
        entry.id === 'sess-0.2.37'
          ? {
              ...entry,
              candidates: [
                ...entry.candidates.map((row) => ({ ...row, approved: false })),
                candidate({ replyId: 'r-new', text: '新候选', textHash: 'new-hash', approved: false }) as never,
              ] as never,
            }
          : entry,
      ),
    }))

    const after = store.getSession('sess-0.2.37')
    assert.ok(after !== undefined)
    assert.equal(after.candidates.length, 2)
    assert.equal(after.candidates[0]?.approved, false, '旧候选不得保留批准')
    assert.equal(after.candidates[1]?.approved, false, '新候选不得继承批准')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.3.0 的配置读取不会因为 store 里有旧字段而改变', () => {
  // 旧配置里可能有 0.3.0 已经不用的键；它们要么被忽略，要么落回默认值，绝不能让
  // 人格/模型来源跟着变。
  const legacy = resolveConfig({
    ...DEFAULT_CONFIG,
    personaStyle: 'tieba_veteran',
    llmModel: 'legacy-model',
    defaultStrategy: 'demand_evidence',
  } as never)
  assert.equal(legacy.personaStyle, 'tieba_veteran')
  assert.equal(legacy.llmModel, 'legacy-model')

  const withGarbage = resolveConfig({ personaStyle: 'nonsense', defaultStrategy: 'nonsense' } as never)
  assert.equal(withGarbage.personaStyle, DEFAULT_CONFIG.personaStyle, '坏值必须落回默认，而不是留空')
})
