/**
 * v0.2.14 复现脚本：证明三项已确认的微博缺陷。
 *
 * 跑这个文件时，三处**必须**输出「复现成功」。某处输出「未复现」说明代码已经变过，
 * 需要重新核对而不是照抄结论。
 *
 * 新增缺陷 4/5（§六 语义）一并复现，因为它们和上面三项属于同一批「已确认」结论。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __setCliInvocation } = await import('../lib/platforms/weibo/cli.js')
const { __setPlanCacheTimings } = await import('../lib/platforms/weibo/plan-cache.js')
const { weiboProvider } = await import('../lib/platforms/weibo/provider.js')
const { judgeRelation } = await import('../lib/conflict.js')

__setPlanCacheTimings({ backoffMs: 0 })

function installFake(rules) {
  const dir = mkdtempSync(join(tmpdir(), 'repro214-'))
  writeFileSync(join(dir, 'script.json'), JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = join(dir, 'script.json')
  process.env.FAKE_CLI_LOG = join(dir, 'calls.log')
  __setCliInvocation({
    file: process.execPath,
    prefixArgs: [join(import.meta.dirname, '..', 'test', 'fixtures', 'fake-weibo-cli.mjs')],
  })
  return join(dir, 'calls.log')
}

const CATALOG = {
  commands: [{ group: 'statuses', action: 'show_batch/biz', access: 'allowed' }],
  total: 1,
}
const SCHEMA = {
  group: 'statuses',
  action: 'show_batch/biz',
  flags: [{ name: 'ids', required: true }],
}

const REF = {
  platform: 'weibo',
  threadId: '4331051486294436',
  url: 'https://m.weibo.cn/detail/4331051486294436',
}

// ---------------------------------------------------------------------------
// 缺陷 1：返回的 MID 与请求的不一致，仍被当成目标微博
// ---------------------------------------------------------------------------

installFake([
  { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
  { match: 'doctor', stdout: 'ok\n' },
  { match: 'commands list', stdout: JSON.stringify(CATALOG) },
  { match: 'commands show statuses show_batch/biz', stdout: JSON.stringify(SCHEMA) },
  {
    match: 'statuses show_batch/biz',
    // A well-formed single status object — but a **different** post. This is the shape
    // `unwrapStatus` accepts, so the mismatch is not caught by structure: the only thing wrong
    // is the MID.
    stdout: JSON.stringify({
      idstr: '9999999999999999',
      text: '这是一条完全不同的微博。',
      user: { id: 222, idstr: '222', screen_name: '别人' },
    }),
  },
])

const adapter = weiboProvider.createAdapter({ settings: {} })
const thread = await adapter.getThread(REF).then(
  (value) => value,
  (error) => ({ error: error.code ?? error.name, message: error.message }),
)

console.log('=== 缺陷 1：正文目标 MID 未校验 ===')
console.log('  请求 MID      :', REF.threadId)
if (thread.error !== undefined) {
  console.log('  结果          : 拒绝了 —', thread.error)
  console.log('  结论: ✅ 已修复（不匹配被拒绝）')
} else {
  console.log('  返回的 thread.id:', thread.id)
  console.log('  返回的正文      :', thread.content)
  const bug = thread.id === REF.threadId && thread.content === '这是一条完全不同的微博。'
  console.log(
    '  结论:',
    bug ? '✅ 复现成功（别人的正文被标成了请求的 MID）' : '⚠️ 未复现',
  )
}

__setCliInvocation(undefined)
delete process.env.FAKE_CLI_SCRIPT
delete process.env.FAKE_CLI_LOG

// ---------------------------------------------------------------------------
// 缺陷 2：评论分页参数生成错误
// ---------------------------------------------------------------------------

function commentRig(schemaFlags) {
  return installFake([
    { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
    { match: 'doctor', stdout: 'ok\n' },
    {
      match: 'commands list',
      stdout: JSON.stringify({
        commands: [
          { group: 'statuses', action: 'show_batch/biz', access: 'allowed' },
          { group: 'comments', action: 'show/biz', access: 'allowed' },
        ],
      }),
    },
    { match: 'commands show statuses show_batch/biz', stdout: JSON.stringify(SCHEMA) },
    {
      match: 'commands show comments show/biz',
      stdout: JSON.stringify({ group: 'comments', action: 'show/biz', flags: schemaFlags }),
    },
    {
      match: 'statuses show_batch/biz',
      stdout: JSON.stringify({ idstr: '4331051486294436', text: '正文', user: { idstr: '1', screen_name: 'u' } }),
    },
    {
      match: 'comments show/biz',
      stdout: JSON.stringify({
        comments: [{ id: 5001, idstr: '5001', text: '评论', user: { id: 2, idstr: '2', screen_name: 'o' } }],
        has_more: true,
      }),
    },
  ])
}

function readCalls(path) {
  const text = readFileSync(path, 'utf8')
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

// 情况 A：只声明 id、count，不声明 page
const logA = commentRig([{ name: 'id', required: true }, { name: 'count' }])
const adapterA = weiboProvider.createAdapter({ settings: {} })
await adapterA.getReplies(REF, 2).catch(() => undefined)
const commentCallA = readCalls(logA).find((argv) => argv[0] === 'comments' && argv[1] === 'show/biz')

// 情况 B：只声明 id、page，不声明 count
const logB = commentRig([{ name: 'id', required: true }, { name: 'page' }])
const adapterB = weiboProvider.createAdapter({ settings: {} })
await adapterB.getReplies(REF, 2).catch(() => undefined)
const commentCallB = readCalls(logB).find((argv) => argv[0] === 'comments' && argv[1] === 'show/biz')

__setCliInvocation(undefined)
delete process.env.FAKE_CLI_SCRIPT
delete process.env.FAKE_CLI_LOG

console.log('')
console.log('=== 缺陷 2：评论分页参数生成错误 ===')
console.log('  情况 A（只声明 id/count），请求第 2 页')
console.log('    argv:', JSON.stringify(commentCallA))
const bugA = commentCallA?.includes('--page') === true
console.log('    发了未声明的 --page:', bugA)
console.log('  情况 B（只声明 id/page），请求第 2 页')
console.log('    argv:', JSON.stringify(commentCallB))
const bugB = commentCallB?.includes('--page') !== true
console.log('    漏发了已声明的 --page:', bugB)
console.log(
  '  结论:',
  bugA || bugB ? '✅ 复现成功（A 多发、B 漏发）' : '⚠️ 未复现',
)

// ---------------------------------------------------------------------------
// 缺陷 3：子评论能力误报
// ---------------------------------------------------------------------------

const logC = installFake([
  { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
  { match: 'doctor', stdout: 'ok\n' },
  {
    match: 'commands list',
    stdout: JSON.stringify({
      commands: [
        { group: 'statuses', action: 'show_batch/biz', access: 'allowed' },
        { group: 'comments', action: 'show/biz', access: 'allowed' },
      ],
    }),
  },
  { match: 'commands show statuses show_batch/biz', stdout: JSON.stringify(SCHEMA) },
  {
    match: 'commands show comments show/biz',
    // 没有任何父评论筛选参数。
    stdout: JSON.stringify({
      group: 'comments',
      action: 'show/biz',
      flags: [{ name: 'id', required: true }, { name: 'page' }],
    }),
  },
  {
    match: 'statuses show_batch/biz',
    stdout: JSON.stringify({ idstr: '4331051486294436', text: '正文', user: { idstr: '1', screen_name: 'u' } }),
  },
  {
    match: 'comments show/biz',
    stdout: JSON.stringify({ comments: [], has_more: false }),
  },
])

const adapterC = weiboProvider.createAdapter({ settings: {} })
await adapterC.getThread(REF).catch(() => undefined)
const caps = adapterC.getCapabilities()
const nested = await adapterC
  .getNestedReplies(REF, { platform: 'weibo', postId: '5001', content: '', images: [] }, 1)
  .then(
    () => 'ok',
    (error) => error.code ?? error.name,
  )

__setCliInvocation(undefined)
delete process.env.FAKE_CLI_SCRIPT
delete process.env.FAKE_CLI_LOG

console.log('')
console.log('=== 缺陷 3：子评论能力误报 ===')
console.log('  getCapabilities().nestedReplies:', caps.nestedReplies)
console.log('  getNestedReplies 实际结果       :', nested)
const bugC = caps.nestedReplies === true && nested !== 'ok'
console.log('  结论:', bugC ? '✅ 复现成功（声明可用，实际拒绝）' : '⚠️ 未复现')

// ---------------------------------------------------------------------------
// 缺陷 4/5：不同对象被判矛盾 / 同一对象判不出矛盾
// ---------------------------------------------------------------------------

const cases = [
  ['A 方案可行。', 'B 方案不可行。', 'different_topics', '不同对象'],
  ['我支持张三的建议。', '我反对李四的建议。', 'different_topics', '不同人物'],
  ['这个方案可行。', '这个方案不可行。', 'contradiction', '同一对象'],
]

console.log('')
console.log('=== 缺陷 4/5：语义对象混淆 ===')
let semanticBugs = 0
for (const [owner, opponent, expected, label] of cases) {
  const verdict = judgeRelation({ ownerText: owner, opponentText: opponent })
  const ok = verdict.relation === expected
  if (!ok) semanticBugs += 1
  console.log(`  [${ok ? '对' : '错'}] ${label}`)
  console.log(`     ${owner} / ${opponent}`)
  console.log(`     预期 ${expected}，实际 ${verdict.relation}`)
}
console.log(
  '  结论:',
  semanticBugs > 0 ? `✅ 复现成功（${semanticBugs}/3 判错）` : '⚠️ 未复现',
)
