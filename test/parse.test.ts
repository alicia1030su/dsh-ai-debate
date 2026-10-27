/**
 * Parser tests, pinned to real captured markup.
 *
 * Every assertion here is against bytes the live site actually returned. A
 * parser test written against self-invented HTML only proves the regex matches
 * itself; these prove the parser matches Tieba.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeEntities,
  parseCommentPage,
  parseInlineNested,
  parseTbs,
  parseTotalComment,
  parseWapFloors,
  parseWapPageMeta,
  parseWapThreadMeta,
  toPlainText,
} from '../lib/platforms/tieba/parse.js'
import { fixture, fixtureBytes, pagedPage } from './helpers.ts'

test('WAP page metadata is read from the embedded page object', () => {
  const meta = parseWapPageMeta(pagedPage(1))
  assert.equal(meta.currentPage, 1)
  assert.equal(meta.totalPages, 8)
  assert.equal(meta.totalCount, 240)
  assert.equal(meta.pageSize, 30)
})

test('thread metadata exposes forum id, name and CSRF token', () => {
  const meta = parseWapThreadMeta(pagedPage(1))
  assert.equal(meta.forumId, '24342155')
  assert.equal(meta.forumName, '似水蓝蝶')
  assert.match(meta.tbs ?? '', /^[0-9a-f]{16,}$/)
})

test('a thread with no title reports an empty title, never invented text', () => {
  // This real thread genuinely has no title on its first post.
  const meta = parseWapThreadMeta(pagedPage(1))
  assert.equal(meta.title, '')
})

test('a thread that does have a title reports it verbatim', () => {
  const meta = parseWapThreadMeta(fixture('wap-small.html'))
  assert.equal(meta.title, '有谁知道百度贴吧怎么复制自己主页链接？')
})

test('every first-level floor is parsed with author, floor number and body', () => {
  const floors = parseWapFloors(pagedPage(1))
  assert.equal(floors.length, 29)

  const first = floors[0]!.floor
  assert.equal(first.floorNumber, 1)
  assert.equal(first.postId, '133529333135')
  assert.equal(first.authorName, '似水蓝蝶')
  assert.equal(first.authorId, '似水蓝蝶')
  assert.equal(first.createdAt, '2020-7-20')
  assert.match(first.content, /贴吧更新后在帖子底下如何正确发链接/)
  assert.equal(first.images.length, 2)
})

test('floor bodies never leak nested markup into the text', () => {
  for (const page of [1, 2, 3]) {
    for (const entry of parseWapFloors(pagedPage(page))) {
      assert.ok(
        !entry.floor.content.includes('<div'),
        `第 ${entry.floor.floorNumber} 楼的正文里混进了 HTML：${entry.floor.content.slice(0, 80)}`,
      )
      assert.ok(
        !entry.floor.content.includes('fr_list'),
        `第 ${entry.floor.floorNumber} 楼的正文里混进了楼中楼面板：${entry.floor.content.slice(0, 80)}`,
      )
    }
  }
})

test('floor order follows the platform display order and floors are unique', () => {
  const floors = parseWapFloors(pagedPage(1)).map((entry) => entry.floor)
  const ids = new Set(floors.map((floor) => floor.postId))
  assert.equal(ids.size, floors.length, '同一页里出现了重复楼层')
  const numbers = floors.map((floor) => floor.floorNumber)
  const sorted = [...numbers].sort((a, b) => a - b)
  assert.deepEqual(numbers, sorted, '楼层顺序不是升序')
})

test('nested reply counter is read from the floor panel', () => {
  // data-list-count is 9 for the busiest floor on page 1.
  const floors = parseWapFloors(pagedPage(1)).map((entry) => entry.floor)
  const counts = floors.map((floor) => floor.nestedCount ?? 0).filter((count) => count > 0)
  assert.ok(counts.length > 0, '第一页应该有带楼中楼的楼层')
  assert.ok(counts.includes(9), `应该出现 9 条楼中楼的楼层，实际：${counts.join(',')}`)
})

test('nested replies are parsed with author and reply target separated', () => {
  const html = fixture('comment-page1.html')
  const parsed = parseCommentPage(html, '150691525747')

  assert.equal(parsed.total, 10)
  assert.equal(parsed.totalPages, 1)
  assert.equal(parsed.replies.length, 10)

  const direct = parsed.replies[0]!.reply
  assert.equal(direct.postId, '150709372452')
  assert.equal(direct.authorName, '夜引星（afd同名')
  // The first reply has no 回复 prefix, so it answers the floor itself.
  assert.equal(direct.replyToName, undefined)
  assert.equal(direct.relationUncertain, false)

  const answering = parsed.replies[1]!.reply
  assert.equal(answering.replyToName, '夜引星（afd同名')
  assert.equal(answering.relationUncertain, false)
  assert.match(answering.content, /不要在百度贴吧上复制链接/)
})

test('the reply author is never mistaken for the reply target', () => {
  // Regression: the lead anchor before the body names the author, and using it
  // as the target made every conversation look like self-replies.
  const parsed = parseCommentPage(fixture('comment-page1.html'), 'floor-1')
  for (const entry of parsed.replies.slice(1)) {
    assert.notEqual(
      entry.reply.replyToName,
      undefined,
      '带「回复 X」前缀的楼中楼必须解析出回复对象',
    )
  }
  for (const entry of parsed.replies) {
    // A reply that names itself as the target would be the old bug.
    assert.ok(
      !(entry.reply.replyToName && entry.reply.replyToName === entry.reply.authorName && /^\s*回复/.test(entry.reply.content) === false),
      '回复对象不应等于作者本身',
    )
  }
})

test('totalComment exposes numeric user ids that the HTML does not', () => {
  const parsed = parseTotalComment(fixture('total-comment.json'))
  assert.ok(parsed.entries.length > 0)
  const withIds = parsed.entries
    .flatMap((entry) => entry.inline)
    .filter((inline) => inline.authorId && /^\d+$/.test(inline.authorId))
  assert.ok(withIds.length > 0, 'totalComment 应该提供数字 user_id')
  assert.ok(parsed.userNames.size > 0, '应该解析出用户名映射')
})

test('totalComment maps numeric ids onto display names', () => {
  const parsed = parseTotalComment(fixture('total-comment.json'))
  for (const entry of parsed.entries) {
    for (const inline of entry.inline) {
      if (inline.authorId && parsed.userNames.has(inline.authorId)) {
        assert.equal(inline.authorName, parsed.userNames.get(inline.authorId))
      }
    }
  }
})

test('a malformed totalComment body yields an empty result, not a throw', () => {
  const parsed = parseTotalComment('not json at all')
  assert.deepEqual(parsed.entries, [])
  assert.equal(parsed.userNames.size, 0)
})

test('an errno response from totalComment is treated as empty', () => {
  const parsed = parseTotalComment(JSON.stringify({ errno: 1, errmsg: 'nope' }))
  assert.deepEqual(parsed.entries, [])
})

test('entities decode including numeric and hex forms', () => {
  assert.equal(decodeEntities('&quot;a&quot; &amp; &#39;b&#39; &#x4e2d;'), `"a" & 'b' 中`)
  // A malformed code point must not throw.
  assert.equal(decodeEntities('&#999999999;x'), 'x')
})

test('toPlainText turns breaks into newlines and strips tags', () => {
  const text = toPlainText('第一行<br>第二行<br/>第三行<b>粗</b>')
  assert.equal(text, '第一行\n第二行\n第三行粗')
})

test('tbs is found from the mobile page', () => {
  assert.match(parseTbs(pagedPage(1)) ?? '', /^[0-9a-f]+$/i)
})

test('tbs extraction tolerates pages without a token', () => {
  assert.equal(parseTbs('<html><body>nothing here</body></html>'), undefined)
})

test('the comment page is valid UTF-8, not GBK', () => {
  // Tieba's /p/comment answers in UTF-8 in the current build. Decoding it as
  // GBK produced mojibake that then reached the model, so this is pinned.
  const bytes = fixtureBytes('comment-page1.html.bytes')
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  assert.match(decoded, /lzl_content_main/)
  assert.match(decoded, /你好|回复/)
  assert.ok(!decoded.includes('\ufffd'), '不应出现替换字符')

  // Decoding the same bytes as GBK must NOT be what we ship: prove the two
  // differ where Chinese actually appears, so a future regression to the wrong
  // decoder fails loudly.
  const asGbk = new TextDecoder('gb18030').decode(bytes)
  const pick = (text: string): string => text.slice(text.indexOf('你好'), text.indexOf('你好') + 40)
  assert.ok(decoded.includes('你好'))
  assert.notEqual(pick(asGbk), pick(decoded))
})

test('inline nested replies are parsed from a real floor page, with the reply target', () => {
  // The WAP page inlines a subset of a floor's replies. Verified live: the page
  // rendered the reply target as a "回复 X：" prefix and the author as the
  // `user_name` anchor. The anchor names the author, never the target — getting
  // those two backwards would attribute every reply to the wrong person.
  const html = pagedPage(1)
  const floors = parseWapFloors(html)
  const withInline = floors.filter((entry) => (entry.floor.inlineNested?.length ?? 0) > 0)
  assert.equal(withInline.length, 7, 'the captured page inlines replies under seven floors')

  const total = withInline.reduce((sum, entry) => sum + (entry.floor.inlineNested?.length ?? 0), 0)
  assert.equal(total, 13, 'the captured first page inlines thirteen nested replies')

  for (const entry of withInline) {
    for (const nested of entry.floor.inlineNested ?? []) {
      assert.equal(nested.parentPostId, entry.floor.postId)
      assert.ok(nested.postId.length > 0)
      assert.ok(nested.authorName, 'every inline reply names its author')
      assert.ok(nested.content.length > 0)
      // A target, when present, came from a name-shaped prefix, so it is
      // explicitly marked as an uncertain relation rather than a real post id.
      if (nested.replyToName) assert.equal(nested.relationUncertain, true)
    }
  }

  // Floor 5's second reply is a real reply-to: author Ftkxmt answered Da大魔王,
  // and the target must be read from the "回复 …：" prefix, not from the anchor.
  const floor5 = withInline.find((entry) => entry.floor.floorNumber === 5)!
  assert.equal(floor5.floor.nestedCount, 9)
  const second = floor5.floor.inlineNested![1]!
  assert.equal(second.authorName, 'Ftkxmt')
  assert.ok(second.replyToName?.startsWith('Da大魔王'), `expected Da大魔王 as target, got ${second.replyToName}`)
  assert.ok(!second.content.startsWith('回复'), 'the prefix is stripped from the body')

  // The owner's own reply under a floor is present and attributed to them.
  const ownerReply = withInline
    .flatMap((entry) => entry.floor.inlineNested ?? [])
    .find((nested) => nested.authorName === '似水蓝蝶')
  assert.ok(ownerReply, 'the owner reply inlined on page 1 must be parsed')
})

test('inline nested parsing never invents replies for a floor with no panel', () => {
  assert.deepEqual(parseInlineNested('<li tid="1">no panel here</li>', '1'), [])
})
