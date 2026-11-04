/**
 * Two defects the real browser found, and the guards that keep them dead.
 *
 * Both were invisible to unit tests and to the type checker. They only appeared when
 * a human-equivalent click path ran against the real plugin inside the real shell.
 *
 * ## 1. The workbench could not be started
 *
 * The no-session branch of the workbench route spread its derived state at the top
 * level, while the session branch nested it under `workbench`. The client reads
 * `view.workbench`, so on a fresh install it got `undefined`, rendered
 * 「当前构建没有接上工作台」 — a false statement about the build — and skipped the link
 * field. A first-time owner had no way to begin a read at all.
 *
 * ## 2. The settings panel crashed on the workbench tab
 *
 * A `const linkForm` definition was moved upward during development and landed in a
 * neighbouring component's scope. `WorkbenchSection` still referenced it, so opening
 * the tab threw `ReferenceError: linkForm is not defined`, and the shell — correctly —
 * unmounted the whole slot. Ten tabs became zero.
 *
 * The guard for (2) is deliberately narrow: it checks that the definition sits inside
 * `WorkbenchSection` and before its first use, which is the specific way this broke.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function clientSource(): string {
  return readFileSync(join(ROOT, 'client', 'client.cjs'), 'utf8')
}

function serverSource(): string {
  return readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
}

test('无会话时工作台返回形状与会话时一致（都嵌在 workbench 下）', () => {
  const source = serverSource()
  const branch = source.slice(
    source.indexOf('if (session === undefined) {'),
    source.indexOf('const platform = session.platform'),
  )
  assert.match(branch, /workbench: deriveWorkbenchState/, '必须嵌在 workbench 下，客户端才读得到')
  assert.doesNotMatch(
    branch,
    /\.\.\.deriveWorkbenchState/,
    '平铺会让客户端拿到 undefined，并误报「构建没接上工作台」',
  )
})

test('链接输入框定义在 WorkbenchSection 内部且在使用之前', () => {
  const source = clientSource()
  const sectionStart = source.indexOf('function WorkbenchSection')
  assert.ok(sectionStart > 0, '必须能找到 WorkbenchSection')

  // The component ends where the next top-level component begins. Both indices are
  // taken from the whole file and compared against that boundary, because JSX in this
  // component spans further than a naive "next function" slice suggests.
  const nextComponent = source.indexOf('function ', sectionStart + 10)
  const defIndex = source.indexOf('const linkForm')
  const useIndex = source.indexOf('\n        linkForm,')
  assert.ok(defIndex > sectionStart, 'linkForm 必须定义在 WorkbenchSection 内')
  assert.ok(defIndex < nextComponent, `定义必须仍在 WorkbenchSection 内（def=${defIndex} next=${nextComponent}）`)
  assert.ok(useIndex > defIndex, `定义必须在渲染处之前（def=${defIndex} use=${useIndex}）`)

  // And it must not be defined anywhere else, which is how it broke: a stray
  // definition in a sibling component left this one referencing nothing.
  const definitions = source.split('const linkForm').length - 1
  assert.equal(definitions, 1, `const linkForm 只应定义一次，实际 ${definitions} 次`)
})

test('空状态也渲染链接输入框，否则用户无法开始', () => {
  const source = clientSource()
  // Both early returns must carry the form forward.
  const emptyBranch = source.slice(
    source.indexOf('if (!view || typeof view !== \'object\')'),
    source.indexOf('if (Array.isArray(view.blockers)'),
  )
  assert.match(emptyBranch, /linkForm/, '无视图时必须仍显示链接输入框')

  const noWorkbenchBranch = source.slice(
    source.indexOf('if (!wb) {'),
    source.indexOf('const outcomeLabel'),
  )
  assert.match(noWorkbenchBranch, /linkForm/, '无 workbench 字段时也必须保留入口')
})
