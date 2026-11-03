/**
 * The whole journey, offline, from a real captured page to a simulated publish.
 *
 * ## What this file is, and is not
 *
 * It is a proof that the *pipeline* carries identity correctly end to end: real
 * captured HTML → timeline → owner resolution → target → candidates → workbench →
 * human edit → approval → pre-publish checks → a fake platform receiving the reply.
 *
 * It is **not** a proof that anything works on Tieba. No network call is made, no
 * cookie is read, and the publish target is a fake adapter that records what it was
 * asked to do. The HTML is a historical capture of a *different* thread than the
 * disputed one, so it demonstrates that the parser survives that shape — nothing
 * more.
 *
 * ## The five things it has to show
 *
 * 1. A partial read is never presented as a complete one.
 * 2. An uncertain identity is never silently upgraded to "the owner".
 * 3. Editing a candidate invalidates the earlier approval.
 * 4. An identity conflict cannot be cleared by approving again.
 * 5. A legitimate candidate *can* complete the entire simulated path.
 *
 * Point 5 is the reason the file exists. A suite that only proves refusals cannot
 * tell "correctly strict" from "permanently broken".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseWapFloors, parseWapThreadMeta, parseCommentPage } from '../lib/platforms/tieba/parse.js'
import { collectThread } from '../lib/collector.js'
import { analyzeDispute } from '../lib/analyzer.js'
import { deriveWorkbenchState } from '../lib/workbench.js'
import { DebateStore } from '../lib/store.js'
import { publishCandidate, resetInFlight } from '../lib/publisher.js'
import { grantApproval } from './helpers.ts'
import { assessmentFingerprint } from '../lib/security/security-policy.js'
import { contentHash } from '../lib/target.js'
import type { Floor, NestedReply, PlatformAdapter, Thread } from '../lib/types.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')

/** The real captured WAP page. Never modified; only read. */
function wapHtml(): string {
  return readFileSync(join(FIXTURES, 'wap-page1.html'), 'utf8')
}

/** The real captured comment page, from a different thread than the disputed one. */
function commentHtml(): string {
  return readFileSync(join(FIXTURES, 'comment-page1.html'), 'utf8')
}

// ── 0. what the real fixtures actually contain ─────────────────────────────

test('真实夹具：WAP 页给出 29 层，作者字段是登录名（un）而不是数字 ID', () => {
  const html = wapHtml()
  const meta = parseWapThreadMeta(html)
  const parsed = parseWapFloors(html)

  assert.ok(meta.forumId !== undefined, '必须读出吧 id')
  assert.equal(parsed.length >= 1, true, '必须至少读到一层')
  assert.equal(parsed.length, 29, `实测是 29 层，实际 ${parsed.length}`)

  const first = parsed[0]!.floor
  // The fact this whole release turns on: the surface publishes `un`, not a uid.
  assert.equal(first.authorId, '似水蓝蝶')
  assert.equal(first.authorNumericUid, undefined, 'WAP 页不提供数字 uid')
  assert.equal(first.authorSource, 'wap_floor', '必须标明来源')
})

test('真实夹具：comment page 只有昵称，没有任何账号标识', () => {
  // If this ever changes, the whole "a nickname cannot identify" rule needs revisiting.
  const parsed = parseCommentPage(commentHtml(), '133529333135')
  assert.equal(parsed.replies.length, 10)

  for (const entry of parsed.replies) {
    assert.equal(entry.reply.authorNumericUid, undefined, '回复页不提供数字 uid')
    assert.equal(entry.reply.authorSource, 'comment_page')
  }

  // Measured against the shipped capture: most rows leave `username` blank and get
  // no `authorId` at all. A handful carry a real login name — and on at least one of
  // those the login name happens to *equal* the display name (`羽绫观月`), which is
  // why "authorId equals authorName" cannot be used as proof of invention. What the
  // parser must guarantee is the weaker, checkable claim: it never fills `authorId`
  // on rows whose `username` is blank.
  const blankRows = parsed.replies.filter((entry) => entry.reply.authorId === undefined)
  assert.ok(
    blankRows.length > 0,
    '必须在 username 为空的行上留下 undefined，而不是退回昵称',
  )
})

