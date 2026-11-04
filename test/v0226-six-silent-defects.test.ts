/**
 * The six silent defects v0.2.26 exists to fix, each pinned by the symptom it produced.
 *
 * ## Why one file, and why these six
 *
 * They were found by driving the real page, not by reading the code, and every one of them
 * had the same shape: **the UI looked fine and the action did nothing**. No exception, no
 * error toast, no red state — a button that could be clicked and had no effect, or a value
 * that was written but never applied. Unit tests had not caught them because each one lived
 * in the seam between two modules that were individually correct.
 *
 * | # | Symptom the owner saw |
 * |---|---|
 * | 1 | 「用这条」「生成候选」「发表」点了没反应 |
 * | 2 | 选好对手的评论后点生成，被拒绝说「找不到对手」 |
 * | 3 | 生成成功，候选正文是空的 |
 * | 4 | 编辑一次正文后，再也无法批准或发表 |
 * | 5 | 批准记录写了，页面却不前进到发表 |
 * | 6 | 批准后发表永远说「正文内容已变」 |
 *
 * Defects 3 and 5/6 are pinned in `v0222-workbench-edit.test.ts` and
 * `v0226-approval-hash-namespace.test.ts` respectively, where the surrounding machinery
 * already exists; this file covers the ones whose failure mode is a *missing* field or a
 * wrong branch, which is only visible from the outside.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { analyzeDispute } from '../lib/analyzer.js'
import type { CollectedThread } from '../lib/collector.js'
import type { StoredCandidate, StoredSession } from '../lib/store.js'
import type { Floor, NestedReply, Thread } from '../lib/types.js'
import { approvalStillApplies, deriveWorkbenchState } from '../lib/workbench.js'
import { makeFloor, makeNested } from './helpers.ts'

const NOW = '2026-11-04T00:00:00.000Z'

function collected(
  thread: Thread,
  floors: readonly Floor[],
  nested: Readonly<Record<string, readonly NestedReply[]>>,
): CollectedThread {
  return {
    thread,
    floors: floors.map((floor) => ({
      floor,
      nested: nested[floor.postId] ?? [],
      nestedComplete: true,
    })),
    complete: true,
    // The separated verdicts a v0.2.2+ read always carries. The fixture is a complete read
    // by construction, so every part is true and there are no reasons to report.
    completeness: {
      sourceComplete: true,
      retainedComplete: true,
      analysisComplete: true,
      nestedComplete: true,
      reasons: [],
    },
    issues: [],
  }
}

function makeThread(id = '1'): Thread {
  return {
    platform: 'tieba',
    forum: { platform: 'tieba', id: '9', name: '测试吧' },
    id,
    title: '测试帖',
    content: '正文',
    url: `https://tieba.baidu.com/p/${id}`,
    images: [],
  }
}

function candidate(overrides: Partial<StoredCandidate> = {}): StoredCandidate {
  return {
    replyId: 'c1',
    text: '你这条把两件事混为一谈了。',
    strategy: 'tieba_veteran',
    targetPostId: 'p-2',
    targetSnapshot: {
      platform: 'tieba',
      threadId: 't1',
      floorPostId: 'p-1',
      floorNumber: 1,
      targetPostId: 'p-2',
      targetKind: 'nested',
      targetAuthorId: 'opp-1',
      targetAuthorName: '对手B',
      contentHash: 'h',
      capturedAt: NOW,
    } as never,
    candidateVersion: 1,
    textHash: 'hash-a',
    confidence: 0.8,
    violations: [],
    notes: [],
    createdAt: NOW,
    approved: true,
    ...overrides,
  }
}

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 's1',
    platform: 'tieba',
    threadId: 't1',
    threadUrl: 'https://tieba.baidu.com/p/1',
    threadTitle: '讨论',
    forumName: '区',
    ownerKey: 'owner-1',
    ownerIdentityAssurance: 'verified' as const,
    ownerIdentityEvidence: { kind: 'handle' as const, value: 'owner-1', source: 'wap_floor' as const },
    disputeFloorPostId: 'p-1',
    disputeFloorNumber: 1,
    triggerPostId: 'p-2',
    targetKind: 'nested',
    state: 'REVIEWING',
    statusText: '已生成候选',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 300 },
    candidates: [candidate()],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ── 1. WorkbenchState carried no session id ─────────────────────────────────
//
// The three action buttons are `disabled: !wb.sessionId`. With the field absent the
// expression was permanently true, so every control rendered disabled — and a disabled
// button still takes a click without complaint. That is why this read as "nothing
// happens" rather than "this is unavailable".

test('缺陷 1：工作台状态必须带上 sessionId，否则三个按钮永远点不动', () => {
  const state = deriveWorkbenchState({ session: session(), approvalApplies: true })
  assert.equal(
    state.sessionId,
    's1',
    'sessionId 缺失时按钮的 disabled 恒为真：能点、点了什么也不发生',
  )
})

test('缺陷 1：没有会话时也不能编一个 sessionId 出来', () => {
  // The fix must not be "always emit some string". With no session there is nothing to act
  // on, and a made-up id would let the page post an action against a session that does not
  // exist — a different silent failure with the same face.
  const state = deriveWorkbenchState({ approvalApplies: false })
  assert.equal(state.sessionId, undefined, '没有会话就没有 id，让按钮如实不可用')
})

// ── 2. The trigger author was treated as "not the opponent" ─────────────────
//
// When the post the owner picked to answer was written by someone other than the owner,
// the analyzer still ran `pickOpponent` (who has the owner replied to before?), which can
// return nobody. The result was a refusal saying it could not find an opponent — for a
// comment the owner had just clicked.

test('缺陷 2：触发帖不是主人写的时，对手就是触发帖作者，不走「以前回复过谁」', () => {
  const floorPostId = '700'
  const nested = [
    makeNested({ postId: 'a1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '这个方案成本会翻倍。' }),
    // 对手B writes the reply the owner is answering, and the owner has never replied to B
    // before — so an interaction-based pick has nothing to go on.
    makeNested({ postId: 'b1', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '成本根本没你说的那么高。' }),
  ]
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 1, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length })],
    { [floorPostId]: nested },
  )

  const dispute = analyzeDispute(data, { userId: 'o' }, { postId: 'b1' })
  assert.notEqual(dispute.opponent, undefined, '选了别人的评论，对手必须就是那个人，而不是「找不到」')
  assert.equal(dispute.opponent?.displayName, '对手B')
  assert.notEqual(dispute.opponent?.key, dispute.owner.key, '不能把主人自己当成对手')
})

test('缺陷 2：触发帖就是主人自己写的时，仍走原来的对手推断', () => {
  // The fix is a special case, and a special case that swallows the normal one is a worse
  // bug than the one it fixes: the owner's own floor must still resolve an opponent from
  // the exchange, not from "the author of this post", which would be the owner.
  const floorPostId = '701'
  const nested = [
    makeNested({ postId: 'a1', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '回复 对手B :前面贴过报价了。', replyToName: '对手B' }),
    makeNested({ postId: 'b1', parentPostId: floorPostId, authorId: 'b', authorName: '对手B', content: '回复 主人 :那报价是同型号吗？', replyToName: '主人' }),
    makeNested({ postId: 'a2', parentPostId: floorPostId, authorId: 'o', authorName: '主人', content: '回复 对手B :同型号。', replyToName: '对手B' }),
  ]
  const data = collected(
    makeThread(),
    [makeFloor({ floorNumber: 1, postId: floorPostId, authorId: 'o', authorName: '主人', content: '开场', nestedCount: nested.length })],
    { [floorPostId]: nested },
  )

  const dispute = analyzeDispute(data, { userId: 'o' }, { postId: 'a2' })
  assert.equal(dispute.opponent?.displayName, '对手B', '主人自己发的帖，对手仍要从往来里推断')
  assert.notEqual(dispute.opponent?.key, dispute.owner.key, '更不能把主人自己当对手')
})

// ── 5 & 6. Approval: the flag, and the hash namespace ───────────────────────
//
// Two separate faults met in the same flow. (5) the approval record was written but the
// candidate's own `approved` flag was not set, so the page never advanced past the approve
// step. (6) the record stored `hashText` (64 hex, raw bytes) while the card compared it with
// `contentHash` (32 hex, normalised) — every approval therefore read as 「正文内容已变」 one
// screen after being granted, and the publish button never appeared.

test('缺陷 5：候选没有 approved 标记时，批准不算生效', () => {
  const state = deriveWorkbenchState({
    session: session({ candidates: [candidate({ approved: false })] }),
    approvalApplies: false,
  })
  assert.notEqual(state.step, 'publish', '候选没被标记批准，页面不能跳到发表')
})

test('缺陷 6：批准记录用 hashText、候选用 contentHash，两者必须能比对上', () => {
  // 64-hex approval record against a 32-hex candidate hash is the *real* shape after the
  // fix: the comparison normalises both sides instead of requiring them to be equal strings.
  const full = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const result = approvalStillApplies({
    candidate: candidate({ approved: true, textHash: full.slice(0, 32), candidateVersion: 1 }),
    approval: { candidateId: 'c1', candidateVersion: 1, textHash: full, targetPostId: 'p-2' },
  })
  assert.equal(
    result.applies,
    true,
    `同一个正文的两种哈希必须能对上，否则批准永远报「正文内容已变」：${result.reason}`,
  )
})

test('缺陷 6：换了正文，两种哈希都必须判为不等', () => {
  const result = approvalStillApplies({
    candidate: candidate({ approved: true, textHash: 'ffffffffffffffffffffffffffffffff', candidateVersion: 1 }),
    approval: {
      candidateId: 'c1',
      candidateVersion: 1,
      textHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      targetPostId: 'p-2',
    },
  })
  assert.equal(result.applies, false, '正文变了还判为有效，等于批准可以覆盖任意内容')
})

test('批准的四要素任何一项变了都要重新批准', () => {
  const approval = { candidateId: 'c1', candidateVersion: 1, textHash: 'hash-a', targetPostId: 'p-2' }
  assert.equal(approvalStillApplies({ candidate: candidate(), approval }).applies, true, '都不变时必须有效')
  assert.equal(
    approvalStillApplies({ candidate: candidate({ candidateVersion: 2 }), approval }).applies,
    false,
    '候选版本变了，旧批准必须失效',
  )
  assert.equal(
    approvalStillApplies({ candidate: candidate({ targetPostId: 'p-3' }), approval }).applies,
    false,
    '目标变了，旧批准必须失效',
  )
  assert.equal(
    approvalStillApplies({ candidate: candidate({ replyId: 'c2' }), approval }).applies,
    false,
    '换了一条候选，旧批准必须失效',
  )
})

// ── 3. The model broke the contract and an empty candidate was stored ────────
//
// `generateDraft` retries an unparseable answer and then reports `violations` with `draft`
// left undefined. The runtime stored `reply ?? ''`, answered `ok: true`, and the page listed
// a normal-looking candidate whose body was empty. The owner approved it and the gate then
// refused an empty reply — so the failure was real, and only its report was wrong.

test('缺陷 3：模型输出不符合契约时，必须报错且不写候选，而不是存一个空草稿', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DebateStore } = await import('../lib/store.js')
  const { DEFAULT_CONFIG, resolveConfig } = await import('../lib/config.js')
  const { ScriptedLlmClient } = await import('../lib/llm.js')
  const { runAnalysis, runGeneration } = await import('../lib/runtime.js')
  const { FakeAdapter, threePartyThread } = await import('./helpers.ts')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0226-empty-'))
  try {
    const store = new DebateStore({ dir })
    const data = threePartyThread({ authorSource: 'wap_inline' })
    const config = resolveConfig({
      ...DEFAULT_CONFIG,
      ownerHandle: 'owner-1',
      aiAccountUserId: '1001',
      llmBaseUrl: 'http://127.0.0.1:1/v1',
      llmModel: 'test-model',
    })
    // Prose instead of the JSON contract, twice: the generator retries once, so both
    // attempts must miss for the "no draft" path to be reached.
    const prose = new ScriptedLlmClient([
      { text: '我觉得对方说的不对，应该反驳他的成本论点。' },
      { text: '我坚持我的看法：成本没有那么高。' },
    ])
    const runtime = {
      adapter: new FakeAdapter(data),
      store,
      policy: {
        mode: 'manual',
        maxAutoPublishesPerSession: 0,
        cooldownMs: 0,
        maxPublishesPerThread: 10,
        stopOnChallenge: true,
      },
      config: () => config,
      llm: () => prose,
      log: () => undefined,
    } as never

    const analyzed = await runAnalysis(runtime, { url: data.thread.url, postId: 'n7' })

    let threw = ''
    try {
      await runGeneration(runtime, { sessionId: analyzed.sessionId })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }

    assert.match(
      threw,
      /没有生成候选/,
      `模型违约时必须报错，让调用方知道没有生成；实际：${threw === '' ? '（没有抛错，说明它"成功"了）' : threw}`,
    )

    const stored = store.getSession(analyzed.sessionId)
    assert.equal(
      (stored?.candidates ?? []).length,
      0,
      '不能留下一个正文为空的候选——它看起来正常，点批准时才被闸门拒绝',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── The page described a different publish than the one it performed ─────────
//
// Found while checking the failure path: the workbench read `session.targetKind` (how the
// session was summoned — a floor post) while the publish path read the candidate's snapshot
// (the comment the owner picked). So a nested reply was displayed as `kind=floor`, and the
// capability row said `comment.publish` — which made the `comment.reply` verification the
// owner had just completed look like it did not count. The page and the network disagreed
// about what was being sent, and the page was the one that was wrong.

test('目标形态必须按候选快照显示，而不是按会话被召唤时的形态', () => {
  const state = deriveWorkbenchState({
    session: session({
      // Summoned by a floor post, so the session says `floor`…
      targetKind: 'floor',
      candidates: [
        candidate({
          targetPostId: 'p-2',
          // …but the owner picked a nested comment, and that is what the publish path reads.
          targetSnapshot: {
            platform: 'tieba',
            threadId: 't1',
            floorPostId: 'p-1',
            floorNumber: 1,
            targetPostId: 'p-2',
            targetKind: 'nested',
            targetAuthorId: 'opp-1',
            targetAuthorName: '对手B',
            contentHash: 'h',
            capturedAt: NOW,
          } as never,
        }),
      ],
    }),
    approvalApplies: true,
  })

  assert.equal(
    state.target?.kind,
    'nested',
    '候选快照说是楼中楼，页面就必须显示楼中楼——否则页面描述的发表和真正发出去的不是同一件事',
  )
  assert.equal(state.target?.postId, 'p-2', '目标 id 也要来自候选，不是会话的触发帖')
})

test('没有快照的旧候选回退到会话形态，不凭空断言', () => {
  // Candidates written before snapshots existed have nothing better to offer. Falling back
  // to the session is honest; guessing `nested` would be inventing a fact.
  const state = deriveWorkbenchState({
    session: session({
      targetKind: 'floor',
      candidates: [candidate({ targetSnapshot: undefined })],
    }),
    approvalApplies: true,
  })
  assert.equal(state.target?.kind, 'floor', '没有快照时用会话形态，这是唯一有的信息')
})
