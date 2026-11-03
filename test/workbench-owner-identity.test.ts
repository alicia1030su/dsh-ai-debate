/**
 * The workbench's view of the owner's identity.
 *
 * ## Why the page needs five states and not two
 *
 * v0.2.23's first pass surfaced a disabled button with no explanation. To the reader
 * that is indistinguishable from a broken tool, and the usual response is to retry
 * the same thing forever. Each state below gets its own sentence, because the fix
 * differs:
 *
 * - `conflict` — the data disagrees; approving again will not help.
 * - `legacy_unknown` — re-analyse, or configure a provable identifier.
 * - `unverified` — the identifier is too weak; use a login name or numeric id.
 * - `verified` — nothing to fix in identity; the target is still re-checked.
 * - `recheck_required` is expressed as `verified` + a notice, because it is the
 *   normal state of a ready page, not a failure.
 *
 * ## What is asserted about the client
 *
 * That the state the page renders comes from the backend's own derivation. The
 * client has no session access at all, so it cannot invent an identity claim — the
 * tests check that the field it reads is the one this module computes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { describeOwnerIdentity, deriveWorkbenchState } from '../lib/workbench.js'
import type { StoredSession } from '../lib/store.js'

/** A minimal READY session; individual tests override only what they are about. */
function session(parts: Partial<Record<string, unknown>> = {}): StoredSession {
  const text = '这是一条候选回复。'
  return {
    id: 's-view',
    platform: 'tieba',
    threadId: '9493941284',
    threadUrl: 'https://tieba.baidu.com/p/9493941284',
    threadTitle: '测试帖',
    forumName: '测试吧',
    ownerKey: '苏小玲',
    ownerName: '苏小玲',
    disputeFloorPostId: '900',
    disputeFloorNumber: 1,
    triggerPostId: 'r1',
    targetKind: 'nested',
    state: 'READY',
    statusText: '就绪',
    persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
    candidates: [
      {
        replyId: 'c1',
        text,
        strategy: 'direct_rebuttal',
        targetPostId: 'r1',
        targetSnapshot: {
          platform: 'tieba',
          threadId: '9493941284',
          floorPostId: '900',
          floorNumber: 1,
          nestedReplyId: 'r1',
          targetPostId: 'r1',
          targetKind: 'nested',
          targetAuthorId: 'opp_handle',
          targetAuthorName: '对手B',
          contentHash: 'h',
          capturedAt: new Date().toISOString(),
        },
        candidateVersion: 1,
        needsConfirmation: false,
        violations: [],
        approved: true,
        createdAt: new Date().toISOString(),
      },
    ],
    publishedPostIds: [],
    sentTexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...parts,
  } as unknown as StoredSession
}

// ── the five states ────────────────────────────────────────────────────────

test('已核验：有证据 → verified，不阻塞', () => {
  const view = describeOwnerIdentity(
    session({
      ownerIdentityAssurance: 'verified',
      ownerIdentityEvidence: { kind: 'handle', value: 'silver_fox', source: 'wap_floor' },
    }),
  )
  assert.equal(view.state, 'verified')
  assert.equal(view.blocking, false)
  assert.match(view.detail, /可核对|依据/)
})

test('只有标签没有证据：页面不得显示 verified', () => {
  // The same bypass as the gate, one layer up. A page that trusted the label would
  // show a green badge for a session that cannot actually publish.
  const view = describeOwnerIdentity(session({ ownerIdentityAssurance: 'verified' }))
  assert.notEqual(view.state, 'verified')
  assert.equal(view.blocking, true)
})

test('昵称证据：unverified，并说明该填什么', () => {
  const view = describeOwnerIdentity(
    session({
      ownerIdentityAssurance: 'unverified',
      ownerIdentityEvidence: { kind: 'nickname', value: '苏小玲' },
    }),
  )
  assert.equal(view.state, 'unverified')
  assert.equal(view.blocking, true)
  assert.match(view.detail, /登录名|数字 ID/, '必须告诉用户下一步怎么做')
  assert.match(view.evidence ?? '', /昵称/)
})

