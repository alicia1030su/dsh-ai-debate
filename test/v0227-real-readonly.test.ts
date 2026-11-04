/**
 * Real-world read-only verification (v0.2.27 §六), and the honesty boundary that matters most.
 *
 * ## What can and cannot be done in this environment
 *
 * Tested at build time: a plain HTTPS GET to `tieba.baidu.com` from this machine returns
 * **HTTP 403 with the body 「百度安全验证」**. That is the platform's access control, and the
 * task book is explicit that it must be respected — no CAPTCHA solving, no UA juggling to
 * defeat the gate, no pretending the read succeeded.
 *
 * So this file does the two things that are both legitimate and useful:
 *
 * 1. **The real 403 body is a fixture** (`test/fixtures/real/challenge-403.html`, captured
 *    from the actual response). Every assertion about "a challenge is not an empty thread"
 *    runs against bytes the platform really sent, not against a paragraph someone wrote to
 *    make the test pass.
 * 2. **The real captured pages** from v0.1.3 (`wap-page1.html`, `wap-page2.html`,
 *    `comment-page1.html`) are re-parsed, so a change that breaks the parser against real
 *    markup fails here rather than in a user's session.
 *
 * What is **not** verified: a live read of a public thread today. That is recorded in the
 * delivery report as an unmet item, because saying otherwise would be the exact dishonesty
 * this project exists to remove.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseCommentPage, parseWapFloors, parseWapPageMeta } from '../lib/platforms/tieba/parse.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const REAL = join(FIXTURES, 'real')

/** The bytes the platform actually returned for an unauthenticated request. */
const challenge = readFileSync(join(REAL, 'challenge-403.html'), 'utf8')

test('真实的 403 响应被识别为安全验证，不是「帖子不存在」', () => {
  // This is the distinction the product must never blur. "Blocked by anti-bot" and "this
  // thread has no content" lead to opposite decisions: the first means try later or log in,
  // the second means tell the owner the thread is gone.
  assert.match(challenge, /百度安全验证/, '夹具必须是真实的安全验证页；若不是，这个测试就失去意义')

  // Parsing must not throw on a challenge page: a throw is reported as "the program broke",
  // which is a different and more alarming statement than "the platform refused".
  const meta = parseWapPageMeta(challenge)
  const floors = parseWapFloors(challenge)
  assert.equal(floors.length, 0, '验证页里没有任何楼层，这是事实')
  assert.equal(meta.totalPages, undefined, '验证页不含分页元信息——所以它不能被当成「只有一页」')
})

test('真实的验证页与真贴的「零楼层」在数据上可区分', () => {
  // A challenge page yields zero floors. Zero floors is also what a deleted thread yields.
  // They are told apart by the challenge marker plus the HTTP status, not by the count — so
  // the marker has to survive into whatever the caller sees.
  const realPage = readFileSync(join(FIXTURES, 'wap-page1.html'), 'utf8')
  assert.equal(parseWapFloors(challenge).length, 0)
  assert.ok(parseWapFloors(realPage).length > 0, '真帖必须解析出楼层')
  assert.match(challenge, /百度安全验证/)
  assert.doesNotMatch(realPage, /百度安全验证/, '真帖里不该出现验证标记')
})

test('真实 WAP 页面仍能解析出楼层与分页元信息', () => {
  const html = readFileSync(join(FIXTURES, 'wap-page1.html'), 'utf8')
  const parsed = parseWapFloors(html)
  assert.ok(parsed.length > 0, `真实页面应解析出楼层，实际 ${parsed.length}`)
  for (const entry of parsed.slice(0, 5)) {
    assert.ok(entry.floor.postId !== '', '楼层必须有 postId')
    assert.ok(entry.floor.authorName !== '', `楼层 ${entry.floor.postId} 必须有作者名`)
    assert.equal(typeof entry.floor.content, 'string')
  }
  const meta = parseWapPageMeta(html)
  assert.ok((meta.totalPages ?? 0) > 1, `真实的第一页应带分页总数，实际 ${JSON.stringify(meta)}`)
  assert.ok((meta.totalCount ?? 0) > parsed.length, '平台声明的总数应大于一页的楼层数')
})

test('真实楼中楼页面仍能解析出回复与其父级', () => {
  const html = readFileSync(join(FIXTURES, 'comment-page1.html'), 'utf8')
  // The parent floor id is a caller-supplied fact, not something the comment page contains:
  // `/p/comment?pid=<floor>` is the floor you asked about.
  const page = parseCommentPage(html, '133529333135')
  assert.ok(page.replies.length > 0, `真实楼中楼页应解析出回复，实际 ${page.replies.length}`)
  for (const entry of page.replies.slice(0, 5)) {
    assert.ok(entry.reply.postId !== '', '回复必须有 postId')
    assert.ok(entry.reply.parentPostId !== '', '回复必须带上父楼层')
    assert.ok(entry.reply.authorName !== '', '回复必须有作者名')
  }
})

test('真实页面的作者字段里，登录名与数字 id 不会互相冒充', () => {
  // v0.2.23's whole point: the WAP floor surfaces `username` (a handle) while `totalComment`
  // publishes numeric `user_id`s. A parser that filled one from the other would make two
  // different people look like one account.
  const html = readFileSync(join(FIXTURES, 'wap-page1.html'), 'utf8')
  for (const entry of parseWapFloors(html)) {
    const floor = entry.floor
    if (floor.authorNumericUid === undefined) continue
    assert.notEqual(
      floor.authorNumericUid,
      floor.authorName,
      `楼层 ${floor.postId} 把昵称当成了数字 id`,
    )
  }
})

test('分页元信息声称的总数与实际读到的楼层是两件事', () => {
  const page1 = readFileSync(join(FIXTURES, 'wap-page1.html'), 'utf8')
  const page2 = readFileSync(join(FIXTURES, 'wap-page2.html'), 'utf8')
  const floors1 = parseWapFloors(page1)
  const floors2 = parseWapFloors(page2)
  // Two real pages of the same thread: their post ids must not overlap, or de-duplication is
  // hiding a pagination bug instead of fixing one.
  const ids1 = new Set(floors1.map((e) => e.floor.postId))
  const overlap = floors2.filter((e) => ids1.has(e.floor.postId))
  assert.deepEqual(overlap.map((e) => e.floor.postId), [], '两页之间不应有重复楼层')
  assert.ok(floors1.length > 0 && floors2.length > 0, '两页都应解析出楼层')
})
