/**
 * v0.2.7 §六：微博 URL 解析与 id 规范化。
 *
 * 这一层不联网、不持凭据、不编造接口——它只回答「这个链接是不是微博、是哪一条」。
 * 之所以值得单独测：mid 读错成 uid、或者拿 base62 的显示 id 去比 numeric mid，
 * 都会安静地指向另一条微博，而错的方向直到发表才会暴露。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseWeiboUrl,
  toBase62,
  toNumericMid,
  weiboCanHandleUrl,
} from '../lib/platforms/weibo/url.js'

test('能识别微博链接，不能识别别的平台', () => {
  const should = [
    'https://weibo.com/1234567890/AbCdEf123',
    'weibo.com/1234567890/AbCdEf123',
    'https://m.weibo.cn/detail/5012345678901234',
    'https://m.weibo.cn/status/5012345678901234',
    'https://weibo.cn/status/5012345678901234',
  ]
  for (const url of should) assert.equal(weiboCanHandleUrl(url), true, `应识别：${url}`)

  const shouldNot = [
    'https://tieba.baidu.com/p/123',
    'https://www.zhihu.com/question/1',
    '刚才那个链接呢',
    '',
    'not a url at all',
  ]
  for (const url of shouldNot) assert.equal(weiboCanHandleUrl(url), false, `不应识别：${url}`)
})

test('canHandleUrl 对垃圾输入不抛错（它会被问任意文本）', () => {
  for (const junk of ['', ' ', '://', 'http://', 'https://[', 'weibo.com:abc', null as never]) {
    assert.doesNotThrow(() => weiboCanHandleUrl(junk))
  }
})

test('桌面版带 uid 的链接：uid 与 mid 分开取，threadId 是 numeric mid', () => {
  // The base62 id here decodes to a specific number; assert the contract, not a
  // memorised constant, by round-tripping it.
  const ref = parseWeiboUrl('https://weibo.com/1234567890/AbCdEf123')
  assert.equal(ref.platform, 'weibo')
  assert.equal(ref.uid, '1234567890')
  assert.equal(ref.rawId, 'AbCdEf123')
  assert.match(ref.threadId, /^\d+$/, 'threadId 必须是 numeric mid')
  assert.equal(ref.threadId, toNumericMid('AbCdEf123'))
  assert.match(ref.url, /^https:\/\/weibo\.com\/1234567890\/\d+$/)
})

test('移动版 detail / status：numeric mid 原样作为 threadId', () => {
  for (const url of ['https://m.weibo.cn/detail/5012345678901234', 'https://m.weibo.cn/status/5012345678901234']) {
    const ref = parseWeiboUrl(url)
    assert.equal(ref.threadId, '5012345678901234')
    assert.equal(ref.uid, undefined, '移动版链接不带 uid，不能编一个')
  }
})

test('query 形式 statuses/show?id=… 也能解析', () => {
  const ref = parseWeiboUrl('https://m.weibo.cn/statuses/show?id=5012345678901234')
  assert.equal(ref.threadId, '5012345678901234')
})

test('裸 base62 mid 的短链接可解析；纯数字短段不被当帖子', () => {
  const ref = parseWeiboUrl('https://weibo.com/AbCdEf123')
  assert.equal(ref.threadId, toNumericMid('AbCdEf123'))

  // A profile link has no post id and must be refused rather than guessed.
  assert.throws(() => parseWeiboUrl('https://weibo.com/u/1234567890'), /没有帖子 id/)
})

test('没有帖子 id 的链接必须抛错，不返回猜的 id', () => {
  for (const url of [
    'https://weibo.com/',
    'https://m.weibo.cn/',
    'https://weibo.com/u/1234567890',
    'https://m.weibo.cn/profile/1234',
  ]) {
    assert.throws(() => parseWeiboUrl(url), /没有帖子 id|无法把/, `应拒绝：${url}`)
  }
})

test('非微博链接：抛错，明确说不是微博', () => {
  assert.throws(() => parseWeiboUrl('https://tieba.baidu.com/p/123'), /不是可以识别的微博链接/)
})

test('base62 ↔ numeric mid 来回转换稳定', () => {
  // Round-trip property rather than a table of remembered constants: the encoding is
  // the contract, and a wrong chunk order still round-trips. So also pin one known
  // direction — the numeric value of a 4-character chunk is its base-62 value.
  for (const mid of ['5012345678901234', '123456789', '1', '999999999999999999']) {
    const encoded = toBase62(mid)
    assert.ok(encoded !== undefined, `应能编码 ${mid}`)
    assert.equal(toNumericMid(encoded!), mid, `${mid} → ${encoded} → 应回到 ${mid}`)
  }
  // 'AbCd' as one chunk: A=36, b=11, C=38, d=13 in the Weibo alphabet.
  assert.equal(toNumericMid('AbCd'), String(36 * 62 ** 3 + 11 * 62 ** 2 + 38 * 62 + 13))
})

test('非法 id：返回 undefined，不抛也不猜', () => {
  for (const bad of ['', '   ', 'abc-def', 'a b', '中文']) {
    assert.equal(toNumericMid(bad), undefined, `不应接受 ${JSON.stringify(bad)}`)
  }
  assert.equal(toBase62('12a4'), undefined)
})

test('同一微博的两种写法归一化到同一个 threadId', () => {
  // This is the whole point of the module: the base62 display id and the numeric mid
  // must not look like two different posts.
  const base62 = 'AbCdEf123'
  const numeric = toNumericMid(base62)!
  const fromDesktop = parseWeiboUrl(`https://weibo.com/1234567890/${base62}`)
  const fromMobile = parseWeiboUrl(`https://m.weibo.cn/detail/${numeric}`)
  assert.equal(fromDesktop.threadId, fromMobile.threadId)
})