// ── a fake platform built from the real capture ────────────────────────────

/**
 * A platform that serves the captured WAP page, plus a floor's replies.
 *
 * `complete: false` is used for the partial-read case: the adapter declares fewer
 * replies than the page claims, which is exactly the shape a rate-limited read has.
 */
function adapterFromCapture(input: {
  floors: readonly Floor[]
  nested: Readonly<Record<string, readonly NestedReply[]>>
  declaredNested?: number
  /** Make every nested page claim there might be more. */
  moreNested?: boolean
  counters: { publishReply: number; reads: number }
}): PlatformAdapter {
  const thread: Thread = {
    platform: 'tieba',
    forum: { platform: 'tieba', id: '24342155', name: '似水蓝蝶' },
    id: '8752343543',
    title: '捕获页测试帖',
    content: input.floors[0]?.content ?? '正文',
    authorId: input.floors[0]?.authorId,
    authorName: input.floors[0]?.authorName ?? '楼主',
    authorSource: 'wap_floor',
    url: 'https://tieba.baidu.com/p/8752343543',
    images: [],
  }

  const published = new Map<string, { text: string; authorId: string; authorName: string }>()

  return {
    platform: 'tieba',
    async getThread() {
      input.counters.reads += 1
      return thread
    },
    async getReplies() {
      input.counters.reads += 1
      return {
        floors: input.floors,
        hasMore: false,
        page: 1,
        declaredTotal: input.floors.length,
        declaredTotalPages: 1,
      }
    },
    async getNestedReplies(_ref: unknown, floor: Floor, page: number) {
      input.counters.reads += 1
      const all = input.nested[floor.postId] ?? []
      return {
        replies: page === 1 ? all : [],
        // Keep promising more even on the empty page. That is what a rate-limited
        // paginator looks like: it declares a total, then serves nothing while still
        // saying the walk is not over.
        hasMore: input.moreNested === true,
        page,
        ...(input.declaredNested === undefined ? {} : { declaredTotal: input.declaredNested }),
      }
    },
    async getReplyContext(_ref: unknown, postId: string) {
      input.counters.reads += 1
      const mine = published.get(postId)
      const floor = input.floors[0]!
      const nestedEntry = mine !== undefined
        ? {
            platform: 'tieba' as const,
            postId,
            parentPostId: floor.postId,
            authorId: mine.authorId,
            authorName: mine.authorName,
            authorSource: 'wap_inline' as const,
            content: mine.text,
            relationUncertain: false,
          }
        : (input.nested[floor.postId] ?? []).find((entry) => entry.postId === postId)

      return {
        thread,
        floor,
        ...(nestedEntry === undefined ? {} : { nested: nestedEntry }),
        ancestors: [],
        siblings: [],
      }
    },
    async checkAuthentication() {
      return {
        authenticated: true,
        userId: '1001',
        userName: 'ai-account',
        checkedAt: new Date().toISOString(),
      }
    },
    async publishReply(_target: unknown, content: string) {
      input.counters.publishReply += 1
      const postId = 'published-ok'
      published.set(postId, { text: content, authorId: '1001', authorName: 'ai-account' })
      return { status: 'confirmed', postId }
    },
  } as unknown as PlatformAdapter
}

