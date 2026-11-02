/**
 * The one-off publish verification, tested against a fake platform (v0.2.21 §三).
 *
 * ## Why the fake is a real adapter, not a mock of the runner
 *
 * Every test below drives `runVerification` — the same function the settings page calls — with an
 * adapter that answers like a platform would. Nothing stubs the runner's own decisions, so a rule
 * that only holds because the test skipped it cannot pass here. The fake counts its calls, which
 * is how "exactly one publish" is asserted rather than assumed.
 *
 * ## What each block is for
 *
 * 1. **Refusals happen before the network.** If any of them fired after `publishReply`, a refused
 *    verification could still have posted.
 * 2. **The four read-back facts are all required.** Three of four is a failed verification, not a
 *    partial pass — that is §三.7, and it is the difference between "something was written" and
 *    "this reply was written where you asked".
 * 3. **Unknown outcomes are never retried.** A timeout leaves an `uncertain` row, and the same
 *    authorization can never be spent again.
 * 4. **Evidence is bound to an account and an adapter build.** The last block exists because
 *    "verified once, on some build, as someone" is the claim that makes capability badges lie.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CapabilityState } from '../lib/platforms/contracts.js'
import {
  effectiveCapability,
  type CapabilityEvidenceRecord,
} from '../lib/capability-evidence.js'
import type { PublishOutcome, PublishTarget, ReplyContext, ThreadRef } from '../lib/types.js'
import type { VerificationAuthorization, VerificationRecord } from '../lib/verification.js'
import {
  readBackVerification,
  runVerification,
  targetFor,
  type VerificationRecordStore,
} from '../lib/verification-runner.js'

const THREAD = '7777'
const FLOOR = 'b1'
const NESTED = 'b1-1'
const ACCOUNT = 'acct-42'

/** A store that keeps everything in memory, written twice per attempt like the real one. */
function memoryStore(): VerificationRecordStore & { readonly writes: VerificationRecord[] } {
  const rows = new Map<string, VerificationRecord>()
  const writes: VerificationRecord[] = []
  return {
    writes,
    all: () => [...rows.values()],
    put: async (record) => {
      writes.push(record)
      rows.set(record.key, record)
    },
  }
}

interface FakeOptions {
  /** What `publishReply` returns. */
  readonly outcome?: PublishOutcome
  /** What `getReplyContext` returns, or the error it throws. */
  readonly context?:
    | (Partial<ReplyContext> & { readonly error?: undefined })
    | { readonly error: string }
  /** Throw from `publishReply` instead of returning. */
  readonly publishThrows?: string
}

function fakeAdapter(options: FakeOptions = {}): {
  adapter: {
    publishReply: (ref: ThreadRef, target: PublishTarget, content: string) => Promise<PublishOutcome>
    getReplyContext: (ref: ThreadRef, postId: string) => Promise<ReplyContext>
  }
  readonly publishes: number
  readonly reads: number
} {
  const state = { publishes: 0, reads: 0 }
  const context = options.context
  const adapter = {
    async publishReply(): Promise<PublishOutcome> {
      state.publishes += 1
      if (options.publishThrows !== undefined) throw new Error(options.publishThrows)
      return options.outcome ?? { status: 'confirmed', postId: 'p-1' }
    },
    async getReplyContext(): Promise<ReplyContext> {
      state.reads += 1
      if (context !== undefined && 'error' in context && context.error !== undefined) {
        throw new Error(context.error)
      }
      const base = (context ?? {}) as Partial<ReplyContext>
      return {
        thread: base.thread ?? { id: THREAD },
        floor: base.floor ?? {
          platform: 'tieba',
          postId: FLOOR,
          authorId: 'floor-author',
          content: '楼主原文',
          images: [],
        },
        ...(base.nested !== undefined ? { nested: base.nested } : {}),
        ancestors: base.ancestors ?? [],
        siblings: base.siblings ?? [],
      } as ReplyContext
    },
  }
  return {
    adapter,
    get publishes() {
      return state.publishes
    },
    get reads() {
      return state.reads
    },
  }
}

function authorization(overrides: Partial<VerificationAuthorization> = {}): VerificationAuthorization {
  return {
    platform: 'tieba',
    capability: 'comment.publish',
    authorizedAccountId: ACCOUNT,
    authorizedThreadId: THREAD,
    authorizedBy: '主人',
    approvedText: '验收一条，稍后可以删',
    ...overrides,
  }
}

