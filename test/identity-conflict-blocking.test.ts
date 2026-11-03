/**
 * The gate the whole release exists for:
 *
 * > Faced with two conflicting author identities, the system must admit it does
 * > not know, rather than pick the answer that looks more plausible.
 *
 * These tests drive the **real** production path — `collectThread` → `walkNested`
 * → `analyzeDispute` → `checkPublishPolicy` — and assert on the *number of publish
 * attempts*, not merely on a boolean. A refusal that still calls the platform is
 * not a refusal.
 *
 * The positive control matters as much as the refusals: a fixture with no conflict
 * must still complete, or the gate would be "everything is blocked", which is not
 * safety, it is breakage.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { collectThread } from '../lib/collector.js'
import { analyzeDispute } from '../lib/analyzer.js'
import { checkPublishPolicy } from '../lib/safety.js'
import type { Floor, NestedReply, PlatformAdapter, Thread } from '../lib/types.js'

const THREAD: Thread = {
  platform: 'tieba',
  forum: { platform: 'tieba', id: '9', name: '测试吧' },
  id: '9493941284',
  title: '测试帖',
  content: '开场',
  authorId: 'silver_fox',
  authorName: '苏小玲',
  authorSource: 'wap_floor',
  url: 'https://tieba.baidu.com/p/9493941284',
  images: [],
}

const FLOOR: Floor = {
  platform: 'tieba',
  floorNumber: 1,
  postId: '900',
  authorId: 'silver_fox',
  authorName: '苏小玲',
  authorSource: 'wap_floor',
  content: '开场',
  images: [],
  nestedCount: 2,
}

/** A nested reply as one surface reports it. */
function nested(input: {
  postId: string
  handle?: string
  name?: string
  source?: NestedReply['authorSource']
  body?: string
}): NestedReply {
  return {
    platform: 'tieba',
    postId: input.postId,
    parentPostId: '900',
    ...(input.handle === undefined ? {} : { authorId: input.handle }),
    ...(input.name === undefined ? {} : { authorName: input.name }),
    ...(input.source === undefined ? {} : { authorSource: input.source }),
    content: input.body ?? '我说的就是这个。',
    relationUncertain: false,
  }
}

/**
 * An adapter that serves `pages` in order and **counts publish attempts**.
 *
 * The counter is the point: every refusal below asserts it stayed at zero.
 */
function adapterWith(input: {
  pages: readonly (readonly NestedReply[])[]
  publishCounter: { calls: number }
}): PlatformAdapter {
  let served = 0
  return {
    platform: 'tieba',
    async getThread() {
      return THREAD
    },
    // The floor list comes from `getReplies`, not `getFloors` — the generic
    // contract names it after the page it reads.
    async getReplies() {
      return {
        floors: [FLOOR],
        hasMore: false,
        page: 1,
        declaredTotal: 1,
        declaredTotalPages: 1,
      }
    },
    async getNestedReplies() {
      const page = input.pages[served] ?? []
      served += 1
      return { replies: page, hasMore: served < input.pages.length, page: served }
    },
    async publishReply() {
      input.publishCounter.calls += 1
      return { status: 'confirmed', postId: 'published-1' }
    },
  } as unknown as PlatformAdapter
}

/** The policy matrix every publish goes through (manual mode, nothing automatic). */
const POLICY = {
  mode: 'manual' as const,
  maxAutoPublishesPerSession: 0,
  cooldownMs: 0,
  maxPublishesPerThread: 10,
  stopOnChallenge: true,
}

test('对照组：无冲突时采集与分析正常完成（证明闸门不是「一律拒绝」）', async () => {
  const counter = { calls: 0 }
  const adapter = adapterWith({
    pages: [
      [
        nested({ postId: 'r1', handle: 'silver_fox', name: '苏小玲', source: 'wap_inline' }),
        nested({ postId: 'r2', handle: 'other_guy', name: '路人', source: 'wap_inline' }),
      ],
    ],
    publishCounter: counter,
  })
  const collected = await collectThread(adapter, { platform: 'tieba' as const, threadId: '9493941284', url: 'https://tieba.baidu.com/p/9493941284' })

  assert.equal(collected.identityConflicts, undefined, '一致的数据不该产生冲突')
  const dispute = analyzeDispute(collected, { userId: undefined, userName: '苏小玲' }, { postId: 'r1' })
  assert.equal(dispute.owner.displayName, '苏小玲')
  assert.equal(counter.calls, 0, '分析阶段绝不发表')
})