/** Build floors from the real capture, plus a hand-marked reply fixture. */
function captureFixture(parts: {
  ownerHandle: string
  replyAuthorHandle?: string
  replyAuthorSource?: 'wap_inline' | undefined
}): { floors: Floor[]; nested: Record<string, NestedReply[]> } {
  const parsed = parseWapFloors(wapHtml())
  // The first two floors, as recorded. Their `authorId` values are the page's own.
  const floors = parsed.slice(0, 2).map((entry) => ({ ...entry.floor }))
  const anchor = floors[0]!
  // The capture's own `data-list-count` is not used here: this fixture supplies the
  // replies itself, so the floor has to declare how many it is about to serve or the
  // collector will not look for them.
  floors[0] = { ...anchor, nestedCount: 2 }

  const replies: NestedReply[] = [
    {
      platform: 'tieba',
      postId: '990001',
      parentPostId: anchor.postId,
      // A *marked simulation*: this handle is not in the capture. The test says so
      // rather than presenting synthetic data as if it were scraped.
      authorId: parts.ownerHandle,
      authorName: '主人显示名',
      ...(parts.replyAuthorSource === undefined ? {} : { authorSource: parts.replyAuthorSource }),
      content: '这个方案我认为不可行，成本会翻倍。',
      relationUncertain: false,
    },
    {
      platform: 'tieba',
      postId: '990002',
      parentPostId: anchor.postId,
      authorId: parts.replyAuthorHandle ?? '对手_hand',
      authorName: '对手显示名',
      ...(parts.replyAuthorSource === undefined ? {} : { authorSource: parts.replyAuthorSource }),
      content: '回复 主人显示名 :你凭什么说成本会翻倍？有数据吗？',
      replyToName: '主人显示名',
      relationUncertain: false,
    },
  ]

  return { floors, nested: { [anchor.postId]: replies } }
}

// ── 1. partial read ────────────────────────────────────────────────────────

test('部分读取不会被当成完整读取', async () => {
  const { floors, nested } = captureFixture({ ownerHandle: '似水蓝蝶' })
  const counters = { publishReply: 0, reads: 0 }
  const adapter = adapterFromCapture({
    floors,
    nested,
    // The page declares two replies; the adapter serves both but says there may be
    // more. A read that believes "hasMore" is complete is the bug this checks.
    moreNested: true,
    declaredNested: 5,
    counters,
  })

  const collected = await collectThread(adapter, {
    platform: 'tieba',
    threadId: '8752343543',
    forumName: '似水蓝蝶',
    url: 'https://tieba.baidu.com/p/8752343543',
  })

  // `collected.complete` is the *source* verdict (did the platform prove an end?).
  // The nested facts live in `completeness`, and that is where a truncated reply walk
  // has to show up — otherwise the page would say "read" while replies were missing.
  assert.equal(collected.completeness.nestedComplete, false, '楼中楼没读全时不能自称完整')
  assert.equal(collected.completeness.analysisComplete, false, '分析所需的数据也不完整')
})

test('部分读取：工作台把缺失证据摆出来，而不是显示“就绪”', () => {
  const state = deriveWorkbenchState({
    session: undefined,
    approvalApplies: false,
    gaps: [
      { kind: 'nested_incomplete', detail: '楼中楼没有读全，可能漏掉了主人的发言' },
    ],
  } as never)

  assert.equal(state.step, 'link')
  assert.equal(state.missingEvidence.length, 1, '缺失证据必须出现在页面上')
})

// ── 2. uncertain identity ─────────────────────────────────────────────────

test('不确定的身份不会被自动确认为主人', async () => {
  // The replies carry NO `authorSource`, which is the legacy shape. The owner is
  // configured by handle and it *does* match the text — and that is exactly the
  // temptation: a string match that proves nothing about which namespace it is in.
  const { floors, nested } = captureFixture({ ownerHandle: 'silver_fox' })
  const counters = { publishReply: 0, reads: 0 }
  const adapter = adapterFromCapture({ floors, nested, counters })

  const collected = await collectThread(adapter, {
    platform: 'tieba',
    threadId: '8752343543',
    forumName: '似水蓝蝶',
    url: 'https://tieba.baidu.com/p/8752343543',
  })

  const dispute = analyzeDispute(collected, { handle: 'silver_fox' }, { postId: '990001' })

  assert.equal(dispute.ownerIdentityAssurance, 'unverified', '旧格式记录不能算已核验')
  assert.equal(dispute.ownerIdentityEvidence.kind, 'legacy')
  assert.ok(
    dispute.notes.some((note) => /旧格式|未核验|legacy/.test(note)),
    '必须留下可读的说明',
  )
})

