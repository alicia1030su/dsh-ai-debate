/**
 * A declared source outranks the shape of the value.
 *
 * ## P1 under test
 *
 * `isAccountHandle` decided whether `authorId` carried an account identity by
 * looking at the string: numeric-looking, or different from the display name. Both
 * are guesses. On Tieba a login name (`un`) is frequently *identical* to the
 * nickname — 4 of the 29 floors in the shipped capture are exactly that — so the
 * heuristic threw away a real identity on 14% of rows.
 *
 * The fix is not a better guess. A surface that declares `authorSource` is stating
 * what its author field means: `wap_floor` and `wap_inline` publish the `un`. When
 * the provenance is known, the value is a handle whatever it looks like, and when
 * it is unknown the row stays a legacy record rather than being promoted.
 *
 * ## What must not change
 *
 * - a row with no source is still legacy: readable, never verified;
 * - a nickname-only row (no `authorId` at all) never becomes a handle;
 * - two accounts sharing a nickname stay separate;
 * - one account changing its nickname keeps its identity key.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { analyzeDispute, describeParticipants, resolveKey } from '../lib/analyzer.js'
import { buildTimeline } from '../lib/collector.js'
import { parseWapFloors } from '../lib/platforms/tieba/parse.js'
import type { CollectedThread } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const THREAD_ID = '8752343543'
const FLOOR_POST_ID = '133529333135'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
  id: THREAD_ID,
  title: '登录名等于昵称',
  content: '开场',
  authorId: 'host_un',
  authorName: '楼主甲',
  authorSource: 'wap_floor',
  url: `https://tieba.baidu.com/p/${THREAD_ID}`,
  images: [],
}

const FLOOR: Floor = {
  platform: 'tieba',
  floorNumber: 1,
  postId: FLOOR_POST_ID,
  authorId: 'host_un',
  authorName: '楼主甲',
  authorSource: 'wap_floor',
  content: '开场',
  images: [],
  nestedCount: 0,
}

/** A nested reply where the login name and the nickname are the same string. */
function sameNameReply(input: {
  postId: string
  handle: string
  source?: 'wap_inline'
  content: string
}): NestedReply {
  return {
    platform: 'tieba',
    postId: input.postId,
    parentPostId: FLOOR_POST_ID,
    authorId: input.handle,
    authorName: input.handle,
    ...(input.source === undefined ? {} : { authorSource: input.source }),
    content: input.content,
    relationUncertain: false,
  } as unknown as NestedReply
}

function collected(nested: readonly NestedReply[]): CollectedThread {
  return {
    thread: THREAD,
    floors: [
      { floor: { ...FLOOR, nestedCount: nested.length }, nested: [...nested], nestedComplete: true },
    ],
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
  } as unknown as CollectedThread
}

// ── the reproduction ───────────────────────────────────────────────────────

test('P1 复现：真实 WAP 夹具里有 4 层 un 恰好等于昵称', () => {
  // Measured, not assumed: this is the frequency that made the heuristic worth fixing
  // rather than dismissing as a corner case.
  const parsed = parseWapFloors(readFileSync(join(FIXTURES, 'wap-page1.html'), 'utf8'))
  const identical = parsed.filter((entry) => entry.floor.authorId === entry.floor.authorName)
  assert.equal(parsed.length, 29)
  assert.equal(identical.length, 4, '夹具中 un === 昵称 的层数')
})

test('P1 复现：声明了来源时，un 等于昵称仍然是 handle', () => {
  const data = collected([
    sameNameReply({ postId: 'r1', handle: '似水蓝蝶', source: 'wap_inline', content: '我的看法。' }),
  ])
  const timeline = buildTimeline(data)
  // The key must be an identity, not a display name: `handle:` proves the field was
  // accepted as the login name.
  const key = resolveKey(timeline.find((entry) => entry.postId === 'r1')!, new Map())
  assert.match(key, /^handle:/, `声明来源后应是 handle 键，实际 ${key}`)
})

