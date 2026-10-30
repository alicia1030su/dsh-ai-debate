/**
 * v0.2.13 §二/§三 复现脚本。
 *
 * ## 它现在的用途变了
 *
 * 最初它是「证明缺陷存在」的脚本，两处都输出「复现成功」。修复之后，同一份脚本的预期
 * 反过来了：两处都应该输出**已修复**。所以判定逻辑改成「哪种结论算正常」由脚本自己说，
 * 而不是恒定期望失败。
 *
 * 它保留在仓库里，因为下一次改缓存或改语义判定时，跑一遍就能知道这两个行为有没有回头。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __setCliInvocation } = await import('../lib/platforms/weibo/cli.js')
const { __setPlanCacheTimings } = await import('../lib/platforms/weibo/plan-cache.js')
const { weiboProvider } = await import('../lib/platforms/weibo/provider.js')
const { parseWeiboUrl } = await import('../lib/platforms/weibo/url.js')
const { analyzeDispute } = await import('../lib/analyzer.js')
const { buildBrief } = await import('../lib/brief-builder.js')
const { validateBrief } = await import('../lib/brief.js')
const { makeFloor, makeNested } = await import('../test/helpers.ts')

// ---------------------------------------------------------------------------
// 1. 读取计划永久缓存
// ---------------------------------------------------------------------------

function installFake(rules) {
  const dir = mkdtempSync(join(tmpdir(), 'repro-'))
  const script = join(dir, 'script.json')
  writeFileSync(script, JSON.stringify({ rules }), 'utf8')
  process.env.FAKE_CLI_SCRIPT = script
  process.env.FAKE_CLI_LOG = join(dir, 'calls.log')
  __setCliInvocation({ file: process.execPath, prefixArgs: [join(import.meta.dirname, '..', 'test', 'fixtures', 'fake-weibo-cli.mjs')] })
  return join(dir, 'calls.log')
}

const MISSING_RULES = [
  { match: 'version', stderr: 'command not found\n', exit: 1 },
]

const READY_RULES = [
  { match: 'version', stdout: 'weibo-cli 1.0.0\n' },
  { match: 'doctor', stdout: 'ok\n' },
  { match: 'commands show statuses/show', stdout: JSON.stringify({ name: 'statuses/show', params: [{ name: 'id', required: true }] }) },
  { match: 'commands show comments/list', stdout: JSON.stringify({ name: 'comments/list', params: [{ name: 'id', required: true }, { name: 'parent_id' }] }) },
  { match: 'commands list', stdout: JSON.stringify({ commands: [{ name: 'statuses/show' }, { name: 'comments/list' }] }) },
  { match: 'statuses/show', stdout: JSON.stringify({ idstr: '4331051486294436', text: '正文', user: { idstr: '111', screen_name: '主人' } }) },
]

const ref = (() => {
  const r = parseWeiboUrl('https://m.weibo.cn/detail/4331051486294436')
  return { platform: 'weibo', threadId: r.threadId, url: r.url }
})()

const adapterA = weiboProvider.createAdapter({ settings: {} })

// The backoff window is set to zero so this measures **recoverability**, not the rate limit.
// With the production 15s window the second read would correctly fail fast with the cached
// reason; that behaviour is covered by the unit tests in `test/v0213-plan-cache.test.ts`.
__setPlanCacheTimings({ backoffMs: 0 })

installFake(MISSING_RULES)
const first = await adapterA.getThread(ref).then(
  () => 'ok',
  (error) => error.code ?? error.name,
)

// CLI 现在可用了 —— 同一个 Adapter，不重建
await new Promise((resolve) => setTimeout(resolve, 5))
installFake(READY_RULES)
const second = await adapterA.getThread(ref).then(
  () => 'ok',
  (error) => error.code ?? error.name,
)

const fresh = weiboProvider.createAdapter({ settings: {} })
const third = await fresh.getThread(ref).then(
  () => 'ok',
  (error) => error.code ?? error.name,
)

__setCliInvocation(undefined)
__setPlanCacheTimings(undefined)
delete process.env.FAKE_CLI_SCRIPT
delete process.env.FAKE_CLI_LOG

console.log('=== 缺陷 1：读取计划永久缓存 ===')
console.log('  第一次（CLI 未装）      :', first)
console.log('  恢复后同一个 Adapter    :', second, second === 'ok' ? '' : '← 仍是旧失败')
console.log('  恢复后新建 Adapter      :', third)
const cacheFixed = first !== 'ok' && second === 'ok'
console.log(
  '  结论:',
  cacheFixed ? '✅ 已修复（同一 Adapter 能自动恢复）' : '❌ 失败被缓存住了',
)

// ---------------------------------------------------------------------------
// 2. buildBrief 把无关观点判为矛盾
// ---------------------------------------------------------------------------

function collected(thread, floor, nested) {
  return {
    thread,
    floors: [{ floor, nested, nestedComplete: true }],
    complete: true,
    issues: [],
  }
}

const floorPostId = 'F1'
const nested = [
  // 主人的爱好
  makeNested({ postId: 'o1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '我喜欢吃苹果，尤其是红富士苹果。' }),
  // 对方的爱好 —— 与主人的话题完全无关
  makeNested({ postId: 't1', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '我喜欢喝乌龙茶，尤其是热乌龙茶。' }),
  makeNested({ postId: 'o2', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '@吵架小号 上。' }),
]

const data = collected(
  { platform: 'tieba', forum: { platform: 'tieba', id: '9', name: '测试吧' }, id: '900', title: 't', content: 'c', url: 'u', images: [] },
  makeFloor({ floorNumber: 1, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length }),
  nested,
)

const dispute = analyzeDispute(data, { userId: 'o', platform: 'tieba' }, { postId: 'o2' })
const { brief, sources } = buildBrief({ platform: 'tieba', threadId: '900', collected: data, dispute })
const problems = validateBrief(brief, sources)

console.log('')
console.log('=== 缺陷 2：无关观点被判为矛盾 ===')
console.log('  主人:', brief.owner.summary)
console.log('  对方:', brief.opponent.summary)
console.log('  disagreements:', JSON.stringify(brief.disagreements))
console.log('  uncertainties:', JSON.stringify(brief.uncertainties.map((item) => item.point)))
console.log('  risks:', JSON.stringify(brief.risks))
console.log('  validateBrief 问题数:', problems.length)

// The fix is "no contradiction claim". Asserting *some* problem from the validator is not the
// point — the validator checks citations, not meaning, so it legitimately passes a
// well-cited brief with no disagreements.
const claimsContradiction = brief.disagreements.some((item) => /不能同时成立/.test(item))
const flagsUncertainty = brief.uncertainties.some((item) => /分歧/.test(item.point))
console.log(
  '  结论:',
  !claimsContradiction
    ? `✅ 已修复（不再断言矛盾；不确定性提示：${flagsUncertainty ? '有' : '无'}）`
    : '❌ 仍在断言无关观点互相矛盾',
)