test('不确定的身份：工作台显示 legacy_unknown，而不是灰色按钮', async () => {
  const { floors, nested } = captureFixture({ ownerHandle: 'silver_fox' })
  const counters = { publishReply: 0, reads: 0 }
  const adapter = adapterFromCapture({ floors, nested, counters })
  const collected = await collectThread(adapter, {
    platform: 'tieba',
    threadId: '8752343543',
    forumName: '似水蓝蝶',
    url: 'https://tieba.baidu.com/p/8752343543',
  })
  const dispute = analyzeDispute(collected, { handle: 'silver_fox' }, { postId: '990001' })

  const state = deriveWorkbenchState({
    session: {
      ...sessionStub(),
      ownerIdentityAssurance: dispute.ownerIdentityAssurance,
      ownerIdentityEvidence: dispute.ownerIdentityEvidence,
    },
    approvalApplies: false,
  } as never)

  assert.equal(state.ownerIdentity.state, 'legacy_unknown')
  assert.equal(state.ownerIdentity.blocking, true)
  assert.match(state.ownerIdentity.detail, /旧会话|旧格式|重新分析/)
})

// ── 3-5: the write path ───────────────────────────────────────────────────

const REPLY_TEXT = '你这条论据没有出处，我不同意这个结论。'

/** A ready session shaped like one the pipeline would have written. */
function sessionStub(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's-flow',
    platform: 'tieba',
    threadId: '8752343543',
    threadUrl: 'https://tieba.baidu.com/p/8752343543',
    threadTitle: '捕获页测试帖',
    forumName: '似水蓝蝶',
    ownerKey: '主人显示名',
    ownerName: '主人显示名',
    opponentKey: '对手显示名',
    opponentName: '对手显示名',
    opponentUserId: '对手_hand',
    disputeFloorPostId: '133529333135',
    disputeFloorNumber: 1,
    triggerPostId: '990002',
    targetKind: 'nested',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  }
}

/** A candidate whose snapshot matches what the fake adapter will report. */
function candidateStub(text: string): Record<string, unknown> {
  return {
    replyId: 'c1',
    text,
    strategy: 'direct_rebuttal',
    targetPostId: '990002',
    targetSnapshot: {
      platform: 'tieba',
      threadId: '8752343543',
      floorPostId: '133529333135',
      floorNumber: 1,
      nestedReplyId: '990002',
      targetPostId: '990002',
      targetKind: 'nested',
      targetAuthorId: '对手_hand',
      targetAuthorName: '对手显示名',
      contentHash: contentHash('回复 主人显示名 :你凭什么说成本会翻倍？有数据吗？'),
      capturedAt: new Date().toISOString(),
    },
    candidateVersion: 1,
    needsConfirmation: false,
    violations: [],
    approved: false,
    security: {
      injectionDetected: false,
      ownerIdentityValid: true,
      targetIdentityValid: true,
      stanceConsistency: 'consistent',
      ownerDirectedAttack: false,
      unauthorizedInstructionFollowed: false,
      secretLeakRisk: false,
      evidenceIntegrityValid: true,
      decision: 'allow',
      reasons: [],
      semanticSettled: true,
      fingerprint: assessmentFingerprint({ reply: text, targetPostId: '990002', decision: 'allow' }),
    },
    semanticSettled: true,
    createdAt: new Date().toISOString(),
  }
}

const VERIFIED = {
  ownerIdentityAssurance: 'verified' as const,
  // Evidence with a source: a login name a surface actually declared.
  ownerIdentityEvidence: { kind: 'handle' as const, value: '似水蓝蝶', source: 'wap_floor' as const },
}

const POLICY = {
  mode: 'manual' as const,
  maxAutoPublishesPerSession: 0,
  cooldownMs: 0,
  maxPublishesPerThread: 10,
  stopOnChallenge: true,
}

