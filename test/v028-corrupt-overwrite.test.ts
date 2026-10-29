/**
 * 失败复现（v0.2.8 §一）：磁盘文件损坏后，mutate() 用内存副本把它覆盖掉。
 *
 * 审计的复现路径：
 *   1. store 正常初始化
 *   2. 成功写一次（文件存在且合法）
 *   3. 外部把文件破坏成非法 JSON
 *   4. 原 store 再 mutate()
 *   5. mutate() 返回成功          ← 不该发生
 *   6. 原始损坏文件被覆盖          ← 数据永久丢失
 *
 * 根因在 v0.2.7 的这一行：
 *
 *   const base = await this.readCurrentDocument().catch(() => this.data)
 *
 * `.catch()` 吞掉了**所有**读取异常，包括 StoreError('corrupt')。于是「文件坏了」
 * 被当成「文件暂时读不到，用内存的吧」，而写入随后把坏文件覆盖成了内存副本——
 * 用户原本还能从坏文件里抢救的内容彻底没了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore, StoreError } from '../lib/store.js'

function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'debate-corrupt-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const statePath = (dir: string): string => join(dir, 'state.json')

test('复现：初始化成功、写过一次、文件被外部破坏，再 mutate 不得覆盖坏文件', async () => {
  const { dir, done } = tempDir()
  try {
    const store = new DebateStore({ dir })
    await store.ready()

    // 2. 成功写一次，确认文件存在且合法
    await store.mutate((data) => ({ ...data, security: [] }))
    const before = readFileSync(statePath(dir), 'utf8')
    JSON.parse(before) // 合法

    // 3. 外部破坏
    const broken = '{ this is not valid json, and it holds data we may still want '
    writeFileSync(statePath(dir), broken, 'utf8')

    // 4/5. 再写
    let threw
    try {
      await store.mutate((data) => ({ ...data, security: [] }))
      threw = undefined
    } catch (error) {
      threw = error
    }

    // 6. 坏文件必须原样还在
    const after = readFileSync(statePath(dir), 'utf8')
    console.log('  mutate 结果:', threw === undefined ? 'RESOLVED（不可接受）' : 'threw ' + threw.code)
    console.log('  磁盘内容是否仍是坏字节:', after === broken)

    assert.notEqual(threw, undefined, '文件损坏时 mutate 必须拒绝，而不是静默成功')
    assert.ok(threw instanceof StoreError, '必须是 StoreError')
    assert.equal((threw as StoreError).code, 'corrupt', '错误码必须是 corrupt')
    assert.equal(after, broken, '拒绝写入时必须保留磁盘原始（损坏）内容，用户还要靠它抢救')
  } finally {
    done()
  }
})

test('复现：已初始化的文件被删掉，再次写入不得当成首次启动静默重建', async () => {
  const { dir, done } = tempDir()
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({
      ...data,
      dedupe: [
        {
          key: 'tieba:1:1:1:na',
          platform: 'tieba',
          threadId: '1',
          triggerPostId: '1',
          ownerKey: 'o',
          sessionId: 's1',
          publishState: 'confirmed',
          firstSeenAt: new Date().toISOString(),
          decidedAt: new Date().toISOString(),
        } as never,
      ],
    }))
    assert.ok(existsSync(statePath(dir)))

    // 文件在 store 已经加载过之后消失
    rmSync(statePath(dir))

    let threw
    try {
      await store.mutate((data) => ({ ...data, security: [] }))
    } catch (error) {
      threw = error
    }
    console.log('  文件消失后 mutate:', threw === undefined ? 'RESOLVED（不可接受）' : 'threw ' + threw.code)

    // 文件确实不在了（没被静默重建）
    const recreated = existsSync(statePath(dir))
    console.log('  是否被静默重建:', recreated)

    assert.notEqual(threw, undefined, '初始化成功后文件消失，不能无条件当成首次启动')
    assert.equal(recreated, false, '拒绝写入时不应凭空创建新文件')
  } finally {
    done()
  }
})

test('基线：真正的首次启动仍然照常工作（不能因为上面的修复让新装用户起不来）', async () => {
  const { dir, done } = tempDir()
  try {
    // 目录是空的，从未有过 state.json
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, security: [] }))
    assert.ok(existsSync(statePath(dir)), '首次启动必须能创建文件')
    JSON.parse(readFileSync(statePath(dir), 'utf8'))
  } finally {
    done()
  }
})
