/**
 * Collection and pagination tests.
 *
 * Tests 1 and 2 of the acceptance list: a normal thread reads correctly, and a
 * thread with more floors than one page reads **every** page without duplicating
 * or skipping floors. The 8 real captured pages back the second one, and a
 * synthetic 500-floor thread covers the "hundreds of floors" requirement without
 * hammering the live site.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertCollected, buildTimeline, collectThread, findInTimeline, walkFloors } from '../lib/collector.js'
import { parseWapFloors, parseWapPageMeta } from '../lib/platforms/tieba/parse.js'
import { FakeAdapter, largeThread, pagedMeta, pagedPage, realThread, threePartyThread } from './helpers.ts'

test('test 1: a normal thread exposes title, body, floor order and authors', async () => {
  const data = realThread()
  const adapter = new FakeAdapter({ thread: data.thread, floors: data.floors })
  const collected = await collectThread(
    adapter,
    { platform: 'tieba', threadId: data.thread.id, url: data.thread.url },
    { wantNested: () => false },
  )

  assert.equal(collected.thread.forum.name, '似水蓝蝶')
  assert.equal(collected.thread.id, pagedMeta().tid)
  assert.match(collected.thread.content, /如何正确发链接/)

  for (let index = 1; index < collected.floors.length; index += 1) {
    const previous = collected.floors[index - 1]!.floor.floorNumber
    const current = collected.floors[index]!.floor.floorNumber
    assert.ok(current > previous, `楼层顺序必须是升序：${previous} → ${current}`)
  }
  const named = collected.floors.filter((entry) => entry.floor.authorName)
  assert.equal(named.length, collected.floors.length, '每一楼都应该有作者名')
})

test('test 2: a 240-floor thread across 8 real pages is fully read without duplicates', async () => {
  // Rebuild the adapter's pages from the real captured HTML, page by page.
  const meta = pagedMeta()
  const pages = new Map<number, ReturnType<typeof parseWapFloors>>()
  for (let page = 1; page <= meta.totalPages; page += 1) {
    pages.set(page, parseWapFloors(pagedPage(page)))
  }

  const allFloors = [...pages.values()].flat().map((entry) => entry.floor)
  const firstPageMeta = parseWapPageMeta(pagedPage(1))
  assert.equal(firstPageMeta.totalPages, 8)
  assert.equal(firstPageMeta.totalCount, 240)

  const adapter = new FakeAdapter({
    thread: realThread().thread,
    floors: allFloors,
    declaredTotal: 240,
  })
  const collected = await collectThread(
    adapter,
    { platform: 'tieba', threadId: meta.tid, url: `https://tieba.baidu.com/p/${meta.tid}` },
    // This fixture carries floors only; nested replies have their own tests.
    // Passing the option in the third argument is the point: an option passed in
    // the ref position is silently ignored, which is what the typecheck guards.
    { wantNested: () => false },
  )

  // Pagination really happened: 8 pages, not just the first.
  assert.equal(adapter.pagesRead, 8, `应该读取 8 页，实际读了 ${adapter.pagesRead} 页`)
  assert.ok(collected.floors.length > 200, `应该读到 200 楼以上，实际 ${collected.floors.length} 楼`)

  // No duplicates anywhere across pages.
  const ids = collected.floors.map((entry) => entry.floor.postId)
  assert.equal(new Set(ids).size, ids.length, '跨页出现了重复楼层')

  // No duplicates by floor number either.
  const numbers = collected.floors.map((entry) => entry.floor.floorNumber)
  assert.equal(new Set(numbers).size, numbers.length, '跨页出现了重复楼层号')

  // The platform claims 240 but only 219 are readable; the gap is reported,
  // never papered over.
  assert.equal(collected.complete, false)
  assert.ok(collected.missingCount !== undefined && collected.missingCount > 0)
  assert.ok(
    collected.issues.some((issue) => issue.includes('缺少')),
    `应该如实报告缺失楼层，实际 issues：${collected.issues.join(' | ')}`,
  )
  assert.equal(
    collected.floors.length + (collected.missingCount ?? 0),
    240,
    '可读楼层数 + 缺失数 应该等于平台声明数',
  )
})

test('test 2b: a synthetic 500-floor thread reads all 17 pages', async () => {
  const data = largeThread(500)
  const adapter = new FakeAdapter({ thread: data.thread, floors: data.floors })
  const collected = await collectThread(
    adapter,
    { platform: 'tieba', threadId: data.thread.id, url: data.thread.url },
    { wantNested: () => false },
  )

  assert.equal(collected.floors.length, 500)
  assert.equal(adapter.pagesRead, 17, `500 楼需要 17 页，实际 ${adapter.pagesRead}`)
  assert.equal(collected.complete, true)
  // First and last floors must both be present: no silent truncation.
  assert.equal(collected.floors[0]!.floor.floorNumber, 1)
  assert.equal(collected.floors[499]!.floor.floorNumber, 500)
})

test('a page failure keeps what was already collected and says what broke', async () => {
  const data = largeThread(200)
  const adapter = new FakeAdapter({
    thread: data.thread,
    floors: data.floors,
    failAtPage: 3,
  })
  const collected = await collectThread(
    adapter,
    { platform: 'tieba', threadId: data.thread.id, url: data.thread.url },
    { wantNested: () => false },
  )

  assert.equal(collected.complete, false)
  assert.ok(collected.floors.length >= 60, '前两页的 60 楼必须保留')
  assert.ok(
    collected.issues.some((issue) => issue.includes('中断')),
    `应该报告读取中断：${collected.issues.join(' | ')}`,
  )
})

test('maxFloors truncates deliberately and records the truncation', async () => {
  const data = largeThread(120)
  const adapter = new FakeAdapter({ thread: data.thread, floors: data.floors })
  const collected = await collectThread(
    adapter,
    { platform: 'tieba', threadId: data.thread.id, url: data.thread.url },
    { maxFloors: 50, wantNested: () => false },
  )
  assert.equal(collected.floors.length, 50)
  assert.ok(
    collected.issues.some((issue) => issue.includes('上限')),
    `应该记录截断：${collected.issues.join(' | ')}`,
  )
})

test('nested replies are fetched only for floors that have them', async () => {
  const data = threePartyThread()
  const adapter = new FakeAdapter(data)
  const collected = await collectThread(adapter, {
    platform: 'tieba',
    threadId: data.thread.id,
    url: data.thread.url,
  })
  const floor = collected.floors[0]!
  assert.equal(floor.nested.length, 7)
  assert.equal(floor.nestedComplete, true)
})

test('an empty thread is rejected instead of silently producing nothing', async () => {
  const adapter = new FakeAdapter({
    thread: {
      platform: 'tieba',
      forum: { platform: 'tieba', name: '空吧' },
      id: '1',
      title: '',
      content: '',
      url: '',
      images: [],
    },
    floors: [],
  })
  const collected = await collectThread(adapter, { platform: 'tieba', threadId: '1', url: '' })
  assert.throws(() => assertCollected(collected), /没有读取到任何楼层/)
})

test('the timeline interleaves floors and their nested replies in order', () => {
  const data = threePartyThread()
  const collected = {
    thread: data.thread,
    floors: data.floors.map((floor) => ({
      floor,
      nested: data.nested[floor.postId] ?? [],
      nestedComplete: true,
    })),
    complete: true,
    issues: [],
  }
  const timeline = buildTimeline(collected)
  assert.equal(timeline[0]!.kind, 'floor')
  assert.equal(timeline[1]!.kind, 'nested')
  assert.equal(timeline[1]!.postId, 'n1')
  assert.equal(timeline[7]!.postId, 'n7')
  assert.equal(findInTimeline(timeline, 'n4')?.authorName, '主人')
})

test('a degraded nested source is reported as incomplete, never as a full read', async () => {
  // Measured live: when the paginated nested endpoint is rate-limited the floor
  // page still inlines a subset. Reading that subset must not be reported as the
  // complete set of replies.
  const data = realThread()
  const withNested = data.floors.filter((floor) => (floor.nestedCount ?? 0) > 0).slice(0, 1)
  assert.ok(withNested.length > 0, 'fixture must contain a floor with nested replies')
  const target = withNested[0]!

  const adapter = new FakeAdapter({
    thread: data.thread,
    floors: data.floors,
    nested: {
      [target.postId]: [
        { platform: 'tieba', postId: 'n1', parentPostId: target.postId, authorName: '甲', content: '第一次回复' },
        { platform: 'tieba', postId: 'n2', parentPostId: target.postId, authorName: '乙', content: '第二次回复' },
      ],
    },
    nestedDegraded: true,
  })

  const collected = await collectThread(adapter, { platform: 'tieba', threadId: data.thread.tid })
  const floor = collected.floors.find((entry) => entry.floor.postId === target.postId)
  assert.ok(floor, 'the target floor must be collected')
  assert.equal(floor.nested.length, 2, 'the inlined replies are still kept')
  assert.equal(floor.nestedComplete, false, 'a degraded source is never complete')
  assert.ok(
    collected.issues.some((issue) => issue.includes('限流') || issue.includes('不完整')),
    `expected an explicit incompleteness issue, got: ${collected.issues.join(' | ')}`,
  )
})

test('a fully readable nested source is still reported as complete', async () => {
  // The control for the test above: degrade detection must not flag healthy reads.
  // Completeness is measured against the platform's own counter, so the fixture's
  // declared count must match what the fake actually returns.
  const data = realThread()
  const seen = data.floors.find((floor) => (floor.nestedCount ?? 0) > 0)!
  const target = { ...seen, nestedCount: 1 }
  const adapter = new FakeAdapter({
    thread: data.thread,
    floors: data.floors.map((floor) => (floor.postId === target.postId ? target : floor)),
    nested: {
      [target.postId]: [
        { platform: 'tieba', postId: 'n1', parentPostId: target.postId, authorName: '甲', content: '回复一' },
      ],
    },
  })
  const collected = await collectThread(adapter, { platform: 'tieba', threadId: data.thread.tid })
  const floor = collected.floors.find((entry) => entry.floor.postId === target.postId)!
  assert.equal(floor.nested.length, 1)
  assert.equal(floor.nestedComplete, true)
})

test('hitting the page cap is reported as an incomplete read, not as the last page', async () => {
  // The distinction matters: "platform says that was the last page" and "I
  // stopped myself at page 2" produce the same short list but mean different
  // things about whether the data can be trusted.
  const data = largeThread(500)
  const adapter = new FakeAdapter({ thread: data.thread, floors: data.floors })

  const capped = await walkFloors(adapter, { platform: 'tieba', threadId: data.thread.tid }, { maxPages: 2 })
  assert.equal(capped.pagesRead, 2)
  assert.equal(capped.stopReason, 'page_cap')
  assert.equal(capped.truncated, true, 'the walk must know more pages remained')
  assert.equal(capped.complete, false, 'a capped walk is never a complete read')

  // The control: the same thread read to the end is complete and says why.
  const full = await walkFloors(adapter, { platform: 'tieba', threadId: data.thread.tid }, { maxPages: 60 })
  assert.equal(full.stopReason, 'last_page')
  assert.equal(full.truncated, false)
  assert.equal(full.complete, true)
})

test('a capped thread read tells the user it is truncated', async () => {
  const data = largeThread(500)
  const adapter = new FakeAdapter({ thread: data.thread, floors: data.floors })
  const collected = await collectThread(adapter, { platform: 'tieba', threadId: data.thread.tid }, { maxPages: 2 })

  assert.equal(collected.truncated, true)
  assert.equal(collected.stopReason, 'page_cap')
  assert.ok(
    collected.issues.some((issue) => issue.includes('分页上限') && issue.includes('不是完整结果')),
    `expected an explicit truncation notice, got: ${collected.issues.join(' | ')}`,
  )
})

test('an unread floor with declared replies marks the nested context incomplete', async () => {
  // Requirement: nested replies that were deliberately skipped must not make the
  // overall context look complete, because the argument may live in them.
  const data = realThread()
  const adapter = new FakeAdapter({ thread: data.thread, floors: data.floors })
  const collected = await collectThread(
    adapter,
    { platform: 'tieba', threadId: data.thread.tid },
    { nestedFloorLimit: 0 },
  )

  const hasDeclaredNested = collected.floors.some((entry) => (entry.floor.nestedCount ?? 0) > 0)
  assert.equal(hasDeclaredNested, true, 'fixture must contain a floor with declared nested replies')
  assert.equal(collected.nestedIncomplete, true, 'skipping nested reads must be visible')
  const skipped = collected.floors.filter((entry) => (entry.floor.nestedCount ?? 0) > 0)
  assert.ok(
    skipped.every((entry) => entry.nestedComplete === false),
    'a skipped floor with declared replies is not complete',
  )
})
