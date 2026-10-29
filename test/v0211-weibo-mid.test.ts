/**
 * v0.2.11 §二/§三：微博 base62 ↔ numeric mid 的分段算法，以及规范链接的自洽性。
 *
 * ## 这个文件存在的理由
 *
 * v0.2.10 把 base62 id 当**一个整体**的 62 进制整数处理。它错得很隐蔽：
 * 编码器和解码器互为逆运算，所以「自编自解」的往返测试全部通过，而两个方向
 * 一起错。只有拿**外部算出来的数字**去比才会暴露。
 *
 * 所以这里的断言全部基于外部已知样例，**编码与解码分开检查**，不使用「往返相等」
 * 作为唯一证据。
 *
 * ## 关于第三组样例
 *
 * 任务书给了三组，其中第三组 `Is0XboARR <-> 4467107636950632` 与它自己的算法
 * 不自洽。算术如下（分组算法，可直接复核）：
 *
 *   Is0XboARR  从右每 4 字符分组 → ["I", "s0Xb", "oARR"]
 *     I    -> 44
 *     s0Xb -> 6676853
 *     oARR -> 5861595
 *     拼接 -> 44 6676853 5861595 = 4466768535861595
 *
 *   4467107636950632  从右每 7 位分组 → ["44", "6710763", "6950632"]
 *     44      -> "I"
 *     6710763 -> "s9M7"
 *     6950632 -> "taaY"
 *     拼接 -> "Is9M7taaY"
 *
 * 两个方向互相得不到对方，所以这组样例本身有问题。前两组与算法完全吻合，且第二组
 * 的中间组算出 6 位（410109）、补零成 0410109 后才对上——那个补零细节如果不存在，
 * 第二组就会失败。两组合起来足以确定算法，因此本文件用这两组作为硬证据，第三组
 * 只在注释里记录不一致，**不写成断言**（把错的期望写进测试，等于把 bug 固化）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseWeiboUrl, toBase62, toNumericMid } from '../lib/platforms/weibo/url.js'

/**
 * The two samples that are self-consistent.
 *
 * Kept as a table rather than inline so a future sample can be added in one place, and
 * so the assertion loops below read as "every known pair, both directions".
 */
const KNOWN: readonly (readonly [base62: string, mid: string])[] = [
  ['Hd1N2qpta', '4331051486294436'],
  ['I1IGF4Ud1', '4404101091169383'],
]

test('外部已知样例：base62 → numeric mid（解码方向）', () => {
  for (const [base62, mid] of KNOWN) {
    assert.equal(toNumericMid(base62), mid, `${base62} 应解出 ${mid}`)
  }
})

test('外部已知样例：numeric mid → base62（编码方向）', () => {
  // Separate from decoding on purpose. The v0.2.10 bug was two functions that agreed
  // with each other and disagreed with the platform; testing only one direction would
  // have left the other wrong.
  for (const [base62, mid] of KNOWN) {
    assert.equal(toBase62(mid), base62, `${mid} 应编成 ${base62}`)
  }
})

test('第二组样例证明「非最左组补 7 位」确实生效', () => {
  // The middle group of I1IGF4Ud1 decodes to 410109 — six digits. Without the pad to
  // seven it would concatenate to 44 + 410109 + 1169383 = shorter string, and the mid
  // would be wrong in the middle. This is the detail that makes the rule non-obvious,
  // so it gets its own assertion rather than being implied by the table above.
  assert.equal(toNumericMid('1IGF'), '410109')
  assert.equal(toNumericMid('I1IGF4Ud1'), '4404101091169383')
  // 44 | 0410109 | 1169383
  assert.equal('44' + '0410109' + '1169383', '4404101091169383')
})

test('第一组样例证明左端组不补位', () => {
  // "H" is 43, not 0043. If the leftmost group were padded the mid would gain leading
  // zeros; if the padding were applied to every group the length would be wrong.
  assert.equal(toNumericMid('H'), '43')
  assert.equal(toNumericMid('Hd1N2qpta'), '4331051486294436')
})

test('纯数字 id 原样通过，不做任何转换', () => {
  // A numeric mid is already canonical. Running it through the base62 decoder would
  // treat it as base62 and produce a different number — the old code's decimal
  // short-circuit is load-bearing and must survive the rewrite.
  for (const mid of ['4331051486294436', '1', '0', '999999999999999999']) {
    assert.equal(toNumericMid(mid), mid)
  }
})

test('mid 以字符串传递，超出 Number 安全范围也不丢精度', () => {
  // 4331051486294436 is below 2^53, but the scheme allows much larger values. Keeping
  // the type a string is what makes that safe; this pins it so a future refactor to
  // `Number` fails here rather than silently rounding a real id.
  const large = '12345678901234567890'
  assert.equal(typeof toNumericMid('Hd1N2qpta'), 'string')
  // Round-trip on a value that would lose precision as a double.
  const encoded = toBase62(large)
  assert.equal(typeof encoded, 'string')
  assert.equal(toNumericMid(encoded!), large)
  assert.notEqual(String(Number(large)), large, '这个值本身就能证明 Number 会丢精度')
})

