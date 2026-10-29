/**
 * 失败复现（v0.2.8 §二）：持有者的 PID 仍存活，但时间戳超过阈值时锁被错误回收。
 *
 * v0.2.7 的 breakStaleLock 逻辑：
 *
 *   const at = typeof parsed.at === 'number' ? parsed.at : 0
 *   if (at !== 0 && Date.now() - at < LOCK_STALE_MS) return false   // 还新鲜，不动
 *   if (at === 0) { ...按 mtime... }
 *   const owner = ...
 *   if (owner !== undefined && owner !== process.pid && isProcessAlive(owner)) return false
 *
 * 看起来有 `isProcessAlive` 兜底，但它只在 `at !== 0` 分支**落下**之后才执行。
 * 也就是说：时间戳一旦超过 30 秒，就直接走到存活检查；而存活检查里有一条
 * `owner !== process.pid`——**自己持有、自己超时的锁，会被自己判为可回收**。
 *
 * 更根本的问题是没有持有者 Token：一个进程 A 回收了 B 的锁之后，B 醒来仍然
 * 认为锁是自己的，`unlink` 会把 A 刚建的新锁删掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'

function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'debate-lock-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const statePath = (dir: string): string => join(dir, 'state.json')
const lockPath = (dir: string): string => join(dir, 'state.json.lock')

test('复现：持有者 PID 存活但时间戳过期，锁不得被回收', async () => {
  const { dir, done } = tempDir()
  try {
    const store = new DebateStore({ dir, lockTimeoutMs: 300 })
    await store.ready()
    await store.mutate((data) => ({ ...data, security: [] }))

    // 伪造一把「本进程持有、但 at 是 60 秒前」的锁
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }),
      'utf8',
    )

    let threw
    try {
      await store.mutate((data) => ({ ...data, security: [] }))
    } catch (error) {
      threw = error
    }

    const stillThere = (() => {
      try {
        readFileSync(lockPath(dir), 'utf8')
        return true
      } catch {
        return false
      }
    })()

    console.log('  mutate:', threw === undefined ? 'RESOLVED（锁被回收了）' : 'threw ' + threw.code)
    console.log('  锁文件还在:', stillThere)

    assert.notEqual(
      threw,
      undefined,
      '一个仍然存活的持有者持有的锁，不能只因为时间超过阈值就被回收',
    )
    assert.equal(stillThere, true, '拒绝写入时不能顺手删掉别人的锁')
  } finally {
    done()
  }
})

test('复现：锁被回收后，原持有者释放时会删掉新持有者的锁', async () => {
  const { dir, done } = tempDir()
  try {
    // 这个测试直接针对「没有持有者 Token」这个根因：
    // 两个 store 指向同一目录，模拟「A 的锁被判过期、B 抢占、A 释放」。
    const a = new DebateStore({ dir, lockTimeoutMs: 200 })
    await a.ready()

    // 用一个独立的锁文件内容模拟「B 抢到了锁」
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')

    // A 尝试写入 —— 应当因为锁被占而超时失败，且**不能删掉这把锁**
    let threw
    try {
      await a.mutate((data) => ({ ...data, security: [] }))
    } catch (error) {
      threw = error
    }

    const lockStillThere = (() => {
      try {
        readFileSync(lockPath(dir), 'utf8')
        return true
      } catch {
        return false
      }
    })()

    console.log('  A 的写入:', threw === undefined ? 'RESOLVED（不该）' : 'threw ' + threw.code)
    console.log('  B 的锁是否被 A 删掉:', lockStillThere ? '否（正确）' : '是（缺陷）')

    assert.notEqual(threw, undefined, '锁被占用时必须拒绝写入')
    assert.equal(lockStillThere, true, '没有抢到锁的一方绝不能删除持有者的锁文件')
  } finally {
    done()
  }
})