/** The nested reply the platform would read back for a successful `comment.reply`. */
function nestedUnder(authorizationValue: VerificationAuthorization): Partial<ReplyContext> {
  return {
    nested: {
      platform: 'tieba',
      postId: 'p-1',
      parentPostId: authorizationValue.authorizedFloorId ?? FLOOR,
      ...(authorizationValue.replyToPostId !== undefined
        ? { replyToPostId: authorizationValue.replyToPostId }
        : {}),
      authorId: ACCOUNT,
      authorName: '小号',
      content: authorizationValue.approvedText,
    },
  }
}

function deps(
  fake: ReturnType<typeof fakeAdapter>,
  store: VerificationRecordStore,
  overrides: {
    readonly capabilityState?: CapabilityState
    readonly liveAccountId?: string | undefined
    readonly adapterVersion?: string
  } = {},
) {
  return {
    adapter: fake.adapter as never,
    capabilityState: () => overrides.capabilityState ?? ('unverified' as CapabilityState),
    liveAccountId: async () => overrides.liveAccountId ?? ACCOUNT,
    records: store,
    now: () => '2026-10-31T12:00:00.000Z',
    ...(overrides.adapterVersion !== undefined ? { adapterVersion: overrides.adapterVersion } : {}),
  }
}

describe('一次性发表验收：拒绝必须发生在网络之前', () => {
  it('能力不是 unverified 时不发表，也不写记录', async () => {
    const fake = fakeAdapter()
    const store = memoryStore()
    const result = await runVerification(authorization(), deps(fake, store, { capabilityState: 'supported' }))
    assert.equal(result.ok, false)
    assert.equal(result.refusal, 'wrong_state')
    assert.equal(fake.publishes, 0, '拒绝之后仍然发了一条，说明检查跑在发表之后')
    assert.equal(store.writes.length, 0)
  })

  it('登录账号与授权账号不一致时不发表', async () => {
    const fake = fakeAdapter()
    const store = memoryStore()
    const result = await runVerification(
      authorization(),
      deps(fake, store, { liveAccountId: 'someone-else' }),
    )
    assert.equal(result.refusal, 'account_mismatch')
    assert.equal(fake.publishes, 0)
  })

  it('一份授权用第二次会被拒绝', async () => {
    const fake = fakeAdapter()
    const store = memoryStore()
    const first = await runVerification(authorization(), deps(fake, store))
    assert.equal(first.ok, true)
    const second = await runVerification(authorization(), deps(fake, store))
    assert.equal(second.ok, false)
    assert.equal(second.refusal, 'already_used')
    assert.equal(fake.publishes, 1, '一次性授权只允许一次发表')
  })

  it('回复缺少楼层或目标评论时拒绝，并要求主人补上', async () => {
    const fake = fakeAdapter()
    const store = memoryStore()
    const result = await runVerification(
      authorization({ capability: 'comment.reply' }),
      deps(fake, store),
    )
    assert.equal(result.refusal, 'incomplete_authorization')
    assert.match(result.message, /楼层|评论/)
    assert.equal(fake.publishes, 0)
  })

  it('正文为空时拒绝而不是发一条空回复', async () => {
    const fake = fakeAdapter()
    const store = memoryStore()
    const result = await runVerification(authorization({ approvedText: '   ' }), deps(fake, store))
    assert.equal(result.refusal, 'incomplete_authorization')
    assert.equal(fake.publishes, 0)
  })
})

