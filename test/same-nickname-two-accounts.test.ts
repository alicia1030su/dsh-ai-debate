/**
 * Two different accounts, one display name.
 *
 * ## The question this file answers
 *
 * Tieba users can and do reuse nicknames. A display name is a label, not an
 * identity, and any account may take one. The failure this file guards against is
 * the one that matters most for this product: the AI argues using a stranger's
 * words because both people were called the same thing.
 *
 * ## What "passing" means here
 *
 * Not that an error is thrown, but that the two accounts remain **two
 * participants**, that the owner's statements contain only the owner's words, and
 * that a reply aimed at the opponent never carries the owner's opinion as the
 * opponent's — or the reverse. Where identity is genuinely undecidable the answer
 * must be "do not publish", not a guess.
 *
 * Everything below drives the production `analyzeDispute()`. A helper that
 * returns the right shape while the real path still merges the two would be worse
 * than no test at all.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeDispute } from '../lib/analyzer.js'
import type { CollectedThread, TimelineEntry } from '../lib/collector.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'

const THREAD_ID = '8752343543'
const FLOOR_POST_ID = '133529333135'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
  id: THREAD_ID,
  title: '同昵称测试帖',
  content: '开场白',
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
  content: '大家看看这个方案值不值得做。',
  images: [],
  nestedCount: 3,
}

/**
 * A nested reply, with the identity fields stated explicitly.
 *
 * `handle` is the login name (`un`); `display` is the nickname. Both accounts below
 * deliberately share `display`.
 */
function reply(input: {
  postId: string
  handle: string
  display: string
  content: string
  replyToName?: string
}): NestedReply {
  return {
    platform: 'tieba',
    postId: input.postId,
    parentPostId: FLOOR_POST_ID,
    authorId: input.handle,
    authorName: input.display,
    authorSource: 'wap_inline',
    content: input.content,
    ...(input.replyToName === undefined ? {} : { replyToName: input.replyToName }),
    relationUncertain: false,
  }
}

