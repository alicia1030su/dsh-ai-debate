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
// The keys that actually reached disk.
//
// ## Why this is a list and not a count (v0.2.29)
//
// The assertion used to reconstruct the successes as keys.slice(0, written) -- the first
// "written" of the twelve it tried. That is only correct if refusals land at the *end* of
// the loop, and a lock timeout lands wherever it happens to land.
//
// Reproduced under CPU load: worker A was refused at race:a:1 and then wrote race:a:2
// ... race:a:11 successfully. It reported written: 11 and the final file held exactly
// 23 rows for 23 successes -- the store was correct -- but slice(0, 11) included the one
// that was refused and excluded the last one that landed. The test then failed with
//
//     a 报告成功但文件里找不到：race:a:1 -- 说明被对方的写入覆盖了
//
// which is a false accusation against a correct store, and would have sent the next
// reader hunting for a lost-update bug that does not exist. Recording the real keys
// removes the guessing entirely.
//
// (No backticks in this comment: it lives inside a template literal, and a backtick here
// terminates the worker source. That is what broke the first version of this fix.)
const succeeded = []
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
    succeeded.push(key)
  } catch {
    refused += 1
  }
  // 50ms 的错位：让两个进程的读-改-写窗口**交叠**，而不是排成两队。
  await new Promise((resolve) => setTimeout(resolve, 5))
}
process.stdout.write(JSON.stringify({ written, refused, keys: succeeded }))
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

test('两个独立进程同时写同一个状态文件：成功的写入一条都不能丢', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-race-'))
  try {
    // 先建库，避免两个进程同时走「首次启动」分支。
    const { DebateStore } = await import('../lib/store.js')
    const seed = new DebateStore({ dir })
    await seed.ready()
    await seed.mutate((data) => ({ ...data, security: [] }))

    const each = 12
    const [a, b] = await Promise.all([runWorker(dir, 'a', each), runWorker(dir, 'b', each)])
    t.diagnostic(`  进程 A 写入 ${a.written} / 拒绝 ${a.refused}`)
    t.diagnostic(`  进程 B 写入 ${b.written} / 拒绝 ${b.refused}`)

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
    t.diagnostic(`  最终台账 ${final.dedupe.length} 条（去重后 ${keys.size} 个 key）`)

    // Each process's own success list must be findable in the file. That is what "no data
    // lost" means: an overwriting write shows up as A reporting 12, B reporting 12, and
    // the file holding only the later batch.
    //
    // `keys` is the real success list — not `slice(0, written)`. See the worker's comment:
    // refusals land wherever a lock timeout happens, so slicing by count accuses a correct
    // store of losing data.
    for (const [label, result] of [
      ['a', a],
      ['b', b],
    ] as const) {
      assert.equal(
        result.keys.length,
        result.written,
        `${label} 报告的条数与记录的成功 key 数不一致（${result.written} vs ${result.keys.length}），worker 自身有问题`,
      )
      const missing = result.keys.filter((key) => !keys.has(key))
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