describe('回读四要素：缺一不可', () => {
  const cases: readonly {
    readonly name: string
    readonly context: Partial<ReplyContext> | { readonly error: string }
    readonly missing: string
  }[] = [
    { name: '帖子读不到', context: { error: '403' }, missing: 'postFound' },
    {
      name: '作者不是授权账号',
      context: {
        nested: {
          platform: 'tieba',
          postId: 'p-1',
          parentPostId: FLOOR,
          authorId: 'impostor',
          content: '验收一条，稍后可以删',
        },
      },
      missing: 'authorMatched',
    },
    {
      name: '正文被平台改写',
      context: { floor: { platform: 'tieba', postId: 'p-1', authorId: ACCOUNT, content: '别的正文', images: [] } },
      missing: 'textMatched',
    },
  ]

  for (const testCase of cases) {
    it(`${testCase.name}时不能算验证通过`, async () => {
      const fake = fakeAdapter({ context: testCase.context as never })
      const store = memoryStore()
      const result = await runVerification(authorization(), deps(fake, store))
      assert.equal(result.ok, true, '发表确实成功了，这一点要如实承认')
      assert.equal(result.upgraded, false, '回读不完整却升级了能力')
      assert.equal(result.record?.readBack?.[testCase.missing as 'postFound'], false)
      assert.match(result.message, /回读证据不完整/)
    })
  }

  it('四要素齐全才算通过', async () => {
    const auth = authorization()
    const fake = fakeAdapter({
      context: { floor: { platform: 'tieba', postId: 'p-1', authorId: ACCOUNT, content: auth.approvedText, images: [] } },
    })
    const store = memoryStore()
    const result = await runVerification(auth, deps(fake, store))
    assert.equal(result.upgraded, true)
    assert.equal(result.record?.readBack?.parentMatched, true)
  })

  it('回复验收要核对父级位置，不能只看「有一条回复」', async () => {
    const auth = authorization({ capability: 'comment.reply', authorizedFloorId: FLOOR, replyToPostId: NESTED })
    const wrongParent = fakeAdapter({
      context: {
        nested: {
          platform: 'tieba',
          postId: 'p-1',
          parentPostId: FLOOR,
          replyToPostId: 'other-comment',
          authorId: ACCOUNT,
          content: auth.approvedText,
        },
      },
    })
    const store = memoryStore()
    const result = await runVerification(auth, deps(wrongParent, store))
    assert.equal(result.record?.readBack?.parentMatched, false)
    assert.equal(result.upgraded, false)
  })

  it('回读接口抛错时如实记成未确认', async () => {
    const fake = fakeAdapter({ context: { error: 'read timeout' } })
    const evidence = await readBackVerification(fake.adapter as never, ThreadRefFor(), 'p-1', authorization())
    assert.equal(evidence.facts.postFound, false)
    assert.equal(evidence.facts.authorMatched, false)
    assert.match(evidence.facts.notes.join(''), /无法回读/)
  })
})

describe('未知结果不重试', () => {
  it('发表抛错时记成 uncertain，并说明不可重试', async () => {
    const fake = fakeAdapter({ publishThrows: 'socket hang up' })
    const store = memoryStore()
    const result = await runVerification(authorization(), deps(fake, store))
    assert.equal(result.ok, false)
    assert.equal(result.record?.outcome, 'uncertain')
    assert.match(result.record?.failure ?? '', /不重试/)
    assert.equal(fake.publishes, 1)
  })

  it('平台返回失败时不重试，也不回读', async () => {
    const fake = fakeAdapter({ outcome: { status: 'failed', error: '403', errorCode: 'forbidden' } })
    const store = memoryStore()
    const result = await runVerification(authorization(), deps(fake, store))
    assert.equal(result.record?.outcome, 'failed')
    assert.equal(fake.publishes, 1)
    assert.equal(fake.reads, 0, '平台已经拒绝，回读没有意义')
  })

  it('没有 post id 时按未知处理，不当成成功', async () => {
    const fake = fakeAdapter({ outcome: { status: 'uncertain' } })
    const store = memoryStore()
    const result = await runVerification(authorization(), deps(fake, store))
    assert.equal(result.ok, false)
    assert.equal(result.record?.outcome, 'uncertain')
    assert.equal(result.upgraded, false)
  })

  it('pending 记录先于发表写入，崩溃后仍有痕迹', async () => {
    const fake = fakeAdapter()
    const store = memoryStore()
    await runVerification(authorization(), deps(fake, store))
    assert.equal(store.writes[0]?.outcome, 'pending', '第一次写入必须是 pending')
    assert.equal(store.writes[store.writes.length - 1]?.outcome, 'succeeded')
  })
})

