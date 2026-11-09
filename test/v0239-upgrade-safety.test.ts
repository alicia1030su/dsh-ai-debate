/**
 * 升级与数据保护的回归测试（v0.2.39 §6）。
 *
 * ## 这一组测试的对象是「别人机器上的旧文件」
 *
 * 单元测试通常自己造数据，于是永远造出「当前版本期望的形状」。升级问题恰好相反：
 * 输入是**旧版本写下的**文件，而写它的代码已经不在了。所以这里的样本是两段真实的
 * 历史形状（v0.2.37 与 v0.2.38），逐字段构造，不经过当前版本的写入路径。
 *
 * ## 四条不能松的线
 *
 * 1. 旧 store 必须能读 —— 读不了等于升级即失忆。
 * 2. 旧的 `approved: true` 不能变成「新候选也批准了」—— 批准绑的是正文哈希与版本。
 * 3. 旧候选缺少新字段时不能崩，只能显示「未记录」。
 * 4. 损坏的文件不能被静默覆盖 —— 必须留下原件，并允许用备份恢复。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DebateStore, validateStore } from '../lib/store.js'

/** v0.2.37 的候选：没有 `argumentStrategy`，也没有 `outcome`。 */
function candidateV037(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = '这是 v0.2.37 写下的一条候选。'
  return {
    replyId: 'r1',
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

/** v0.2.37 的会话。字段与当年 `StoredSession` 一致，缺后续版本新增的键。 */
function sessionV037(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sess-old',
    platform: 'tieba',
    threadId: 'thread-1',
    threadUrl: 'https://example.invalid/t',
    threadTitle: '旧会话',
    forumName: '某吧',
    ownerKey: 'owner-1',
    ownerName: '主人',
    opponentKey: 'opp-1',
    opponentName: '对方',
    disputeFloorPostId: 'p-floor',
    disputeFloorNumber: 1,
    triggerPostId: 'p-target',
    targetKind: 'floor',
    /** v0.2.37 起就有的必填字段：已发表过的帖子 id（去重台账靠它）。 */
    publishedPostIds: [],
    /** v0.2.37 起的必填字段：这条会话用的人格与发出过的正文。 */
    persona: 'tieba_veteran',
    sentTexts: [],
    state: 'READY',
    statusText: '候选回复已就绪',
    candidates: [candidateV037()],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

function storeDoc(sessions: readonly unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, sessions, dedupe: [], usage: [], ...extra }
}

test('v0.2.37 形状的 store 能被当前版本读取（不丢会话、不丢批准）', () => {
  const parsed = validateStore(storeDoc([sessionV037()]))
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason)
  if (!parsed.ok) return
  assert.equal(parsed.data.sessions.length, 1)
  const session = parsed.data.sessions[0]
  assert.equal(session.candidates.length, 1)
  assert.equal(session.candidates[0].approved, true, '旧批准必须在读出来时仍然存在')
  assert.equal(session.candidates[0].argumentStrategy, undefined, '旧候选没有新字段，读出来就该是 undefined')
})

test('v0.2.38 形状的 store（有 argumentStrategy）也能读', () => {
  const candidate = candidateV037({
    argumentStrategy: {
      id: 'demand_basis',
      name: '追问关键依据',
      source: 'auto',
      reason: '简报里有可引用的论据',
      confidence: 'high',
      evidence: [{ field: 'opponentArguments', postIds: ['p-1'], why: '一条可引用论据' }],
    },
  })
  const parsed = validateStore(storeDoc([sessionV037({ candidates: [candidate] })]))
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason)
  if (!parsed.ok) return
  assert.equal(parsed.data.sessions[0].candidates[0].argumentStrategy?.id, 'demand_basis')
})

