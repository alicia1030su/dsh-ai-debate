/**
 * 失败复现（v0.2.7 §二）：两个 DebateStore 实例共享同一个 state.json 时丢失更新。
 *
 * 这不是假想：`buildRuntime()` 里 `new DebateStore(...)`，而 `currentRuntime()`
 * 在配置/凭据变化时会重新调用 `buildRuntime()` —— 于是同一个进程里同时存在
 * 两个指向同一文件的 store。旧的实例仍然被正在进行的操作持有。
 *
 * 这个文件先只做复现，不修。修完之后它必须从「失败」变成「通过」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'

function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'debate-multi-store-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('复现：两个 store 交错写同一文件，后写的覆盖先写的', async () => {
  const { dir, done } = tempDir()
  try {
    const a = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    const b = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    await a.ready()
    await b.ready()

    // A 写入一条安全事件（模拟「产生了第 1 条记录」）
    await a.appendSecurityEvent(
      {
        id: 'evt-from-a',
        at: new Date().toISOString(),
        kind: 'injection_detected',
        detail: 'A 写的',
        sessionId: 's1',
      } as never,
      100,
    )

    // B 这时还持有着它加载时的旧快照（空），它写自己的东西
    await b.appendSecurityEvent(
      {
        id: 'evt-from-b',
        at: new Date().toISOString(),
        kind: 'stance_conflict',
        detail: 'B 写的',
        sessionId: 's2',
      } as never,
      100,
    )

    // 磁盘上现在是什么？
    const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    const ids = (onDisk.security ?? []).map((row: { id: string }) => row.id)

    console.log('  磁盘上的安全事件: ' + JSON.stringify(ids))
    console.log('  A 的内存视图: ' + JSON.stringify(a.getSecurityEvents().map((r) => r.id)))
    console.log('  B 的内存视图: ' + JSON.stringify(b.getSecurityEvents().map((r) => r.id)))

    assert.deepEqual(
      ids.sort(),
      ['evt-from-a', 'evt-from-b'],
      '两个实例的写入都必须留在磁盘上——丢一条就是丢失更新',
    )
  } finally {
    done()
  }
})

test('复现：两个 store 交错写去重台账，confirmed 记录被覆盖', async () => {
  const { dir, done } = tempDir()
  try {
    const a = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    const b = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    await a.ready()
    await b.ready()

    // A 写入一条 confirmed 去重记录（这条记录的作用是「已经发过，别再发」）
    await a.mutate((data) => ({
      ...data,
      dedupe: [
        ...data.dedupe,
        {
          key: 'tieba:1:1:1:na',
          platform: 'tieba',
          threadId: '1',
          triggerPostId: '1',
          ownerKey: 'owner',
          sessionId: 'sess-a',
          publishState: 'confirmed',
          confirmed: true,
          firstSeenAt: new Date().toISOString(),
          decidedAt: new Date().toISOString(),
          candidateId: 'c1',
        } as never,
      ],
    }))

    // B 用自己的旧快照写另一条
    await b.mutate((data) => ({
      ...data,
      dedupe: [
        ...data.dedupe,
        {
          key: 'tieba:2:2:2:na',
          platform: 'tieba',
          threadId: '2',
          triggerPostId: '2',
          ownerKey: 'owner',
          sessionId: 'sess-b',
          publishState: 'confirmed',
          confirmed: true,
          firstSeenAt: new Date().toISOString(),
          decidedAt: new Date().toISOString(),
          candidateId: 'c2',
        } as never,
      ],
    }))

    const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    const keys = (onDisk.dedupe ?? []).map((row: { key: string }) => row.key)
    console.log('  磁盘上的去重键: ' + JSON.stringify(keys))

    assert.ok(
      keys.includes('tieba:1:1:1:na'),
      'A 的 confirmed 记录必须还在——它丢了就意味着可能重复发帖',
    )
    assert.ok(keys.includes('tieba:2:2:2:na'), 'B 的记录也必须在')
  } finally {
    done()
  }
})

test('复现：批准记录被另一个实例的写入冲掉', async () => {
  const { dir, done } = tempDir()
  try {
    const a = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    const b = new DebateStore({ dir, sessionTtlMs: 3600_000 })
    await a.ready()
    await b.ready()

    await a.mutate((data) => ({
      ...data,
      approvals: [
        ...(data.approvals ?? []),
        {
          id: 'approval-1',
          sessionId: 'sess-a',
          candidateId: 'c1',
          platform: 'tieba',
          targetPostId: 'post-1',
          publishingAccount: 'ai-account',
          textHash: 'a'.repeat(64),
          candidateVersion: 1,
          assessmentFingerprint: 'fp-1',
          grantedBy: 'owner',
          grantedAt: new Date().toISOString(),
        } as never,
      ],
    }))

    await b.appendSecurityEvent(
      {
        id: 'evt-b',
        at: new Date().toISOString(),
        kind: 'injection_detected',
        detail: 'B',
        sessionId: 's2',
      } as never,
      100,
    )

    const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    const approvals = (onDisk.approvals ?? []).map((row: { id: string }) => row.id)
    console.log('  磁盘上的批准记录: ' + JSON.stringify(approvals))

    assert.ok(approvals.includes('approval-1'), '批准记录不能被另一个实例的写入冲掉')
  } finally {
    done()
  }
})