describe('证据绑定账号与适配器版本', () => {
  const evidenceOf = (overrides: Partial<CapabilityEvidenceRecord> = {}): CapabilityEvidenceRecord => ({
    platform: 'tieba',
    capability: 'comment.publish',
    accountId: ACCOUNT,
    adapterVersion: 'v1',
    verifiedAt: '2026-10-31T12:00:00.000Z',
    method: 'live',
    readBackComplete: true,
    ...overrides,
  })

  it('同一账号、同一适配器版本、回读齐全才升级', () => {
    const decision = effectiveCapability(
      'unverified',
      { platform: 'tieba', capability: 'comment.publish', accountId: ACCOUNT, adapterVersion: 'v1' },
      [evidenceOf()],
    )
    assert.equal(decision.effective, 'supported')
    assert.equal(decision.promotedByEvidence, true)
  })

  it('换了适配器版本就失效，不能拿上一份代码的成功当证据', () => {
    const decision = effectiveCapability(
      'unverified',
      { platform: 'tieba', capability: 'comment.publish', accountId: ACCOUNT, adapterVersion: 'v2' },
      [evidenceOf()],
    )
    assert.equal(decision.effective, 'unverified')
    assert.equal(decision.promotedByEvidence, false)
  })

  it('换了账号就失效', () => {
    const decision = effectiveCapability(
      'unverified',
      { platform: 'tieba', capability: 'comment.publish', accountId: 'someone-else', adapterVersion: 'v1' },
      [evidenceOf()],
    )
    assert.equal(decision.effective, 'unverified')
  })

  it('回读不完整的记录不能升级', () => {
    const decision = effectiveCapability(
      'unverified',
      { platform: 'tieba', capability: 'comment.publish', accountId: ACCOUNT, adapterVersion: 'v1' },
      [evidenceOf({ readBackComplete: false })],
    )
    assert.equal(decision.effective, 'unverified')
  })

  it('静态声明不会被运行时改写：证据只能抬升 unverified，不能救活 unavailable', () => {
    const decision = effectiveCapability(
      'unavailable',
      { platform: 'tieba', capability: 'comment.publish', accountId: ACCOUNT, adapterVersion: 'v1' },
      [evidenceOf()],
    )
    assert.equal(decision.effective, 'unavailable')
    assert.equal(decision.promotedByEvidence, false)
  })

  it('权限缺失也不能靠验收记录补上', () => {
    const decision = effectiveCapability(
      'permission_required',
      { platform: 'tieba', capability: 'comment.publish', accountId: ACCOUNT, adapterVersion: 'v1' },
      [evidenceOf()],
    )
    assert.equal(decision.effective, 'permission_required')
  })

  it('记录里带着本次运行的适配器版本', async () => {
    const fake = fakeAdapter()
    const store = memoryStore()
    await runVerification(authorization(), deps(fake, store, { adapterVersion: 'abcd1234' }))
    assert.equal(store.writes[0]?.adapterVersion, 'abcd1234')
  })

  it('没有适配器版本时记录如实留空，不编一个', async () => {
    const fake = fakeAdapter()
    const store = memoryStore()
    await runVerification(authorization(), deps(fake, store))
    assert.equal(store.writes[0]?.adapterVersion, undefined)
  })

  it('授权键把父级位置算进去，同一帖子的不同楼层是两份授权', async () => {
    const a = authorization({ capability: 'comment.reply', authorizedFloorId: FLOOR, replyToPostId: NESTED })
    const b = authorization({ capability: 'comment.reply', authorizedFloorId: FLOOR, replyToPostId: 'b1-2' })
    const fake = fakeAdapter({ context: nestedUnder(a) as never })
    const store = memoryStore()
    await runVerification(a, deps(fake, store))
    const second = await runVerification(b, deps(fake, store))
    assert.equal(second.ok, true, '换了目标评论就是新的一份授权')
    assert.equal(fake.publishes, 2)
  })
})

describe('目标由授权决定，不由模型决定', () => {
  it('新评论目标里带帖子 id，且形态是楼层', () => {
    const { ref, target } = targetFor(authorization())
    assert.equal(ref.threadId, THREAD)
    assert.equal(target.threadId, THREAD)
    assert.equal(target.targetKind, 'floor')
    assert.equal(target.nestedReplyId, undefined)
  })

  it('回复目标带上楼层与目标评论', () => {
    const { target } = targetFor(
      authorization({ capability: 'comment.reply', authorizedFloorId: FLOOR, replyToPostId: NESTED }),
    )
    assert.equal(target.floorPostId, FLOOR)
    assert.equal(target.nestedReplyId, NESTED)
    assert.equal(target.targetKind, 'nested')
  })

  it('新评论不会继承上一次回复留下的父级 id', () => {
    const { target } = targetFor(authorization())
    assert.equal(target.floorPostId, undefined)
    assert.equal(target.nestedReplyId, undefined)
  })
})

function ThreadRefFor(): ThreadRef {
  return { platform: 'tieba', threadId: THREAD, url: `https://tieba.baidu.com/p/${THREAD}` }
}