test('数字 UID 缺命名空间：unverified', () => {
  const view = describeOwnerIdentity(
    session({ ownerIdentityEvidence: { kind: 'numeric_uid', value: '348099763' } }),
  )
  assert.equal(view.state, 'unverified')
  assert.equal(view.blocking, true)
})

test('旧会话无证据字段：legacy_unknown，与 unverified 区分开', () => {
  const view = describeOwnerIdentity(session({}))
  assert.equal(view.state, 'legacy_unknown')
  assert.equal(view.blocking, true)
  assert.match(view.detail, /旧会话/)
})

test('身份冲突：conflict，并说明再批准也没用', () => {
  const view = describeOwnerIdentity(
    session({
      ownerIdentityAssurance: 'verified',
      ownerIdentityEvidence: { kind: 'handle', value: 'silver_fox', source: 'wap_floor' },
      identityConflicts: [{ postId: 'r1', summary: '两个来源给出了不同的登录名' }],
    }),
  )
  assert.equal(view.state, 'conflict', '冲突优先于其他一切')
  assert.equal(view.blocking, true)
  assert.match(view.detail, /批准/, '必须说清批准不能解除冲突')
  assert.match(view.evidence ?? '', /不同的登录名/)
})

test('无会话：unknown，并指向第一步', () => {
  const view = describeOwnerIdentity(undefined)
  assert.equal(view.state, 'unknown')
  assert.equal(view.blocking, true)
})

// ── wired into the workbench ───────────────────────────────────────────────

test('工作台：主人未核验时停在 review，并在 blockers 里说明原因', () => {
  const state = deriveWorkbenchState({
    session: session({ ownerIdentityEvidence: { kind: 'nickname', value: '苏小玲' } }),
    approvalApplies: true,
  } as never)

  assert.equal(state.step, 'review', '不能停在 publish 步骤')
  assert.equal(state.ownerIdentity.state, 'unverified')
  assert.ok(
    state.blockers.some((entry) => entry.includes('登录名') || entry.includes('数字 ID')),
    `blockers 必须能执行，实际：${JSON.stringify(state.blockers)}`,
  )
})

test('工作台：主人已核验时走到 publish，但保留「目标会重新核对」的提示', () => {
  const state = deriveWorkbenchState({
    session: session({
      ownerIdentityAssurance: 'verified',
      ownerIdentityEvidence: { kind: 'handle', value: 'silver_fox', source: 'wap_floor' },
    }),
    approvalApplies: true,
  } as never)

  assert.equal(state.step, 'publish')
  assert.equal(state.ownerIdentity.blocking, false)
  assert.ok(
    state.notices.some((entry) => entry.includes('重新') || entry.includes('核对')),
    '仍要说明目标会被重新核对，否则读者会以为批准覆盖了一切',
  )
})

test('工作台：冲突时 blockers 说的是身份，不是内容', () => {
  const state = deriveWorkbenchState({
    session: session({
      identityConflicts: [{ postId: 'r1', summary: '同一 postId 两个来源作者不同' }],
      ownerIdentityEvidence: { kind: 'handle', value: 'x', source: 'wap_floor' },
    }),
    approvalApplies: true,
  } as never)

  assert.equal(state.ownerIdentity.state, 'conflict')
  assert.ok(
    state.blockers.some((entry) => entry.includes('冲突') || entry.includes('不同账号')),
    `blockers 要指名冲突，实际：${JSON.stringify(state.blockers)}`,
  )
})

test('工作台：没有会话时 ownerIdentity 是 unknown 而不是崩溃', () => {
  const state = deriveWorkbenchState({ session: undefined, approvalApplies: false } as never)
  assert.equal(state.ownerIdentity.state, 'unknown')
  assert.equal(state.step, 'link')
})