/** Wrap floors + nested replies in the shape `analyzeDispute` consumes. */
function collected(nested: readonly NestedReply[]): CollectedThread {
  const timeline: TimelineEntry[] = [
    {
      kind: 'floor',
      platform: 'tieba',
      postId: FLOOR.postId,
      floorPostId: FLOOR.postId,
      floorNumber: 1,
      authorId: FLOOR.authorId,
      authorName: FLOOR.authorName,
      authorSource: 'wap_floor',
      content: FLOOR.content,
      order: 0,
    },
    ...nested.map((entry, index) => ({
      kind: 'nested' as const,
      platform: entry.platform,
      postId: entry.postId,
      floorPostId: FLOOR.postId,
      floorNumber: 1,
      order: index + 1,
      ...(entry.replyToPostId === undefined ? {} : { replyToPostId: entry.replyToPostId }),
      ...(entry.authorId === undefined ? {} : { authorId: entry.authorId }),
      ...(entry.authorName === undefined ? {} : { authorName: entry.authorName }),
      ...(entry.authorSource === undefined ? {} : { authorSource: entry.authorSource }),
      content: entry.content,
      ...(entry.replyToName === undefined ? {} : { replyToName: entry.replyToName }),
    })),
  ]

  return {
    thread: THREAD,
    floors: [{ floor: FLOOR, nested: [...nested], nestedComplete: true }],
    timeline,
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

/**
 * The scenario, built once so every test below is about the same facts.
 *
 * - `owner_a` / 小财神 — the owner's account.
 * - `attacker_b` / 小财神 — a second account that took the same nickname.
 * - A third reply from `onlooker_c` so the floor is not a two-way tie.
 */
function sameNameScene(): readonly NestedReply[] {
  // Ordered the way a thread actually reads: someone argues, then the owner answers
  // them. Opponent selection only looks at what came *before* the owner's reply, so a
  // scene with the attack after the reply would test nothing.
  return [
    reply({
      postId: 'r-attacker',
      handle: 'attacker_b',
      display: '小财神',
      content: '这方案根本站不住脚，纯粹浪费钱。',
    }),
    reply({
      postId: 'r-owner',
      handle: 'owner_a',
      display: '小财神',
      content: '这个方案我认为可行，成本可控。',
      // Deliberately ambiguous: the platform renders only the nickname, and two
      // accounts carry it. The analyzer must not pick one of them for this edge.
      replyToName: '小财神',
    }),
    reply({
      postId: 'r-onlooker',
      handle: 'onlooker_c',
      display: '路人丙',
      content: '我倒觉得可以试试看。',
    }),
  ]
}

// ── the reproduction ───────────────────────────────────────────────────────

test('P0 复现：同昵称的两个账号必须是两个参与者', () => {
  const data = collected(sameNameScene())
  const dispute = analyzeDispute(data, { handle: 'owner_a' }, { postId: 'r-owner' })

  // The bug was that `resolveKey` returned `authorName`, so both accounts landed on
  // the key "小财神" and became one participant. The observable consequence is that
  // the owner's post set is *both* accounts' posts — asserted below — and that the
  // owner's display name is shared with the opponent. What must now hold is that the
  // owner resolves to the configured handle and the two are separable by key.
  assert.equal(dispute.owner.handle, 'owner_a', `主人必须绑定 owner_a，实际 ${dispute.owner.handle}`)
  assert.equal(dispute.owner.displayName, '小财神', '显示名仍然是昵称，用于展示')
  assert.notEqual(
    dispute.owner.key,
    dispute.opponent?.key,
    '主人与对手不能是同一个参与者',
  )
})

test('P0 复现：主人的 ownerStatements 不得包含另一账号的发言', () => {
  const data = collected(sameNameScene())
  const dispute = analyzeDispute(data, { handle: 'owner_a' }, { postId: 'r-owner' })

  const ownerPostIds = dispute.ownerStatements.map((entry) => entry.postId)
  assert.deepEqual(ownerPostIds, ['r-owner'], `主人发言只能是 r-owner，实际 ${JSON.stringify(ownerPostIds)}`)

  // And the specific words that must never be attributed to the owner.
  assert.equal(
    dispute.ownerStatements.some((entry) => entry.content.includes('浪费钱')),
    false,
    '另一账号的发言不得进入主人立场',
  )
})

test('P0 复现：对手选择不得因同昵称而错位', () => {
  const data = collected(sameNameScene())
  const dispute = analyzeDispute(data, { handle: 'owner_a' }, { postId: 'r-owner' })

  // The opponent is the account arguing against the owner. It must not resolve to
  // the owner themselves, which is what a shared key would do.
  assert.notEqual(dispute.opponent?.key, dispute.owner.key, '对手不能是主人自己')
  assert.equal(dispute.opponent?.handle, 'attacker_b', `对手应是 attacker_b，实际 ${dispute.opponent?.handle}`)
})

test('P0 复现：身份不确定时不得自动归属其中一方', () => {
  // The owner is configured by *nickname* only, and two accounts share it. There is
  // no way to tell which one they are, so the only safe answer is to refuse.
  const data = collected(sameNameScene())
  assert.throws(
    () => analyzeDispute(data, { userName: '小财神' }, { postId: 'r-owner' }),
    /不同的账号|无法确定/,
    '两个账号共用昵称时，按昵称配置必须拒绝，而不是挑一个',
  )
})

// ── the same rule must hold on every surface ───────────────────────────────

test('P0：普通楼层与楼中楼共用同一套身份语义', () => {
  // The key is computed from the record, not from which surface produced it, so a
  // floor and a reply by the same account must land on the same key — and two
  // accounts sharing a nickname must stay apart on *both*.
  const owners = analyzeDispute(
    collected([
      reply({ postId: 'r1', handle: 'owner_a', display: '小财神', content: '我的看法。' }),
      reply({ postId: 'r2', handle: 'attacker_b', display: '小财神', content: '我不同意。' }),
    ]),
    { handle: 'owner_a' },
    { postId: 'r1' },
  )
  const posters = analyzeDispute(
    collected([
      reply({ postId: 'r1', handle: 'owner_a', display: '小财神', content: '我的看法。' }),
      reply({ postId: 'r2', handle: 'attacker_b', display: '小财神', content: '我不同意。' }),
    ]),
    { handle: 'attacker_b' },
    { postId: 'r2' },
  )

  // Same thread, two different configured owners: each sees exactly one statement.
  assert.deepEqual(owners.ownerStatements.map((entry) => entry.postId), ['r1'])
  assert.deepEqual(posters.ownerStatements.map((entry) => entry.postId), ['r2'])
  // And the floor's own author is never folded into either of them.
  assert.equal(owners.ownerStatements.some((entry) => entry.postId === FLOOR_POST_ID), false)
})

test('P0：跨平台同登录名不得合并', () => {
  // `handle:platform:name` — the platform is part of the key, because a login name is
  // scoped to one site. This is built through the real nested records (not by editing
  // the timeline afterwards) because `analyzeDispute` rebuilds the timeline from the
  // collected thread; a test that patched the timeline would be measuring nothing.
  const data = collected([
    reply({ postId: 'r1', handle: 'same_un', display: '同名', content: '我是甲平台的。' }),
    {
      ...reply({ postId: 'r2', handle: 'same_un', display: '同名', content: '我是乙平台的。' }),
      platform: 'weibo',
    } as NestedReply,
  ])

  const dispute = analyzeDispute(data, { handle: 'same_un', platform: 'tieba' }, { postId: 'r1' })
  assert.deepEqual(
    dispute.ownerStatements.map((entry) => entry.postId),
    ['r1'],
    '另一个平台的同登录名不是同一个人',
  )
})

test('P0：只有昵称的记录不会被并入同名的真实账号', () => {
  // A record with no account identifier keys on `name:…`, which can never equal a
  // `handle:…` key. The owner's statements must therefore exclude it even though the
  // nickname matches exactly.
  const data = collected([
    reply({ postId: 'r-owner', handle: 'owner_a', display: '小财神', content: '我的看法。' }),
    {
      platform: 'tieba',
      postId: 'r-anon',
      parentPostId: FLOOR_POST_ID,
      authorName: '小财神',
      content: '我没有登录名。',
      relationUncertain: false,
    } as NestedReply,
  ])

  const dispute = analyzeDispute(data, { handle: 'owner_a' }, { postId: 'r-owner' })
  assert.deepEqual(
    dispute.ownerStatements.map((entry) => entry.postId),
    ['r-owner'],
    '无账号标识的同名记录不得被当成主人',
  )
})