const CONFIG = {
  ownerUserId: '',
  ownerHandle: '似水蓝蝶',
  ownerUserName: '主人显示名',
  aiAccountUserId: '1001',
  aiAccountName: 'ai-account',
  allowedOwnerIds: '',
}

/** Run one publish through the real publisher against the capture adapter. */
async function publishOnce(parts: {
  session: Record<string, unknown>
  counters: { publishReply: number; reads: number }
  approvedText?: string
  text?: string
  withApproval?: boolean
}): Promise<{ ok: boolean; errorCode?: string; message?: string }> {
  resetInFlight()
  const { floors, nested } = captureFixture({ ownerHandle: '似水蓝蝶', replyAuthorSource: 'wap_inline' })
  const adapter = adapterFromCapture({ floors, nested, counters: parts.counters })
  const dir = mkdtempSync(join(tmpdir(), 'p23-flow-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    await store.mutate((data) => ({ ...data, sessions: [parts.session as never] }))

    if (parts.withApproval !== false) {
      await grantApproval(store, {
        sessionId: String(parts.session.id),
        candidateId: 'c1',
        ...(parts.approvedText === undefined ? {} : { text: parts.approvedText }),
        config: () => CONFIG as never,
      })
    }

    const report = await publishCandidate(
      {
        adapter,
        store,
        policy: POLICY,
        config: () => CONFIG as never,
        llm: () => {
          throw new Error('not used')
        },
        log: () => undefined,
      } as never,
      {
        sessionId: String(parts.session.id),
        candidateId: 'c1',
        approvedText: parts.text ?? parts.approvedText ?? REPLY_TEXT,
      } as never,
    )
    return {
      ok: report.ok,
      ...(report.errorCode === undefined ? {} : { errorCode: report.errorCode }),
      ...(report.message === undefined ? {} : { message: report.message }),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('3. 修改候选会使旧批准失效', async () => {
  const counters = { publishReply: 0, reads: 0 }
  const session = sessionStub({
    ...VERIFIED,
    candidates: [candidateStub('改写之后的正文。')],
  })

  const result = await publishOnce({
    session,
    counters,
    // The human approved the *old* text; the stored candidate is now different.
    approvedText: REPLY_TEXT,
    text: '改写之后的正文。',
  })

  assert.equal(result.ok, false, '旧批准不能授权新正文')
  assert.equal(counters.publishReply, 0, '平台一次都不能被调用')
})

test('4. 身份冲突不能通过再次批准来解除', async () => {
  const counters = { publishReply: 0, reads: 0 }
  const session = sessionStub({
    ...VERIFIED,
    candidates: [candidateStub(REPLY_TEXT)],
    identityConflicts: [
      { postId: '990002', summary: '两个来源把同一条回复判给了不同的登录名' },
    ],
  })

  const result = await publishOnce({ session, counters, text: REPLY_TEXT })

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'identity_conflict')
  assert.notEqual(result.errorCode, 'approval_required', '理由必须是身份，不是缺批准')
  assert.equal(counters.publishReply, 0)
})

test('5. 合法候选可以走完整条模拟发表路径', async () => {
  const counters = { publishReply: 0, reads: 0 }
  const session = sessionStub({
    ...VERIFIED,
    candidates: [candidateStub(REPLY_TEXT)],
  })

  const result = await publishOnce({ session, counters, text: REPLY_TEXT })

  assert.equal(result.ok, true, `合法候选必须能走通，实际：${result.errorCode ?? ''} ${result.message ?? ''}`)
  assert.equal(counters.publishReply, 1, '恰好一次')
})

test('5b. 走通之后工作台显示已在发表步骤，且身份仍是 verified', async () => {
  const session = sessionStub({
    ...VERIFIED,
    candidates: [candidateStub(REPLY_TEXT)],
  })
  const state = deriveWorkbenchState({ session: session as never, approvalApplies: true } as never)

  assert.equal(state.step, 'publish')
  assert.equal(state.ownerIdentity.state, 'verified')
  assert.equal(state.ownerIdentity.blocking, false)
})
