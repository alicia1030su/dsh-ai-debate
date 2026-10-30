/**
 * v0.2.14 §二：微博正文的目标身份核对。
 *
 * ## 这个文件防的是什么
 *
 * v0.2.13 的 `getThread` 把请求的 MID 直接贴在投影结果上，从不读返回对象自己的 id。用发布
 * 产物复现过：请求 `4331051486294436`，CLI 返回 `9999999999999999` 的完整微博，
 * `getThread` 照样把它标成请求的 MID，分析器随后写出一份关于陌生人微博的争论简报。
 *
 * 这是**目标身份完整性**问题：注入防护、立场保护、人工审核全部建立在「这条正文就是主人
 * 指的那条」之上。这一步错了，后面每一步都不可信。
 *
 * 这里的断言分三层：
 * 1. `matchReturnedStatus` 的纯逻辑（不需要 CLI）；
 * 2. 真实 spawn 出去的调用路径（用假 CLI）；
 * 3. 精度：id 全程当字符串，超过安全整数也不能丢位。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __setCliInvocation } from '../lib/platforms/weibo/cli.js'
import { __setPlanCacheTimings } from '../lib/platforms/weibo/plan-cache.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'
import {
  collectStatusCandidates,
  matchReturnedStatus,
  normaliseStatusId,
} from '../lib/platforms/weibo/target-match.js'

const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')
const TARGET = '4331051486294436'

// ---------------------------------------------------------------------------
// A. Pure matching logic
// ---------------------------------------------------------------------------

test('目标身份：返回同一条微博时接受，并指出匹配依据', () => {
  const result = matchReturnedStatus(
    { idstr: TARGET, text: '正文', user: { idstr: '1', screen_name: 'u' } },
    TARGET,
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.matchedOn, 'id')
})

test('目标身份：返回不同微博时拒绝，并报出实际看到什么', () => {
  const result = matchReturnedStatus(
    { idstr: '9999999999999999', text: '这是一条完全不同的微博。' },
    TARGET,
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.observed.includes('9999999999999999'), true, '要说清实际返回了什么')
    assert.match(result.reason, /不一致|不同/)
  }
})

test('目标身份：只能检查「有 id」时不算通过', () => {
  // The payload has no id at all. "It exists" is not evidence it is the target.
  const result = matchReturnedStatus({ text: '正文' }, TARGET)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /没有带可识别 id|无法证明/)
})

test('目标身份：批量返回多条时精确挑出目标，而不是取第一条', () => {
  const payload = {
    statuses: [
      { idstr: '1111111111111111', text: '别的微博' },
      { idstr: TARGET, text: '目标微博' },
      { idstr: '2222222222222222', text: '又一条别的' },
    ],
  }
  const result = matchReturnedStatus(payload, TARGET)
  assert.equal(result.ok, true, '目标在列表中间时也必须找到')
  if (result.ok) assert.equal(result.status.text, '目标微博', '必须挑出目标那一条，不是第一条')
})

test('目标身份：批量结果里没有目标时拒绝', () => {
  const payload = {
    statuses: [
      { idstr: '1111111111111111', text: 'a' },
      { idstr: '2222222222222222', text: 'b' },
    ],
  }
  const result = matchReturnedStatus(payload, TARGET)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.observed.length, 2, '两条实际 id 都要报出来')
  }
})

test('目标身份：批量里只有一条且就是目标时接受', () => {
  const result = matchReturnedStatus({ statuses: [{ idstr: TARGET, text: '目标' }] }, TARGET)
  assert.equal(result.ok, true)
})

test('目标身份：重复 MID 且内容一致时接受，内容冲突时拒绝', () => {
  const agrees = matchReturnedStatus(
    {
      statuses: [
        { idstr: TARGET, text: '同样的话' },
        { idstr: TARGET, text: '同样的话' },
      ],
    },
    TARGET,
  )
  assert.equal(agrees.ok, true, '同一个目标被回声两次但内容一致，可以接受')

  const conflicts = matchReturnedStatus(
    {
      statuses: [
        { idstr: TARGET, text: '第一版' },
        { idstr: TARGET, text: '第二版' },
      ],
    },
    TARGET,
  )
  assert.equal(conflicts.ok, false, '同一 id 两个不同正文时不能猜')
  if (!conflicts.ok) assert.match(conflicts.reason, /不同|无法判断/)
})

test('目标身份：数字与字符串形式的 MID 都能比对', () => {
  assert.equal(normaliseStatusId('4331051486294436'), '4331051486294436')
  // A safe integer round-trips through String() without loss.
  assert.equal(normaliseStatusId(123456789012345), '123456789012345')
  // A number beyond the safe range has already lost precision; it must NOT be treated as an id.
  assert.equal(normaliseStatusId(9999999999999999), undefined, '超出安全整数范围的数字不能当 id')
})

test('目标身份：超出安全整数范围的 MID 保持字符串精度', () => {
  // 9007199254740993 is 2^53 + 1, the first integer a double cannot represent.
  const beyond = '9007199254740993'
  assert.equal(normaliseStatusId(beyond), beyond, '字符串形式必须原样保留')

  // And the comparison must not be fooled by the rounded neighbour.
  const result = matchReturnedStatus({ idstr: '9007199254740992', text: 'x' }, beyond)
  assert.equal(result.ok, false, '相邻的可表示值不能算作同一 id')
})

test('目标身份：非数字 id 不被当成可比对的 mid', () => {
  assert.equal(normaliseStatusId('abc'), undefined)
  assert.equal(normaliseStatusId(''), undefined)
  assert.equal(normaliseStatusId(null), undefined)
  assert.equal(normaliseStatusId(undefined), undefined)
})

test('目标身份：候选收集能同时处理单对象与列表信封', () => {
  assert.equal(collectStatusCandidates({ status: { idstr: '1' } }).length, 1)
  assert.equal(collectStatusCandidates({ data: [{ idstr: '1' }, { idstr: '2' }] }).length, 2)
  assert.equal(collectStatusCandidates({ idstr: '1' }).length, 1, 'payload 本身就是微博')
  assert.equal(collectStatusCandidates({ unrelated: true }).length, 0)
  assert.equal(collectStatusCandidates(null).length, 0)
})

// ---------------------------------------------------------------------------
// B. The real call path
// ---------------------------------------------------------------------------

interface Rig {
  readonly logPath: string
  readonly reset: () => void
  readonly calls: () => string[][]
}

function useFakeCli(rules: readonly unknown[]): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'mid-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'calls.log')
  writeFileSync(scriptPath, JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = scriptPath
  process.env.FAKE_CLI_LOG = logPath
  __setCliInvocation({ file: process.execPath, prefixArgs: [SCRIPT] })
  return {
    logPath,
    reset: () => {
      __setCliInvocation(undefined)
      delete process.env.FAKE_CLI_SCRIPT
      delete process.env.FAKE_CLI_LOG
    },
    calls: () => {
      const text = require('node:fs').readFileSync(logPath, 'utf8') as string
      return text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as string[])
    },
  }
}

const CATALOG = {
  commands: [{ group: 'statuses', action: 'show_batch/biz', access: 'allowed' }],
}

function rulesFor(statusPayload: unknown): unknown[] {
  return [
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    { match: 'commands list', stdout: JSON.stringify(CATALOG) },
    {
      match: 'commands show statuses show_batch/biz',
      stdout: JSON.stringify({
        group: 'statuses',
        action: 'show_batch/biz',
        flags: [{ name: 'ids', required: true }],
      }),
    },
    { match: 'statuses show_batch/biz', stdout: JSON.stringify(statusPayload) },
  ]
}

const REF = {
  platform: 'weibo' as const,
  threadId: TARGET,
  url: 'https://m.weibo.cn/detail/4331051486294436',
}

test('集成：返回不同微博时 getThread 抛 target_mismatch，不把它当目标', async () => {
  const rig = useFakeCli(rulesFor({ idstr: '9999999999999999', text: '这是一条完全不同的微博。' }))
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const error = await adapter.getThread(REF).then(
      () => undefined,
      (caught: { code?: string; message?: string }) => caught,
    )
    assert.notEqual(error, undefined, '必须失败，不能静默接受')
    assert.equal(error!.code, 'target_mismatch', `实际 ${error!.code}`)
    assert.match(error!.message, /4331051486294436/, '消息里要写清请求的是哪一条')
    assert.match(error!.message, /9999999999999999/, '也要写清实际返回了哪一条')
  } finally {
    rig.reset()
  }
})

test('集成：返回同一条微博时正常投影，id 来自请求而不是瞎编', async () => {
  const rig = useFakeCli(
    rulesFor({ idstr: TARGET, text: '这条说法站不住脚。', user: { idstr: '111', screen_name: '主人' } }),
  )
  try {
    const thread = await weiboProvider.createAdapter({ settings: {} }).getThread(REF)
    assert.equal(thread.id, TARGET)
    assert.equal(thread.content, '这条说法站不住脚。')
    // The body came from the payload; the id came from the request — but only because they agree.
    assert.equal(thread.authorName, '主人')
  } finally {
    rig.reset()
  }
})

test('集成：批量返回多条时，投影的是目标那一条的正文', async () => {
  const rig = useFakeCli(
    rulesFor({
      statuses: [
        { idstr: '1111111111111111', text: '别的微博' },
        { idstr: TARGET, text: '目标微博的正文', user: { idstr: '222', screen_name: '目标作者' } },
      ],
    }),
  )
  try {
    const thread = await weiboProvider.createAdapter({ settings: {} }).getThread(REF)
    assert.equal(thread.content, '目标微博的正文', '不能取第一条的正文')
    assert.equal(thread.authorName, '目标作者')
  } finally {
    rig.reset()
  }
})

test('集成：批量里没有目标时拒绝', async () => {
  const rig = useFakeCli(
    rulesFor({ statuses: [{ idstr: '1111111111111111', text: 'a' }, { idstr: '2222222222222222', text: 'b' }] }),
  )
  try {
    const error = await weiboProvider
      .createAdapter({ settings: {} })
      .getThread(REF)
      .then(
        () => undefined,
        (caught: { code?: string }) => caught,
      )
    assert.equal(error?.code, 'target_mismatch')
  } finally {
    rig.reset()
  }
})

test('集成：不匹配的读取不会为后续分析留下任何可用的 thread', async () => {
  // The point of the guarantee: an analyzer cannot silently proceed on a stranger's post,
  // because there is no thread object to proceed with.
  const rig = useFakeCli(rulesFor({ idstr: '8888888888888888', text: '陌生人的微博' }))
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    let observed: unknown
    try {
      observed = await adapter.getThread(REF)
    } catch {
      observed = undefined
    }
    assert.equal(observed, undefined, '不匹配时不能返回可用的 Thread')
  } finally {
    rig.reset()
  }
})