test('冲突时分析必须拒绝，且不得给出主人立场', async () => {
  const counter = { calls: 0 }
  const adapter = adapterWith({
    pages: [
      [
        nested({ postId: 'r1', handle: 'silver_fox', name: '苏小玲', source: 'wap_inline' }),
      ],
      [
        nested({ postId: 'r1', handle: 'someone_else', name: '小财神', source: 'comment_page' }),
      ],
    ],
    publishCounter: counter,
  })
  const collected = await collectThread(adapter, { platform: 'tieba' as const, threadId: '9493941284', url: 'https://tieba.baidu.com/p/9493941284' })

  assert.equal(collected.identityConflicts?.length, 1, '采集层必须发现冲突')

  let threw = false
  try {
    analyzeDispute(collected, { userId: undefined, userName: '苏小玲' }, { postId: 'r1' })
  } catch (error) {
    threw = true
    const message = (error as Error).message
    assert.match(message, /身份冲突|作者/, '错误要说明是身份问题')
    assert.match(message, /silver_fox|someone_else/, '要保留两个来源的诊断信息')
    assert.equal(/猜|假设|默认取/.test(message), false, '不得暗示插件替你选了一个')
  }
  assert.equal(threw, true, '冲突时分析必须抛错，不能返回一个「看起来还行」的结果')
  assert.equal(counter.calls, 0, '拒绝路径不得触发任何发表')
})

test('发表闸门：带身份冲突时，即使已人工批准也不放行', () => {
  const decision = checkPublishPolicy(POLICY, {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: true,
    securityDecision: 'allow',
    semanticSettled: true,
    identityConflict: { postId: 'r1', summary: '同一 postId 两个来源作者不同' },
    now: 1_000_000,
  })
  assert.equal(decision.allowed, false, '人工批准不能治愈身份冲突')
  assert.equal((decision as { code: string }).code, 'identity_conflict')
  assert.match((decision as { reason: string }).reason, /不能证明/)
})

test('发表闸门：无冲突时同一策略仍可放行（对照）', () => {
  const decision = checkPublishPolicy(POLICY, {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: true,
    securityDecision: 'allow',
    semanticSettled: true,
    // The control: nothing about identity is in question, so the policy's other
    // gates are the only ones that can refuse.
    ownerIdentityAssurance: 'verified' as const,
    now: 1_000_000,
  })
  assert.equal(decision.allowed, true)
})

test('冲突优先于其他拒绝理由：原因是身份，不是缺批准', () => {
  const decision = checkPublishPolicy(POLICY, {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: false,
    securityDecision: 'allow',
    semanticSettled: true,
    identityConflict: { postId: 'r1', summary: '冲突' },
    now: 1_000_000,
  })
  assert.equal((decision as { code: string }).code, 'identity_conflict')
  assert.notEqual((decision as { code: string }).code, 'approval_required')
})

test('一个来源缺作者标识时：分析可以继续，但主人身份不算已核实', async () => {
  const counter = { calls: 0 }
  const adapter = adapterWith({
    pages: [
      [nested({ postId: 'r1', handle: 'silver_fox', name: '苏小玲', source: 'wap_inline' })],
      [nested({ postId: 'r1', name: '苏小玲', source: 'comment_page' })],
    ],
    publishCounter: counter,
  })
  const collected = await collectThread(adapter, { platform: 'tieba' as const, threadId: '9493941284', url: 'https://tieba.baidu.com/p/9493941284' })

  assert.equal(collected.identityConflicts, undefined, '缺失不是冲突')
  const dispute = analyzeDispute(collected, { userName: '苏小玲' }, { postId: 'r1' })
  assert.ok(
    dispute.notes.some((note) => note.includes('昵称')),
    '按昵称匹配必须留下「未核实」的提示',
  )
  assert.equal(counter.calls, 0)
})

test('旧记录（无 authorSource）：可读，但必须是 unverified', () => {
  // The rule is platform-scoped, not shape-scoped. A legacy Tieba `authorId` is a
  // login name whether or not it looks like a number. It may resolve the owner
  // enough to *read* the thread — otherwise every historical session is unusable —
  // but the result must come back `unverified`, and the publish gate must refuse.
  const legacyNested: NestedReply = {
    platform: 'tieba',
    postId: 'r1',
    parentPostId: '900',
    authorId: '1254480024',
    authorName: '寻º乐',
    content: '内容',
    relationUncertain: false,
  }
  const legacyFloor: Floor = { ...FLOOR, nestedCount: 1 }
  const collected = {
    thread: THREAD,
    floors: [{ floor: legacyFloor, nested: [legacyNested], nestedComplete: true }],
    complete: true,
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
  }

  const dispute = analyzeDispute(
    collected,
    { userId: '1254480024', platform: 'tieba' },
    { postId: 'r1' },
  )
  assert.equal(dispute.ownerIdentityAssurance, 'unverified', '旧记录只能得出「未核验」')
  assert.ok(
    dispute.notes.some((note) => /旧格式|未核验/.test(note)),
    '必须留下可读的说明，而不是静默通过',
  )

  // And that assurance is what stops the send, not a note somebody might skip.
  const decision = checkPublishPolicy(POLICY, {
    sessionId: 's',
    threadId: 't',
    sessionPublishes: 0,
    threadPublishes: 0,
    humanApproved: true,
    securityDecision: 'allow',
    semanticSettled: true,
    ownerIdentityAssurance: dispute.ownerIdentityAssurance,
    now: 1_000_000,
  })
  assert.equal(decision.allowed, false, '未核验的主人即使获批也不能发表')
  assert.equal((decision as { code: string }).code, 'owner_identity_unverified')
})
