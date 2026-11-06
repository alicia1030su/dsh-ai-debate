/**
 * 两处「这条发表需要哪个能力」的同构实现，必须给出同一个答案（v0.2.31 §七）。
 *
 * ## 为什么用测试钉住，而不是把它们合并成一个函数
 *
 * 一处是 `src/index.ts` 的 `capabilityNameForSession`（页面读的），一处是
 * `src/publisher.ts` 的 `capabilityForSession`（真正决定发出去的是什么）。合并要动
 * `publisher.ts`——那是发表安全路径，而这两处目前**行为一致**，没有缺陷可修。
 * 为了消掉十行重复去改发表路径，风险远大于收益：一个手误就是把「检查的能力」和
 * 「执行的动作」重新分开，而那正是 v0.2.26 修掉的缺陷。
 *
 * 所以这里选择**用测试钉住一致性**：两处只要漂移，这里立刻红，而且报得出是哪一组
 * 入参分叉。改发表路径仍然要人决定，但「悄悄漂移」这条路被堵住了。
 *
 * ## 怎么拿到两个私有函数
 *
 * 它们都没有导出（故意：不该有第三个调用点）。所以这里不 import 函数，而是
 * **从源码文本里读出那条规则**并断言两处逐字相同。这听起来脆弱，但它测的恰好是
 * 关键性质：两处写的是同一句话。函数被重命名、被搬走都不影响这条断言的意义；
 * 只有规则真的分叉时它才红。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

/** 把一段源码里 `targetKind ?? … ?? 'nested'` 这条表达式抓出来。 */
function kindRuleIn(source: string, anchor: string): string {
  const at = source.indexOf(anchor)
  assert.notEqual(at, -1, `源码里找不到锚点「${anchor}」——函数被重命名了？请更新这条测试的锚点`)
  const window = source.slice(at, at + 1200)
  const match = window.match(/^.*targetSnapshot\?\.targetKind \?\? .*targetKind \?\? 'nested'.*$/m)
  assert.notEqual(
    match,
    null,
    `「${anchor}」附近找不到「候选快照优先」的那条规则。` +
      '如果它被改写了，说明决定「发什么」的规则变了——那是需要人审的改动。',
  )
  return match![0].trim()
}

test('页面与发表路径对「需要哪个能力」使用同一条规则', () => {
  const index = readFileSync(join(root, 'src/index.ts'), 'utf8')
  const publisher = readFileSync(join(root, 'src/publisher.ts'), 'utf8')

  const fromPage = kindRuleIn(index, 'function capabilityNameForSession')
  const fromPublish = kindRuleIn(publisher, 'function capabilityForSession')

  // 归一化两处**不改变语义**的差异，只比较规则本身：
  //
  // - 空白：缩进不同不算分叉。
  // - `?.` 与 `.`：页面那处的参数是可选的（`session?`），发表那处拿到的是非可选
  //   对象，所以一处写 `candidate?.targetSnapshot`、另一处写
  //   `candidate.targetSnapshot`。**读的是同一个字段、同一个优先顺序**，把这一处
  //   整成一样只会让其中一边的类型变成谎话（对可能为 undefined 的对象用 `.`）。
  const normalize = (line: string) =>
    line.replace(/\?\./g, '.').replace(/\s+/g, ' ').trim()
  assert.equal(
    normalize(fromPage),
    normalize(fromPublish),
    '两处规则必须同构：读的字段或优先顺序不同，就会让「页面说 A、实际发 B」重演',
  )
})

test('工作台展示的目标形态也读候选快照，不读会话', () => {
  /**
   * 第三处同构：`src/workbench.ts` 里展示 `target.kind` 的那一行。
   *
   * 它不决定发表，但决定**用户看到的是什么**。v0.2.26 的缺陷是这三处里的两处
   * 各读一个字段，于是页面上「kind=楼层 / comment.publish」旁边躺着一条真实的
   * 楼中楼回复。所以它也必须钉住。
   */
  const workbench = readFileSync(join(root, 'src/workbench.ts'), 'utf8')
  const at = workbench.indexOf('kind: current.targetSnapshot?.targetKind')
  assert.notEqual(
    at,
    -1,
    '工作台的 target.kind 必须优先读候选快照；找不到这行说明它被改成了别的字段',
  )
})
