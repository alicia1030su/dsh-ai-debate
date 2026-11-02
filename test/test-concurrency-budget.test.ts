/**
 * 测试命令的并发上限必须有依据，并且本地与 CI 一致。
 *
 * ## 这条测试为什么存在
 *
 * v0.2.22 阶段十三把测试文件从 103 个增加到 113 个之后，默认并发（= CPU 核数，
 * 本机 16）开始偶发**整体停滞**：不是某个断言失败，而是跑到一半所有 worker 都不再
 * 推进，日志停在任意一条测试上，`fail` 是 0 但 `tests` 少了几百项。三次运行里能中
 * 一次，最终运行 5 次里中 2 次。
 *
 * 这不是某个测试写错了。同一份套件在 `--test-concurrency=8` 下连跑 3 次全绿，
 * 在 `--test-concurrency=4` 下连跑 3 次全绿；而**基线提交 b0540a2（103 个文件）**
 * 在默认并发下连跑 4 次全绿。差别只在并行 worker 数：每个 worker 要拉起一个 Node
 * 进程、加载 jsdom 与 React、再 spawn 子进程跑 bash，15 个同时起步会撞上这台机器的
 * 进程创建与内存带宽上限。
 *
 * ## 为什么是 8 而不是"我试出来能过的最小值"
 *
 * 8 是**每个 worker 至少有 2 个逻辑核可用**的数量级，同时仍是 113 个文件的一半以上，
 * 并行收益基本保住（27 秒 vs 串行 90 秒）。往上加没有收益——瓶颈已经是 IO 与进程
 * 启动，不是 CPU 占用。
 *
 * ## 这条测试同时防止两件事
 *
 * 1. 有人为了"看起来更快"把并发改回去（默认值），把偶发停滞重新引进来；
 * 2. 本地 `package.json` 与 CI 里跑的不是同一条命令——那会让"本地全绿"和"CI 全绿"
 *    变成两句互不相干的话。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')

/** The concurrency cap this suite is validated at. */
const EXPECTED = 8

const WORKFLOWS = ['ci.yml', 'release.yml']

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

test('package.json 的 test 脚本显式限制了并发', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
  const script = pkg.scripts?.['test'] ?? ''
  assert.match(
    script,
    new RegExp(`--test-concurrency=${EXPECTED}\\b`),
    `test 脚本没有 --test-concurrency=${EXPECTED}：默认并发（=核数）在文件数超过 110 后会偶发整体停滞，` +
      '这不是断言失败，而是 tests 数偏少且 fail 为 0，最难发现',
  )
  // 仍然必须用通配：手写文件清单会静默漏掉新测试。
  assert.match(script, /test\/\*\*\/\*\.test\.ts/, '测试文件必须用通配，不能用清单')
})

test('每一个跑全量测试的工作流步骤都用同一个并发上限', () => {
  for (const name of WORKFLOWS) {
    const source = read(join('.github', 'workflows', name))
    const lines = source.split(/\r?\n/).filter((line) => /--test\s/.test(line))
    assert.ok(lines.length > 0, `${name} 里找不到跑测试的行`)
    for (const line of lines) {
      assert.match(
        line,
        new RegExp(`--test-concurrency=${EXPECTED}\\b`),
        `${name} 的测试命令没有限制并发：${line.trim()}`,
      )
    }
  }
})

test('发布工作流的 pipefail 没有被这次改动弄丢', () => {
  // 并发参数是加在同一行上的，改这一行很容易顺手把 `set -euo pipefail` 也动了。
  const source = read(join('.github', 'workflows', 'release.yml'))
  assert.match(source, /set -euo pipefail/, 'release.yml 丢了 set -euo pipefail')
})
