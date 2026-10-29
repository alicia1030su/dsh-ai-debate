/**
 * v0.2.7 §三：批准必须绑定「主人看到的那一条」。
 *
 * v0.2.5 引入的批准记录已经绑定了 textHash / 目标 / 账号 / 评估指纹，但**创建入口**
 * 不接受任何预期快照：`POST /approve {sessionId, candidateId}` 会把记录绑到「此刻
 * 存储里的候选」。于是一个十秒没刷新的页面，可以让主人批准一条他没看过的正文——
 * 记录本身自洽，下游无从发现。
 *
 * 这里测的是生产代码里那两个函数（`readExpectation` / `checkExpectation`），
 * 而不是测试里复刻的一份逻辑：复刻的守卫只能证明「我又写了一遍」，证明不了
 * 路由真的会拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DebateStore } from '../lib/store.js'
import { hashText } from '../lib/security/approvals.js'
import {
  checkExpectation,
  readExpectation,
  type ApprovalActual,
  type ApprovalExpectation,
} from '../lib/security/approve-guard.js'

function baseActual(overrides: Partial<ApprovalActual> = {}): ApprovalActual {
  return {
    sessionId: 'sess-1',
    candidateId: 'cand-1',
    candidateVersion: 3,
    platform: 'tieba',
    targetPostId: 'n5',
    publishingAccount: '900',
    textHash: hashText('你这条论据没有出处。'),
    assessmentFingerprint: 'fp-current',
    ...overrides,
  }
}

function baseExpectation(overrides: Partial<ApprovalExpectation> = {}): ApprovalExpectation {
  return {
    sessionId: 'sess-1',
    candidateId: 'cand-1',
    candidateVersion: 3,
    platform: 'tieba',
    targetPostId: 'n5',
    publishingAccount: '900',
    textHash: hashText('你这条论据没有出处。'),
    assessmentFingerprint: 'fp-current',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 缺快照：必须拒绝，且不留兼容通道
// ---------------------------------------------------------------------------

test('批准请求不带预期快照：snapshot_required，400', () => {
  // `[]` is deliberately absent from this list: an array is `typeof 'object'`, and an
  // empty one is honestly "present but has no fields", which is `snapshot_incomplete`.
  // The distinction that matters is "nothing was sent at all" versus "something was
  // sent and it is not enough".
  for (const raw of [undefined, null, 'string', 42]) {
    const result = readExpectation(raw, 'sess-1', 'cand-1')
    assert.equal(result.ok, false, `expected ${String(raw)} to be refused`)
    if (result.ok) continue
    assert.equal(result.status, 400)
    assert.equal(result.code, 'snapshot_required')
    assert.match(result.reason, /必须携带预期快照/)
  }
})

test('空对象/空数组：不是「没带」，而是「带了但不足」', () => {
  for (const raw of [{}, []]) {
    const result = readExpectation(raw, 'sess-1', 'cand-1')
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.code, 'snapshot_incomplete', `${JSON.stringify(raw)} 应判为不完整`)
  }
})

test('快照缺字段：snapshot_incomplete 并点名缺哪个', () => {
  const result = readExpectation(
    { sessionId: 'sess-1', candidateId: 'cand-1', candidateVersion: 3 },
    'sess-1',
    'cand-1',
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.status, 400)
  assert.equal(result.code, 'snapshot_incomplete')
  for (const field of ['platform', 'targetPostId', 'publishingAccount', 'textHash', 'assessmentFingerprint']) {
    assert.match(result.reason, new RegExp(field), `错误里要点名缺少 ${field}`)
  }
})

test('candidateVersion 必须是数字：字符串 "3" 也算缺字段', () => {
  const result = readExpectation(
    {
      ...baseExpectation(),
      candidateVersion: '3',
    },
    'sess-1',
    'cand-1',
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'snapshot_incomplete')
  assert.match(result.reason, /candidateVersion/)
})

test('快照与请求指向不同候选：stale_candidate，409', () => {
  const result = readExpectation(
    { ...baseExpectation(), candidateId: 'cand-OTHER' },
    'sess-1',
    'cand-1',
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.status, 409)
  assert.equal(result.code, 'stale_candidate')
})

test('基线：完整快照通过形状校验（证明拒绝都是因为特定原因）', () => {
  const result = readExpectation(baseExpectation(), 'sess-1', 'cand-1')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.expectation.candidateVersion, 3)
})

// ---------------------------------------------------------------------------
// 快照与存储不符：每一条漂移都必须被抓住
// ---------------------------------------------------------------------------

const DRIFTS: readonly (readonly [string, Partial<ApprovalActual>, RegExp])[] = [
  ['改正文', { textHash: hashText('完全不同的正文') }, /正文内容/],
  ['改目标', { targetPostId: 'n9' }, /回复目标/],
  ['换账号', { publishingAccount: 'oops-other' }, /发帖账号/],
  ['重新生成（版本）', { candidateVersion: 4 }, /候选版本/],
  ['重新评估', { assessmentFingerprint: 'fp-new' }, /安全评估/],
  ['换平台', { platform: 'weibo' }, /平台/],
]

for (const [label, drift, expectedPattern] of DRIFTS) {
  test(`快照与存储不符（${label}）：stale_candidate 且指出是哪一项`, () => {
    const result = checkExpectation(baseExpectation(), baseActual(drift))
    assert.equal(result.ok, false, `${label} 必须被拒绝`)
    if (result.ok) return
    assert.equal(result.code, 'stale_candidate')
    assert.match(result.reason, expectedPattern)
    assert.match(result.reason, /请刷新设置页/, '必须告诉用户下一步该做什么')
  })
}

test('基线：完全一致时通过（防止「一律拒绝」式的假修复）', () => {
  const result = checkExpectation(baseExpectation(), baseActual())
  assert.equal(result.ok, true)
})

test('多处同时漂移：一次说清全部，而不是只报第一处', () => {
  const result = checkExpectation(
    baseExpectation(),
    baseActual({ textHash: hashText('换过'), publishingAccount: 'other', candidateVersion: 9 }),
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /正文内容/)
  assert.match(result.reason, /发帖账号/)
  assert.match(result.reason, /候选版本/)
})

// ---------------------------------------------------------------------------
// 端到端：候选真的被重新生成时，旧快照失效
// ---------------------------------------------------------------------------

test('候选被重新生成后：旧快照不再匹配（真实 store，不是构造的对象）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-snapshot-e2e-'))
  try {
    const store = new DebateStore({ dir })
    await store.ready()
    const now = new Date().toISOString()
    const text = '你这条论据没有出处。'
    await store.mutate((data) => ({
      ...data,
      sessions: [
        ...data.sessions,
        {
          id: 'sess-1',
          platform: 'tieba',
          threadId: '100',
          threadUrl: 'https://tieba.baidu.com/p/100',
          threadTitle: 't',
          forumName: 'f',
          ownerKey: 'o',
          disputeFloorPostId: 'n1',
          disputeFloorNumber: 1,
          triggerPostId: 'n2',
          state: 'READY' as const,
          statusText: '',
          persona: { style: 'tieba_veteran', intensity: 3, maxLength: 150 },
          candidates: [
            {
              replyId: 'cand-1',
              text,
              strategy: 'direct_rebuttal',
              targetPostId: 'n5',
              candidateVersion: 3,
              textHash: hashText(text),
              confidence: 0.8,
              violations: [],
              notes: [],
              security: {
                injectionDetected: false,
                ownerIdentityValid: true,
                targetIdentityValid: true,
                stanceConsistency: 'consistent' as const,
                ownerDirectedAttack: false,
                unauthorizedInstructionFollowed: false,
                secretLeakRisk: false,
                evidenceIntegrityValid: true,
                decision: 'review' as const,
                reasons: [],
                fingerprint: 'fp-current',
              },
              createdAt: now,
              approved: false,
            },
          ],
          publishedPostIds: [],
          sentTexts: [],
          createdAt: now,
          updatedAt: now,
        } as never,
      ],
    }))

    const before = store.getSession('sess-1')!.candidates[0]!
    const pageSnapshot = baseExpectation({ textHash: hashText(before.text) })

    // The agent regenerates: new body, new version, new assessment.
    await store.mutate((data) => ({
      ...data,
      sessions: data.sessions.map((session) =>
        session.id !== 'sess-1'
          ? session
          : {
              ...session,
              candidates: session.candidates.map((candidate) => ({
                ...candidate,
                text: '换成完全不同的说法。',
                textHash: hashText('换成完全不同的说法。'),
                candidateVersion: (candidate.candidateVersion ?? 0) + 1,
                security: { ...candidate.security!, fingerprint: 'fp-new' },
              })),
            },
      ),
    }))

    const after = store.getSession('sess-1')!.candidates[0]!
    const verdict = checkExpectation(pageSnapshot, {
      sessionId: 'sess-1',
      candidateId: after.replyId,
      candidateVersion: after.candidateVersion ?? 0,
      platform: 'tieba',
      targetPostId: after.targetPostId,
      publishingAccount: '900',
      textHash: hashText(after.text),
      assessmentFingerprint: after.security!.fingerprint,
    })
    assert.equal(verdict.ok, false, '旧快照必须失效')
    if (verdict.ok) return
    assert.match(verdict.reason, /正文内容/)
    assert.match(verdict.reason, /候选版本/)
    assert.match(verdict.reason, /安全评估/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两个 store 交错写批准记录：不会互相覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-approval-multi-'))
  try {
    const a = new DebateStore({ dir })
    const b = new DebateStore({ dir })
    await a.ready()
    await b.ready()

    const base = {
      platform: 'tieba',
      targetPostId: 'n5',
      publishingAccount: '900',
      textHash: hashText('x'),
      candidateVersion: 1,
      assessmentFingerprint: 'fp',
      grantedBy: 'owner',
      grantedAt: new Date().toISOString(),
    }
    await a.mutate((data) => ({
      ...data,
      approvals: [...(data.approvals ?? []), { ...base, sessionId: 's1', candidateId: 'c1', id: 'ap-first' } as never],
    }))
    await b.mutate((data) => ({
      ...data,
      approvals: [...(data.approvals ?? []), { ...base, sessionId: 's2', candidateId: 'c2', id: 'ap-second' } as never],
    }))

    // `b` wrote last, so its in-memory copy is current; `a`'s is a cache that is now
    // behind. Read through a *third* store to assert on the durable record rather
    // than on whichever instance happens to be in hand.
    const c = new DebateStore({ dir })
    await c.ready()
    const ids = c.getApprovals().map((row) => row.id)
    assert.ok(ids.includes('ap-first'), '第一个批准记录不能被第二个实例冲掉')
    assert.ok(ids.includes('ap-second'), '第二个批准记录也要在')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
