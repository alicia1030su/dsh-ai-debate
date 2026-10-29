/**
 * 两个**真正的独立进程**并发写同一个状态文件（v0.2.8 §二/§七-3）。
 *
 * ## 为什么必须在进程里测，不能在进程内测
 *
 * 进程内的「并发」只是两条 Promise 交错：`writeChain` 会把它们排队，磁盘锁根本
 * 没被真正竞争过。锁协议唯一要防的情况——两个进程同时读同一份文档、各自合并、
 * 后写的覆盖先写的——在单进程里不可能复现，所以用 `spawn` 起两个 worker 进程。
 *
 * ## 断言的是「没有丢」，不是「没有报错」
 *
 * 争锁失败是**正确行为**（宁可拒绝也不悄悄丢记录）。所以每个 worker 允许失败，
 * 但每一条成功写入的记录都必须在最终文件里找到。写进去多少条，就得出来多少条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The worker: append N dedupe rows, one mutate per row, and report what landed. */
const WORKER = `
import { DebateStore } from ${JSON.stringify(new URL('../lib/store.js', import.meta.url).href)}

// Node puts the extra arguments of "node -e script a b c" at argv[1..], not argv[2..],
// because there is no script path. Slicing from 2 silently made every worker write into
// a directory named after its own label and report zero rows — a green test that proved
// nothing, which is worse than a red one.
const [dir, label, count] = process.argv.slice(1)
const store = new DebateStore({ dir, lockTimeoutMs: 20000 })
await store.ready()

let written = 0
let refused = 0
for (let index = 0; index < Number(count); index += 1) {
  const key = 'race:' + label + ':' + index
  try {
    await store.mutate((data) => ({
      ...data,
      dedupe: [
        ...data.dedupe,
        {
          key,
          platform: 'tieba',
          threadId: '1',
          triggerPostId: '1',
          ownerKey: 'o',
          sessionId: 's-' + label + '-' + index,
          publishState: 'pending',
          firstSeenAt: new Date().toISOString(),
          decidedAt: new Date().toISOString(),
        },
      ],
    }))
    written += 1
  } catch {
    refused += 1
  }
  // 50ms 的错位：让两个进程的读-改-写窗口**交叠**，而不是排成两队。
  await new Promise((resolve) => setTimeout(resolve, 5))
}
process.stdout.write(JSON.stringify({ written, refused, keys: Array.from({ length: Number(count) }, (_, i) => 'race:' + label + ':' + i) }))
`

function runWorker(
  dir: string,
  label: string,
  count: number,
): Promise<{ written: number; refused: number; keys: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', '--input-type=module', '-e', WORKER, dir, label, String(count)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${label} 退出码 ${code}：${err.slice(0, 800)}`))
        return
      }
      try {
        resolve(JSON.parse(out) as { written: number; refused: number; keys: string[] })
      } catch {
        reject(new Error(`worker ${label} 输出不可解析：${out.slice(0, 400)} / ${err.slice(0, 400)}`))
      }
    })
  })
}

test('两个独立进程同时写同一个状态文件：成功的写入一条都不能丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-race-'))
  try {
    // 先建库，避免两个进程同时走「首次启动」分支。
    const { DebateStore } = await import('../lib/store.js')
    const seed = new DebateStore({ dir })
    await seed.ready()
    await seed.mutate((data) => ({ ...data, security: [] }))

    const each = 12
    const [a, b] = await Promise.all([runWorker(dir, 'a', each), runWorker(dir, 'b', each)])
    console.log(`  进程 A 写入 ${a.written} / 拒绝 ${a.refused}`)
    console.log(`  进程 B 写入 ${b.written} / 拒绝 ${b.refused}`)

    // A worker that wrote nothing proves nothing. This guard exists because the first
    // version of this file sliced argv from index 2, so every worker opened a directory
    // named after its own label and reported zero rows — the run was green and empty.
    assert.ok(
      a.written + b.written > 0,
      `两个进程都没有成功写入任何记录（A ${a.written}，B ${b.written}），测试没有真正竞争过`,
    )

    const final = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
      dedupe: { key: string }[]
    }
    const keys = new Set(final.dedupe.map((row) => row.key))
    console.log(`  最终台账 ${final.dedupe.length} 条（去重后 ${keys.size} 个 key）`)

    // 每个进程自己报告成功的那几条，必须能在文件里找到。这才是「没有丢数据」：
    // 覆盖写会表现成 A 说写了 12 条、B 也说写了 12 条，但文件里只剩后面那批。
    for (const [label, result] of [
      ['a', a],
      ['b', b],
    ] as const) {
      const reported = result.keys.slice(0, result.written)
      const missing = reported.filter((key) => !keys.has(key))
      assert.deepEqual(
        missing,
        [],
        `${label} 报告成功但文件里找不到：${missing.join(', ')} —— 说明被对方的写入覆盖了`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('一个进程持有锁时，另一个进程拒绝写入而不是无锁写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-race-refuse-'))
  try {
    const { DebateStore } = await import('../lib/store.js')
    const seed = new DebateStore({ dir })
    await seed.ready()
    await seed.mutate((data) => ({ ...data, security: [] }))

    // 伪造一把「别的进程持有、且活着、时间很新」的锁：pid 用 1（在 Windows 上
    // process.kill(1, 0) 会抛 EPERM 而不是 ESRCH，等价于「探测不到，视为活」）。
    const fs = await import('node:fs')
    fs.writeFileSync(
      join(dir, 'state.json.lock'),
      JSON.stringify({ pid: process.pid, at: Date.now(), token: 'held-by-a-peer' }),
      'utf8',
    )

    const store = new DebateStore({ dir, lockTimeoutMs: 300 })
    await store.ready()
    let threw: unknown
    try {
      await store.mutate((data) => ({ ...data, security: [] }))
    } catch (error) {
      threw = error
    }

    assert.notEqual(threw, undefined, '锁被占用时必须拒绝写入，不能改成无锁写入')
    assert.equal(
      existsSync(join(dir, 'state.json.lock')),
      true,
      '拒绝写入时不能顺手删掉持有者的锁',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