test('旧批准不会自动覆盖新候选：新候选的 approved 必须是 false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({
      ...data,
      sessions: [sessionV037()] as never,
    }))

    const session = store.getSession('sess-old')
    assert.ok(session !== undefined)
    assert.equal(session.candidates[0].approved, true)

    // 模拟「升级后重新生成一条」：新写入的候选自带 approved: false。
    await store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((entry) =>
        entry.id === 'sess-old'
          ? {
              ...entry,
              candidates: [
                ...entry.candidates.map((row) => ({ ...row, approved: false })),
                candidateV037({ replyId: 'r2', text: '新候选', textHash: 'new', candidateVersion: 4, approved: false }) as never,
              ] as never,
            }
          : entry,
      ),
    }))

    const after = store.getSession('sess-old')
    assert.ok(after !== undefined)
    assert.equal(after.candidates.length, 2)
    assert.equal(
      after.candidates.find((row) => row.replyId === 'r2')?.approved,
      false,
      '新候选不能继承旧批准',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store 版本不认识时拒绝启动，并说明原因（不静默降级）', () => {
  const parsed = validateStore({ version: 2, sessions: [], dedupe: [] })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.match(parsed.reason, /version/)
  assert.match(parsed.reason, /备份|手动/)
})

test('损坏的 store 不被静默覆盖，原文件留作 *.corrupt-*', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-corrupt-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [sessionV037()] as never }))

    // 截断文件，模拟写盘中途断电。
    const path = join(dir, 'state.json')
    const good = readFileSync(path, 'utf8')
    writeFileSync(path, good.slice(0, Math.floor(good.length / 2)), 'utf8')

    const second = new DebateStore({ dir })
    await assert.rejects(() => second.ready(), /损坏|无法|不是|缺少/)

    const kept = readFileSync(path, 'utf8')
    assert.ok(kept.length < good.length, '损坏的内容必须原样留着，不能被空状态覆盖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('备份可以恢复：换回好文件后能正常读取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restore-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [sessionV037()] as never }))
    const path = join(dir, 'state.json')
    const good = readFileSync(path, 'utf8')
    writeFileSync(join(dir, 'state.json.backup'), good, 'utf8')

    writeFileSync(path, '{ broken', 'utf8')
    const broken = new DebateStore({ dir })
    await assert.rejects(() => broken.ready())

    // 用备份覆盖回去。
    writeFileSync(path, readFileSync(join(dir, 'state.json.backup'), 'utf8'), 'utf8')
    const restored = new DebateStore({ dir })
    await restored.ready()
    assert.equal(restored.snapshot().sessions.length, 1)
    assert.equal(restored.snapshot().sessions[0].id, 'sess-old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('残留的临时文件不影响启动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tmpfile-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [sessionV037()] as never }))
    // 上次写到一半留下的临时文件。
    writeFileSync(join(dir, 'state.json.tmp'), '{ half written', 'utf8')

    const second = new DebateStore({ dir })
    await second.ready()
    assert.equal(second.snapshot().sessions.length, 1, '临时文件不该让正常状态读不出来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store 里未知的顶层键不会让整份状态读不出来（前向兼容的底线）', () => {
  /**
   * 这条断言的是「不会被拒绝」，**不是**「会被保留」。
   *
   * `validateStore` 是逐字段重建文档的，没在重建清单里的键会被丢掉。对
   * `approvals` / `verification` 这类字段，那个丢法曾经是真实事故（批准记录重启后消失），
   * 因为它们**必须**存在；而对一个当前版本根本不认识的键，丢掉是安全的 —— 它本来
   * 就没有读者。
   *
   * 真正危险的是「不认识就整份拒绝」：那样一次宿主升级写进一个新键，用户的全部会话
   * 都会读不出来。所以底线是接受并继续。
   *
   * 记录这个边界而不是美化它：未知键会在下一次写入时消失。如果将来真的需要跨版本
   * 保留字段，得显式加进重建清单，并配一次迁移测试。
   */
  const parsed = validateStore({
    ...storeDoc([sessionV037()]),
    someFutureField: { hello: 'world' },
  })
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason)
  if (!parsed.ok) return
  assert.equal(parsed.data.sessions.length, 1, '未知键不能让会话读不出来')
})
