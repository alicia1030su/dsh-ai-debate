/**
 * v0.2.15 §二：微博身份字段的语义边界。
 *
 * ## 这个文件防的是 v0.2.14 的放行缺陷
 *
 * v0.2.14 的 `idsOf()` 把 `id`、`idstr`、`mid` 平铺进一个数组，**任一命中即放行**。审计复现：
 *
 * ```json
 * { "idstr": "4331051486294436", "id": "9999999999999999", "text": "测试正文" }
 * ```
 *
 * 返回 `ok: true`。这个对象自己说自己是两条不同的微博。
 *
 * ## 修复的两个方向
 *
 * 1. **同语义组内冲突必须拒绝。** `id` 与 `idstr` 是同一个值的两种写法，同时出现却不同，
 *    说明响应自相矛盾，不能采信。
 * 2. **不同语义组之间不得强制比较。** `mid` 是微博 URL 里的编号，与 `id` 是两个空间，
 *    值本来就不同。拿它们互相校验会把完全正常的响应判成不匹配——这是过度校验。
 *
 * 两条都要测：只测第一条会奖励一个「把所有字段都要求相等」的实现，那会让真实响应全部失败。
 *
 * ## 字段语义的依据
 *
 * 微博开放平台 CLI 手册明确要求「发布后请保存 id/idstr」，把两者并列为同一个标识的两种形式；
 * 而 `mid` 出现在 `weibo.com/<uid>/<mid>` 形式的 URL 里，是另一套编号（mid → id 需要换算）。
 * 见 https://open.weibo.com/cli/manual 。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __setCliInvocation } from '../lib/platforms/weibo/cli.js'
import { __setPlanCacheTimings } from '../lib/platforms/weibo/plan-cache.js'
import { weiboProvider } from '../lib/platforms/weibo/provider.js'
import { matchReturnedStatus } from '../lib/platforms/weibo/target-match.js'

const SCRIPT = join(import.meta.dirname, 'fixtures', 'fake-weibo-cli.mjs')
const TARGET = '4331051486294436'

// ---------------------------------------------------------------------------
// A. 同语义组内的冲突（§二.3）
// ---------------------------------------------------------------------------

test('身份语义：id 与 idstr 冲突时拒绝——这正是审计复现的那份 payload', () => {
  // The exact shape the audit used. `idstr` agrees with the request, `id` says something else.
  const result = matchReturnedStatus(
    { idstr: TARGET, id: '9999999999999999', text: '测试正文' },
    TARGET,
  )
  assert.equal(result.ok, false, 'id 与 idstr 指向两条不同微博时不能放行')
  if (!result.ok) {
    assert.equal(result.code, 'identity_conflict', `实际 ${result.code}`)
    assert.match(result.reason, /自相矛盾|无法确定/)
    // Both values must be reported so the reader can see the contradiction.
    assert.equal(result.observed.includes(TARGET), true)
    assert.equal(result.observed.includes('9999999999999999'), true)
  }
})

test('身份语义：id 与 idstr 相等时正常接受', () => {
  const result = matchReturnedStatus({ idstr: TARGET, id: TARGET, text: '正文' }, TARGET)
  assert.equal(result.ok, true, '两个字段一致就是正常的响应')
  if (result.ok) assert.equal(result.matchedOn, 'id')
})

test('身份语义：只有 id、只有 idstr、两者都有，三种正常形状都接受', () => {
  for (const payload of [
    { idstr: TARGET, text: 'a' },
    { id: TARGET, text: 'b' },
    { idstr: TARGET, id: TARGET, text: 'c' },
  ]) {
    const result = matchReturnedStatus(payload, TARGET)
    assert.equal(result.ok, true, `合法形状被拒了：${JSON.stringify(payload)}`)
  }
})

test('身份语义：冲突且两个值都不等于请求时不误报成「匹配」', () => {
  // Neither field is the target. The refusal reason should be the contradiction, not a match.
  const result = matchReturnedStatus(
    { idstr: '1111111111111111', id: '2222222222222222', text: 'x' },
    TARGET,
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'identity_conflict')
})

test('身份语义：批量里一条冲突、一条正常时，正常的那条仍可用', () => {
  // A contradicting entry must not poison the rest of the batch: it is skipped as ineligible,
  // and the consistent target is still found.
  const result = matchReturnedStatus(
    {
      statuses: [
        { idstr: TARGET, id: '9999999999999999', text: '矛盾的' },
        { idstr: TARGET, id: TARGET, text: '正确的' },
      ],
    },
    TARGET,
  )
  assert.equal(result.ok, true, '一致的那条应当可用')
  if (result.ok) assert.equal(result.status.text, '正确的')
})

test('身份语义：批量里只有冲突对象时拒绝，并说明是矛盾而非不匹配', () => {
  const result = matchReturnedStatus(
    { statuses: [{ idstr: TARGET, id: '9999999999999999', text: '矛盾的' }] },
    TARGET,
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'identity_conflict', '要和「不是这条」区分开')
})

// ---------------------------------------------------------------------------
// B. 不同语义组之间不得强制比较（§二.4）
// ---------------------------------------------------------------------------

test('身份语义：mid 与 id 取值不同是正常的，不得因此拒绝', () => {
  // `mid` lives in a different numbering space (weibo.com/<uid>/<mid>). A payload carrying a
  // status id and an unrelated-looking mid is *correct*, and demanding they be equal would
  // reject ordinary responses — the over-strict failure mode.
  const result = matchReturnedStatus(
    { idstr: TARGET, id: TARGET, mid: '4629806286915333', text: '正文' },
    TARGET,
  )
  assert.equal(result.ok, true, 'mid 与 id 不同不代表冲突')
})

test('身份语义：请求值是 mid 时可以按 mid 匹配，并报告命中分组', () => {
  const result = matchReturnedStatus({ mid: TARGET, id: '1234567890123456', text: '正文' }, TARGET)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.matchedOn, 'mid', '要说明是按哪个语义组对上的')
})

test('身份语义：mid 命中但 id 是另一条时，仍以 id 组为准拒绝矛盾', () => {
  // Here the mid matches but the status-id group contradicts itself. The contradiction wins:
  // an object that names itself two different ways is not trustworthy even if a third field
  // happens to agree.
  const result = matchReturnedStatus(
    { mid: TARGET, idstr: TARGET, id: '9999999999999999', text: 'x' },
    TARGET,
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'identity_conflict')
})

// ---------------------------------------------------------------------------
// C. 重复对象（§二.5）
// ---------------------------------------------------------------------------

test('重复对象：正文一致时接受', () => {
  const result = matchReturnedStatus(
    {
      statuses: [
        { idstr: TARGET, text: '同样的话', user: { idstr: '1' } },
        { idstr: TARGET, text: '同样的话', user: { idstr: '1' } },
      ],
    },
    TARGET,
  )
  assert.equal(result.ok, true)
})

test('重复对象：正文矛盾时拒绝', () => {
  const result = matchReturnedStatus(
    {
      statuses: [
        { idstr: TARGET, text: '第一版' },
        { idstr: TARGET, text: '第二版' },
      ],
    },
    TARGET,
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'duplicate_conflict')
})

test('重复对象：正文相同但作者不同也拒绝（§二.5 的作者矛盾）', () => {
  // v0.2.14 compared only the body, so two copies attributed to different authors passed. That
  // is exactly the case where "which one is real" decides who the opponent is.
  const result = matchReturnedStatus(
    {
      statuses: [
        { idstr: TARGET, text: '一模一样的正文', user: { idstr: '111', screen_name: '甲' } },
        { idstr: TARGET, text: '一模一样的正文', user: { idstr: '222', screen_name: '乙' } },
      ],
    },
    TARGET,
  )
  assert.equal(result.ok, false, '同一 id 挂在两个作者名下时不能猜')
  if (!result.ok) assert.equal(result.code, 'duplicate_conflict')
})

test('重复对象：正文与作者都一致时接受', () => {
  const result = matchReturnedStatus(
    {
      statuses: [
        { idstr: TARGET, text: '正文', user: { idstr: '111', screen_name: '甲' } },
        { idstr: TARGET, text: '正文', user: { idstr: '111', screen_name: '甲' } },
      ],
    },
    TARGET,
  )
  assert.equal(result.ok, true)
})

// ---------------------------------------------------------------------------
// D. 嵌套响应结构（§二.6）
// ---------------------------------------------------------------------------

test('嵌套结构：{ data: { status } } 能找到目标', () => {
  const result = matchReturnedStatus({ data: { status: { idstr: TARGET, text: '嵌套正文' } } }, TARGET)
  assert.equal(result.ok, true, 'v0.2.14 只找一层，嵌套响应会变成「没有可识别 id」')
  if (result.ok) assert.equal(result.status.text, '嵌套正文')
})

test('嵌套结构：{ result: { statuses: [...] } } 能精确挑出目标', () => {
  const result = matchReturnedStatus(
    {
      result: {
        statuses: [
          { idstr: '1111111111111111', text: '别的' },
          { idstr: TARGET, text: '目标' },
        ],
      },
    },
    TARGET,
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.status.text, '目标')
})

test('嵌套结构：嵌套层里的冲突同样被拒绝', () => {
  const result = matchReturnedStatus(
    { data: { status: { idstr: TARGET, id: '9999999999999999', text: 'x' } } },
    TARGET,
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'identity_conflict')
})

test('嵌套结构：没有微博对象的嵌套不误判成目标', () => {
  const result = matchReturnedStatus({ data: { error: 'boom' } }, TARGET)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'no_candidates')
})

// ---------------------------------------------------------------------------
// E. 真实调用路径：冲突时不得生成可分析的 thread（§二.8）
// ---------------------------------------------------------------------------

interface Rig {
  readonly reset: () => void
}

function useFakeCli(rules: readonly unknown[]): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'idfield-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'calls.log')
  writeFileSync(scriptPath, JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = scriptPath
  process.env.FAKE_CLI_LOG = logPath
  __setCliInvocation({ file: process.execPath, prefixArgs: [SCRIPT] })
  __setPlanCacheTimings({ readyTtlMs: 0, failedBackoffMs: 0 })
  return {
    reset: () => {
      __setCliInvocation(undefined)
      delete process.env.FAKE_CLI_SCRIPT
      delete process.env.FAKE_CLI_LOG
    },
  }
}

function rulesFor(statusPayload: unknown): unknown[] {
  return [
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    {
      match: 'commands list',
      stdout: JSON.stringify({ commands: [{ group: 'statuses', action: 'show_batch/biz', access: 'allowed' }] }),
    },
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
  url: `https://m.weibo.cn/detail/${TARGET}`,
}

test('集成：id 与 idstr 冲突时 getThread 抛 target_mismatch，不产生可分析 thread', async () => {
  const rig = useFakeCli(rulesFor({ idstr: TARGET, id: '9999999999999999', text: '测试正文' }))
  try {
    const adapter = weiboProvider.createAdapter({ settings: {} })
    const error = await adapter.getThread(REF).then(
      (thread) => ({ thread }),
      (caught: { code?: string; message?: string }) => caught,
    )
    assert.equal('thread' in error, false, '矛盾的身份不能产出 thread')
    assert.equal((error as { code?: string }).code, 'target_mismatch')
  } finally {
    rig.reset()
  }
})

test('集成：id 与 idstr 一致的正常响应仍然可用', async () => {
  const rig = useFakeCli(
    rulesFor({ idstr: TARGET, id: TARGET, text: '正常正文', user: { idstr: '1', screen_name: '作者' } }),
  )
  try {
    const thread = await weiboProvider.createAdapter({ settings: {} }).getThread(REF)
    assert.equal(thread.id, TARGET)
    assert.equal(thread.content, '正常正文')
  } finally {
    rig.reset()
  }
})
