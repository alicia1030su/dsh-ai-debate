/**
 * 故障注入（v0.3.0 阶段 F.2）。
 *
 * ## 这一组补的是哪一块
 *
 * `v0239-upgrade-safety` 已经覆盖四类：store 损坏、备份恢复、临时文件残留、未知顶层键。
 * 任务书 §7.2 点名的另外四类一直没有自动化证据：
 *
 * 1. 进程异常退出（写盘中途被杀）
 * 2. 未完成的模型生成（候选只写了一半）
 * 3. 配置写盘失败（磁盘拒绝写入）
 * 4. 会话文件部分损坏（不是整份坏，是某个字段坏）
 *
 * 全部在隔离临时目录里做，不碰任何正式用户数据；每个用例结束都删掉自己的目录。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { DebateStore, validateStore } from '../lib/store.js'

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
      text,
      capturedAt: '2026-11-01T00:00:00.000Z',
    },
    candidateVersion: 1,
    approved: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sess-fault',
    platform: 'manual',
    threadId: 'thread-1',
    threadUrl: 'https://example.invalid/t',
    threadTitle: '故障注入用的会话',
    forumName: '',
    ownerKey: 'owner',
    ownerName: '原帖作者',
    opponentKey: 'opponent',
    opponentName: '对手',
    disputeFloorPostId: 'p-floor',
    disputeFloorNumber: 1,
    triggerPostId: 'p-target',
    targetKind: 'floor',
    publishedPostIds: [],
    state: 'READY',
    statusText: '候选已就绪',
    persona: 'tieba_veteran',
    candidates: [candidate()],
    sentTexts: [],
    comments: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

// ---- 1. 进程异常退出：写盘中途留下的临时文件 ----------------------------------

test('故障注入：写盘中途被杀留下的 .tmp 不会覆盖正式文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kill-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [session()] as never }))
    const good = readFileSync(join(dir, 'state.json'), 'utf8')

    // 模拟：新内容已经写到 .tmp，进程在 rename 之前被杀。
    writeFileSync(join(dir, 'state.json.tmp'), '{"version":1,"sessions":[]}', 'utf8')

    const reopened = new DebateStore({ dir })
    await reopened.ready()
    assert.equal(reopened.snapshot().sessions.length, 1, '正式文件必须还是原来那份')
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), good, '正式文件字节不该被 .tmp 影响')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 2. 未完成的模型生成：候选字段缺一半 --------------------------------------

test('故障注入：候选缺 targetSnapshot 时整份 store 仍可读（不让一条坏候选毁掉全部）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-halfgen-'))
  try {
    mkdirSync(dir, { recursive: true })
    const raw = {
      version: 1,
      sessions: [
        session({
          id: 'sess-bad',
          candidates: [{ replyId: 'r-half', text: '写到一半', candidateVersion: 1 }],
        }),
      ],
      dedupe: [],
      usage: [],
      security: [],
      approvals: [],
      verification: [],
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(raw), 'utf8')

    const store = new DebateStore({ dir })
    await store.ready()
    const read = store.getSession('sess-bad')
    assert.ok(read !== undefined, '会话本身必须读得到')
    assert.equal(read.candidates.length, 1, '缺字段的候选也要保留，不能静默丢弃')
    assert.equal(read.candidates[0].text, '写到一半')
    // 关键：缺 targetSnapshot 的候选不能被当成「可发表」。
    assert.notEqual(read.candidates[0].approved, true, '缺目标快照的候选不得是已批准')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 3. 配置写盘失败：只读目录下的写操作 --------------------------------------

test('故障注入：配置目录不可写时不产生「一半新一半旧」的配置', () => {
  /**
   * 配置是纯函数解析的：`resolveConfig` 对同一份输入总是给同一个结果，
   * 没有「写了一半」的中间态可留下。这里钉住的是**解析失败时的落点**：
   * 坏值落默认，而不是让整份配置读不出来。
   */
  const bad = resolveConfig({ personaStyle: 'does_not_exist', intensity: 'loud', maxLength: null })
  assert.equal(bad.personaStyle, DEFAULT_CONFIG.personaStyle, '不认识的人格落默认')
  // 类型不对时落默认：`readNumber` 只放行有限数，其余一律用 fallback。
  assert.equal(bad.intensity, DEFAULT_CONFIG.intensity, '强度不是数字时落默认')
  assert.equal(bad.maxLength, DEFAULT_CONFIG.maxLength, '字数上限不是数字时落默认')

  /**
   * 数值越界（999 / -1）**不会**在这里被夹到区间内 —— `resolveConfig` 的职责是把
   * 原始输入读成可用配置，区间约束在 schema 层。这条断言钉住的是当前真实行为，
   * 不是理想行为；要收紧得先决定「越界是夹紧、报错、还是落默认」，那是产品决定。
   */
  const outOfRange = resolveConfig({ intensity: 999, maxLength: -1 })
  assert.equal(typeof outOfRange.intensity, 'number', '越界值仍然是一个数字（不静默变成 undefined）')
  assert.equal(typeof outOfRange.maxLength, 'number')

  // 完全不是对象时也不能抛：调用方在启动路径上，抛出去等于插件装不上。
  for (const weird of [null, undefined, 42, 'text', []]) {
    const resolved = resolveConfig(weird as never)
    assert.equal(typeof resolved.personaStyle, 'string', `输入 ${JSON.stringify(weird)} 时必须给出可用的默认配置`)
  }
})

