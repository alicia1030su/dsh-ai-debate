/**
 * v0.2.33 §七：一次微博读取的分阶段耗时账。
 *
 * ## 这些测试在证明什么
 *
 * 「插件读一条微博要 40 秒」是一个无法行动的观测。能行动的形式是：
 *
 *     探测 12.4s / 读 9.1s / 投影 0.02s，共 4 个子进程
 *
 * 所以这一组测试盯的不是「快不快」，而是**账记得对不对**：
 *
 * 1. 每个阶段的耗时都记上了，失败阶段也记（超时的 `doctor` 才是最该被看见的）；
 * 2. 同一阶段跑多次要累加，而不是被最后一次覆盖；
 * 3. 没有跑过的阶段不出现在账上——`0ms` 会让人以为它跑过而且很快；
 * 4. 子进程次数是**真正 spawn 的次数**，被只读守卫拦下的调用不算；
 * 5. 快照带 `checkedAt`：诊断不能说「现在慢」，只能说「刚才那次慢」。
 *
 * 最后一条是这一版反复出现的主题：状态会变，观测必须带时间。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createReadTrace, PHASE_ORDER } from '../lib/platforms/weibo/trace.js'

/** 一个可以推进的假时钟：真睡会让这组测试变成 5 秒，而它们要证明的是记账逻辑。 */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
    },
  }
}

test('分阶段记账：每个阶段的耗时各自独立', async () => {
  const clock = fakeClock()
  const trace = createReadTrace(() => ({ invocations: 0, totalMs: 0 }), clock.now)

  await trace.run('probe', async () => {
    clock.advance(120)
    return 'probe'
  })
  await trace.run('read', async () => {
    clock.advance(900)
    return 'read'
  })
  await trace.run('project', async () => {
    clock.advance(3)
    return 'project'
  })

  const snapshot = trace.snapshot()
  const byName = new Map(snapshot.phases.map((phase) => [phase.name, phase.ms]))
  assert.equal(byName.get('probe'), 120)
  assert.equal(byName.get('read'), 900)
  assert.equal(byName.get('project'), 3)
  // 总时长是墙钟，不是各阶段之和——这里两者相等，因为全程串行。
  assert.equal(snapshot.totalMs, 1023)
})

test('失败阶段也要记账：一次抛错的 doctor 正是最需要被看见的那一段', async () => {
  const clock = fakeClock()
  const trace = createReadTrace(() => ({ invocations: 0, totalMs: 0 }), clock.now)

  await assert.rejects(
    trace.run('probe', async () => {
      clock.advance(2_500)
      throw new Error('doctor 超时')
    }),
    /doctor 超时/,
  )

  const phases = trace.snapshot().phases
  assert.equal(phases.length, 1, '抛错的阶段仍然要出现在账上')
  assert.equal(phases[0]?.name, 'probe')
  assert.equal(phases[0]?.ms, 2_500)
})

test('同一阶段跑多次是累加，不是覆盖', async () => {
  const clock = fakeClock()
  const trace = createReadTrace(() => ({ invocations: 0, totalMs: 0 }), clock.now)

  // 分页读取里 `read` 每页一次。只留最后一次会让「读了 5 页共 40 秒」
  // 显示成「读了 8 秒」——那正好把这个模块要解释的现象藏起来。
  for (let page = 0; page < 3; page += 1) {
    await trace.run('read', async () => {
      clock.advance(800)
      return page
    })
  }

  const phases = trace.snapshot().phases
  assert.equal(phases.length, 1)
  assert.equal(phases[0]?.ms, 2_400)
})

test('没跑过的阶段不出现：0ms 会被读成「跑过而且很快」', () => {
  const trace = createReadTrace(() => ({ invocations: 0, totalMs: 0 }), fakeClock().now)
  assert.deepEqual(trace.snapshot().phases, [])
})

test('阶段按固定顺序输出，两次运行可以逐行对比', async () => {
  const clock = fakeClock()
  const trace = createReadTrace(() => ({ invocations: 0, totalMs: 0 }), clock.now)

  // 故意反序执行：输出仍应按 PHASE_ORDER 排列。
  await trace.run('project', async () => 'p')
  await trace.run('probe', async () => 'q')
  await trace.run('catalog', async () => 'r')

  const names = trace.snapshot().phases.map((phase) => phase.name)
  assert.deepEqual(names, ['catalog', 'probe', 'project'])
  // 顺序表本身也要是稳定的：报表按它排版。
  assert.deepEqual([...PHASE_ORDER].slice(0, 3), ['locate', 'catalog', 'probe'])
})

test('子进程次数与耗时是这一次的增量，不是进程启动以来的总数', () => {
  // 计数器是进程级累加的；这份账要回答「刚才这次读取启动了几个子进程」。
  // 直接读累加值会让第二次读取报出两次之和，而这个数字恰恰是用来判断
  // 「一次读取的结构是否合理」的。
  let invocations = 100
  let totalMs = 500_000
  const trace = createReadTrace(() => ({ invocations, totalMs }), fakeClock().now)

  invocations += 4
  totalMs += 13_000

  const snapshot = trace.snapshot()
  assert.equal(snapshot.cliInvocations, 4)
  assert.equal(snapshot.cliMs, 13_000)
})

test('计数器被重置时不报负数', () => {
  let invocations = 5
  const trace = createReadTrace(() => ({ invocations, totalMs: 0 }), fakeClock().now)
  invocations = 0
  assert.equal(trace.snapshot().cliInvocations, 0)
})

test('快照带 startedAt 与 checkedAt：诊断只能说「刚才那次」', () => {
  const clock = fakeClock()
  const trace = createReadTrace(() => ({ invocations: 0, totalMs: 0 }), clock.now)
  clock.advance(500)
  const snapshot = trace.snapshot()

  assert.match(snapshot.startedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(snapshot.checkedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.notEqual(snapshot.startedAt, '', 'startedAt 不能是空串')
  // 两者都是合法时间戳；先后关系由 totalMs 表达，不靠字符串比较。
  assert.equal(Number.isFinite(Date.parse(snapshot.startedAt)), true)
  assert.equal(Number.isFinite(Date.parse(snapshot.checkedAt)), true)
})