test('非法输入返回 undefined，不抛也不猜', () => {
  for (const bad of ['', '   ', 'abc-def', 'a b', '中文', '!!!']) {
    assert.equal(toNumericMid(bad), undefined, `不应接受 ${JSON.stringify(bad)}`)
  }
  assert.equal(toBase62('12a4'), undefined, '非纯数字不能编码')
  assert.equal(toBase62(''), undefined)
})

test('分组边界：4/7 字符的整数倍与余数都正确', () => {
  // The two split directions use different widths (4 for base62, 7 for decimal), so an
  // id whose length is a multiple of one but not the other is where an off-by-one in
  // the loop shows up.
  for (const mid of ['1', '1234567', '12345678', '12345678901234', '123456789012345']) {
    const encoded = toBase62(mid)
    assert.ok(encoded !== undefined, `${mid} 应能编码`)
    assert.equal(toNumericMid(encoded!), mid, `${mid} -> ${encoded} -> 应回到自身`)
  }
})

// ---------------------------------------------------------------------------
// §三 规范链接：parseWeiboUrl(parseWeiboUrl(x).url) 必须是同一个 threadId
// ---------------------------------------------------------------------------

/** Every shape that must survive a round trip through the canonical URL. */
const ROUND_TRIP = [
  'https://m.weibo.cn/detail/4331051486294436',
  'https://m.weibo.cn/status/4331051486294436',
  'https://m.weibo.cn/statuses/show?id=4331051486294436',
  'https://weibo.com/1234567890/Hd1N2qpta',
  'https://weibo.com/Hd1N2qpta',
  'weibo.com/1234567890/Hd1N2qpta',
] as const

test('规范链接能被自己解析回同一个 threadId（v0.2.11）', () => {
  // The bug: v0.2.10 always emitted `https://weibo.com/<numeric mid>`, and its own
  // parser rejects a bare numeric segment (it is indistinguishable from a profile).
  // So the field whose purpose is "a human can open what was stored" produced a URL
  // the plugin itself refused — for every mobile link.
  for (const input of ROUND_TRIP) {
    const first = parseWeiboUrl(input)
    const second = parseWeiboUrl(first.url)
    assert.equal(
      second.threadId,
      first.threadId,
      `${input} -> ${first.url} -> 应得到同一个 threadId，实际 ${second.threadId} vs ${first.threadId}`,
    )
  }
})

test('没有作者 UID 时，规范链接明确是移动端详情地址', () => {
  // Chosen because it states its own intent in the path, so a purely numeric mid is
  // unambiguous there. A desktop `weibo.com/<digits>` would be read as a profile.
  const ref = parseWeiboUrl('https://m.weibo.cn/detail/4331051486294436')
  assert.equal(ref.uid, undefined, '这条链接没有 uid')
  assert.match(ref.url, /^https:\/\/m\.weibo\.cn\/detail\/4331051486294436$/)
})

test('有作者 UID 时，规范链接是 base62 形式的桌面 permalink', () => {
  // The desktop shape needs a base62 mid: `<uid>/<numeric mid>` would not match what
  // Weibo actually serves, even though the parser accepts it.
  const ref = parseWeiboUrl('https://weibo.com/1234567890/Hd1N2qpta')
  assert.equal(ref.uid, '1234567890')
  assert.equal(ref.url, 'https://weibo.com/1234567890/Hd1N2qpta')
  assert.match(ref.url, /Hd1N2qpta$/, '必须是 base62 形式，不能是纯数字 mid')
})

test('规范链接不得编造作者 UID', () => {
  // If the input carried no uid, the canonical URL must not invent one — that would
  // attribute the post to a stranger.
  for (const input of [
    'https://m.weibo.cn/detail/4331051486294436',
    'https://weibo.com/Hd1N2qpta',
  ]) {
    const ref = parseWeiboUrl(input)
    assert.equal(ref.uid, undefined, `${input} 不该冒出一个 uid`)
    assert.doesNotMatch(ref.url, /weibo\.com\/\d+\//, '规范链接里不该出现编造的 uid')
  }
})

test('纯数字 UID 不得被当成帖子 ID（v0.2.8 的歧义拒绝必须保持）', () => {
  // The fix for the canonical link must not weaken the ambiguity refusal: a bare
  // numeric segment really is ambiguous between "profile" and "post".
  assert.throws(() => parseWeiboUrl('https://weibo.com/1234567890'), /无法判断|用户主页/)
})

test('规范链接与 threadId 在任何输入下都指向同一条微博', () => {
  // The property that matters downstream: whatever url we store, opening it lands on
  // the post whose id we stored.
  for (const input of ROUND_TRIP) {
    const ref = parseWeiboUrl(input)
    const canonicalMid = ref.url.includes('/detail/')
      ? ref.url.split('/detail/')[1]
      : toNumericMid(ref.url.split('/').pop()!)
    assert.equal(canonicalMid, ref.threadId, `${input} 的规范链接应指向 ${ref.threadId}`)
  }
})