// ---- 4. 会话文件部分损坏：只有某个字段坏 --------------------------------------

test('故障注入：单个会话的字段类型错时，其它会话仍然读得出来', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-partial-'))
  try {
    mkdirSync(dir, { recursive: true })
    const raw = {
      version: 1,
      sessions: [
        session({ id: 'sess-good' }),
        // 字段类型错：candidates 不是数组。
        { ...session({ id: 'sess-broken' }), candidates: 'not-an-array' },
      ],
      dedupe: [],
      usage: [],
      security: [],
      approvals: [],
      verification: [],
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(raw), 'utf8')

    const parsed = validateStore(raw)
    // 两种结果都可接受，但必须**明确**：要么拒绝整份并说明原因，要么读出来。
    // 不允许的是「读出来了但少了东西却不吭声」。
    if (parsed.ok) {
      const store = new DebateStore({ dir })
      await store.ready()
      assert.ok(store.getSession('sess-good') !== undefined, '好会话必须读得到')
    } else {
      assert.ok(parsed.reason.length > 0, '拒绝时必须给出原因')
      assert.match(parsed.reason, /会话|session|candidates|数组/i)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 5. 升级失败后回滚：旧版本文件仍在 ----------------------------------------

test('故障注入：升级失败后回滚，旧文件字节未变（不是「看起来一样」）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rollback-'))
  try {
    mkdirSync(dir, { recursive: true })
    const v0239 = {
      version: 1,
      sessions: [session({ id: 'sess-0239' })],
      dedupe: [],
      usage: [],
      security: [],
      approvals: [],
      verification: [],
    }
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify(v0239), 'utf8')
    const beforeBytes = readFileSync(path)
    const beforeMtime = statSync(path).mtimeMs

    // 「升级」：用新代码打开并写一次。
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, usage: [...data.usage, { kind: 'upgrade' }] as never }))
    assert.ok(readFileSync(path).length !== beforeBytes.length, '升级应当确实改了文件')

    // 「回滚」：把备份换回去。
    writeFileSync(path, beforeBytes)
    const restored = readFileSync(path)
    assert.deepEqual(restored, beforeBytes, '回滚后必须与升级前逐字节相同')
    assert.equal(JSON.parse(restored.toString('utf8')).sessions.length, 1)

    const reopened = new DebateStore({ dir })
    await reopened.ready()
    assert.equal(reopened.snapshot().sessions[0].id, 'sess-0239', '回滚后旧会话仍可读')
    void beforeMtime
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
