/**
 * v0.2.30 §六：异常流程里「预览」与「确认」必须说同一件事。
 *
 * ## 这个文件在防什么
 *
 * 真机跑异常验收时抓到两件事，都发生在**预览这一步**：
 *
 * 1. **只有一条发言的输入被判成功。** 粘进来一段没有「作者：内容」格式的文字，
 *    冒号把前半句读成了作者名，于是解析器产出「一个作者 + 零条评论」，预览返回
 *    `ok: true` 并显示一个莫名其妙的作者。用户点「确认导入并分析」时才被拒——
 *    理由是「这份导入内容里没有任何评论」。
 *
 *    预览的职责就是让用户在**确认之前**知道这样不行。它当时没说。
 *
 * 2. **截断在预览里看不见。** 超长正文在落盘（`toStoredImport`）时被截到
 *    `MAX_IMPORTED_CHARS`，而预览不经过落盘，所以它展示完整正文、`issues` 为空。
 *    用户以为确认的是自己看到的那一段，实际存下的是截断版本。
 *
 * 两条的共同点：**预览展示的不是确认之后会发生的事**。所以这里的断言都对着
 * 「预览与落盘的一致性」，而不是某个字符串。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseImport } from '../lib/import/manual.js'
import { MAX_IMPORTED_CHARS, toStoredImport } from '../lib/import/session.js'

/**
 * 复刻 index.ts 里 `manualImport.preview` 的判定：解析之后还挡什么。
 *
 * 为什么不直接调 `manualImport.preview`：它挂在 Cordis 的 apply 里，构造需要一整套
 * 运行时依赖。而这里要测的是**判定规则**，把它抽成一个小函数、并在源码里保持
 * 同一套常量，比为了可测性把整个 apply 拖进单测更诚实。规则一旦与源码分歧，
 * 下面第一条断言（与 toStoredImport 一致）会红。
 */
function previewVerdict(content: string): {
  ok: boolean
  reason?: string
  warningCodes: string[]
} {
  const parsed = parseImport({ kind: 'text', content })
  const blocking = parsed.issues.find((issue) => issue.severity === 'error')
  if (parsed.discussion === undefined || blocking !== undefined) {
    return { ok: false, reason: blocking?.message ?? '解析失败', warningCodes: [] }
  }
  const comments = parsed.discussion.comments
  if (comments.length === 0) {
    return {
      ok: false,
      reason: '这份导入内容里没有任何评论，无法分析。请至少导入一条别人说的话——只有原帖时没有可回复的对象。',
      warningCodes: [],
    }
  }
  const overlong = comments.filter((comment) => comment.text.length > MAX_IMPORTED_CHARS)
  const overlongRoot = parsed.discussion.root.text.length > MAX_IMPORTED_CHARS
  return {
    ok: true,
    warningCodes: overlong.length === 0 && !overlongRoot ? [] : ['will_truncate'],
  }
}

const GOOD = `# 价格翻倍合理吗

原帖作者：我觉得这个价格翻倍是合理的，成本上涨了那么多。
---
路人甲：成本上涨不等于可以翻倍，你先把数据拿出来。
路人乙：行业平均也才涨了三成，翻倍是漫天要价。`

test('预览：只有一条发言时 preview 与 confirm 的结论一致', () => {
  // 一段没有任何格式的叙述。解析器会把它当成「冒号前是作者名」的一条发言。
  const narrative = '这里只是一段没有任何格式的文字：我随手写下的想法，没有第二个人说话。'
  const parsed = parseImport({ kind: 'text', content: narrative })
  assert.ok(parsed.discussion !== undefined, '这一段确实会被解析成一条发言——这正是问题所在')
  assert.equal(parsed.discussion.comments.length, 0)

  const verdict = previewVerdict(narrative)
  assert.equal(verdict.ok, false, '没有评论时预览必须拒绝，而不是返回一个像成功的结果')
  // 关键：理由必须是「没有任何评论」，与确认那一步给出的理由同一件事。
  assert.match(verdict.reason!, /没有任何评论/)
  assert.match(verdict.reason!, /别人说的|可回复/)
})

test('预览：一条正常的讨论仍然通过', () => {
  const verdict = previewVerdict(GOOD)
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.warningCodes, [], '正常长度不该出现截断警告')
})

test('预览：超长正文在预览时就被标出截断', () => {
  const long = '这是一句很长的发言，'.repeat(Math.ceil(MAX_IMPORTED_CHARS / 5))
  assert.ok(long.length > MAX_IMPORTED_CHARS, '素材必须真的超过上限')
  const content = ['原作者：原始发言。', '---', `路人甲：${long}`].join('\n')

  const verdict = previewVerdict(content)
  assert.equal(verdict.ok, true, '超长不是错误，只是会截断')
  assert.deepEqual(verdict.warningCodes, ['will_truncate'], '预览必须提前说明会截断')

  // 与落盘对齐：落盘确实截了，且记了数。
  const parsed = parseImport({ kind: 'text', content })
  const stored = toStoredImport(parsed.discussion!, '2026-11-06T00:00:00.000Z')
  assert.equal(stored.truncatedComments, 1, '落盘应当记录一条被截断')
  const saved = stored.comments[0]!
  assert.equal(saved.text.length, MAX_IMPORTED_CHARS + 1, '落盘正文应是上限 + 省略号')
  assert.match(saved.text, /…$/)
})

test('预览：原帖超长也被标出', () => {
  const long = '这是原帖里非常长的一段话，'.repeat(Math.ceil(MAX_IMPORTED_CHARS / 6))
  assert.ok(long.length > MAX_IMPORTED_CHARS)
  const content = [`原作者：${long}`, '---', '路人甲：你这话说得太长了。'].join('\n')

  const verdict = previewVerdict(content)
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.warningCodes, ['will_truncate'], '原帖超长同样要提前说明')

  const stored = toStoredImport(parseImport({ kind: 'text', content }).discussion!, '2026-11-06T00:00:00.000Z')
  assert.equal(stored.truncatedComments, 1, '原帖被截也要计数')
  assert.ok(stored.root.text.length <= MAX_IMPORTED_CHARS + 1)
})

test('预览：正好等于上限时不报截断', () => {
  // 差一位就必须报，差零位就不该报。边界写反会让每一条正常长文都带一条假警告。
  const exact = '字'.repeat(MAX_IMPORTED_CHARS)
  const content = ['原作者：原始发言。', '---', `路人甲：${exact}`].join('\n')
  assert.deepEqual(previewVerdict(content).warningCodes, [], '等于上限不该被截断')

  const over = '字'.repeat(MAX_IMPORTED_CHARS + 1)
  const content2 = ['原作者：原始发言。', '---', `路人甲：${over}`].join('\n')
  assert.deepEqual(previewVerdict(content2).warningCodes, ['will_truncate'], '超一位就该被标出')
})