test('P1 复现：没有来源的旧记录不得升级为 handle 身份', () => {
  const data = collected([
    sameNameReply({ postId: 'r1', handle: '似水蓝蝶', content: '旧记录。' }),
  ])
  const timeline = buildTimeline(data)
  const key = resolveKey(timeline.find((entry) => entry.postId === 'r1')!, new Map())
  assert.match(key, /^name:/, `无来源只能按昵称分组，实际 ${key}`)
})

test('P1：只有昵称、没有 authorId 的记录不会获得 handle 身份', () => {
  const anon: NestedReply = {
    platform: 'tieba',
    postId: 'r-anon',
    parentPostId: FLOOR_POST_ID,
    authorName: '无名氏',
    authorSource: 'wap_inline',
    content: '我没有登录名。',
    relationUncertain: false,
  } as unknown as NestedReply

  const data = collected([anon])
  const timeline = buildTimeline(data)
  const key = resolveKey(timeline.find((entry) => entry.postId === 'r-anon')!, new Map())
  assert.match(key, /^name:/, `没有 authorId 就没有 handle，实际 ${key}`)
})

// ── the older guarantees must survive ─────────────────────────────────────

test('P1：两个账号同昵称仍然分离（有来源）', () => {
  // Here the *nickname* is shared but the login names differ — the previous P0.
  const data = collected([
    {
      platform: 'tieba',
      postId: 'r1',
      parentPostId: FLOOR_POST_ID,
      authorId: 'owner_a',
      authorName: '小财神',
      authorSource: 'wap_inline',
      content: '我是主人。',
      relationUncertain: false,
    } as unknown as NestedReply,
    {
      platform: 'tieba',
      postId: 'r2',
      parentPostId: FLOOR_POST_ID,
      authorId: 'attacker_b',
      authorName: '小财神',
      authorSource: 'wap_inline',
      content: '我不同意。',
      relationUncertain: false,
    } as unknown as NestedReply,
  ])

  const participants = describeParticipants(data, 1)
  const named = participants.filter((entry) => entry.displayName === '小财神')
  assert.equal(named.length, 2, '同昵称不同登录名必须是两个人')

  const dispute = analyzeDispute(data, { handle: 'owner_a' }, { postId: 'r1' })
  assert.deepEqual(
    dispute.ownerStatements.map((entry) => entry.postId),
    ['r1'],
    '攻击者的发言不得进入主人立场',
  )
})

test('P1：同一账号改昵称，身份键不变', () => {
  // The login name is the identity; the nickname is a label that may change.
  const before: NestedReply = {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorId: 'stable_un',
    authorName: '旧昵称',
    authorSource: 'wap_inline',
    content: '第一句。',
    relationUncertain: false,
  } as unknown as NestedReply
  const after: NestedReply = { ...before, postId: 'r2', authorName: '新昵称', content: '第二句。' }

  const data = collected([before, after])
  const timeline = buildTimeline(data)
  const k1 = resolveKey(timeline.find((entry) => entry.postId === 'r1')!, new Map())
  const k2 = resolveKey(timeline.find((entry) => entry.postId === 'r2')!, new Map())
  assert.equal(k1, k2, '同一个人换了昵称，仍然是同一个身份键')

  const participants = describeParticipants(data, 1)
  const mine = participants.filter((entry) => entry.handle === 'stable_un')
  assert.equal(mine.length, 1, '两条发言属于同一个参与者')
  assert.equal(mine[0]!.postCount, 2)
})

test('P1：声明来源后，数字样式的 un 也是 handle 而不是 uid', () => {
  // `1254480024` is a `un`, not a numeric uid. The distinction matters because only
  // a uid can satisfy a uid match.
  const numericUn: NestedReply = {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: FLOOR_POST_ID,
    authorId: '1254480024',
    authorName: '寻º乐',
    authorSource: 'wap_floor',
    content: '数字样式的登录名。',
    relationUncertain: false,
  } as unknown as NestedReply

  const data = collected([numericUn])
  const timeline = buildTimeline(data)
  const key = resolveKey(timeline.find((entry) => entry.postId === 'r1')!, new Map())
  assert.match(key, /^handle:/, `un 是登录名，应按 handle 分组，实际 ${key}`)
  assert.equal(/^uid:/.test(key), false, '不得被当成数字 uid')
})
