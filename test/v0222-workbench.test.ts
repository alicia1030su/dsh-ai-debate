/**
 * The workbench derivation (v0.2.22 §一/§二/§五/§八).
 *
 * ## What is actually being tested here
 *
 * Not the rendering — that comes later and is tested against the DOM. What is tested is the set
 * of rules that decide **whether an irreversible action may be offered**, and the one rule that
 * makes editing safe: an approval authorizes bytes, so changing the bytes (or the target, or the
 * version) must retire it.
 *
 * These are cheap to test and expensive to get wrong: every assertion below corresponds to a way
 * the workbench could tell an owner "you may publish this" when they may not.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { StoredCandidate, StoredSession } from '../lib/store.js'
import {
  approvalStillApplies,
  deriveWorkbenchState,
  workbenchDiagnostics,
  type MissingEvidence,
} from '../lib/workbench.js'

const NOW = '2026-10-31T12:00:00.000Z'

function candidate(overrides: Partial<StoredCandidate> = {}): StoredCandidate {
  return {
    replyId: 'c1',
    text: '你这条把两件事混为一谈了：我反对的是做法，不是你这个人。',
    strategy: 'tieba_veteran',
    targetPostId: 'p-2',
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

describe('v0.2.22 §一：步骤由持久事实推导，不是存下来的字段', () => {
  it('什么都没有时停在「粘贴链接」，且不谎称已有目标', () => {
    const state = deriveWorkbenchState({ approvalApplies: false })
    assert.equal(state.step, 'link')
    assert.equal(state.counts.floors, 0)
    assert.equal(state.outcome, 'not_attempted')
  })

  it('有会话但没目标时停在「选目标」，并说明插件不按昵称猜', () => {
    const state = deriveWorkbenchState({
      session: session({ targetSnapshot: undefined, candidates: [] }),
      approvalApplies: false,
    })
    assert.equal(state.step, 'target')
    assert.match(state.blockers.join(''), /不会按昵称猜/)
  })

  it('有目标但没候选时停在「生成候选」', () => {
    const state = deriveWorkbenchState({
      session: session({ targetSnapshot: { threadId: 't1', floorPostId: 'p-1', postId: 'p-2', kind: 'nested', contentHash: 'h', capturedAt: NOW } as never, candidates: [] }),
      approvalApplies: false,
    })
    assert.equal(state.step, 'generate')
  })

  it('有候选但没批准时停在「批准」，并点明所有模式都要逐条批准', () => {
    const state = deriveWorkbenchState({
      session: session({ candidates: [candidate({ approved: false })] }),
      approvalApplies: false,
    })
    assert.equal(state.step, 'approve')
    assert.match(state.blockers.join(''), /逐条批准/)
  })

  it('批准有效时停在「发表」', () => {
    const state = deriveWorkbenchState({ session: session(), approvalApplies: true })
    assert.equal(state.step, 'publish')
    assert.equal(state.outcome, 'not_attempted')
  })

  it('步骤列表里链接与目标在合适时标记为已完成', () => {
    const state = deriveWorkbenchState({ session: session(), approvalApplies: true })
    const byId = Object.fromEntries(state.steps.map((step) => [step.id, step.status]))
    assert.equal(byId['link'], 'done')
    assert.equal(byId['target'], 'done')
    assert.equal(byId['publish'], 'current')
    assert.equal(byId['readback'], 'pending')
  })
})

describe('v0.2.22 §五：五种结果状态不能合并', () => {
  it('有 post id 但没回读 → 已发出未确认，不是成功', () => {
    const state = deriveWorkbenchState({
      session: session({ candidates: [candidate({ publishedPostId: 'r-1' })] }),
      approvalApplies: true,
    })
    assert.equal(state.outcome, 'sent_unconfirmed')
    assert.notEqual(state.step, 'done', '没回读就显示完成，等于把「发出去了」当成「发对了」')
  })

  it('回读确认后才算完成', () => {
    const state = deriveWorkbenchState({
      session: session({ state: 'PUBLISHED', candidates: [candidate({ publishedPostId: 'r-1' })] }),
      approvalApplies: true,
      lastAttempt: { status: 'confirmed' },
    })
    assert.equal(state.outcome, 'confirmed')
    assert.equal(state.step, 'done')
  })

  it('结果未知时停在回读，并明确不会自动重发', () => {
    const state = deriveWorkbenchState({
      session: session(),
      approvalApplies: true,
      lastAttempt: { status: 'uncertain', reason: 'socket hang up' },
    })
    assert.equal(state.outcome, 'unknown')
    assert.equal(state.step, 'readback')
    assert.match(state.blockers.join(''), /不会自动重发/)
  })

  it('平台明确拒绝时回到可编辑状态，并带上原因', () => {
    const state = deriveWorkbenchState({
      session: session(),
      approvalApplies: true,
      lastAttempt: { status: 'failed', reason: '403' },
    })
    assert.equal(state.outcome, 'refused')
    assert.equal(state.step, 'review')
    assert.match(state.blockers.join(''), /403/)
  })

  it('未知优先于「没有尝试过」：不能把可能已发出说成没发', () => {
    const state = deriveWorkbenchState({
      session: session({ state: 'PUBLISHING' }),
      approvalApplies: true,
    })
    assert.equal(state.outcome, 'sent_unconfirmed')
  })
})

describe('v0.2.22 §三：批准绑定字节，改动即失效', () => {
  it('正文改了，旧批准失效', () => {
    const result = approvalStillApplies({
      candidate: candidate({ textHash: 'hash-b' }),
      approval: { candidateId: 'c1', candidateVersion: 1, textHash: 'hash-a', targetPostId: 'p-2' },
    })
    assert.equal(result.applies, false)
    assert.match(result.reason, /正文/)
  })

  it('重新生成（版本变了）即使正文一样也失效', () => {
    const result = approvalStillApplies({
      candidate: candidate({ candidateVersion: 2, textHash: 'hash-a' }),
      approval: { candidateId: 'c1', candidateVersion: 1, textHash: 'hash-a' },
    })
    assert.equal(result.applies, false)
    assert.match(result.reason, /版本/)
  })

  it('目标变了，旧批准失效', () => {
    const result = approvalStillApplies({
      candidate: candidate({ targetPostId: 'p-3' }),
      approval: { candidateId: 'c1', candidateVersion: 1, textHash: 'hash-a', targetPostId: 'p-2' },
    })
    assert.equal(result.applies, false)
    assert.match(result.reason, /目标/)
  })

  it('批准绑的是另一条候选时失效', () => {
    const result = approvalStillApplies({
      candidate: candidate(),
      approval: { candidateId: 'c9' },
    })
    assert.equal(result.applies, false)
    assert.match(result.reason, /另一条候选/)
  })

  it('没有批准记录时是拒绝，不是默认通过', () => {
    const result = approvalStillApplies({ candidate: candidate() })
    assert.equal(result.applies, false)
  })

  it('三个字段都一致时才通过', () => {
    const result = approvalStillApplies({
      candidate: candidate(),
      approval: { candidateId: 'c1', candidateVersion: 1, textHash: 'hash-a', targetPostId: 'p-2' },
    })
    assert.equal(result.applies, true)
  })
})

describe('v0.2.22 §二/§八：缺失证据与脱敏诊断', () => {
  it('缺页/截断要作为缺失证据暴露，而不是补全成内容', () => {
    const gaps: MissingEvidence[] = [
      { what: '第 3 页', detail: '分页请求超时，这一页的回复没有被读到' },
    ]
    const state = deriveWorkbenchState({ session: session(), approvalApplies: true, gaps })
    assert.equal(state.missingEvidence.length, 1)
    assert.match(state.missingEvidence[0]!.detail, /没有被读到/)
  })

  it('计数取实际读取量，不取平台声称的回复数', () => {
    const state = deriveWorkbenchState({
      session: session({ declaredReplyCount: 999 } as never),
      approvalApplies: true,
      floorCount: 7,
      nestedCount: 12,
    })
    assert.equal(state.counts.floors, 7)
    assert.equal(state.counts.nested, 12)
  })

  it('诊断报告只带白名单字段，并显式声明脱敏范围', () => {
    const report = workbenchDiagnostics({
      platform: 'tieba',
      threadId: 't1',
      step: 'publish',
      outcome: 'not_attempted',
      counts: { floors: 3, nested: 5, candidates: 1 },
      faults: [{ kind: 'platform_refused', label: '平台拒绝访问', reason: '403', nextStep: '按平台域名确认' }],
    })
    // The `redacted` list names the sensitive fields, so it is excluded from the scan — it is a
    // declaration of intent, not data. Everything else must be free of credential shapes.
    const { redacted, ...payload } = report
    const text = JSON.stringify(payload)
    assert.doesNotMatch(text, /cookie|token|apiKey|Bearer/i, '诊断报告里不能出现凭据形状的字段值')
    assert.deepEqual(redacted, [
      'cookie',
      'token',
      'apiKey',
      'credential',
      'authorization',
      'set-cookie',
    ])
  })

  it('能力未达到 supported 时把原因摆在阻断项里，而不是让按钮看起来可用', () => {
    const state = deriveWorkbenchState({
      session: session(),
      approvalApplies: true,
      capability: { declared: 'unverified', effective: 'unverified', reason: '没有一条记录适用于这次发表' },
    })
    assert.match(state.blockers.join(''), /没有一条记录适用于这次发表/)
    assert.match(state.blockers.join(''), /验收也补不上/, '要说明权限缺失不能被验收补上')
  })
})
